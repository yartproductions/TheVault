// Direct eBay selling (Sell Inventory API). Pure helpers — no network, no Firebase — tested in ebaysell.test.js.
// The Vault's generated listing (listing.js) already carries eBay's condition code, category and specs;
// this module turns it into the Inventory API's inventory item + offer, and fills eBay's item details.

const fs = require('fs');
const path = require('path');
const listing = require('./listing');

const ENV = {
  production: { api: 'https://api.ebay.com', auth: 'https://auth.ebay.com', web: 'https://www.ebay.com' },
  sandbox: { api: 'https://api.sandbox.ebay.com', auth: 'https://auth.sandbox.ebay.com', web: 'https://www.sandbox.ebay.com' }
};
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly'
];

// eBay's numeric condition IDs → Inventory API condition values.
const CONDITION_ENUM = {
  '1000': 'NEW', '1500': 'NEW_OTHER', '1750': 'NEW_WITH_DEFECTS', '2000': 'CERTIFIED_REFURBISHED',
  '2010': 'EXCELLENT_REFURBISHED', '2020': 'VERY_GOOD_REFURBISHED', '2030': 'GOOD_REFURBISHED', '2500': 'SELLER_REFURBISHED',
  '2750': 'LIKE_NEW', '3000': 'USED_EXCELLENT', '4000': 'USED_VERY_GOOD', '5000': 'USED_GOOD', '6000': 'USED_ACCEPTABLE',
  '7000': 'FOR_PARTS_OR_NOT_WORKING'
};
const conditionFor = gen => CONDITION_ENUM[String(((gen || {}).ebay || {}).ebay_condition_code || '3000')] || 'USED_EXCELLENT';

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// The Vault's spec labels / metafield keys that answer each common eBay item detail.
const SYNONYMS = {
  'brand': ['brand', 'manufacturer', 'make'],
  'mpn': ['mpn', 'part number', 'model number', 'manufacturer part number', 'pn'],
  'model': ['model', 'model name', 'product model'],
  'storage capacity': ['storage capacity', 'capacity', 'storage', 'hard drive capacity', 'ssd capacity'],
  'capacity per module': ['capacity per module', 'module capacity', 'capacity'],
  'total capacity': ['total capacity', 'ram', 'memory', 'capacity'],
  'ram size': ['ram size', 'ram', 'memory'],
  'form factor': ['form factor', 'size'],
  'interface': ['interface', 'connection', 'connectivity'],
  'type': ['type', 'drive type', 'memory type'],
  'color': ['color', 'colour'],
  'processor': ['processor', 'cpu'],
  'gpu': ['gpu', 'graphics', 'graphics processing type'],
  'screen size': ['screen size', 'display size', 'display'],
  'network': ['network', 'carrier'],
  'operating system': ['operating system', 'os'],
  'bus speed': ['bus speed', 'speed'],
  'number of modules': ['number of modules', 'modules', 'kit'],
  'rotation speed': ['rotation speed', 'rpm', 'spindle speed'],
  'cache': ['cache', 'buffer'],
  'chipset manufacturer': ['chipset manufacturer', 'gpu brand'],
  'platform': ['platform', 'console'],
  'serial number': ['serial number', 'serial']
};

// Collected answers from the generated listing: spec rows, metafields, then the lister's own eBay details.
function knownDetails(gen, overrides) {
  const out = {};
  const put = (k, v) => { const key = norm(k); const val = String(v == null ? '' : v).trim(); if (key && val && !/^(n\/?a|none|unknown|-)$/i.test(val)) out[key] = val; };
  for (const r of (gen && gen.rows) || []) put(r.label, r.value);
  for (const [k, v] of Object.entries((gen && gen.metafields) || {})) put(k.replace(/_/g, ' '), v);
  for (const [k, v] of Object.entries(overrides || {})) put(k, v);
  return out;
}

function answerFor(aspectName, known, overrides) {
  const exact = Object.entries(overrides || {}).find(([k]) => norm(k) === norm(aspectName));
  if (exact && String(exact[1]).trim()) return String(exact[1]).trim();
  const name = norm(aspectName);
  for (const key of [name, ...(SYNONYMS[name] || [])]) if (known[norm(key)]) return known[norm(key)];
  return '';
}

// eBay's aspect list (Taxonomy getItemAspectsForCategory) → aspects to send + what's still missing.
// Selection-only aspects must use one of eBay's values, so the closest match is picked.
function fillAspects(ebayAspects, gen, overrides) {
  const known = knownDetails(gen, overrides);
  const aspects = {}; const missing = []; const filled = [];
  for (const a of ebayAspects || []) {
    const name = a.localizedAspectName;
    const c = a.aspectConstraint || {};
    const required = !!c.aspectRequired;
    if (!required && c.aspectUsage !== 'RECOMMENDED') continue;
    let value = answerFor(name, known, overrides);
    const allowed = (a.aspectValues || []).map(v => v.localizedValue);
    if (value && c.aspectMode === 'SELECTION_ONLY' && allowed.length) {
      const v = norm(value);
      value = allowed.find(x => norm(x) === v) || allowed.find(x => norm(x).includes(v) || v.includes(norm(x))) || '';
    }
    if (value) { aspects[name] = [value.slice(0, 65)]; filled.push({ name, value, required }); }
    else if (required) missing.push({ name, options: c.aspectMode === 'SELECTION_ONLY' ? allowed.slice(0, 40) : [] });
  }
  return { aspects, missing, filled };
}

// Inventory item body: PUT /sell/inventory/v1/inventory_item/{sku}
function inventoryItem({ gen, quantity, photos, aspects, packageInfo }) {
  const condition = conditionFor(gen);
  const body = {
    availability: { shipToLocationAvailability: { quantity: Math.max(0, Number(quantity) || 0) } },
    condition,
    product: {
      title: String(gen.title || '').slice(0, 80),
      aspects: aspects || {},
      imageUrls: (photos || []).filter(u => /^https:\/\//.test(u)).slice(0, 24)
    }
  };
  const desc = String(((gen || {}).ebay || {}).ebay_condition_description || '').trim();
  if (desc && condition !== 'NEW') body.conditionDescription = desc.slice(0, 1000);
  // Brand and MPN always travel as a complete pair. eBay files product.brand/product.mpn under its
  // <BrandMPN> tag and refuses the publish ("Input data for tag <BrandMPN> is invalid or missing") when one
  // half is blank, so MPN falls back to "Does Not Apply" and the item details carry the same values.
  const mf = gen.metafields || {};
  const a = body.product.aspects = { ...(aspects || {}) };
  const key = name => Object.keys(a).find(k => k.toLowerCase() === name);
  const first = name => { const k = key(name); return k ? String((a[k] || [])[0] || '').trim() : ''; };
  const brand = (first('brand') || String(mf.brand || '').trim()).slice(0, 65);
  const mpn = (first('mpn') || String(mf.mpn || '').trim() || 'Does Not Apply').slice(0, 65);
  if (brand) {
    a[key('brand') || 'Brand'] = [brand];
    a[key('mpn') || 'MPN'] = [mpn];
    body.product.brand = brand;
    body.product.mpn = mpn;
  }
  if (packageInfo && Number(packageInfo.weightLb) > 0) {
    body.packageWeightAndSize = { weight: { value: Number(packageInfo.weightLb), unit: 'POUND' } };
    if (Number(packageInfo.lengthIn) > 0 && Number(packageInfo.widthIn) > 0 && Number(packageInfo.heightIn) > 0)
      body.packageWeightAndSize.dimensions = { length: Number(packageInfo.lengthIn), width: Number(packageInfo.widthIn), height: Number(packageInfo.heightIn), unit: 'INCH' };
  }
  return body;
}

// Offer body: POST /sell/inventory/v1/offer (or PUT /offer/{id}).
function offer({ sku, categoryId, price, quantity, policies, locationKey, descriptionHtml }) {
  return {
    sku,
    marketplaceId: 'EBAY_US',
    format: 'FIXED_PRICE',
    availableQuantity: Math.max(0, Number(quantity) || 0),
    categoryId: String(categoryId),
    listingDescription: descriptionHtml,
    listingPolicies: { fulfillmentPolicyId: policies.fulfillment, paymentPolicyId: policies.payment, returnPolicyId: policies.returns },
    pricingSummary: { price: { value: Number(price).toFixed(2), currency: 'USD' } },
    merchantLocationKey: locationKey
  };
}

// What still stops a publish, in plain words.
function readiness({ gen, price, photos, settings, connected, missingAspects }) {
  const problems = [];
  if (!connected) problems.push('Connect eBay in Settings first.');
  if (!gen) problems.push('Write the listing first (step 1).');
  if (!(Number(price) > 0)) problems.push('Set a price.');
  if (!(photos || []).some(u => /^https:\/\//.test(u))) problems.push('Add at least one photo.');
  const s = settings || {};
  if (!s.fulfillmentPolicyId || !s.paymentPolicyId || !s.returnPolicyId) problems.push('Pick your eBay shipping, payment and return policies in Settings.');
  if (!s.locationKey) problems.push('Save your ship-from location in Settings.');
  for (const m of missingAspects || []) problems.push(`eBay needs “${m.name}”.`);
  return problems;
}

// ── Description: the Gadget Flippers template with the Vault's report inside ──
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'ebay-template.html'), 'utf8');
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function descriptionHtml(gen, { photos = [], standardWear = true, title } = {}) {
  const ok = (photos || []).filter(u => /^https:\/\//.test(u));
  const noReturns = (((gen || {}).ebay || {}).ebay_returns_accepted) === 'No';
  const gallery = ok.length > 1
    ? `<div class="gf-card gf-gallery" style="box-sizing:border-box;margin:24px 24px 0;overflow:hidden;background:#0e2c20;border:1px solid rgba(255,255,255,.1);border-radius:14px;display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:20px">${ok.slice(1, 13).map(u => `<img alt="Additional product photo" src="${escAttr(u)}" style="box-sizing:border-box;display:block;width:100%;height:160px;object-fit:contain;background:#08201a;border:1px solid rgba(255,255,255,.1);border-radius:10px"/>`).join('')}</div>`
    : '';
  const fills = {
    '{{TITLE}}': escText(title || gen.title || ''),
    '{{PHOTO}}': ok[0] ? `<img alt="Product photo" class="gf-z" src="${escAttr(ok[0])}" style="box-sizing:border-box;position:relative;z-index:1;display:block;max-width:100%;width:auto;height:auto;max-height:340px;border-radius:8px"/>` : '',
    '{{REPORT}}': listing.renderHtml(gen, { standardWear }),
    '{{GALLERY}}': gallery,
    '{{RETURNS_FACT}}': noReturns ? 'eBay buyer protection' : 'Returns accepted',
    '{{RETURNS_PILL}}': noReturns ? 'eBay buyer protection' : 'Returns accepted',
    '{{RETURNS_TEXT}}': noReturns ? 'Seller does not accept discretionary returns. eBay buyer protections may still apply.' : 'Returns accepted within 30 days; buyer pays return shipping. See the listing’s return policy for full terms.'
  };
  let html = TEMPLATE;
  for (const [k, v] of Object.entries(fills)) html = html.split(k).join(v);
  return html;
}

// ── Orders (Fulfillment API getOrders) ──
// Paid, not cancelled, with Vault SKUs → [{ sku, qty, price, shipping }] per line (price per unit).
function orderLines(order) {
  const o = order || {};
  if (o.orderPaymentStatus && !/PAID/i.test(o.orderPaymentStatus)) return [];
  if (o.cancelStatus && /CANCELED|IN_PROGRESS/i.test(o.cancelStatus.cancelState || '')) return [];
  return (o.lineItems || []).map(l => {
    const qty = Math.max(0, Number(l.quantity) || 0);
    const total = Number((l.lineItemCost || {}).value) || 0;
    const ship = Number(((l.deliveryCost || {}).shippingCost || {}).value) || 0;
    return { sku: String(l.sku || '').trim(), qty, price: qty ? +(total / qty).toFixed(2) : 0, shipping: qty ? +(ship / qty).toFixed(2) : 0, lineItemId: l.lineItemId };
  }).filter(l => l.sku && l.qty);
}
const ebayFee = (price, shipping, feePct) => +(((Number(price) || 0) + (Number(shipping) || 0)) * (Number(feePct) || 13.25) / 100 + 0.30).toFixed(2);

const listingUrl = (env, listingId) => listingId ? `${(ENV[env] || ENV.production).web}/itm/${listingId}` : '';
const consentUrl = (env, clientId, ruName, state) => `${(ENV[env] || ENV.production).auth}/oauth2/authorize?` + new URLSearchParams({ client_id: clientId, redirect_uri: ruName, response_type: 'code', scope: SCOPES.join(' '), state, prompt: 'login' }).toString();

module.exports = { ENV, SCOPES, CONDITION_ENUM, conditionFor, knownDetails, fillAspects, inventoryItem, offer, readiness, descriptionHtml, orderLines, ebayFee, listingUrl, consentUrl };
