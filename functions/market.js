// Pure helpers for the eBay market collector. No network or Firebase here,
// so everything is covered by market.test.js.
const crypto = require('node:crypto');

const IN_STOCK = new Set(['new', 'proc', 'prep', 'list']);

// Vault condition → which eBay listings it competes with.
const condGroup = condition => condition === 'For Parts' ? 'parts' : 'used';

// Storage size is part of a model's identity; color is not (it splits the market too thin).
function storageOf(specs) {
  const m = String(specs || '').match(/(\d+(?:\.\d+)?)\s*(GB|TB)\b/i);
  return m ? `${m[1]}${m[2].toUpperCase()}` : '';
}

// The search phrase for a model, e.g. "Apple iPhone 14 Pro 128GB".
function marketQuery(title, specs) {
  const base = String(title || '').replace(/\s+/g, ' ').trim();
  const storage = storageOf(specs);
  return storage && !base.toUpperCase().includes(storage) ? `${base} ${storage}` : base;
}

// Stable id for a model + condition group. The Vault page computes the same key.
function marketKey(title, specs, condition) {
  const slug = marketQuery(title, specs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return slug ? `${slug}--${condGroup(condition)}` : '';
}

// eBay leaf categories for the Vault's device categories (filters only work on leaf categories).
function ebayCategory(category, title) {
  const t = String(title || '').toLowerCase();
  if (category === 'Smartphone') return '9355';
  if (category === 'Tablet') return '171485';
  if (category === 'Laptop') return /macbook/.test(t) ? '111422' : '177';
  if (category === 'Console') return '139971';
  return '';
}

function ebayFilter(group) {
  const cond = group === 'parts' ? 'conditionIds:{7000}' : 'conditions:{USED}';
  return `${cond},buyingOptions:{FIXED_PRICE},itemLocationCountry:US,priceCurrency:USD`;
}

// What a buyer pays for a listing: item price plus the first shipping option, when given.
function landedPrice(summary) {
  const price = Number(summary && summary.price && summary.price.value);
  if (!(price > 0)) return null;
  const ship = Number(summary.shippingOptions && summary.shippingOptions[0] && summary.shippingOptions[0].shippingCost && summary.shippingOptions[0].shippingCost.value) || 0;
  return +(price + ship).toFixed(2);
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return +(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)).toFixed(2);
}

// Price spread of the live listings, ignoring accessories and junk priced far below the pack.
function priceStats(prices) {
  const clean = prices.filter(p => p > 0).sort((a, b) => a - b);
  if (!clean.length) return { n: 0, low: null, p25: null, median: null, p75: null, high: null };
  const roughMedian = quantile(clean, 0.5);
  const kept = clean.filter(p => p >= roughMedian * 0.35 && p <= roughMedian * 3);
  return { n: kept.length, low: kept[0], p25: quantile(kept, 0.25), median: quantile(kept, 0.5), p75: quantile(kept, 0.75), high: kept[kept.length - 1] };
}

// Listings that left the market since the last full snapshot (mostly sold), and new ones.
function diffListings(previousIds, currentIds) {
  const prev = new Set(previousIds || []);
  const cur = new Set(currentIds || []);
  let gone = 0;
  let added = 0;
  prev.forEach(id => { if (!cur.has(id)) gone++; });
  cur.forEach(id => { if (!prev.has(id)) added++; });
  return { gone, added };
}

// Estimated listings leaving per week, from complete snapshots in the last `days` days.
function weeklyGone(history, now = Date.now(), days = 14) {
  const since = now - days * 864e5;
  const recent = (history || []).filter(h => h.gone != null && Date.parse(h.t) >= since);
  if (recent.length < 2) return null;
  const first = Date.parse(recent[0].t);
  const spanDays = Math.max(1, (now - first) / 864e5);
  const total = recent.slice(1).reduce((n, h) => n + h.gone, 0);
  return +(total / spanDays * 7).toFixed(1);
}

// eBay's account-deletion endpoint check: sha256(challengeCode + verificationToken + endpoint), hex.
function ebayChallengeResponse(challengeCode, verificationToken, endpoint) {
  return crypto.createHash('sha256').update(String(challengeCode) + String(verificationToken) + String(endpoint)).digest('hex');
}

module.exports = { IN_STOCK, condGroup, storageOf, marketQuery, marketKey, ebayCategory, ebayFilter, landedPrice, priceStats, diffListings, weeklyGone, ebayChallengeResponse };
