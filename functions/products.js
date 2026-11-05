// Keeping the Vault in step with what happens to a product inside Shopify.
// Pure helpers, tested in products.test.js.

// Shopify webhook bodies are REST-shaped; the Vault stores GraphQL ids.
function productGid(body) {
  const b = body || {};
  if (b.admin_graphql_api_id) return String(b.admin_graphql_api_id);
  return b.id != null ? `gid://shopify/Product/${b.id}` : '';
}

// Packet fields that describe the Shopify product; cleared when the product is gone.
const SHOPIFY_FIELDS = ['shopifyId', 'shopifyUrl', 'shopifySku', 'shopifyStatus', 'shopifyQty', 'shopifyInventoryItemId',
  'shopifyMediaSent', 'shopifyPushedHash', 'shopifyPushedAt', 'shopifyChannels', 'shopifyPublishError', 'shopifySyncedAt',
  'shopifyActivatedAt', 'shopifySavingAt'];

// What each unit's Vault status becomes when Shopify's product status changes.
//   ACTIVE            → Prepared units go to Listed (someone activated it in Shopify)
//   DRAFT / ARCHIVED  → Listed units go back to Prepared
//   DELETED           → Listed units go back to Prepared; the listing keeps its units, so re-creating
//                       the product brings back the same quantity
// Sold and archived units are never touched.
function unitChanges(shopifyStatus, units, mainSku) {
  const status = String(shopifyStatus || '').toUpperCase();
  const out = [];
  for (const u of units || []) {
    if (u.status === 'sold' || u.status === 'arch') continue;
    const change = {};
    if (status === 'ACTIVE' && u.status === 'prep') change.status = 'list';
    if ((status === 'DRAFT' || status === 'ARCHIVED' || status === 'DELETED') && u.status === 'list') change.status = 'prep';
    if (Object.keys(change).length) out.push({ code: u.code, ...change });
  }
  return out;
}

// Shopify's REST status ("active") as the GraphQL value the Vault stores ("ACTIVE").
const restStatus = s => String(s || '').toUpperCase();

module.exports = { productGid, SHOPIFY_FIELDS, unitChanges, restStatus };
