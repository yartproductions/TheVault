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

// ── Precise matching to eBay item specifics ──────────────────────
// Words in a listing title that mean it isn't the device itself (or not a working one).
const JUNK = /\b(case|cover|skin|screen protector|tempered glass|box only|empty box|charger only|cable only|for parts|parts only|not working|read description|icloud locked|blacklisted|bad esn|lot of|bundle of|dummy|replica|housing|back glass|lcd|digitizer|motherboard|logic board)\b/i;
const PARTS_OK = /\b(case|cover|skin|screen protector|tempered glass|box only|empty box|charger only|cable only|dummy|replica)\b/i;
function junkTitle(title, group) {
  const t = String(title || '');
  return group === 'parts' ? PARTS_OK.test(t) : JUNK.test(t);
}

const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

// Picks the value of one eBay aspect (e.g. "Model") that best matches the Vault title,
// preferring values whose words all appear in the title, then the most listings.
function pickAspect(distributions, namePattern, title) {
  const aspect = (distributions || []).find(a => namePattern.test(String(a.localizedAspectName || '')));
  if (!aspect) return { value: '', options: [] };
  const titleWords = new Set(words(title));
  const options = (aspect.aspectValueDistributions || [])
    .map(v => ({ value: String(v.localizedAspectValue || ''), count: Number(v.matchCount) || 0 }))
    .filter(v => v.value && !/^(unknown|does not apply|not applicable|other)$/i.test(v.value));
  const scored = options.map(o => {
    const w = words(o.value);
    const hits = w.filter(x => titleWords.has(x)).length;
    return { ...o, score: w.length ? hits / w.length : 0, hits, extra: w.length - hits };
  }).sort((a, b) => b.score - a.score || b.hits - a.hits || a.extra - b.extra || b.count - a.count);
  const best = scored[0] && scored[0].score >= 0.99 ? scored[0].value : '';
  return { value: best, options: options.sort((a, b) => b.count - a.count).slice(0, 10).map(o => o.value) };
}

// "128GB" → the way eBay writes storage, e.g. "128 GB".
function pickStorage(distributions, specs, title) {
  const want = storageOf(specs) || storageOf(title);
  const aspect = (distributions || []).find(a => /storage capacity|^storage$/i.test(String(a.localizedAspectName || '')));
  const options = aspect ? (aspect.aspectValueDistributions || []).map(v => String(v.localizedAspectValue || '')).filter(Boolean) : [];
  if (!want) return { value: '', options: options.slice(0, 10) };
  const norm = s => String(s).toUpperCase().replace(/\s+/g, '');
  return { value: options.find(o => norm(o) === norm(want)) || '', options: options.slice(0, 10) };
}

// Network / carrier from the Vault specs text, matched to eBay's value when possible.
function pickNetwork(distributions, specs) {
  const s = String(specs || '').toLowerCase();
  const carriers = ['unlocked', 'verizon', 'at&t', 't-mobile', 'sprint', 'us cellular', 'cricket', 'metro', 'boost', 'tracfone', 'straight talk'];
  const found = carriers.find(c => s.includes(c));
  const aspect = (distributions || []).find(a => /^network$|carrier/i.test(String(a.localizedAspectName || '')));
  const options = aspect ? (aspect.aspectValueDistributions || []).map(v => String(v.localizedAspectValue || '')).filter(Boolean) : [];
  if (!found) return { value: '', options: options.slice(0, 10) };
  return { value: options.find(o => o.toLowerCase().includes(found.replace('&', '&'))) || '', options: options.slice(0, 10) };
}

// eBay aspect_filter string: "categoryId:9355,Model:{Apple iPhone 14 Pro},Storage Capacity:{128 GB}".
function aspectFilter(category, match) {
  if (!category || !match) return '';
  const esc = v => String(v).replace(/([|{}])/g, '\\$1');
  const parts = [];
  if (match.brand) parts.push(`Brand:{${esc(match.brand)}}`);
  if (match.model) parts.push(`Model:{${esc(match.model)}}`);
  if (match.storage) parts.push(`${match.storageName || 'Storage Capacity'}:{${esc(match.storage)}}`);
  if (match.network) parts.push(`${match.networkName || 'Network'}:{${esc(match.network)}}`);
  return parts.length ? `categoryId:${category},${parts.join(',')}` : '';
}

Object.assign(module.exports, { junkTitle, pickAspect, pickStorage, pickNetwork, aspectFilter });
