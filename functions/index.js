const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { HttpsError, onCall, onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { vaultSku, listingUnits } = require('./sku');
const orders = require('./orders');
const listing = require('./listing');
const photos = require('./photos');

initializeApp();
setGlobalOptions({ region: 'us-east1', maxInstances: 5 });

const db = getFirestore();
const auth = getAuth();
const BOOTSTRAP_OWNERS = new Set(['paulckinckay@gmail.com', 'kohlindersjohn@gmail.com']);
const SHOPIFY_SHOP = defineSecret('SHOPIFY_SHOP');
const EBAY_CLIENT_ID = defineSecret('EBAY_CLIENT_ID');
const EBAY_CLIENT_SECRET = defineSecret('EBAY_CLIENT_SECRET');
const SHOPIFY_CLIENT_ID = defineSecret('SHOPIFY_CLIENT_ID');
const SHOPIFY_CLIENT_SECRET = defineSecret('SHOPIFY_CLIENT_SECRET');
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const llm = require('./llm');
const LISTING_MODEL = llm.DEFAULT_MODELS.anthropic;

function signedIn(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to the vault first.');
  return request.auth;
}

async function memberFor(request) {
  const session = signedIn(request);
  const email = String(session.token.email || '').toLowerCase();
  const snap = await db.doc(`members/${session.uid}`).get();
  if (snap.exists && snap.data().active) return { uid: session.uid, email, ...snap.data() };
  if (BOOTSTRAP_OWNERS.has(email)) return { uid: session.uid, email, role: 'owner', active: true };
  throw new HttpsError('permission-denied', 'This account does not have vault access.');
}

async function ownerFor(request) {
  const member = await memberFor(request);
  if (member.role !== 'owner') throw new HttpsError('permission-denied', 'Only a vault owner can manage accounts.');
  return member;
}

// Every callable function records its failures in the shared `syslog` collection,
// which the Vault shows in Settings → System log. Ids count down so newest sort first.
const QUIET_CODES = new Set(['invalid-argument', 'failed-precondition', 'not-found', 'already-exists', 'unauthenticated']);
async function logServerError(where, error, request) {
  try {
    const now = Date.now();
    const id = `${String(9e15 - now).padStart(16, '0')}-${crypto.randomBytes(4).toString('hex')}`;
    const code = String(error && error.code || '');
    await db.doc(`syslog/${id}`).set({
      t: new Date(now).toISOString(),
      level: error instanceof HttpsError && QUIET_CODES.has(code) && !error.raw ? 'warn' : 'error',
      source: 'backend',
      where,
      msg: String(error && error.message || 'Unknown backend error').slice(0, 500),
      detail: String([code && `code: ${code}`, error && error.raw, error && error.stack].filter(Boolean).join('\n')).slice(0, 3000),
      who: '',
      email: String(request && request.auth && request.auth.token && request.auth.token.email || ''),
      page: '',
      device: 'Firebase Functions (us-east1)',
      app: 'functions'
    });
  } catch (logError) {
    console.error('Could not write to syslog:', logError);
  }
}

function logged(where, handler) {
  return async request => {
    try {
      return await handler(request);
    } catch (error) {
      console.error(`${where} failed:`, error);
      await logServerError(where, error, request);
      // A plain Error reaches the app as a bare "internal"; pass its message through instead.
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', String((error && error.message) || error || 'Unexpected server error').slice(0, 500));
    }
  };
}

exports.ensureVaultMembership = onCall(logged('ensureVaultMembership', async request => {
  const member = await memberFor(request);
  if (BOOTSTRAP_OWNERS.has(member.email)) {
    await db.doc(`members/${member.uid}`).set({
      email: member.email,
      displayName: request.auth.token.name || member.email.split('@')[0],
      role: 'owner',
      active: true,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  return { role: member.role };
}));

// Firebase Auth errors otherwise reach the Vault as a bare "internal" error.
function explainAuthError(error, step) {
  const code = String(error && (error.code || error.errorInfo && error.errorInfo.code) || '');
  const raw = String(error && error.message || '');
  console.error(`createVaultMember failed while ${step}:`, code, raw);
  if (error instanceof HttpsError) return error;
  const friendly = explainAuthCode(code, raw);
  friendly.raw = [code && `firebase-auth: ${code}`, `while ${step}`, raw, error && error.stack].filter(Boolean).join('\n');
  return friendly;
}

function explainAuthCode(code, raw) {
  if (/unauthorized-continue-uri|invalid-continue-uri|domain/i.test(code + raw))
    return new HttpsError('failed-precondition', 'Firebase blocked the setup link. In Firebase → Authentication → Settings → Authorized domains, add yartproductions.github.io.');
  if (/insufficient-permission|permission|PERMISSION_DENIED|403/i.test(code + raw))
    return new HttpsError('failed-precondition', 'The Vault backend is not allowed to manage logins. In Google Cloud → IAM, give the functions service account the "Firebase Authentication Admin" role.');
  if (/operation-not-allowed|CONFIGURATION_NOT_FOUND/i.test(code + raw))
    return new HttpsError('failed-precondition', 'Email/Password sign-in is turned off. Turn it on in Firebase → Authentication → Sign-in method.');
  if (/email-already-exists/i.test(code)) return new HttpsError('already-exists', 'That email already has a login. Try adding it again.');
  if (/invalid-email/i.test(code)) return new HttpsError('invalid-argument', 'Enter a valid email address.');
  if (/too-many|quota|RESOURCE_EXHAUSTED/i.test(code + raw)) return new HttpsError('resource-exhausted', 'Firebase is rate-limiting new accounts. Wait a few minutes and try again.');
  return new HttpsError('internal', `Could not add the account: ${code || raw || 'unknown error'}`);
}

exports.createVaultMember = onCall(logged('createVaultMember', async request => {
  const owner = await ownerFor(request);
  const email = String(request.data && request.data.email || '').trim().toLowerCase();
  const displayName = String(request.data && request.data.displayName || '').trim().slice(0, 80);
  const role = request.data && request.data.role === 'owner' ? 'owner' : 'member';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Enter a valid email address.');

  let user;
  try {
    try {
      user = await auth.getUserByEmail(email);
    } catch (error) {
      if (!/user-not-found/.test(String(error && error.code))) throw error;
      user = await auth.createUser({
        email,
        displayName: displayName || undefined,
        password: crypto.randomBytes(24).toString('base64url'),
        emailVerified: false
      });
    }
    await auth.updateUser(user.uid, { disabled: false, displayName: displayName || user.displayName || undefined });
  } catch (error) {
    throw explainAuthError(error, 'creating the login');
  }
  try {
    await db.doc(`members/${user.uid}`).set({
      email,
      displayName: displayName || user.displayName || email.split('@')[0],
      role,
      active: true,
      invitedBy: owner.uid,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    throw explainAuthError(error, 'saving the member record');
  }
  let inviteLink;
  try {
    inviteLink = await auth.generatePasswordResetLink(email, { url: 'https://yartproductions.github.io/TheVault/' });
  } catch (error) {
    throw explainAuthError(error, 'making the password setup link');
  }
  return { uid: user.uid, inviteLink };
}));

exports.setVaultMemberActive = onCall(logged('setVaultMemberActive', async request => {
  const owner = await ownerFor(request);
  const uid = String(request.data && request.data.uid || '');
  const active = request.data && request.data.active === true;
  if (!uid) throw new HttpsError('invalid-argument', 'A member is required.');
  if (uid === owner.uid && !active) throw new HttpsError('failed-precondition', 'You cannot disable your own account.');
  const snap = await db.doc(`members/${uid}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Member not found.');
  await auth.updateUser(uid, { disabled: !active });
  await snap.ref.update({ active, updatedAt: FieldValue.serverTimestamp() });
  return { active };
}));

async function shopifyToken() {
  const shop = SHOPIFY_SHOP.value().replace(/\.myshopify\.com$/i, '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(shop)) throw new HttpsError('failed-precondition', 'SHOPIFY_SHOP is not configured.');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SHOPIFY_CLIENT_ID.value(),
    client_secret: SHOPIFY_CLIENT_SECRET.value()
  });
  const response = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const json = await response.json();
  if (!response.ok || !json.access_token) throw new HttpsError('failed-precondition', 'Shopify authentication failed.');
  return { shop, token: json.access_token };
}

async function shopifyGraphql(connection, query, variables = {}) {
  const response = await fetch(`https://${connection.shop}.myshopify.com/admin/api/2026-10/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': connection.token },
    body: JSON.stringify({ query, variables })
  });
  const json = await response.json();
  if (!response.ok || json.errors) throw new HttpsError('internal', json.errors?.[0]?.message || `Shopify returned ${response.status}.`);
  return json.data;
}

function checkUserErrors(payload) {
  const error = payload && payload.userErrors && payload.userErrors[0];
  if (error) throw new HttpsError('invalid-argument', error.message);
  return payload;
}

// Works out which physical units a listing covers, and which of those are still in stock.
// The listing's own record is always a member; other units must not belong to another listing.
async function resolveUnits(sku, packet, mainItem) {
  const units = [];
  const inStock = [];
  for (const code of listingUnits(sku, packet.units)) {
    let data = mainItem;
    if (code !== sku) {
      const snap = await db.doc(`items/${code}`).get();
      if (!snap.exists) continue;
      data = snap.data();
      if (data.listedIn && data.listedIn !== sku) continue;
      if (data.packet && data.packet.shopifyId) continue;
    }
    units.push(code);
    if (data && orders.IN_STOCK.has(data.status)) inStock.push(code);
  }
  return { units, inStock };
}

// The Shopify listing a unit belongs to: its own, or the one it was pulled into.
async function listingFor(code) {
  const snap = await db.doc(`items/${code}`).get();
  if (!snap.exists) return null;
  const item = snap.data();
  if (item.packet && item.packet.shopifyId) return { sku: code, item };
  if (item.listedIn) {
    const parent = await db.doc(`items/${item.listedIn}`).get();
    if (parent.exists && parent.data().packet && parent.data().packet.shopifyId) return { sku: item.listedIn, item: parent.data() };
  }
  return null;
}

async function primaryLocationId(connection) {
  const data = await shopifyGraphql(connection, `query PrimaryLocation { location { id } }`);
  return data.location ? data.location.id : null;
}

async function setAvailable(connection, inventoryItemId, quantity) {
  const locationId = await primaryLocationId(connection);
  if (!locationId) return;
  const activate = await shopifyGraphql(connection,
    `mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!, $key: String!) { inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $key) { inventoryLevel { id } userErrors { field message } } }`,
    { inventoryItemId, locationId, key: crypto.randomUUID() });
  checkUserErrors(activate.inventoryActivate);
  const data = await shopifyGraphql(connection,
    `mutation SetAvailable($input: InventorySetQuantitiesInput!, $key: String!) { inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { reason } userErrors { field message } } }`,
    { key: crypto.randomUUID(), input: { name: 'available', reason: 'correction', referenceDocumentUri: 'obsidian-vault://listing', quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity: null }] } });
  checkUserErrors(data.inventorySetQuantities);
}

// ── Listing generator: lister notes + Thoky rulebook → final title, HTML and metafields ──
async function anthropic(body) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY.value().trim(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = (json.error && json.error.message) || `HTTP ${response.status}`;
    const err = new Error(`Listing generator: ${msg}`);
    err.status = response.status;
    throw err;
  }
  return json;
}

// Asks Claude for the listing. Web search lets it confirm model numbers and MPNs, as the
// rulebook's research rules ask; if search isn't available on the account it runs without.
async function claudeListing(inputs) {
  const { system, user } = listing.buildPrompt(inputs);
  // The rulebook prompt is identical for every listing, so it's cached: later listings read it
  // at a tenth of the price. 1-hour cache for listing sessions; falls back to the 5-minute one.
  let ttl = '1h';
  const systemBlocks = () => [{ type: 'text', text: system, cache_control: ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' } }];
  let messages = [{ role: 'user', content: user }];
  let tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }];
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let searches = 0;
  let reply;
  for (let turn = 0; turn < 6; turn++) {
    try { reply = await anthropic({ model: LISTING_MODEL, max_tokens: 4000, system: systemBlocks(), messages, ...(tools ? { tools } : {}) }); }
    catch (error) {
      if (error.status === 400 && ttl === '1h' && /ttl|cache/i.test(error.message)) { ttl = '5m'; continue; }
      if (error.status === 400 && tools && /tool|web_search/i.test(error.message)) { tools = null; continue; }
      throw error;
    }
    const u = reply.usage || {};
    for (const k of Object.keys(usage)) usage[k] += Number(u[k]) || 0;
    searches += (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
    if (reply.stop_reason !== 'pause_turn') break;
    messages = [...messages, { role: 'assistant', content: reply.content }];
  }
  const text = (reply.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { out: listing.extractJson(text), searches, usage, cost: listing.estimateCost(usage, searches, ttl), ttl };
}

async function openai(body) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY.value().trim()}` },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = (json.error && json.error.message) || `HTTP ${response.status}`;
    const err = new Error(`Listing generator (OpenAI): ${msg}`);
    err.status = response.status;
    throw err;
  }
  return json;
}

// Same rulebook prompt and output format as Claude, through OpenAI's Responses API.
// Web search confirms model numbers; if the model or account rejects a feature it's dropped and retried.
async function openaiListing(inputs, model) {
  const prompt = listing.buildPrompt(inputs);
  const opts = {};
  let reply;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { reply = await openai(llm.openaiBody(prompt, model, opts)); break; }
    catch (error) {
      const part = error.status === 400 && llm.openaiRejected(error.message);
      if (part && opts[part] !== false) { opts[part] = false; continue; }
      throw error;
    }
  }
  const { text, searches, usage, incomplete } = llm.parseOpenai(reply);
  if (incomplete && !/listing_json/.test(text)) throw new Error(`Listing generator (OpenAI) stopped early: ${incomplete}.`);
  const { cost, estimate } = llm.openaiCost(usage, searches, model);
  return { out: listing.extractJson(text), searches, usage, cost, costEstimate: estimate };
}

// Picks Claude or OpenAI from Settings → Shopify → Listing generator (auto = whichever key is set).
function secretValue(secret) { try { return secret.value(); } catch (e) { return ''; } }
async function writeListing(inputs, shopifySettings) {
  const provider = llm.pickProvider(shopifySettings.listingProvider || 'auto', { anthropic: secretValue(ANTHROPIC_API_KEY), openai: secretValue(OPENAI_API_KEY) });
  if (provider === 'openai') {
    const model = llm.modelFor('openai', shopifySettings.openaiModel);
    return { provider, model, ...(await openaiListing(inputs, model)) };
  }
  return { provider, model: LISTING_MODEL, ...(await claudeListing(inputs)) };
}

async function generateListing(itemRef, item) {
  const packet = item.packet || {};
  const inputs = listing.listingInputs(item, packet);
  const hash = listing.inputsHash(inputs);
  const settingsSnap = await db.doc('meta/settings').get();
  const shopifySettings = (settingsSnap.exists && settingsSnap.data().shopify) || {};
  const standardWear = shopifySettings.standardWear !== false;
  const { out, searches, usage, cost, costEstimate, provider, model } = await writeListing(inputs, shopifySettings);
  const result = listing.normalizeListing(out, inputs);
  const generated = {
    ...result,
    html: listing.renderHtml(result, { standardWear }),
    inputsHash: hash,
    inputs,
    provider,
    model,
    searches,
    usage,
    cost,
    costEstimate: !!costEstimate,
    at: new Date().toISOString()
  };
  await itemRef.set({ packet: { generated } }, { merge: true });
  return generated;
}

// Shopify metafields from the generated listing: only real values, single-line text.
function generatedMetafields(gen) {
  const all = { ...(gen.metafields || {}), ...(gen.ebay || {}) };
  return Object.entries(all)
    .filter(([, v]) => String(v || '').trim())
    .map(([key, value]) => ({ namespace: 'custom', key, type: 'single_line_text_field', value: String(value).replace(/\s+/g, ' ').trim().slice(0, 255) }));
}

// "Generate listing" in the packet: preview before anything goes to Shopify.
exports.shopifyGenerateListing = onCall({ secrets: [ANTHROPIC_API_KEY, OPENAI_API_KEY], timeoutSeconds: 180, memory: '512MiB' }, logged('shopifyGenerateListing', async request => {
  await memberFor(request);
  const sku = vaultSku(request.data && request.data.code);
  const itemRef = db.doc(`items/${sku}`);
  const snap = await itemRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Vault item not found.');
  const item = snap.data();
  if (!String((item.packet || {}).description || item.defect || '').trim()) throw new HttpsError('failed-precondition', 'Write the lister notes first: what it is, what was tested, defects and what\'s included.');
  return await generateListing(itemRef, { ...item, code: sku });
}));

exports.shopifySaveDraft = onCall({ secrets: [SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, ANTHROPIC_API_KEY, OPENAI_API_KEY], timeoutSeconds: 240, memory: '512MiB' }, logged('shopifySaveDraft', async request => {
  await memberFor(request);
  const sku = vaultSku(request.data && request.data.code);
  const itemRef = db.doc(`items/${sku}`);
  const itemSnap = await itemRef.get();
  if (!itemSnap.exists) throw new HttpsError('not-found', 'Vault item not found.');
  const item = itemSnap.data();
  const packet = item.packet || {};
  if (item.listedIn && item.listedIn !== sku) throw new HttpsError('failed-precondition', `This unit is already part of the ${item.listedIn} listing.`);
  const title = String(packet.title || item.title || '').trim();
  const price = Number(packet.price || item.resale);
  if (!title) throw new HttpsError('failed-precondition', 'Add a listing title first.');
  if (!(price > 0)) throw new HttpsError('failed-precondition', 'Add a valid listing price first.');
  const { units, inStock } = await resolveUnits(sku, packet, item);
  const quantity = inStock.length;
  if (!quantity) throw new HttpsError('failed-precondition', 'Every unit in this listing is sold or archived.');

  // One send per item at a time: two overlapping updates would each add the same new photos.
  await db.runTransaction(async tx => {
    const snap = await tx.get(itemRef);
    const since = Date.parse(((snap.data() || {}).packet || {}).shopifySavingAt || '');
    if (isFinite(since) && Date.now() - since < 120000) throw new HttpsError('aborted', 'This item is already being sent to Shopify. Wait a moment and try again.');
    tx.set(itemRef, { packet: { shopifySavingAt: new Date().toISOString() } }, { merge: true });
  });
  try { return await saveDraftLocked(itemRef, sku, item, packet, title, price, units, quantity); }
  finally { await itemRef.set({ packet: { shopifySavingAt: FieldValue.delete() } }, { merge: true }).catch(() => {}); }
}));

async function saveDraftLocked(itemRef, sku, item, packet, title, price, units, quantity) {
  let mediaCleanup = 0; let photosAdded = 0;
  const connection = await shopifyToken();
  // The lister's notes are plain English, not final copy: the listing is generated from them with
  // the Thoky rulebook (or reused if nothing changed since the last "Generate listing").
  let gen = packet.generated;
  if (!gen || gen.inputsHash !== listing.inputsHash(listing.listingInputs({ ...item, code: sku }, packet))) {
    gen = await generateListing(itemRef, { ...item, code: sku });
  }
  const finalTitle = gen.title || title;
  // Rebuilt from the saved listing (no AI call) so template changes reach existing listings on Update.
  const settingsSnap = await db.doc('meta/settings').get();
  const standardWear = (((settingsSnap.exists && settingsSnap.data().shopify) || {}).standardWear) !== false;
  let descriptionHtml = gen.html;
  try { if (gen.rows && gen.grade) descriptionHtml = listing.renderHtml(gen, { standardWear }); } catch (e) { descriptionHtml = gen.html; }
  const productInput = {
    title: finalTitle,
    descriptionHtml,
    productType: gen.type || String(item.category || 'Other'),
    vendor: (gen.metafields && gen.metafields.brand) || finalTitle.split(/\s+/)[0],
    tags: ['obsidian-vault', sku, gen.type, gen.grade].filter(Boolean),
    metafields: [{ namespace: 'custom', key: 'vault_record', type: 'single_line_text_field', value: sku }, ...generatedMetafields(gen)]
  };
  const media = (packet.photos || []).filter(url => /^https:\/\//i.test(url) && !photos.isShopifyCdn(url)).slice(0, 12).map((url, index) => ({
    originalSource: url,
    alt: `${(packet.generated && packet.generated.title) || title} photo ${index + 1}`,
    mediaContentType: 'IMAGE'
  }));

  let product;
  // Deleted in Shopify but the notice never arrived: forget the old product and create a new one.
  if (packet.shopifyId) {
    const check = await shopifyGraphql(connection, `query Exists($id: ID!) { product(id: $id) { id } }`, { id: packet.shopifyId });
    if (!check.product) {
      await applyShopifyStatus(sku, 'DELETED', 'not found in Shopify when updating');
      packet = { ...packet }; products.SHOPIFY_FIELDS.forEach(f => delete packet[f]);
    }
  }
  if (packet.shopifyId) {
    productInput.id = packet.shopifyId;
    // Only photos the product doesn't have yet. Checked against Shopify itself (not just our own
    // record), and repeat copies of the same Vault photo left by earlier updates are removed.
    const existing = await shopifyGraphql(connection,
      `query ProductMedia($id: ID!) { product(id: $id) { media(first: 100) { nodes { id status ... on MediaImage { image { url } preview { image { url } } } } } } }`,
      { id: packet.shopifyId });
    const plan = photos.planMedia(media.map(m => m.originalSource), existing.product ? existing.product.media.nodes : [], packet.shopifyMediaSent);
    const newMedia = media.filter(m => plan.toAdd.includes(m.originalSource));
    photosAdded = newMedia.length;
    if (plan.duplicates.length) {
      try {
        const removed = await shopifyGraphql(connection,
          `mutation RemoveDuplicateMedia($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id } userErrors { field message } } }`,
          { files: plan.duplicates.map(id => ({ id, referencesToRemove: [packet.shopifyId] })) });
        checkUserErrors(removed.fileUpdate);
        mediaCleanup = plan.duplicates.length;
      } catch (error) { console.warn('Duplicate photo cleanup failed:', error.message); }
    }
    const data = await shopifyGraphql(connection,
      `mutation UpdateProduct($product: ProductUpdateInput!, $media: [CreateMediaInput!]) { productUpdate(product: $product, media: $media) { product { id handle status variants(first: 1) { nodes { id inventoryItem { id } } } } userErrors { field message } } }`,
      { product: productInput, media: newMedia.length ? newMedia : null });
    product = checkUserErrors(data.productUpdate).product;
  } else {
    productInput.status = 'DRAFT';
    photosAdded = media.length;
    const data = await shopifyGraphql(connection,
      `mutation CreateProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) { productCreate(product: $product, media: $media) { product { id handle status variants(first: 1) { nodes { id inventoryItem { id } } } } userErrors { field message } } }`,
      { product: productInput, media });
    product = checkUserErrors(data.productCreate).product;
  }

  const variant = product.variants.nodes[0];
  const variantData = await shopifyGraphql(connection,
    `mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id inventoryItem { id sku tracked } } userErrors { field message } } }`,
    { productId: product.id, variants: [{ id: variant.id, price: price.toFixed(2), inventoryPolicy: 'DENY', inventoryItem: { sku, tracked: true, requiresShipping: true, ...(Number(item.cost) > 0 ? { cost: Number(item.cost).toFixed(2) } : {}) } }] });
  checkUserErrors(variantData.productVariantsBulkUpdate);

  // Shopify's quantity always matches the number of Vault units in this listing.
  await setAvailable(connection, variant.inventoryItem.id, quantity);

  // An already-active listing is (re)published, so fixing app permissions and pressing Update makes it visible.
  let publish = {};
  if (product.status === 'ACTIVE') {
    try { publish = { shopifyChannels: await publishToChannels(connection, product.id), shopifyPublishError: '' }; }
    catch (error) { publish = { shopifyPublishError: /access|scope|denied|permission/i.test(String(error.message)) ? 'The Shopify app needs the read_publications and write_publications scopes to put products on your Online Store.' : String(error.message || error) }; }
  }

  const adminUrl = `https://admin.shopify.com/store/${connection.shop}/products/${product.id.split('/').pop()}`;
  const batch = db.batch();
  batch.set(itemRef, { packet: { shopifyId: product.id, shopifyUrl: adminUrl, shopifySku: sku, shopifyStatus: product.status || 'DRAFT', shopifyQty: quantity, shopifyInventoryItemId: variant.inventoryItem.id, units, shopifyMediaSent: media.map(m => m.originalSource), ...publish, shopifySyncedAt: FieldValue.serverTimestamp() } }, { merge: true });
  units.filter(code => code !== sku).forEach(code => batch.set(db.doc(`items/${code}`), { listedIn: sku }, { merge: true }));
  await batch.commit();
  return { id: product.id, adminUrl, sku, status: product.status || 'DRAFT', quantity, units, generatedHash: gen.inputsHash || '', photosAdded, duplicatesRemoved: mediaCleanup };
}

// Puts a product on the store's sales channels (Online Store and Shop). Products created through
// the API start unpublished, so an Active product isn't visible to buyers until this runs.
// Needs the read_publications and write_publications scopes on the Shopify app.
const SALES_CHANNELS = /online store|^shop$|for shop$/i;
async function publishToChannels(connection, productId) {
  const data = await shopifyGraphql(connection, `query Channels { publications(first: 25) { nodes { id catalog { title } } } }`);
  const targets = data.publications.nodes.filter(p => SALES_CHANNELS.test(String((p.catalog && p.catalog.title) || '').replace(/^channel catalog \d+ for /i, '').trim()));
  if (!targets.length) return [];
  const result = await shopifyGraphql(connection,
    `mutation Publish($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
    { id: productId, input: targets.map(t => ({ publicationId: t.id })) });
  checkUserErrors(result.publishablePublish);
  return targets.map(t => String(t.catalog.title).replace(/^channel catalog \d+ for /i, ''));
}

exports.shopifyActivate = onCall({ secrets: [SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET], timeoutSeconds: 60 }, logged('shopifyActivate', async request => {
  await memberFor(request);
  const sku = vaultSku(request.data && request.data.code);
  const itemRef = db.doc(`items/${sku}`);
  const itemSnap = await itemRef.get();
  if (!itemSnap.exists) throw new HttpsError('not-found', 'Vault item not found.');
  const item = itemSnap.data();
  const packet = item.packet || {};
  if (!packet.shopifyId) throw new HttpsError('failed-precondition', 'Create the Shopify draft first.');
  const { units, inStock } = await resolveUnits(sku, packet, item);
  if (!inStock.length) throw new HttpsError('failed-precondition', 'Every unit in this listing is sold or archived.');

  const connection = await shopifyToken();
  const check = await shopifyGraphql(connection, `query Exists($id: ID!) { product(id: $id) { id } }`, { id: packet.shopifyId });
  if (!check.product) {
    await applyShopifyStatus(sku, 'DELETED', 'not found in Shopify when activating');
    throw new HttpsError('failed-precondition', 'This product was deleted in Shopify. Press Create Shopify draft to make it again.');
  }
  if (packet.shopifyInventoryItemId) await setAvailable(connection, packet.shopifyInventoryItemId, inStock.length);
  const data = await shopifyGraphql(connection,
    `mutation ActivateProduct($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }`,
    { product: { id: packet.shopifyId, status: 'ACTIVE' } });
  const product = checkUserErrors(data.productUpdate).product;
  let channels = [];
  let publishError = '';
  try { channels = await publishToChannels(connection, product.id); }
  catch (error) {
    publishError = /access|scope|denied|permission/i.test(String(error.message)) ? 'The Shopify app needs the read_publications and write_publications scopes to put products on your Online Store.' : String(error.message || error);
    await writeSyslog('warn', 'shopifyActivate', `Product is Active but not published to sales channels: ${publishError}`, product.id);
  }

  // Only after Shopify confirms do the in-stock units move to Listed.
  const now = new Date().toISOString();
  const batch = db.batch();
  batch.set(itemRef, { packet: { shopifyStatus: product.status, shopifyQty: inStock.length, units, shopifyChannels: channels, shopifyPublishError: publishError, shopifyActivatedAt: FieldValue.serverTimestamp() } }, { merge: true });
  inStock.forEach(code => batch.set(db.doc(`items/${code}`), code === sku ? { status: 'list', updatedAt: now } : { status: 'list', updatedAt: now, listedIn: sku }, { merge: true }));
  await batch.commit();
  return { id: product.id, status: product.status, quantity: inStock.length, units: inStock, channels, publishError };
}));

// ── Sales sync ───────────────────────────────────────────────────
// Makes Shopify's quantity match the units still in stock. At zero the product goes back
// to Draft so it disappears from the store; a return brings the quantity back up.
async function syncListingStock(connection, sku) {
  const itemRef = db.doc(`items/${sku}`);
  const snap = await itemRef.get();
  if (!snap.exists) return null;
  const item = snap.data();
  const packet = item.packet || {};
  if (!packet.shopifyId) return null;
  const check = await shopifyGraphql(connection, `query Exists($id: ID!) { product(id: $id) { id } }`, { id: packet.shopifyId });
  if (!check.product) { await applyShopifyStatus(sku, 'DELETED', 'not found in Shopify when syncing stock'); return { sku, deleted: true }; }
  const { inStock } = await resolveUnits(sku, packet, item);
  const quantity = inStock.length;
  let inventoryItemId = packet.shopifyInventoryItemId;
  if (!inventoryItemId) {
    const data = await shopifyGraphql(connection, `query Variant($id: ID!) { product(id: $id) { variants(first: 1) { nodes { inventoryItem { id } } } } }`, { id: packet.shopifyId });
    inventoryItemId = data.product && data.product.variants.nodes[0] && data.product.variants.nodes[0].inventoryItem.id;
  }
  if (inventoryItemId) await setAvailable(connection, inventoryItemId, quantity);
  let status = packet.shopifyStatus || 'DRAFT';
  if (quantity === 0 && status === 'ACTIVE') {
    const data = await shopifyGraphql(connection,
      `mutation Unlist($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }`,
      { product: { id: packet.shopifyId, status: 'DRAFT' } });
    status = checkUserErrors(data.productUpdate).product.status;
  }
  await itemRef.set({ packet: { shopifyQty: quantity, shopifyStatus: status, shopifyInventoryItemId: inventoryItemId || null, shopifySyncedAt: FieldValue.serverTimestamp() } }, { merge: true });
  return { sku, quantity, status };
}

// Called by the Vault after a sale or return is recorded there.
exports.shopifySyncListing = onCall({ secrets: [SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET], timeoutSeconds: 60 }, logged('shopifySyncListing', async request => {
  await memberFor(request);
  const code = vaultSku(request.data && request.data.code);
  const listing = await listingFor(code);
  if (!listing) return { synced: false };
  const connection = await shopifyToken();
  const result = await syncListingStock(connection, listing.sku);
  return { synced: true, ...result };
}));

async function writeSyslog(level, where, msg, detail = '') {
  try {
    const now = Date.now();
    const id = `${String(9e15 - now).padStart(16, '0')}-${crypto.randomBytes(4).toString('hex')}`;
    await db.doc(`syslog/${id}`).set({ t: new Date(now).toISOString(), level, source: 'backend', where, msg: String(msg).slice(0, 500), detail: String(detail).slice(0, 3000), who: '', email: '', page: '', device: 'Firebase Functions (us-east1)', app: 'functions' });
  } catch (error) {
    console.error('Could not write to syslog:', error);
  }
}

// Same paged activity log the Vault writes to, attributed to "sys".
async function appendActivity(entry) {
  const e = { t: new Date().toISOString(), by: 'sys', uid: '', type: 'SL', code: '', obj: '', detail: '', links: [], from: '', to: '', ...entry };
  const month = e.t.slice(0, 7).replace('-', '');
  try {
    for (let part = 1; part < 40; part++) {
      const ref = db.doc(`activity/${month}-sys-${part}`);
      const added = await db.runTransaction(async t => {
        const snap = await t.get(ref);
        const list = snap.exists && Array.isArray(snap.data().entries) ? snap.data().entries : [];
        if (list.length >= 600) return false;
        t.set(ref, { month, by: 'sys', part, entries: [...list, e] });
        return true;
      });
      if (added) return;
    }
  } catch (error) {
    console.error('Could not append activity:', error);
  }
}

// Shopify → Vault: a paid order marks the sold units Sold and books each sale, exactly once.
// ── Product sync: Shopify → Vault ────────────────────────────────
const products = require('./products');
// Applies a Shopify product status to the Vault listing that owns it. 'DELETED' unlinks the
// product so the packet goes back to "Create Shopify draft"; the listing keeps its units.
async function applyShopifyStatus(sku, status, source) {
  const itemRef = db.doc(`items/${sku}`);
  const snap = await itemRef.get();
  if (!snap.exists) return null;
  const main = snap.data();
  const packet = main.packet || {};
  const units = [{ code: sku, ...main }];
  for (const code of listingUnits(sku, packet.units).filter(c => c !== sku)) {
    const u = await db.doc(`items/${code}`).get();
    if (u.exists) units.push({ code, ...u.data() });
  }
  const changes = products.unitChanges(status, units, sku);
  const now = new Date().toISOString();
  const batch = db.batch();
  if (status === 'DELETED') {
    const cleared = Object.fromEntries(products.SHOPIFY_FIELDS.map(f => [`packet.${f}`, FieldValue.delete()]));
    batch.update(itemRef, { ...cleared, 'packet.shopifyDeletedAt': now, updatedAt: now });
  } else if (packet.shopifyStatus !== status) {
    batch.set(itemRef, { packet: { shopifyStatus: status } }, { merge: true });
  }
  changes.forEach(c => { const { code, ...fields } = c; batch.set(db.doc(`items/${code}`), { ...fields, updatedAt: now }, { merge: true }); });
  await batch.commit();
  const moved = changes.filter(c => c.status);
  if (status === 'DELETED' || moved.length) {
    await appendActivity({ type: 'LT', verb: status === 'DELETED' ? 'saw the Shopify product deleted for' : `saw Shopify set ${status.toLowerCase()} for`, code: sku, obj: main.title || '',
      detail: `${source}${moved.length ? ` · ${moved.length} unit${moved.length === 1 ? '' : 's'} → ${moved[0].status === 'list' ? 'Listed' : 'Prepared'}` : ''}`, links: moved.map(c => c.code),
      from: moved.length ? (moved[0].status === 'list' ? 'Prepared' : 'Listed') : '', to: moved.length ? (moved[0].status === 'list' ? 'Listed' : 'Prepared') : '' });
  }
  return { sku, status, moved: moved.map(c => c.code) };
}
async function skusForProduct(gid) {
  if (!gid) return [];
  const snap = await db.collection('items').where('packet.shopifyId', '==', gid).limit(5).get();
  return snap.docs.map(d => d.id);
}
async function handleProductWebhook(topic, body) {
  const gid = products.productGid(body);
  const skus = await skusForProduct(gid);
  if (!skus.length) return 'No Vault listing for this product';
  const status = topic === 'products/delete' ? 'DELETED' : products.restStatus(body.status);
  if (!['ACTIVE', 'DRAFT', 'ARCHIVED', 'DELETED'].includes(status)) return 'Status ignored';
  for (const sku of skus) await applyShopifyStatus(sku, status, topic === 'products/delete' ? 'deleted in Shopify' : `status changed in Shopify`);
  return `Synced ${skus.join(', ')}`;
}

exports.shopifyOrderWebhook = onRequest({ secrets: [SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, EBAY_CLIENT_ID, EBAY_CLIENT_SECRET], invoker: 'public', timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('POST only');
  if (!orders.validShopifyHmac(req.rawBody, req.get('X-Shopify-Hmac-Sha256'), SHOPIFY_CLIENT_SECRET.value())) {
    await writeSyslog('warn', 'shopifyOrderWebhook', 'Rejected a webhook with a bad signature.', `topic: ${req.get('X-Shopify-Topic') || '?'}`);
    return res.status(401).send('Bad signature');
  }
  const topic = req.get('X-Shopify-Topic') || '';
  if (topic === 'products/delete' || topic === 'products/update') {
    try { return res.status(200).send(await handleProductWebhook(topic, req.body || {})); }
    catch (error) { await writeSyslog('error', 'shopifyProductWebhook', `Could not sync ${topic}: ${error.message}`, products.productGid(req.body)); return res.status(500).send('Retry'); }
  }
  const order = req.body || {};
  if (topic !== 'orders/paid' || !order.id) return res.status(200).send('Ignored');
  if (order.test) return res.status(200).send('Test order ignored');

  try {
    const settingsSnap = await db.doc('meta/settings').get();
    // Buyer-paid shipping (the default) covers the label, so no flat shipping cost comes off the sale.
    const settingsData = settingsSnap.exists ? settingsSnap.data() : {};
    const shipFlat = settingsData.buyerPaysShipping === false ? Number(settingsData.shipFlat) || 0 : 0;
    const date = orders.orderDate(order);
    const buyer = orders.buyerName(order);
    const orderName = String(order.name || order.order_number || order.id);

    const outcome = await db.runTransaction(async t => {
      // Reads first: the order marker, each listing and its units, then the code counters.
      const orderRef = db.doc(`shopifyOrders/${order.id}`);
      if ((await t.get(orderRef)).exists) return { duplicate: true };
      const lines = [];
      for (const line of order.line_items || []) {
        const sku = orders.lineSku(line);
        const qty = Math.max(0, Number(line.quantity) || 0);
        if (!sku || !qty) { lines.push({ line, sku, qty, picked: [], reason: sku ? 'no quantity' : 'not a Vault SKU' }); continue; }
        const mainSnap = await t.get(db.doc(`items/${sku}`));
        if (!mainSnap.exists) { lines.push({ line, sku, qty, picked: [], reason: 'listing not in the Vault' }); continue; }
        const main = mainSnap.data();
        const units = [{ code: sku, ...main }];
        for (const code of listingUnits(sku, (main.packet || {}).units).filter(c => c !== sku)) {
          const u = await t.get(db.doc(`items/${code}`));
          if (u.exists && (!u.data().listedIn || u.data().listedIn === sku)) units.push({ code, ...u.data() });
        }
        const taken = new Set(lines.flatMap(l => l.picked));
        const picked = orders.pickUnits(units.filter(u => !taken.has(u.code)), qty);
        lines.push({ line, sku, qty, picked, units, main, reason: picked.length < qty ? `only ${picked.length} of ${qty} in stock` : '' });
      }
      const soldCount = lines.reduce((n, l) => n + l.picked.length, 0);
      const counters = {};
      if (soldCount) for (const k of ['SL', 'TX']) { const c = await t.get(db.doc(`counters/${k}`)); counters[k] = c.exists ? Number(c.data().n) || 0 : 0; }

      // Writes.
      const now = new Date().toISOString();
      const sales = [];
      for (const l of lines) {
        const price = orders.unitPrice(l.line);
        const fees = orders.shopifyFee(price);
        for (const code of l.picked) {
          const unit = l.units.find(u => u.code === code);
          const sl = `SL-${String(++counters.SL).padStart(4, '0')}`;
          const tx = `TX-${String(++counters.TX).padStart(4, '0')}`;
          const net = +(price - fees - shipFlat).toFixed(2);
          const profit = +(net - (Number(unit.cost) || 0)).toFixed(2);
          const sale = { code: sl, txCode: tx, channel: 'Shopify', price, fees, ship: shipFlat, date, order: orderName, tracking: '', buyer };
          t.set(db.doc(`sales/${sl}`), { ...sale, item: code, net, profit, by: 'sys', shopifyOrderId: String(order.id), createdAt: now });
          t.set(db.doc(`items/${code}`), { status: 'sold', sale, updatedAt: now, updatedBy: 'sys' }, { merge: true });
          t.set(db.doc(`txs/${tx}`), { code: tx, date, desc: `Sale ${sl} · ${unit.title || code}`, amount: net, category: 'Sales', method: 'Payout', by: 'sys', payee: buyer, ref: orderName, link: sl, tags: 'Shopify', notes: `Shopify order ${orderName}: price ${price.toFixed(2)} − fees ${fees.toFixed(2)} − shipping ${shipFlat.toFixed(2)}`, createdAt: now });
          sales.push({ sl, tx, code, title: unit.title || code, price, profit, listing: l.sku, from: unit.status });
        }
      }
      // Remaining stock per listing, counting every line of this order.
      const allPicked = new Set(lines.flatMap(l => l.picked));
      for (const sku of new Set(lines.filter(l => l.picked.length).map(l => l.sku))) {
        const l = lines.find(x => x.sku === sku && x.units);
        const left = l.units.filter(u => orders.IN_STOCK.has(u.status) && !allPicked.has(u.code)).length;
        t.set(db.doc(`items/${sku}`), { packet: { shopifyQty: left } }, { merge: true });
      }
      if (soldCount) for (const k of ['SL', 'TX']) t.set(db.doc(`counters/${k}`), { n: counters[k] });
      const problems = lines.filter(l => l.reason).map(l => ({ sku: l.sku || String(l.line.sku || ''), title: String(l.line.title || ''), qty: l.qty, reason: l.reason }));
      t.set(orderRef, { name: orderName, date, buyer, sales: sales.map(x => x.sl), items: sales.map(x => x.code), problems, receivedAt: now });
      return { sales, problems };
    });

    if (outcome.duplicate) return res.status(200).send('Already recorded');
    for (const x of outcome.sales) {
      await appendActivity({ verb: 'recorded Shopify sale', code: x.sl, obj: x.title, detail: `Shopify ${orderName} · $${x.price.toFixed(2)} · net $${x.profit.toFixed(2)}`, links: [x.code, x.tx], from: x.from, to: 'Sold' });
    }
    // A Shopify sale changes stock: the eBay listing (if any) follows, ending at zero.
    for (const listingSku of new Set(outcome.sales.map(x => x.listing))) {
      await ebaySyncStock(listingSku).catch(e => writeSyslog('warn', 'shopifyOrderWebhook', `Couldn’t update eBay quantity for ${listingSku}: ${e.message}`, ''));
    }
    if (outcome.problems.length) {
      await writeSyslog('warn', 'shopifyOrderWebhook', `Shopify order ${orderName}: ${outcome.problems.length} line(s) not matched to Vault stock.`, outcome.problems.map(p => `${p.sku || '(no SKU)'} ${p.title} ×${p.qty}: ${p.reason}`).join('\n'));
    }
    return res.status(200).send(`Recorded ${outcome.sales.length} sale(s)`);
  } catch (error) {
    console.error('shopifyOrderWebhook failed:', error);
    await logServerError('shopifyOrderWebhook', error, null);
    return res.status(500).send('Error'); // Shopify retries; the order marker keeps it exactly-once
  }
});

// Settings button: subscribes the store's paid orders to the webhook above.
exports.shopifyConnectOrders = onCall({ secrets: [SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET], timeoutSeconds: 60 }, logged('shopifyConnectOrders', async request => {
  await ownerFor(request);
  const project = process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId;
  const uri = `https://us-east1-${project}.cloudfunctions.net/shopifyOrderWebhook`;
  const connection = await shopifyToken();
  // Paid orders book sales; product updates and deletions keep the packet's Shopify state in step.
  const topics = ['ORDERS_PAID', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE'];
  const existing = await shopifyGraphql(connection,
    `query Hooks { webhookSubscriptions(first: 100) { nodes { id topic uri } } }`);
  const have = new Set(existing.webhookSubscriptions.nodes.filter(n => n.uri === uri).map(n => n.topic));
  // Each topic separately: Shopify can refuse one (orders need extra permission) without blocking the others.
  const failed = [];
  for (const topic of topics.filter(t => !have.has(t))) {
    try {
      const data = await shopifyGraphql(connection,
        `mutation Subscribe($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id uri } userErrors { field message } } }`,
        { topic, sub: { uri, format: 'JSON' } });
      checkUserErrors(data.webhookSubscriptionCreate);
      have.add(topic);
    } catch (error) { failed.push({ topic, message: String(error.message || error) }); }
  }
  if (failed.length) await writeSyslog('warn', 'shopifyConnectOrders', `Shopify refused: ${failed.map(f => f.topic).join(', ')}`, failed.map(f => `${f.topic}: ${f.message}`).join('\n'));
  const ordersOk = have.has('ORDERS_PAID');
  const productSync = have.has('PRODUCTS_UPDATE') && have.has('PRODUCTS_DELETE');
  if (!ordersOk && !productSync) throw new HttpsError('failed-precondition', `Shopify refused every subscription: ${failed.map(f => `${f.topic} (${f.message})`).join('; ')}`);
  return { connected: true, uri, orders: ordersOk, products: productSync, failed, already: !failed.length && topics.every(t => have.has(t)) };
}));

// ── eBay market collector ────────────────────────────────────────
// Every few hours: for each watched model, snapshot eBay's live fixed-price listings
// (count and price spread), and count listings that left since the last snapshot.
// Only numbers and listing ids are kept, never copies of other people's listings.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const market = require('./market');
const EBAY_VERIFICATION_TOKEN = defineSecret('EBAY_VERIFICATION_TOKEN');
const EBAY_SECRETS = [EBAY_CLIENT_ID, EBAY_CLIENT_SECRET];
const EBAY_DELETION_ENDPOINT = 'https://us-east1-obsidian-vault-38dfd.cloudfunctions.net/ebayAccountDeletion';
const MARKET_MAX_MODELS = 60;
const MARKET_MAX_PAGES = 5; // up to 1,000 listings per model
const MARKET_HISTORY = 180;

let ebayCachedToken = null;
async function ebayToken() {
  if (ebayCachedToken && ebayCachedToken.expires > Date.now() + 60e3) return ebayCachedToken.token;
  const basic = Buffer.from(`${EBAY_CLIENT_ID.value().trim()}:${EBAY_CLIENT_SECRET.value().trim()}`).toString('base64');
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    const why = json.error_description || json.error || `HTTP ${response.status}`;
    throw new HttpsError('failed-precondition', `eBay sign-in failed (${why}). Check EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are your Production keys and the keyset is enabled.`);
  }
  ebayCachedToken = { token: json.access_token, expires: Date.now() + (Number(json.expires_in) || 7200) * 1000 };
  return ebayCachedToken.token;
}

async function ebayGet(token, params) {
  const response = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = (json.errors && json.errors[0] && (json.errors[0].longMessage || json.errors[0].message)) || `HTTP ${response.status}`;
    throw new Error(`eBay search failed: ${msg}`);
  }
  return json;
}

function searchParams(doc, extra = {}) {
  const match = doc.match || {};
  // Part-number mode: the exact manufacturer part, in its category, nothing else to guess.
  if (doc.mode === 'mpn' && match.mpn) {
    const params = new URLSearchParams({ q: match.mpn, filter: market.ebayFilter(doc.group, doc.category), ...extra });
    if (doc.category) params.set('category_ids', doc.category);
    return { params, exact: true };
  }
  const aspects = market.aspectFilter(doc.category, match);
  const params = new URLSearchParams({ q: (match.model && aspects ? match.model : doc.query).slice(0, 100), filter: market.ebayFilter(doc.group, doc.category), ...extra });
  if (doc.category) params.set('category_ids', doc.category);
  if (aspects) params.set('aspect_filter', aspects);
  return { params, exact: !!(aspects && (match.model || (match.brand && match.storage) || (match.extra || []).length >= 2)) };
}

async function ebaySearchAll(token, doc) {
  const ids = [];
  const listings = [];
  let total = 0;
  let junk = 0;
  let seen = 0;
  const { exact } = searchParams(doc);
  for (let page = 0; page < MARKET_MAX_PAGES; page++) {
    const json = await ebayGet(token, searchParams(doc, { limit: '200', offset: String(page * 200) }).params);
    total = Number(json.total) || 0;
    for (const s of json.itemSummaries || []) {
      seen++;
      if (market.junkTitle(s.title, doc.group, doc.category)) { junk++; continue; }
      if (s.itemId) ids.push(s.itemId);
      const p = market.landedPrice(s);
      // Lot listings ("Lot of 5", "2x16GB") are compared per unit.
      const units = market.lotSize(s.title);
      if (p != null) listings.push({ id: s.itemId, title: String(s.title || '').slice(0, 120), price: +(p / units).toFixed(2), lot: units, url: s.itemWebUrl || '' });
    }
    if (!json.itemSummaries || json.itemSummaries.length < 200 || seen >= total) break;
  }
  return { total: Math.max(0, total - junk), ids, listings, junk, exact, complete: seen >= total, mode: doc.mode === 'mpn' ? 'mpn' : 'details' };
}

// Finds eBay's own Brand / Model / Storage / Network values for a model, from one search
// that returns how eBay's listings are spread across those item specifics.
async function resolveMatch(token, doc) {
  if (!doc.category) { const mpn = market.partNumbers(`${doc.title || doc.query} ${doc.specs || ''}`)[0] || ''; return { source: 'auto', at: new Date().toISOString(), model: '', mpn, extra: [], detail: market.detailScore({ mpn }), options: {} }; }
  const params = new URLSearchParams({ q: doc.query.slice(0, 100), filter: market.ebayFilter(doc.group, doc.category), category_ids: doc.category, fieldgroups: 'ASPECT_REFINEMENTS', limit: '1' });
  const json = await ebayGet(token, params);
  const dist = (json.refinement && json.refinement.aspectDistributions) || [];
  const title = doc.title || doc.query;
  const brand = market.pickAspect(dist, /^brand$/i, title);
  const model = market.pickAspect(dist, /^model$/i, title);
  const storage = market.pickStorage(dist, doc.specs || '', title);
  const network = market.pickNetwork(dist, doc.specs || '');
  const nameOf = re => ((dist.find(a => re.test(String(a.localizedAspectName || ''))) || {}).localizedAspectName) || '';
  const text = `${doc.title || doc.query} ${doc.specs || ''}`;
  const storageName = nameOf(/storage capacity|^storage$|total capacity|^capacity$|capacity per module/i);
  const extra = market.pickDetails(dist, text).filter(d => d.name !== storageName);
  const mpn = market.partNumbers(text)[0] || '';
  const found = { brand: brand.value, model: model.value, storage: storage.value, extra, mpn };
  return {
    source: 'auto', at: new Date().toISOString(),
    brand: brand.value, model: model.value, storage: storage.value, network: network.value, mpn, extra, detail: market.detailScore(found),
    storageName: nameOf(/storage capacity|^storage$|total capacity|^capacity$|capacity per module/i) || 'Storage Capacity', networkName: nameOf(/^network$|carrier/i) || 'Network',
    options: { model: model.options, storage: storage.options, network: network.options }
  };
}

// Asks eBay which category a model belongs in, for items the Vault has no fixed category for.
async function suggestCategory(token, query) {
  const url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(query.slice(0, 100))}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  const top = (json.categorySuggestions || [])[0];
  return top && top.category ? { id: String(top.category.categoryId), name: String(top.category.categoryName || '') } : null;
}

const matchSig = match => JSON.stringify([match && match.brand, match && match.model, match && match.storage, match && match.network, match && match.mpn, (match && match.extra || []).map(d => `${d.name}=${d.value}`)]);

// Builds the watch list from what is in stock: one model per title + storage + condition group.
async function refreshAutoWatchlist() {
  const items = await db.collection('items').where('status', 'in', [...market.IN_STOCK]).get();
  const seen = new Map();
  items.forEach(d => {
    const it = d.data();
    const key = market.marketKey(it.title, it.specs, it.condition);
    if (!key) return;
    const entry = seen.get(key) || { key, label: market.marketQuery(it.title, it.specs), query: market.marketQuery(it.title, it.specs), title: market.stripLot(it.title), specs: String(it.specs || ''), group: market.condGroup(it.condition), category: market.ebayCategory(it.category, it.title), codes: [] };
    entry.codes.push(d.id);
    seen.set(key, entry);
  });
  const batch = db.batch();
  for (const e of [...seen.values()].slice(0, MARKET_MAX_MODELS)) {
    batch.set(db.doc(`market/${e.key}`), { key: e.key, label: e.label, query: e.query, title: e.title, specs: e.specs, group: e.group, ...(e.category ? { category: e.category } : {}), codes: e.codes.sort(), auto: true, active: true }, { merge: true });
  }
  await batch.commit();
}

async function collectModel(token, ref, doc) {
  const now = new Date().toISOString();
  try {
    if (!doc.category && !doc.categoryChecked) {
      const cat = await suggestCategory(token, doc.query).catch(() => null);
      doc = { ...doc, category: cat ? cat.id : '', categoryName: cat ? cat.name : '', categoryChecked: true };
      await ref.set({ category: doc.category, categoryName: doc.categoryName, categoryChecked: true }, { merge: true });
    }
    let match = doc.match;
    const stale = !match || (match.source !== 'manual' && Date.now() - Date.parse(match.at || 0) > 14 * 864e5);
    if (stale) match = await resolveMatch(token, doc);
    const sig = matchSig(match);
    let result = match && match.mpn ? await ebaySearchAll(token, { ...doc, match, mode: 'mpn' }) : null;
    if (!result || result.listings.length < 5) result = await ebaySearchAll(token, { ...doc, match, mode: 'details' });
    const stats = market.priceStats(result.listings.map(l => l.price));
    // A changed match means a different set of listings: skip one diff instead of counting false "sales".
    const canDiff = result.complete && doc.lastComplete && Array.isArray(doc.ids) && doc.matchSig === sig && (doc.last || {}).mode === result.mode;
    const diff = canDiff ? market.diffListings(doc.ids, result.ids) : { gone: null, added: null };
    const point = { t: now, total: result.total, median: stats.median, p25: stats.p25, gone: diff.gone, added: diff.added };
    const history = [...(doc.history || []), point].slice(-MARKET_HISTORY);
    // A few listings around the median, so people can see what the model was matched to.
    const sample = stats.median ? [...result.listings].sort((a, b) => Math.abs(a.price - stats.median) - Math.abs(b.price - stats.median)).slice(0, 5) : [];
    await ref.set({
      match, matchSig: sig,
      last: { t: now, total: result.total, priced: stats.n, low: stats.low, p25: stats.p25, median: stats.median, p75: stats.p75, high: stats.high, gone: diff.gone, added: diff.added, complete: result.complete, exact: result.exact, junk: result.junk, mode: result.mode },
      sample, history,
      perWeek: market.weeklyGone(history),
      ids: result.complete ? result.ids : FieldValue.delete(),
      lastComplete: result.complete,
      error: ''
    }, { merge: true });
    return { key: doc.key, ok: true };
  } catch (error) {
    await ref.set({ error: String(error.message || error).slice(0, 300), errorAt: now }, { merge: true });
    return { key: doc.key, ok: false, error: String(error.message || error) };
  }
}

async function collectMarket(onlyKey) {
  if (!onlyKey) await refreshAutoWatchlist();
  const snap = onlyKey ? await db.collection('market').where('key', '==', onlyKey).get() : await db.collection('market').where('active', '==', true).get();
  const token = await ebayToken();
  const results = [];
  for (const d of snap.docs.slice(0, MARKET_MAX_MODELS)) results.push(await collectModel(token, d.ref, d.data()));
  const failed = results.filter(r => !r.ok);
  if (failed.length) await writeSyslog('warn', 'ebayMarket', `${failed.length} of ${results.length} eBay model(s) could not be collected.`, failed.map(f => `${f.key}: ${f.error}`).join('\n'));
  await db.doc('meta/market').set({ lastRun: new Date().toISOString(), models: results.length, failed: failed.length }, { merge: true });
  return results;
}

exports.ebayMarketCollect = onSchedule({ schedule: 'every 6 hours', timeZone: 'America/New_York', secrets: EBAY_SECRETS, timeoutSeconds: 540, memory: '512MiB' }, async () => {
  try { await collectMarket(); }
  catch (error) { await logServerError('ebayMarketCollect', error, null); throw error; }
});

// "Refresh now" from the Market page, for one model or all of them.
exports.ebayMarketRefresh = onCall({ secrets: EBAY_SECRETS, timeoutSeconds: 540, memory: '512MiB' }, logged('ebayMarketRefresh', async request => {
  await memberFor(request);
  const key = String(request.data && request.data.key || '').slice(0, 100);
  if (!key) {
    const meta = await db.doc('meta/market').get();
    const last = meta.exists ? Date.parse(meta.data().lastRun || 0) : 0;
    if (Date.now() - last < 10 * 60e3) throw new HttpsError('resource-exhausted', 'The market was refreshed in the last 10 minutes. Try again shortly.');
  }
  const results = await collectMarket(key || null);
  return { models: results.length, failed: results.filter(r => !r.ok).length };
}));

// Add a model by hand, or stop watching one.
exports.ebayMarketWatch = onCall({ secrets: EBAY_SECRETS, timeoutSeconds: 120 }, logged('ebayMarketWatch', async request => {
  await memberFor(request);
  const data = request.data || {};
  if (data.action === 'remove') {
    const key = String(data.key || '');
    if (!key) throw new HttpsError('invalid-argument', 'Choose a model.');
    await db.doc(`market/${key}`).set({ active: false }, { merge: true });
    return { key, active: false };
  }
  const title = String(data.title || '').trim().slice(0, 120);
  if (title.length < 3) throw new HttpsError('invalid-argument', 'Enter a brand and model to watch.');
  const condition = data.condition === 'For Parts' ? 'For Parts' : 'Good';
  const key = market.marketKey(title, data.specs || '', condition);
  const query = market.marketQuery(title, data.specs || '');
  const count = (await db.collection('market').where('active', '==', true).get()).size;
  if (count >= MARKET_MAX_MODELS) throw new HttpsError('resource-exhausted', `Watching ${MARKET_MAX_MODELS} models already. Remove one first.`);
  const ref = db.doc(`market/${key}`);
  await ref.set({ key, label: query, query, title, specs: String(data.specs || ''), group: market.condGroup(condition), category: market.ebayCategory(String(data.category || ''), title), auto: false, active: true, addedAt: new Date().toISOString() }, { merge: true });
  const token = await ebayToken();
  const snap = await ref.get();
  const result = await collectModel(token, ref, snap.data());
  return { key, ...result };
}));

// Fix how a model is matched on eBay (choose eBay's Model / Storage / Network), or go back to automatic.
exports.ebayMarketMatch = onCall({ secrets: EBAY_SECRETS, timeoutSeconds: 120 }, logged('ebayMarketMatch', async request => {
  await memberFor(request);
  const data = request.data || {};
  const key = String(data.key || '');
  const ref = db.doc(`market/${key}`);
  const snap = await ref.get();
  if (!key || !snap.exists) throw new HttpsError('not-found', 'Model not found.');
  const doc = snap.data();
  const token = await ebayToken();
  let match;
  if (data.reset) match = await resolveMatch(token, doc);
  else {
    const clean = v => String(v || '').trim().slice(0, 80);
    match = { ...(doc.match || {}), model: clean(data.model), storage: clean(data.storage), network: clean(data.network), mpn: clean(data.mpn).toUpperCase(), source: 'manual', at: new Date().toISOString() };
    match.detail = market.detailScore(match);
  }
  await ref.set({ match }, { merge: true });
  const result = await collectModel(token, ref, { ...doc, match });
  return { key, ...result };
}));

// eBay requires production apps to accept account-deletion notices. The Vault keeps no
// eBay user data, so it only answers eBay's endpoint check and acknowledges each notice.
exports.ebayAccountDeletion = onRequest({ secrets: [EBAY_VERIFICATION_TOKEN], invoker: 'public' }, async (req, res) => {
  // Must be exactly the URL entered in the eBay developer portal: eBay hashes it.
  const endpoint = EBAY_DELETION_ENDPOINT;
  if (req.method === 'GET' && req.query.challenge_code) {
    const challengeResponse = market.ebayChallengeResponse(req.query.challenge_code, EBAY_VERIFICATION_TOKEN.value().trim(), endpoint);
    return res.status(200).json({ challengeResponse });
  }
  if (req.method === 'POST') return res.status(204).send('');
  return res.status(400).send('Bad request');
});


// ── Photo cleanup (1st and 15th of each month) ────────────────────
// Frees Firebase Storage without losing photos. See functions/photos.js for the rules.
async function runPhotoCleanup({ dryRun }) {
  const now = Date.now();
  const settingsSnap = await db.doc('meta/settings').get();
  const cfg = ((settingsSnap.exists && settingsSnap.data().photoCleanup) || {});
  const soldDays = Number(cfg.soldDays) || 30;
  const bucket = getStorage().bucket();
  const report = { at: new Date(now).toISOString(), dryRun: !!dryRun, soldDays, swapped: [], deleted: [], orphans: 0, files: 0, bytes: 0, skipped: [], errors: [] };

  const itemsSnap = await db.collection('items').get();
  const referenced = new Set();
  const plans = [];
  itemsSnap.forEach(d => {
    const item = d.data();
    for (const u of ((item.packet || {}).photos || [])) { const p = photos.storagePath(u); if (p) referenced.add(p); }
    const plan = photos.planItem(item, now, { soldDays });
    if (plan.action !== 'keep') plans.push({ code: d.id, ref: d.ref, item, plan });
  });

  const fileSize = async path => { try { const [m] = await bucket.file(path).getMetadata(); return Number(m.size) || 0; } catch (e) { return 0; } };
  const removeFiles = async urls => {
    for (const u of urls) {
      const path = photos.storagePath(u); if (!path) continue;
      report.files++; report.bytes += await fileSize(path);
      if (!dryRun) await bucket.file(path).delete({ ignoreNotFound: true });
    }
  };

  // Items whose photos are on Shopify: confirm Shopify's copies are READY, switch to them, then delete ours.
  const swaps = plans.filter(p => p.plan.action === 'swap');
  let connection = null;
  if (swaps.length) { try { connection = await shopifyToken(); } catch (e) { report.errors.push(`Shopify: ${e.message}`); } }
  for (const { code, ref, item, plan } of swaps) {
    if (!connection) { report.skipped.push(`${code}: Shopify unavailable`); continue; }
    try {
      const data = await shopifyGraphql(connection, `query Media($id: ID!) { product(id: $id) { media(first: 50) { nodes { ... on MediaImage { status image { url } } } } } }`, { id: plan.shopifyId });
      const copies = data.product ? photos.shopifyCopies(data.product.media.nodes, plan.photos.length) : null;
      if (!copies) { report.skipped.push(`${code}: Shopify copies not ready`); continue; }
      const keep = ((item.packet || {}).photos || []).filter(u => !photos.isFirebasePhoto(u) && !copies.includes(u));
      const next = [...copies, ...keep].slice(0, 12);
      if (!dryRun) await ref.set({ packet: { photos: next, shopifyMediaSent: FieldValue.arrayUnion(...copies), photosOnShopifyAt: report.at } }, { merge: true });
      await removeFiles(plan.photos);
      report.swapped.push(code);
    } catch (e) { report.errors.push(`${code}: ${e.message}`); }
  }

  // Sold / archived long enough, not on Shopify.
  for (const { code, ref, item, plan } of plans.filter(p => p.plan.action === 'delete')) {
    try {
      const rest = ((item.packet || {}).photos || []).filter(u => !photos.isFirebasePhoto(u));
      if (!dryRun) await ref.set({ packet: { photos: rest, photosPurged: plan.photos.length, photosPurgedAt: report.at } }, { merge: true });
      await removeFiles(plan.photos);
      report.deleted.push(code);
    } catch (e) { report.errors.push(`${code}: ${e.message}`); }
  }

  // Files nothing points to.
  try {
    const [files] = await bucket.getFiles({ prefix: 'photos/' });
    const orphans = photos.orphanFiles(files.map(f => ({ name: f.name, created: f.metadata.timeCreated, size: Number(f.metadata.size) || 0 })), referenced, now);
    for (const f of orphans) { report.files++; report.bytes += f.size; if (!dryRun) await bucket.file(f.name).delete({ ignoreNotFound: true }); }
    report.orphans = orphans.length;
  } catch (e) { report.errors.push(`Listing files: ${e.message}`); }

  report.swapped = report.swapped.slice(0, 200);
  report.deleted = report.deleted.slice(0, 200);
  report.skipped = report.skipped.slice(0, 50);
  await db.doc(dryRun ? 'meta/photoCleanupPreview' : 'meta/photoCleanup').set(report);
  if (!dryRun) {
    await appendActivity({ type: 'SYS', verb: 'cleaned up photo storage', code: 'PHOTOS', obj: '', detail: `${report.files} files · ${(report.bytes / 1e6).toFixed(1)} MB freed · ${report.swapped.length} items now use Shopify's copies · ${report.deleted.length} sold/archived · ${report.orphans} orphans` });
  }
  if (report.errors.length) await writeSyslog('warn', 'photoCleanup', `Photo cleanup finished with ${report.errors.length} problem(s).`, report.errors.join('\n'));
  return report;
}

exports.photoCleanupScheduled = onSchedule({ schedule: '17 4 1,15 * *', timeZone: 'America/New_York', secrets: [SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET], timeoutSeconds: 540, memory: '512MiB' }, async () => {
  const settingsSnap = await db.doc('meta/settings').get();
  const cfg = ((settingsSnap.exists && settingsSnap.data().photoCleanup) || {});
  if (cfg.enabled === false) return;
  try { await runPhotoCleanup({ dryRun: false }); }
  catch (error) { await logServerError('photoCleanupScheduled', error, null); throw error; }
});

// Settings → Photo cleanup: "Preview" (nothing deleted) or "Run now". Owners only.
exports.photoCleanupRun = onCall({ secrets: [SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET], timeoutSeconds: 540, memory: '512MiB' }, logged('photoCleanupRun', async request => {
  await ownerFor(request);
  const report = await runPhotoCleanup({ dryRun: !(request.data && request.data.run === true) });
  return { ...report, mb: +(report.bytes / 1e6).toFixed(1) };
}));

// ── eBay direct selling (Sell Inventory API) ─────────────────────────
// The seller account that signs in (Settings → Connect eBay) authorizes the Vault; every listing is
// made as that account. Tokens live in private/ebaySeller, which the app itself can never read.
const ebaysell = require('./ebaysell');
const EBAY_AUTH_CALLBACK = 'https://us-east1-obsidian-vault-38dfd.cloudfunctions.net/ebaySellerAuthCallback';
const EBAY_APP_URL = 'https://yartproductions.github.io/TheVault/';
const ebayEnv = () => 'production';
const ebayBasic = () => Buffer.from(`${EBAY_CLIENT_ID.value().trim()}:${EBAY_CLIENT_SECRET.value().trim()}`).toString('base64');

async function ebaySettings() {
  const snap = await db.doc('meta/settings').get();
  return ((snap.exists && snap.data()) || {}).ebay || {};
}

async function ebayTokenRequest(params) {
  const response = await fetch(`${ebaysell.ENV[ebayEnv()].api}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${ebayBasic()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpsError('failed-precondition', `eBay sign-in failed: ${json.error_description || json.error || response.status}. Connect eBay again in Settings.`);
  return json;
}

// A fresh user token for the connected seller (access tokens last 2 hours; refresh tokens about 18 months).
async function ebayUserToken() {
  const ref = db.doc('private/ebaySeller');
  const snap = await ref.get();
  const s = snap.exists ? snap.data() : null;
  if (!s || !s.refreshToken) throw new HttpsError('failed-precondition', 'eBay isn’t connected. Press Connect eBay in Settings.');
  if (s.accessToken && Date.now() < (s.accessExpiresAt || 0) - 60000) return s.accessToken;
  const json = await ebayTokenRequest({ grant_type: 'refresh_token', refresh_token: s.refreshToken, scope: ebaysell.SCOPES.join(' ') });
  await ref.set({ accessToken: json.access_token, accessExpiresAt: Date.now() + (json.expires_in || 7200) * 1000 }, { merge: true });
  return json.access_token;
}

// Calls a Sell API as the connected seller; eBay's own error text comes back to the app.
async function ebaySell(method, apiPath, body) {
  const token = await ebayUserToken();
  const response = await fetch(`${ebaysell.ENV[ebayEnv()].api}${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Language': 'en-US', 'Accept-Language': 'en-US', 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch (e) { return { raw: text }; } })() : {};
  if (!response.ok) {
    const errs = (json.errors || []).map(e => e.longMessage || e.message).filter(Boolean);
    const err = new HttpsError('failed-precondition', `eBay: ${errs.join(' · ') || `HTTP ${response.status}`}`);
    err.ebayErrors = json.errors || [];
    err.status = response.status;
    throw err;
  }
  return json;
}

// Settings → Connect eBay: the sign-in link for eBay's own consent page.
exports.ebaySellerAuthStart = onCall({ secrets: EBAY_SECRETS }, logged('ebaySellerAuthStart', async request => {
  await ownerFor(request);
  const s = await ebaySettings();
  if (!s.ruName) throw new HttpsError('failed-precondition', 'Paste your eBay RuName in Settings → eBay first.');
  const state = require('crypto').randomBytes(16).toString('hex');
  await db.doc('private/ebayAuthState').set({ state, uid: request.auth.uid, at: Date.now() });
  return { url: ebaysell.consentUrl(ebayEnv(), EBAY_CLIENT_ID.value().trim(), s.ruName, state) };
}));

// eBay sends the seller back here after they approve; the code is swapped for tokens.
exports.ebaySellerAuthCallback = onRequest({ secrets: EBAY_SECRETS, invoker: 'public' }, async (req, res) => {
  const back = (q) => res.redirect(302, `${EBAY_APP_URL}?${new URLSearchParams(q).toString()}#/settings`);
  try {
    const { code, state } = req.query;
    const st = (await db.doc('private/ebayAuthState').get()).data() || {};
    if (!code) return back({ ebay: 'declined' });
    if (!state || state !== st.state || Date.now() - (st.at || 0) > 15 * 60000) return back({ ebay: 'expired' });
    const s = await ebaySettings();
    const json = await ebayTokenRequest({ grant_type: 'authorization_code', code: String(code), redirect_uri: s.ruName });
    let seller = '';
    try {
      const u = await fetch('https://apiz.ebay.com/commerce/identity/v1/user/', { headers: { Authorization: `Bearer ${json.access_token}` } });
      if (u.ok) seller = (await u.json()).username || '';
    } catch (e) {}
    await db.doc('private/ebaySeller').set({
      refreshToken: json.refresh_token, refreshExpiresAt: Date.now() + (json.refresh_token_expires_in || 0) * 1000,
      accessToken: json.access_token, accessExpiresAt: Date.now() + (json.expires_in || 7200) * 1000,
      connectedBy: st.uid || '', connectedAt: new Date().toISOString(), seller
    });
    await db.doc('private/ebayAuthState').delete();
    await db.doc('meta/settings').set({ ebay: { connected: true, seller, connectedAt: new Date().toISOString() } }, { merge: true });
    await appendActivity({ type: 'SYS', verb: 'connected eBay seller', code: 'EBAY', obj: seller || 'eBay account', detail: 'Direct listing enabled' });
    return back({ ebay: 'connected' });
  } catch (error) {
    await writeSyslog('error', 'ebaySellerAuthCallback', `eBay connect failed: ${error.message}`, '');
    return back({ ebay: 'error' });
  }
});

exports.ebaySellerDisconnect = onCall({}, logged('ebaySellerDisconnect', async request => {
  await ownerFor(request);
  await db.doc('private/ebaySeller').delete();
  await db.doc('meta/settings').set({ ebay: { connected: false, seller: '' } }, { merge: true });
  return { ok: true };
}));

// Settings: the seller's business policies and locations, and saving the ship-from location.
exports.ebaySellerSetup = onCall({ secrets: EBAY_SECRETS, timeoutSeconds: 60 }, logged('ebaySellerSetup', async request => {
  await ownerFor(request);
  const d = request.data || {};
  if (d.action === 'location') {
    const a = d.address || {};
    if (!a.postalCode || !a.city || !a.stateOrProvince) throw new HttpsError('invalid-argument', 'Enter the city, state and ZIP code you ship from.');
    const key = 'vault-main';
    try {
      await ebaySell('POST', `/sell/inventory/v1/location/${key}`, { location: { address: { city: a.city, stateOrProvince: a.stateOrProvince, postalCode: a.postalCode, country: 'US', ...(a.addressLine1 ? { addressLine1: a.addressLine1 } : {}) } }, locationTypes: ['WAREHOUSE'], merchantLocationStatus: 'ENABLED', name: 'Vault ship-from' });
    } catch (error) {
      if (!(error.ebayErrors || []).some(e => e.errorId === 25803)) throw error; // 25803: already exists
      await ebaySell('POST', `/sell/inventory/v1/location/${key}/update_location_details`, { location: { address: { city: a.city, stateOrProvince: a.stateOrProvince, postalCode: a.postalCode, country: 'US' } } });
    }
    await db.doc('meta/settings').set({ ebay: { locationKey: key, location: `${a.city}, ${a.stateOrProvince} ${a.postalCode}` } }, { merge: true });
    return { locationKey: key };
  }
  const get = async kind => {
    try { const r = await ebaySell('GET', `/sell/account/v1/${kind}_policy?marketplace_id=EBAY_US`); return r[`${kind}Policies`] || []; }
    catch (error) { if ((error.ebayErrors || []).some(e => e.errorId === 20403)) throw new HttpsError('failed-precondition', 'This eBay account isn’t set up for business policies yet. In eBay: Account settings → Business policies → opt in, then create shipping, payment and return policies.'); throw error; }
  };
  const [fulfillment, payment, returns] = await Promise.all([get('fulfillment'), get('payment'), get('return')]);
  const pick = (list, idKey) => list.map(p => ({ id: String(p[idKey]), name: p.name, ...(p.returnsAccepted != null ? { returnsAccepted: !!p.returnsAccepted } : {}) }));
  return { fulfillment: pick(fulfillment, 'fulfillmentPolicyId'), payment: pick(payment, 'paymentPolicyId'), returns: pick(returns, 'returnPolicyId') };
}));

// The item's eBay category and required item details, filled from the listing where possible.
async function ebayCategoryAndAspects(item, packet) {
  const gen = packet.generated;
  const appToken = await ebayToken();
  let category = packet.ebayCategoryId ? { id: String(packet.ebayCategoryId), name: packet.ebayCategoryName || '' } : null;
  if (!category && gen && gen.title) category = await suggestCategory(appToken, gen.title);
  if (!category && gen && gen.ebay && gen.ebay.ebay_category_id) category = { id: String(gen.ebay.ebay_category_id), name: '' };
  if (!category) throw new HttpsError('failed-precondition', 'Couldn’t find an eBay category for this item. Write the listing first, or set the eBay category ID on the packet.');
  const r = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${encodeURIComponent(category.id)}`, { headers: { Authorization: `Bearer ${appToken}` } });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpsError('failed-precondition', `eBay couldn’t list the details for category ${category.id}${json.errors ? `: ${json.errors.map(e => e.message).join(' · ')}` : ''}. It may not be a leaf category — set a more specific category ID.`);
  return { category, ...ebaysell.fillAspects(json.aspects || [], gen, packet.ebayAspects || {}) };
}

exports.ebayDetails = onCall({ secrets: EBAY_SECRETS, timeoutSeconds: 60 }, logged('ebayDetails', async request => {
  await memberFor(request);
  const sku = String((request.data || {}).code || '');
  const snap = await db.doc(`items/${sku}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Item not found.');
  const item = snap.data(); const packet = item.packet || {};
  if (!packet.generated) throw new HttpsError('failed-precondition', 'Write the listing first (step 1) — eBay’s details are filled from it.');
  const d = await ebayCategoryAndAspects(item, packet);
  const settings = await ebaySettings();
  const { inStock } = await resolveUnits(sku, packet, item);
  const problems = ebaysell.readiness({ gen: packet.generated, price: Number(packet.price) || Number(item.resale), photos: packet.photos || [], settings, connected: !!settings.connected, missingAspects: d.missing });
  if (!inStock.length) problems.push('No units in stock for this listing.');
  await snap.ref.set({ packet: { ebayCheck: { at: new Date().toISOString(), categoryId: d.category.id, categoryName: d.category.name, missing: d.missing, filled: d.filled, problems } } }, { merge: true });
  return { category: d.category, missing: d.missing, filled: d.filled, problems };
}));

// Publish (or update) the item on eBay: inventory item → offer → publish. Live as soon as eBay accepts it.
exports.ebayPublish = onCall({ secrets: EBAY_SECRETS, timeoutSeconds: 120 }, logged('ebayPublish', async request => {
  const user = await memberFor(request);
  const sku = String((request.data || {}).code || '');
  const itemRef = db.doc(`items/${sku}`);
  const snap = await itemRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Item not found.');
  const item = snap.data(); const packet = item.packet || {};
  const gen = packet.generated;
  const settings = await ebaySettings();
  const price = Number(packet.price) || 0;
  const d = await ebayCategoryAndAspects(item, packet);
  const problems = ebaysell.readiness({ gen, price, photos: packet.photos || [], settings, connected: !!settings.connected, missingAspects: d.missing });
  if (problems.length) {
    await itemRef.set({ packet: { ebayCheck: { at: new Date().toISOString(), categoryId: d.category.id, categoryName: d.category.name, missing: d.missing, filled: d.filled, problems } } }, { merge: true });
    throw new HttpsError('failed-precondition', `Not ready for eBay: ${problems.join(' ')}`);
  }
  const { units, inStock } = await resolveUnits(sku, packet, item);
  if (!inStock.length) throw new HttpsError('failed-precondition', 'No units in stock for this listing.');
  const policies = { fulfillment: settings.fulfillmentPolicyId, payment: settings.paymentPolicyId, returns: (gen.ebay || {}).ebay_returns_accepted === 'No' && settings.noReturnPolicyId ? settings.noReturnPolicyId : settings.returnPolicyId };
  const descriptionHtml = ebaysell.descriptionHtml(gen, { photos: packet.photos || [], standardWear: true });

  await ebaySell('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, ebaysell.inventoryItem({ gen, quantity: inStock.length, photos: packet.photos || [], aspects: d.aspects, packageInfo: packet.package || null }));
  const offerBody = ebaysell.offer({ sku, categoryId: d.category.id, price, quantity: inStock.length, policies, locationKey: settings.locationKey, descriptionHtml });
  let offerId = (packet.ebay || {}).offerId || '';
  if (!offerId) {
    const existing = await ebaySell('GET', `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=EBAY_US`).catch(() => ({}));
    offerId = ((existing.offers || [])[0] || {}).offerId || '';
  }
  if (offerId) await ebaySell('PUT', `/sell/inventory/v1/offer/${offerId}`, offerBody);
  else offerId = (await ebaySell('POST', '/sell/inventory/v1/offer', offerBody)).offerId;
  let listingId = (packet.ebay || {}).listingId || '';
  const wasLive = (packet.ebay || {}).status === 'ACTIVE' && listingId;
  if (!wasLive) listingId = (await ebaySell('POST', `/sell/inventory/v1/offer/${offerId}/publish`, {})).listingId || listingId;

  const now = new Date().toISOString();
  const ebay = { offerId, listingId, url: ebaysell.listingUrl(ebayEnv(), listingId), status: 'ACTIVE', categoryId: d.category.id, categoryName: d.category.name, quantity: inStock.length, price, publishedAt: (packet.ebay || {}).publishedAt || now, updatedAt: now, seller: settings.seller || '' };
  const batch = db.batch();
  batch.set(itemRef, { packet: { ebay, units, ebayCheck: { at: now, categoryId: d.category.id, categoryName: d.category.name, missing: [], filled: d.filled, problems: [] } } }, { merge: true });
  inStock.forEach(code => batch.set(db.doc(`items/${code}`), code === sku ? { status: 'list', updatedAt: now } : { status: 'list', updatedAt: now, listedIn: sku }, { merge: true }));
  await batch.commit();
  await appendActivity({ type: 'LT', verb: wasLive ? 'updated the eBay listing for' : 'listed on eBay', code: sku, obj: gen.title || item.title || '', detail: `${settings.seller || 'eBay'} · $${price.toFixed(2)} × ${inStock.length}`, links: inStock, from: wasLive ? '' : 'Prepared', to: 'Listed', uid: user.uid });
  return ebay;
}));

// End the eBay listing (units go back to Prepared unless also active on Shopify).
async function ebayEndListing(sku, reason) {
  const itemRef = db.doc(`items/${sku}`);
  const snap = await itemRef.get();
  const item = snap.data() || {}; const packet = item.packet || {};
  const e = packet.ebay || {};
  if (!e.offerId) return { ended: false };
  try { await ebaySell('POST', `/sell/inventory/v1/offer/${e.offerId}/withdraw`, {}); }
  catch (error) { if (error.status !== 404 && !(error.ebayErrors || []).some(x => x.errorId === 25713)) throw error; }
  const now = new Date().toISOString();
  const batch = db.batch();
  batch.set(itemRef, { packet: { ebay: { ...e, status: 'ENDED', endedAt: now, endReason: reason } } }, { merge: true });
  if (reason !== 'sold out' && packet.shopifyStatus !== 'ACTIVE') {
    const { inStock } = await resolveUnits(sku, packet, item);
    inStock.forEach(code => batch.set(db.doc(`items/${code}`), { status: 'prep', updatedAt: now }, { merge: true }));
  }
  await batch.commit();
  return { ended: true };
}
exports.ebayEnd = onCall({ secrets: EBAY_SECRETS, timeoutSeconds: 60 }, logged('ebayEnd', async request => {
  const user = await memberFor(request);
  const sku = String((request.data || {}).code || '');
  const r = await ebayEndListing(sku, 'ended in the Vault');
  await appendActivity({ type: 'LT', verb: 'ended the eBay listing for', code: sku, obj: '', detail: '', uid: user.uid });
  return r;
}));

// Keeps eBay's quantity equal to the Vault's stock; ends the listing at zero.
async function ebaySyncStock(sku) {
  const snap = await db.doc(`items/${sku}`).get();
  if (!snap.exists) return null;
  const item = snap.data(); const packet = item.packet || {}; const e = packet.ebay || {};
  if (!e.offerId || e.status !== 'ACTIVE') return null;
  const { inStock } = await resolveUnits(sku, packet, item);
  if (!inStock.length) return ebayEndListing(sku, 'sold out');
  await ebaySell('POST', '/sell/inventory/v1/bulk_update_price_quantity', { requests: [{ sku, shipToLocationAvailability: { quantity: inStock.length }, offers: [{ offerId: e.offerId, availableQuantity: inStock.length }] }] });
  await snap.ref.set({ packet: { ebay: { ...e, quantity: inStock.length, updatedAt: new Date().toISOString() } } }, { merge: true });
  return { quantity: inStock.length };
}

// Books one eBay order exactly once (marker ebayOrders/{orderId}), same unit picking as Shopify sales.
async function bookEbayOrder(order, feePct) {
  const lines = ebaysell.orderLines(order);
  if (!lines.length) return { sales: [], skus: [] };
  const orderName = String(order.orderId);
  const buyer = String((order.buyer && order.buyer.username) || '');
  const date = String(order.creationDate || new Date().toISOString()).slice(0, 10);
  return db.runTransaction(async t => {
    const marker = db.doc(`ebayOrders/${order.orderId}`);
    if ((await t.get(marker)).exists) return { sales: [], skus: [], duplicate: true };
    const picks = [];
    for (const l of lines) {
      const mainSnap = await t.get(db.doc(`items/${l.sku}`));
      if (!mainSnap.exists) { picks.push({ ...l, picked: [], reason: 'listing not in the Vault' }); continue; }
      const main = mainSnap.data();
      const units = [{ code: l.sku, ...main }];
      for (const code of listingUnits(l.sku, (main.packet || {}).units).filter(c => c !== l.sku)) {
        const u = await t.get(db.doc(`items/${code}`));
        if (u.exists && (!u.data().listedIn || u.data().listedIn === l.sku)) units.push({ code, ...u.data() });
      }
      const taken = new Set(picks.flatMap(p => p.picked));
      const picked = orders.pickUnits(units.filter(u => !taken.has(u.code)), l.qty);
      picks.push({ ...l, picked, units, reason: picked.length < l.qty ? `only ${picked.length} of ${l.qty} in stock` : '' });
    }
    const soldCount = picks.reduce((n, p) => n + p.picked.length, 0);
    const counters = {};
    if (soldCount) for (const k of ['SL', 'TX']) { const c = await t.get(db.doc(`counters/${k}`)); counters[k] = c.exists ? Number(c.data().n) || 0 : 0; }
    const now = new Date().toISOString();
    const sales = [];
    for (const p of picks) {
      const fees = ebaysell.ebayFee(p.price, p.shipping, feePct);
      for (const code of p.picked) {
        const unit = p.units.find(u => u.code === code);
        const sl = `SL-${String(++counters.SL).padStart(4, '0')}`;
        const tx = `TX-${String(++counters.TX).padStart(4, '0')}`;
        const net = +(p.price - fees).toFixed(2);
        const profit = +(net - (Number(unit.cost) || 0)).toFixed(2);
        const sale = { code: sl, txCode: tx, channel: 'eBay', price: p.price, fees, ship: 0, date, order: orderName, tracking: '', buyer };
        t.set(db.doc(`sales/${sl}`), { ...sale, item: code, net, profit, by: 'sys', ebayOrderId: orderName, createdAt: now });
        t.set(db.doc(`items/${code}`), { status: 'sold', sale, updatedAt: now, updatedBy: 'sys' }, { merge: true });
        t.set(db.doc(`txs/${tx}`), { code: tx, date, desc: `Sale ${sl} · ${unit.title || code}`, amount: net, category: 'Sales', method: 'Payout', by: 'sys', payee: buyer, ref: orderName, link: sl, tags: 'eBay', notes: `eBay order ${orderName}: price ${p.price.toFixed(2)} − est. fees ${fees.toFixed(2)} (buyer paid shipping ${p.shipping.toFixed(2)})`, createdAt: now });
        sales.push({ sl, tx, code, title: unit.title || code, price: p.price, profit, from: unit.status });
      }
    }
    if (soldCount) for (const k of ['SL', 'TX']) t.set(db.doc(`counters/${k}`), { n: counters[k] });
    t.set(marker, { date, buyer, sales: sales.map(x => x.sl), items: sales.map(x => x.code), problems: picks.filter(p => p.reason).map(p => ({ sku: p.sku, qty: p.qty, reason: p.reason })), receivedAt: now });
    return { sales, skus: [...new Set(picks.filter(p => p.picked.length).map(p => p.sku))], problems: picks.filter(p => p.reason) };
  });
}

// Every 10 minutes: new paid eBay orders → Sold in the Vault, then quantities on eBay and Shopify follow.
exports.ebayOrdersPoll = onSchedule({ schedule: 'every 10 minutes', timeZone: 'America/New_York', secrets: [...EBAY_SECRETS, SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET], timeoutSeconds: 300 }, async () => {
  const settings = await ebaySettings();
  if (!settings.connected) return;
  const stateRef = db.doc('private/ebayPoll');
  const last = ((await stateRef.get()).data() || {}).since || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const since = new Date(Date.parse(last) - 3600 * 1000).toISOString(); // overlap an hour; markers keep it exactly-once
  const startedAt = new Date().toISOString();
  const s = (await db.doc('meta/settings').get()).data() || {};
  try {
    let next = `/sell/fulfillment/v1/order?filter=${encodeURIComponent(`creationdate:[${since}..]`)}&limit=50`;
    const touched = new Set();
    for (let page = 0; next && page < 10; page++) {
      const r = await ebaySell('GET', next);
      for (const order of r.orders || []) {
        const out = await bookEbayOrder(order, s.feePct);
        out.skus.forEach(x => touched.add(x));
        for (const x of out.sales) await appendActivity({ verb: 'recorded eBay sale', code: x.sl, obj: x.title, detail: `eBay ${order.orderId} · $${x.price.toFixed(2)} · net $${x.profit.toFixed(2)}`, links: [x.code, x.tx], from: x.from, to: 'Sold' });
        if ((out.problems || []).length) await writeSyslog('warn', 'ebayOrdersPoll', `eBay order ${order.orderId}: ${out.problems.length} line(s) not matched to Vault stock.`, out.problems.map(p => `${p.sku} ×${p.qty}: ${p.reason}`).join('\n'));
      }
      next = r.next ? r.next.replace(/^https:\/\/api(\.sandbox)?\.ebay\.com/, '') : '';
    }
    for (const sku of touched) {
      await ebaySyncStock(sku).catch(e => writeSyslog('warn', 'ebayOrdersPoll', `Couldn’t update eBay quantity for ${sku}: ${e.message}`, ''));
      const it = (await db.doc(`items/${sku}`).get()).data() || {};
      if ((it.packet || {}).shopifyId) await shopifyToken().then(c => syncListingStock(c, sku)).catch(e => writeSyslog('warn', 'ebayOrdersPoll', `Couldn’t update Shopify quantity for ${sku}: ${e.message}`, ''));
    }
    await stateRef.set({ since: startedAt, lastRunAt: startedAt }, { merge: true });
  } catch (error) {
    await writeSyslog('error', 'ebayOrdersPoll', `eBay order check failed: ${error.message}`, '');
  }
});
