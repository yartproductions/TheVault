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

// How many units a title describes: "Lot of 4 | SK hynix 64GB" → 4, "2x16GB kit" → 2, otherwise 1.
const LOT_PATTERNS = [/\blot\s*of\s*\(?(\d{1,3})\)?/i, /\b(?:set|bundle|pack|box)\s*of\s*\(?(\d{1,3})\)?/i, /\b(\d{1,3})\s*(?:pcs|pc|pieces|pack|count|ct|units)\b/i, /\b(\d{1,2})\s*x\s*\d+(?:\.\d+)?\s*(?:gb|tb)\b/i];
function lotSize(title) {
  for (const re of LOT_PATTERNS) { const m = String(title || '').match(re); if (m) { const n = Number(m[1]); if (n >= 1 && n <= 100) return n; } }
  return 1;
}
// The title without lot wording or separators, so a lot is compared with single units.
function stripLot(title) {
  return String(title || '').replace(/\blot\s*of\s*\(?\d{1,3}\)?/ig, ' ').replace(/\b(?:set|bundle|pack|box)\s*of\s*\(?\d{1,3}\)?/ig, ' ').replace(/\b\d{1,3}\s*(?:pcs|pc|pieces|count|ct|units)\b/ig, ' ').replace(/[|•·,]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The search phrase for a model, e.g. "Apple iPhone 14 Pro 128GB".
function marketQuery(title, specs) {
  const base = stripLot(title);
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

// Fixed-price only works on leaf categories, so it's left off when eBay picked no category.
function ebayFilter(group, category) {
  const cond = group === 'parts' ? 'conditionIds:{7000}' : group === 'new' ? 'conditions:{NEW}' : 'conditions:{USED}';
  return `${cond}${category ? ',buyingOptions:{FIXED_PRICE}' : ''},itemLocationCountry:US,priceCurrency:USD`;
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
// Titles that aren't the item itself. Device accessory/part words only count for devices
// (phones, tablets, laptops, consoles): for computer parts a "motherboard" is the product.
const ALWAYS_JUNK = /\b(box only|empty box|dummy|replica|fake|read description)\b/i;
const BROKEN = /\b(for parts|parts only|not working|untested|as is|icloud locked|blacklisted|bad esn|faulty|defective)\b/i;
const DEVICE_ACCESSORY = /\b(case|cover|skin|screen protector|tempered glass|charger only|cable only)\b/i;
const DEVICE_PART = /\b(housing|back glass|lcd|digitizer|motherboard|logic board|replacement screen)\b/i;
const DEVICE_CATEGORIES = new Set(['9355', '171485', '111422', '177', '139971']);
function junkTitle(title, group, category) {
  const t = String(title || '');
  const device = !category || DEVICE_CATEGORIES.has(String(category));
  if (ALWAYS_JUNK.test(t)) return true;
  if (device && DEVICE_ACCESSORY.test(t)) return true;
  if (group === 'parts') return false; // broken devices and their parts are the market here
  return (device && DEVICE_PART.test(t)) || BROKEN.test(t);
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
  const aspect = (distributions || []).find(a => /storage capacity|^storage$|total capacity|^capacity$|capacity per module/i.test(String(a.localizedAspectName || '')));
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
  for (const d of match.extra || []) if (d && d.name && d.value) parts.push(`${d.name}:{${esc(d.value)}}`);
  return parts.length ? `categoryId:${category},${parts.join(',')}` : '';
}

Object.assign(module.exports, { junkTitle, pickAspect, pickStorage, pickNetwork, aspectFilter, lotSize, stripLot, DEVICE_CATEGORIES });

// ── Identifying details (what makes a part a specific part) ──────
const compact = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
// Manufacturer part numbers look like HMA84GR7AFR4N-VK, MZ-7KH240, 0RVDT9: letters and digits, 6+ long.
function partNumbers(text) {
  const out = [];
  for (const raw of String(text || '').toUpperCase().match(/\b[A-Z0-9][A-Z0-9-]{4,}[A-Z0-9]\b/g) || []) {
    const t = raw.replace(/-+$/, '');
    if (!/\d/.test(t) || !/[A-Z]/.test(t)) continue;
    if (/^\d+(\.\d+)?(GB|TB|MB|MHZ|GHZ|W|MM|IN)$/.test(t)) continue; // sizes and speeds aren't part numbers
    if (/^(DDR\d|PC\d|LPDDR\d|GDDR\d)/.test(t) && t.length < 10) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, 3);
}

// Which eBay item specifics identify a product (type, speed, form factor, interface, generation…).
const DETAIL_ASPECT = /^(type|speed|bus speed|form factor|number of modules|capacity per module|interface|ecc|registered\/buffered|series|product line|processor|processor model|ram size|screen size|generation|chipset|lock status|connectivity|drive type|height|configuration|memory type|mpn)$/i;
// Picks every detail aspect whose value is stated in the record's title or specs.
function pickDetails(distributions, text) {
  const hay = compact(text);
  const picks = [];
  for (const a of distributions || []) {
    const name = String(a.localizedAspectName || '');
    if (!DETAIL_ASPECT.test(name)) continue;
    const found = (a.aspectValueDistributions || [])
      .map(v => String(v.localizedAspectValue || ''))
      .filter(v => compact(v).length >= 3 && !/^(unknown|does not apply|not applicable|other)$/i.test(v) && hay.includes(compact(v)))
      .sort((x, y) => compact(y).length - compact(x).length);
    if (found[0]) picks.push({ name, value: found[0] });
  }
  return picks.slice(0, 5);
}

// How precisely a record is described: model or part number count most, each detail adds a little.
function detailScore(match) {
  if (!match) return 0;
  return (match.mpn ? 3 : 0) + (match.model ? 2 : 0) + (match.storage ? 1 : 0) + Math.min(3, (match.extra || []).length);
}

Object.assign(module.exports, { partNumbers, pickDetails, detailScore });
