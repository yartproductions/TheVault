const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { HttpsError, onCall, onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { vaultSku, listingUnits } = require('./sku');
const orders = require('./orders');

initializeApp();
setGlobalOptions({ region: 'us-east1', maxInstances: 5 });

const db = getFirestore();
const auth = getAuth();
const BOOTSTRAP_OWNERS = new Set(['paulckinckay@gmail.com', 'kohlindersjohn@gmail.com']);
const SHOPIFY_SHOP = defineSecret('SHOPIFY_SHOP');
const SHOPIFY_CLIENT_ID = defineSecret('SHOPIFY_CLIENT_ID');
const SHOPIFY_CLIENT_SECRET = defineSecret('SHOPIFY_CLIENT_SECRET');

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
      throw error;
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

exports.shopifySaveDraft = onCall({ secrets: [SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET], timeoutSeconds: 60 }, logged('shopifySaveDraft', async request => {
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

  const connection = await shopifyToken();
  const productInput = {
    title,
    descriptionHtml: String(packet.description || item.defect || '').split(/\n{2,}/).map(p => `<p>${p.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])).replace(/\n/g, '<br>')}</p>`).join(''),
    productType: String(item.category || 'Other'),
    vendor: title.split(/\s+/)[0],
    tags: ['obsidian-vault', sku],
    metafields: [{ namespace: 'custom', key: 'vault_record', type: 'single_line_text_field', value: sku }]
  };
  const media = (packet.photos || []).filter(url => /^https:\/\//i.test(url)).slice(0, 12).map((url, index) => ({
    originalSource: url,
    alt: `${title} photo ${index + 1}`,
    mediaContentType: 'IMAGE'
  }));

  let product;
  if (packet.shopifyId) {
    productInput.id = packet.shopifyId;
    const data = await shopifyGraphql(connection,
      `mutation UpdateProduct($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id handle status variants(first: 1) { nodes { id inventoryItem { id } } } } userErrors { field message } } }`,
      { product: productInput });
    product = checkUserErrors(data.productUpdate).product;
  } else {
    productInput.status = 'DRAFT';
    const data = await shopifyGraphql(connection,
      `mutation CreateProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) { productCreate(product: $product, media: $media) { product { id handle status variants(first: 1) { nodes { id inventoryItem { id } } } } userErrors { field message } } }`,
      { product: productInput, media });
    product = checkUserErrors(data.productCreate).product;
  }

  const variant = product.variants.nodes[0];
  const variantData = await shopifyGraphql(connection,
    `mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id inventoryItem { id sku tracked } } userErrors { field message } } }`,
    { productId: product.id, variants: [{ id: variant.id, price: price.toFixed(2), inventoryPolicy: 'DENY', inventoryItem: { sku, tracked: true, requiresShipping: true } }] });
  checkUserErrors(variantData.productVariantsBulkUpdate);

  // Shopify's quantity always matches the number of Vault units in this listing.
  await setAvailable(connection, variant.inventoryItem.id, quantity);

  const adminUrl = `https://admin.shopify.com/store/${connection.shop}/products/${product.id.split('/').pop()}`;
  const batch = db.batch();
  batch.set(itemRef, { packet: { shopifyId: product.id, shopifyUrl: adminUrl, shopifySku: sku, shopifyStatus: product.status || 'DRAFT', shopifyQty: quantity, shopifyInventoryItemId: variant.inventoryItem.id, units, shopifySyncedAt: FieldValue.serverTimestamp() } }, { merge: true });
  units.filter(code => code !== sku).forEach(code => batch.set(db.doc(`items/${code}`), { listedIn: sku }, { merge: true }));
  await batch.commit();
  return { id: product.id, adminUrl, sku, status: product.status || 'DRAFT', quantity, units };
}));

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
  if (packet.shopifyInventoryItemId) await setAvailable(connection, packet.shopifyInventoryItemId, inStock.length);
  const data = await shopifyGraphql(connection,
    `mutation ActivateProduct($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }`,
    { product: { id: packet.shopifyId, status: 'ACTIVE' } });
  const product = checkUserErrors(data.productUpdate).product;

  // Only after Shopify confirms do the in-stock units move to Listed.
  const now = new Date().toISOString();
  const batch = db.batch();
  batch.set(itemRef, { packet: { shopifyStatus: product.status, shopifyQty: inStock.length, units, shopifyActivatedAt: FieldValue.serverTimestamp() } }, { merge: true });
  inStock.forEach(code => batch.set(db.doc(`items/${code}`), code === sku ? { status: 'list', updatedAt: now } : { status: 'list', updatedAt: now, listedIn: sku }, { merge: true }));
  await batch.commit();
  return { id: product.id, status: product.status, quantity: inStock.length, units: inStock };
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
exports.shopifyOrderWebhook = onRequest({ secrets: [SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET], invoker: 'public', timeoutSeconds: 30 }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('POST only');
  if (!orders.validShopifyHmac(req.rawBody, req.get('X-Shopify-Hmac-Sha256'), SHOPIFY_CLIENT_SECRET.value())) {
    await writeSyslog('warn', 'shopifyOrderWebhook', 'Rejected a webhook with a bad signature.', `topic: ${req.get('X-Shopify-Topic') || '?'}`);
    return res.status(401).send('Bad signature');
  }
  const topic = req.get('X-Shopify-Topic') || '';
  const order = req.body || {};
  if (topic !== 'orders/paid' || !order.id) return res.status(200).send('Ignored');
  if (order.test) return res.status(200).send('Test order ignored');

  try {
    const settingsSnap = await db.doc('meta/settings').get();
    const shipFlat = Number(settingsSnap.exists && settingsSnap.data().shipFlat) || 0;
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
  const existing = await shopifyGraphql(connection,
    `query Hooks { webhookSubscriptions(first: 50, topics: [ORDERS_PAID]) { nodes { id uri } } }`);
  if (existing.webhookSubscriptions.nodes.some(n => n.uri === uri)) return { connected: true, uri, already: true };
  const data = await shopifyGraphql(connection,
    `mutation Subscribe($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id uri } userErrors { field message } } }`,
    { topic: 'ORDERS_PAID', sub: { uri, format: 'JSON' } });
  checkUserErrors(data.webhookSubscriptionCreate);
  return { connected: true, uri };
}));

// ── eBay market collector ────────────────────────────────────────
// Every few hours: for each watched model, snapshot eBay's live fixed-price listings
// (count and price spread), and count listings that left since the last snapshot.
// Only numbers and listing ids are kept, never copies of other people's listings.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const market = require('./market');
const EBAY_CLIENT_ID = defineSecret('EBAY_CLIENT_ID');
const EBAY_CLIENT_SECRET = defineSecret('EBAY_CLIENT_SECRET');
const EBAY_VERIFICATION_TOKEN = defineSecret('EBAY_VERIFICATION_TOKEN');
const EBAY_SECRETS = [EBAY_CLIENT_ID, EBAY_CLIENT_SECRET];
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

async function ebaySearchAll(token, query, category, group) {
  const ids = [];
  const prices = [];
  let total = 0;
  for (let page = 0; page < MARKET_MAX_PAGES; page++) {
    const params = new URLSearchParams({ q: query, filter: market.ebayFilter(group), limit: '200', offset: String(page * 200) });
    if (category) params.set('category_ids', category);
    const response = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' }
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = (json.errors && json.errors[0] && (json.errors[0].longMessage || json.errors[0].message)) || `HTTP ${response.status}`;
      throw new Error(`eBay search failed: ${msg}`);
    }
    total = Number(json.total) || 0;
    for (const s of json.itemSummaries || []) {
      if (s.itemId) ids.push(s.itemId);
      const p = market.landedPrice(s);
      if (p != null) prices.push(p);
    }
    if (!json.itemSummaries || json.itemSummaries.length < 200 || ids.length >= total) break;
  }
  return { total, ids, prices, complete: ids.length >= total };
}

// Builds the watch list from what is in stock: one model per title + storage + condition group.
async function refreshAutoWatchlist() {
  const items = await db.collection('items').where('status', 'in', [...market.IN_STOCK]).get();
  const seen = new Map();
  items.forEach(d => {
    const it = d.data();
    const key = market.marketKey(it.title, it.specs, it.condition);
    if (!key) return;
    const entry = seen.get(key) || { key, label: market.marketQuery(it.title, it.specs), query: market.marketQuery(it.title, it.specs), group: market.condGroup(it.condition), category: market.ebayCategory(it.category, it.title), codes: [] };
    entry.codes.push(d.id);
    seen.set(key, entry);
  });
  const batch = db.batch();
  for (const e of [...seen.values()].slice(0, MARKET_MAX_MODELS)) {
    batch.set(db.doc(`market/${e.key}`), { key: e.key, label: e.label, query: e.query, group: e.group, category: e.category, codes: e.codes.sort(), auto: true, active: true }, { merge: true });
  }
  await batch.commit();
}

async function collectModel(token, ref, doc) {
  const now = new Date().toISOString();
  try {
    const result = await ebaySearchAll(token, doc.query, doc.category, doc.group);
    const stats = market.priceStats(result.prices);
    const canDiff = result.complete && doc.lastComplete && Array.isArray(doc.ids);
    const diff = canDiff ? market.diffListings(doc.ids, result.ids) : { gone: null, added: null };
    const point = { t: now, total: result.total, median: stats.median, p25: stats.p25, gone: diff.gone, added: diff.added };
    const history = [...(doc.history || []), point].slice(-MARKET_HISTORY);
    await ref.set({
      last: { t: now, total: result.total, priced: stats.n, low: stats.low, p25: stats.p25, median: stats.median, p75: stats.p75, high: stats.high, gone: diff.gone, added: diff.added, complete: result.complete },
      history,
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
  await ref.set({ key, label: query, query, group: market.condGroup(condition), category: market.ebayCategory(String(data.category || ''), title), auto: false, active: true, addedAt: new Date().toISOString() }, { merge: true });
  const token = await ebayToken();
  const snap = await ref.get();
  const result = await collectModel(token, ref, snap.data());
  return { key, ...result };
}));

// eBay requires production apps to accept account-deletion notices. The Vault keeps no
// eBay user data, so it only answers eBay's endpoint check and acknowledges each notice.
exports.ebayAccountDeletion = onRequest({ secrets: [EBAY_VERIFICATION_TOKEN], invoker: 'public' }, async (req, res) => {
  const project = process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId;
  const endpoint = `https://us-east1-${project}.cloudfunctions.net/ebayAccountDeletion`;
  if (req.method === 'GET' && req.query.challenge_code) {
    const challengeResponse = market.ebayChallengeResponse(req.query.challenge_code, EBAY_VERIFICATION_TOKEN.value().trim(), endpoint);
    return res.status(200).json({ challengeResponse });
  }
  if (req.method === 'POST') return res.status(204).send('');
  return res.status(400).send('Bad request');
});
