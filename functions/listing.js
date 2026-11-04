// Turns a lister's plain-English notes into the final Shopify listing, following the SYG
// "Thoky" listing rulebook (title formats, condition grading, HTML template, metafields).
// Claude writes the content as structured data; this file renders and checks it, so the
// HTML template, fixed rows and banned terms can never drift from the rulebook.

const RULEBOOK = `SYG LISTING RULEBOOK (Thoky) — follow exactly.

TITLE FORMATS, by category
- Phones: <Lock Status> Brand Model ModelNo MPN Storage BH% Color Condition
  Order: Lock Status → Brand → Model → Model No. → MPN → Storage → BH % → Color → Condition.
  Lock status first: Unlocked, or the carrier (Verizon, AT&T, T-Mobile). Battery Health written "BH 74%".
  Condition word only at the end when needed (For Parts, Used, New).
- Watches: Unlocked Apple Watch [Model] ModelNo GPS+Cellular(or GPS) Size(mm) Color
  e.g. Unlocked Apple Watch Ultra 2 A2986 GPS+Cellular 49mm Natural Titanium
- Laptops / Tablets / Consoles / Other: Brand-first, same spec order where applicable, e.g.
  Apple MacBook Pro 14-inch 2021 A2442 MKGP3LL/A M1 Pro 16GB 512GB Space Gray
  Dell Latitude 7450 14-inch Intel Core Ultra 7 165U 32GB 1TB SSD Gray Used
  Sony PlayStation 5 Digital CFI-1215B 825GB White w/ Controller & Power Cable
- Lots: start with "Lot of N" and describe the single item, e.g. Lot of 4 SK hynix 64GB 2Rx4 PC4-2933Y DDR4 ECC RDIMM Server RAM
Universal title rules: screen sizes 6–16" written "-inch" (14-inch, 12.9-inch), never 14". 80 characters maximum.
Title Case, never ALL CAPS. No symbols/emojis, no keyword stuffing, no duplicate words, no banned terms.
Never a letter grade (A/B/C). Spell out accessories when there's room: "w/ Controller & Power Cable", "w/ Case".

CONDITION GRADING (a word, never a letter)
- "New In Box" → New — "New; New In Box, sealed original packaging."
- No defects listed / "Good Condition" / light scratches → Used – Good
- "scratches and dents" (unqualified), heavy scratches, heavy dust/marks (cosmetic only, still works) → Used – Fair
- Cracked glass/back, bad display, no power, Service Battery, doesn't turn on, or lister says "For Parts" → For Parts, listing the exact defect.
- The condition text carries full detail, e.g. "Used – Fair; heavy scratches on the screen and dents on the bezel. Fully functional. Please review all photos for the exact condition."
- For Parts text always ends with "Sold for parts or repair."
- The lister's stated "For Parts" or "New In Box" always wins over inference.
- "Scratches and dents" (unqualified) grades Fair even if the lister also wrote "Good Condition" — flag the conflict.

DESCRIPTION ROWS
- One row per spec that applies, chosen from: Type, Brand, Model, Model Number, MPN, Color, Storage, Lock Status/Network,
  Screen Size, Processor, GPU, RAM, Battery Health (+ cycle count), IMEI, iCloud/IMEI Status, Serial Number, and
  category specifics (PSU: Wattage/Certification/Modularity; Motherboard: Socket/Chipset/Form Factor; RAM: Capacity,
  Speed, Rank, Form Factor, ECC/Registered; Storage: Capacity, Interface, Form Factor, Drive Health; Console: Controllers,
  Cables). Lots get a "Quantity" row.
- Lock Status is one of: Factory Unlocked / Network Unlocked / Network Locked / Compatible with <Carrier> only.
- No "Untested — sold for parts" functionality rows. Never first person. Professional, concise, accurate; never
  oversell; disclose every defect and missing accessory.
- Banned terms: never "Broken" (use "For Parts"), no "Grade A/B/C", no "Item Specifications" heading.

METAFIELDS (namespace custom) — only these keys, fill only the ones relevant to the type:
  type, brand, model, model_number, features, screen_size, color, connectivity, processor, storage_capacity,
  storage_type, operating_system, ram, gpu, mpn, network, platform, release_year, game_name, upc,
  battery_health, imei_status, serial_number, ebay_condition, video_game_platform, controller, hdmi_cable,
  power_cable, watch_size, case_material, band
- Per type: Phone: type, brand, model, model_number, storage_capacity, color, network, operating_system, screen_size, mpn, upc, battery_health, imei_status, serial_number.
  Tablet: type, brand, model, model_number, mpn, storage_capacity, ram, color, connectivity, network, operating_system, screen_size, processor, release_year, serial_number.
  Watch: type, brand, model, model_number, mpn, color, connectivity, screen_size, processor, ram, storage_capacity, operating_system, release_year, watch_size, case_material, band.
  Laptop: type, brand, model, model_number, processor, ram, storage_capacity, gpu, operating_system, screen_size, mpn.
  Desktop: type, brand, model, processor, ram, storage_capacity, gpu, operating_system, mpn.
  Console: type, brand, model, model_number, storage_capacity, color, network, mpn, controller, hdmi_cable, power_cable (Included / Not Included).
  GPU: type, brand, model, model_number, gpu, features, mpn. CPU: type, brand, model, model_number, processor, platform, mpn.
  Motherboard: type, brand, model, model_number, platform, features, mpn. PSU: type, brand, model, model_number, features, mpn.
  Storage: type, brand, model, model_number, storage_capacity, storage_type, mpn. RAM: type, brand, model, model_number, ram, mpn.
  Other types: type, brand, model, model_number, features, connectivity, color, mpn.
- Model Number ≠ MPN. MPN is the exact part number for that configuration. If no distinct MPN is found, use the Model Number and flag it.
- ebay_condition holds only New, Used, or For Parts.
- Leave a key out when it doesn't apply or isn't known — never write "N/A" or "MISSING" as a value.

RESEARCH RULES
- Constants (model number, MPN, screen size, processor, RAM, GPU, connectivity, release year, OS) may be looked up
  with web search or filled from confident knowledge of the exact product — never guessed. Every value not stated by
  the lister must be listed in filled_from_knowledge.
- Per-unit variables (storage, color, carrier/lock, condition, battery, IMEI, defects, accessories) come only from the
  lister. If missing, list them in missing — don't guess.
- Service/replacement part numbers supplied by the lister override researched retail MPNs.
- PS5 model numbers encode storage: CFI-11xxB = Digital 825GB; CFI-2015 = Slim 1TB.`;

const TYPES = ['Phone', 'Tablet', 'Watch', 'Laptop', 'Desktop', 'Console', 'GPU', 'CPU', 'Motherboard', 'PSU', 'Storage', 'RAM', 'Camera', 'Audio Equipment', 'Gaming Accessories', 'Computer Peripherals', 'Power Tools', 'Test Equipment', 'Server Components', 'Other'];
const METAFIELD_KEYS = ['type', 'brand', 'model', 'model_number', 'features', 'screen_size', 'color', 'connectivity', 'processor', 'storage_capacity', 'storage_type', 'operating_system', 'ram', 'gpu', 'mpn', 'network', 'platform', 'release_year', 'game_name', 'upc', 'battery_health', 'imei_status', 'serial_number', 'ebay_condition', 'video_game_platform', 'controller', 'hdmi_cable', 'power_cable', 'watch_size', 'case_material', 'band'];
const GRADES = ['New', 'Used – Good', 'Used – Fair', 'For Parts'];
const RETURN_POLICIES = ['30 Days Free Return', 'Returns accepted', 'No returns', 'For parts / no returns'];
const STANDARD_WEAR = 'Item is used and may show light scratches, scuffs or dust consistent with normal use, beyond any defects noted above.';

// Confirmed eBay leaf categories from the SYG list; anything else stays blank (never guessed).
const EBAY_CATEGORY_IDS = { Storage: '175669', RAM: '170083', Motherboard: '1244', GPU: '27386', PSU: '42017', Phone: '9355', Laptop: '175672', Console: '139971', 'Computer Peripherals': '3676', 'Gaming Accessories': '54968', 'Power Tools': '3247', 'Test Equipment': '181939', 'Server Components': '168074' };

// What Claude must return (described in the prompt, checked by normalizeListing).
const OUTPUT_SPEC = `Return ONE JSON object inside <listing_json></listing_json> tags, nothing else after it:
{
  "type": one of ${JSON.stringify(TYPES)},
  "title": "the SEO title per the title rules (max 80 characters)",
  "grade": one of ${JSON.stringify(GRADES)},
  "condition_text": "the full condition sentence(s) per the grading rules",
  "rows": [{"label": "Brand", "value": "..."}, ...]   // spec rows only — no Condition, Included, Shipping or Returns rows
  "included": "what's included, e.g. 'Device only; no charger' or 'Console, 1 controller, HDMI cable, power cable'",
  "metafields": {"brand": "...", ...},                 // only the allowed keys relevant to the type
  "missing": ["per-unit details the lister should add, e.g. 'Battery health %'"],
  "filled_from_knowledge": [{"field": "Model Number", "value": "A2650"}],
  "flags": ["anything conflicting or uncertain, e.g. 'Lister wrote Good Condition but also scratches and dents — graded Fair'"]
}`;

// The lister's inputs, gathered from the Vault record.
function listingInputs(item, packet) {
  const pk = packet || {};
  return {
    sku: item.code,
    vault_title: String(item.title || ''),
    working_title: String(pk.title || ''),
    category: String(item.category || ''),
    vault_condition: String(item.condition || ''),
    specs: String(item.specs || ''),
    serial: String(item.serial || ''),
    defects: String(item.defect || ''),
    lister_notes: String(pk.description || ''),
    included: String(pk.included || ''),
    return_policy: RETURN_POLICIES.includes(pk.returnPolicy) ? pk.returnPolicy : RETURN_POLICIES[0]
  };
}

// A short fingerprint of the inputs, so the Vault knows when a generated listing is out of date.
function inputsHash(inputs) {
  return require('node:crypto').createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 16);
}

function buildPrompt(inputs) {
  const system = `You write product listings for SYG, a used-electronics resale business, from the lister's plain-English notes.\n\n${RULEBOOK}\n\n${OUTPUT_SPEC}`;
  const user = `Write the listing for this item. The lister's notes are plain English, not final copy — turn them into the rulebook format.\n\n${JSON.stringify(inputs, null, 2)}`;
  return { system, user };
}

// Pulls the JSON object out of Claude's reply.
function extractJson(text) {
  const tagged = String(text || '').match(/<listing_json>([\s\S]*?)<\/listing_json>/);
  const raw = tagged ? tagged[1] : String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The listing generator returned no JSON.');
  return JSON.parse(raw.slice(start, end + 1));
}

const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const EMPTY = /^(n\/?a|none|missing|unknown|not applicable|-|—)$/i;
const LOWER_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'w/', 'with']);

// Title rules that code can enforce: "-inch", no letter grades, no banned words, no ALL CAPS, ≤80 chars, no duplicate words.
function fixTitle(title) {
  let t = clean(title);
  // ALL CAPS → Title Case, keeping tokens with digits (128GB, A2442) as written.
  if (t === t.toUpperCase() && /[A-Z]{4,}/.test(t)) {
    t = t.split(' ').map((w, i) => /\d/.test(w) ? w : (i && LOWER_WORDS.has(w.toLowerCase())) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
  }
  t = t
    .replace(/\b(\d{1,2}(?:\.\d)?)\s*(?:"|''|”|in\b|inch\b)/gi, '$1-inch')
    .replace(/\bgrade\s*[abc]\b/gi, '')
    .replace(/\bbroken\b/gi, 'For Parts')
    .replace(/[^\w\s\-+/&().,%'#]/g, ' ');
  // Only accidental back-to-back repeats ("Dell Dell"); "MacBook Pro … M1 Pro" is legitimate.
  t = t.split(/\s+/).filter((w, i, a) => !i || w.toLowerCase() !== a[i - 1].toLowerCase()).join(' ');
  t = clean(t);
  if (t.length > 80) t = t.slice(0, 80).replace(/\s+\S*$/, '');
  return clean(t);
}

// Checks Claude's output against the rulebook and fills the parts code owns.
function normalizeListing(out, inputs) {
  const flags = [...(Array.isArray(out.flags) ? out.flags.map(clean).filter(Boolean) : [])];
  const type = TYPES.includes(out.type) ? out.type : 'Other';
  let grade = GRADES.includes(out.grade) ? out.grade : (/parts/i.test(out.grade) ? 'For Parts' : /fair/i.test(out.grade) ? 'Used – Fair' : /new/i.test(out.grade) ? 'New' : 'Used – Good');
  // The lister's own "For Parts" / "New In Box" always wins.
  if (inputs.vault_condition === 'For Parts' && grade !== 'For Parts') { grade = 'For Parts'; flags.push('Vault condition is For Parts, so the listing is graded For Parts.'); }
  let conditionText = clean(out.condition_text || grade).replace(/\bbroken\b/gi, 'for parts').replace(/\bgrade\s*[abc]\b/gi, '');
  if (!conditionText.toLowerCase().startsWith(grade.toLowerCase().split(' ')[0])) conditionText = `${grade}; ${conditionText}`;
  if (grade === 'For Parts' && !/sold for parts or repair\.?$/i.test(conditionText)) conditionText = `${conditionText.replace(/\.?$/, '.')} Sold for parts or repair.`;
  const rows = (Array.isArray(out.rows) ? out.rows : [])
    .map(r => ({ label: clean(r && r.label), value: clean(r && r.value) }))
    .filter(r => r.label && r.value && !EMPTY.test(r.value) && !/^(condition|included|shipping|return policy|returns|description)$/i.test(r.label))
    .slice(0, 30);
  const metafields = {};
  for (const [k, v] of Object.entries(out.metafields || {})) {
    const key = String(k).toLowerCase();
    const value = clean(v);
    if (METAFIELD_KEYS.includes(key) && value && !EMPTY.test(value)) metafields[key] = value.slice(0, 255);
  }
  metafields.type = metafields.type || type;
  metafields.ebay_condition = grade === 'New' ? 'New' : grade === 'For Parts' ? 'For Parts' : 'Used';
  if (inputs.serial && !metafields.serial_number) metafields.serial_number = clean(inputs.serial);
  const title = fixTitle(out.title || inputs.working_title || inputs.vault_title);
  if (/\b(i|we|my|our)\b/i.test(conditionText + ' ' + rows.map(r => r.value).join(' '))) flags.push('Possible first-person wording — check the description.');
  return {
    type, title, grade, conditionText,
    rows,
    included: clean(out.included) || '',
    metafields,
    missing: (Array.isArray(out.missing) ? out.missing : []).map(clean).filter(Boolean).slice(0, 12),
    filledFromKnowledge: (Array.isArray(out.filled_from_knowledge) ? out.filled_from_knowledge : []).map(f => ({ field: clean(f && f.field), value: clean(f && f.value) })).filter(f => f.field).slice(0, 20),
    flags: flags.slice(0, 12),
    returnPolicy: inputs.return_policy,
    ebay: ebayReadiness(type, grade, conditionText, inputs.return_policy)
  };
}

// eBay Marketplace Connect readiness metafields, derived in code (rulebook: never guess a category ID).
function ebayReadiness(type, grade, conditionText, returnPolicy) {
  const code = grade === 'New' ? '1000' : grade === 'For Parts' ? '7000' : '3000';
  const noReturns = /no returns/i.test(returnPolicy);
  return {
    ebay_category_id: EBAY_CATEGORY_IDS[type] || '',
    ebay_condition_code: code,
    ebay_condition_description: code === '1000' ? '' : conditionText.slice(0, 1000),
    ebay_returns_accepted: noReturns ? 'No' : 'Yes',
    ebay_returns_within: noReturns ? '' : '30 Days'
  };
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The eBay-safe HTML template: one table, navy section bars, alternating rows, inline hex CSS only,
// no scripts or links, fixed Shipping & Returns rows at the end.
function renderHtml(listing, opts = {}) {
  let condition = listing.conditionText;
  if (opts.standardWear && /^Used/.test(listing.grade) && !condition.includes(STANDARD_WEAR)) condition = `${condition} ${STANDARD_WEAR}`;
  const rows = [...listing.rows];
  rows.push({ label: 'Condition', value: condition });
  if (listing.included) rows.push({ label: 'Included', value: listing.included });
  const header = text => `<tr><th colspan="2" style="background-color:#1F4E79;color:#ffffff;font-weight:bold;text-align:left;padding:8px;">${esc(text)}</th></tr>`;
  const row = (r, i) => `<tr style="background-color:${i % 2 ? '#f9f9f9' : '#ffffff'};"><td style="padding:8px;border:1px solid #dddddd;font-weight:bold;width:35%;">${esc(r.label)}</td><td style="padding:8px;border:1px solid #dddddd;">${esc(r.value)}</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;max-width:800px;"><table style="width:100%;border-collapse:collapse;font-size:14px;color:#333333;"><tbody>`
    + header('Product Details') + rows.map(row).join('')
    + header('Shipping & Returns') + row({ label: 'Shipping', value: 'Free Shipping' }, 0) + row({ label: 'Return Policy', value: listing.returnPolicy }, 1)
    + `</tbody></table></div>`;
}

module.exports = { RULEBOOK, TYPES, METAFIELD_KEYS, GRADES, RETURN_POLICIES, STANDARD_WEAR, listingInputs, inputsHash, buildPrompt, extractJson, fixTitle, normalizeListing, ebayReadiness, renderHtml };
