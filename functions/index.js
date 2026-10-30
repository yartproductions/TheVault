const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { HttpsError, onCall } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { vaultSku, listingUnits } = require('./sku');

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

exports.ensureVaultMembership = onCall(async request => {
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
});

// Firebase Auth errors otherwise reach the Vault as a bare "internal" error.
function explainAuthError(error, step) {
  const code = String(error && (error.code || error.errorInfo && error.errorInfo.code) || '');
  const raw = String(error && error.message || '');
  console.error(`createVaultMember failed while ${step}:`, code, raw);
  if (error instanceof HttpsError) return error;
  if (/unauthorized-continue-uri|invalid-continue-uri|domain/i.test(code + raw))
    return new HttpsError('failed-precondition', 'Firebase blocked the setup link. In Firebase → Authentication → Settings → Authorized domains, add yartproductions.github.io.');
  if (/insufficient-permission|permission|PERMISSION_DENIED|403/i.test(code + raw))
    return new HttpsError('failed-precondition', 'The Vault backend is not allowed to manage logins. In Google Cloud → IAM, give the functions service account the "Firebase Authentication Admin" role.');
  if (/operation-not-allowed|CONFIGURATION_NOT_FOUND/i.test(code + raw))
    return new HttpsError('failed-precondition', 'Email/Password sign-in is turned off. Turn it on in Firebase → Authentication → Sign-in method.');
  if (/email-already-exists/i.test(code)) return new HttpsError('already-exists', 'That email already has a login. Try adding it again.');
  if (/invalid-email/i.test(code)) return new HttpsError('invalid-argument', 'Enter a valid email address.');
  if (/too-many|quota|RESOURCE_EXHAUSTED/i.test(code + raw)) return new HttpsError('resource-exhausted', 'Firebase is rate-limiting new accounts. Wait a few minutes and try again.');
  return new HttpsError('internal', `Could not add the account while ${step}: ${code || raw || 'unknown error'}`);
}

exports.createVaultMember = onCall(async request => {
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
});

exports.setVaultMemberActive = onCall(async request => {
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
});

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

// Works out which physical units a listing covers and checks each is still sellable.
async function resolveUnits(sku, packet) {
  const codes = listingUnits(sku, packet.units);
  const units = [];
  for (const code of codes) {
    const snap = code === sku ? null : await db.doc(`items/${code}`).get();
    if (snap && !snap.exists) continue;
    const data = snap ? snap.data() : null;
    if (data) {
      if (data.status === 'sold' || data.status === 'arch') continue;
      if (data.listedIn && data.listedIn !== sku) continue;
      if (data.packet && data.packet.shopifyId) continue;
    }
    units.push(code);
  }
  return units;
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

exports.shopifySaveDraft = onCall({ secrets: [SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET], timeoutSeconds: 60 }, async request => {
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
  const units = await resolveUnits(sku, packet);
  const quantity = units.length;

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
});

exports.shopifyActivate = onCall({ secrets: [SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET], timeoutSeconds: 60 }, async request => {
  await memberFor(request);
  const sku = vaultSku(request.data && request.data.code);
  const itemRef = db.doc(`items/${sku}`);
  const itemSnap = await itemRef.get();
  if (!itemSnap.exists) throw new HttpsError('not-found', 'Vault item not found.');
  const item = itemSnap.data();
  const packet = item.packet || {};
  if (!packet.shopifyId) throw new HttpsError('failed-precondition', 'Create the Shopify draft first.');
  if (item.status === 'sold' || item.status === 'arch') throw new HttpsError('failed-precondition', 'This item is no longer in stock.');
  const units = await resolveUnits(sku, packet);

  const connection = await shopifyToken();
  if (packet.shopifyInventoryItemId) await setAvailable(connection, packet.shopifyInventoryItemId, units.length);
  const data = await shopifyGraphql(connection,
    `mutation ActivateProduct($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }`,
    { product: { id: packet.shopifyId, status: 'ACTIVE' } });
  const product = checkUserErrors(data.productUpdate).product;

  // Only after Shopify confirms do the Vault records move to Listed.
  const now = new Date().toISOString();
  const batch = db.batch();
  units.forEach(code => batch.set(db.doc(`items/${code}`), code === sku
    ? { status: 'list', updatedAt: now, packet: { shopifyStatus: product.status, shopifyQty: units.length, units, shopifyActivatedAt: FieldValue.serverTimestamp() } }
    : { status: 'list', updatedAt: now, listedIn: sku }, { merge: true }));
  await batch.commit();
  return { id: product.id, status: product.status, quantity: units.length, units };
});
