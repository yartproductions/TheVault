const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./listing');

const inputs = (over = {}) => L.listingInputs({ code: 'VR-00011', title: 'Lot of 4 | SKhynix 64GB', category: 'Computer Parts', condition: 'Good', specs: 'HMA84GR7AFR4N-VK', serial: '', defect: 'None found', ...over }, { description: 'pulled from a working server, all 4 tested', returnPolicy: '30 Days Free Return' });

test('titles follow the rulebook', () => {
  assert.equal(L.fixTitle('Apple MacBook Pro 14" M1 Pro 16GB 512GB Grade B'), 'Apple MacBook Pro 14-inch M1 Pro 16GB 512GB');
  assert.equal(L.fixTitle('UNLOCKED APPLE IPHONE 13 128GB BROKEN'), 'Unlocked Apple Iphone 13 128GB For Parts');
  assert.equal(L.fixTitle('Dell Dell Latitude 7450 ⭐ 32GB'), 'Dell Latitude 7450 32GB');
  assert.ok(L.fixTitle('x '.repeat(60) + 'end').length <= 80);
});

test('output is checked and the code-owned parts are filled', () => {
  const out = L.normalizeListing({
    type: 'RAM', title: 'Lot of 4 SK hynix 64GB 2Rx4 PC4-2933Y DDR4 ECC RDIMM Server RAM', grade: 'Used – Good',
    condition_text: 'Used – Good; pulled from a working server, all modules tested.',
    rows: [{ label: 'Brand', value: 'SK hynix' }, { label: 'MPN', value: 'HMA84GR7AFR4N-VK' }, { label: 'GPU', value: 'N/A' }, { label: 'Condition', value: 'dup' }],
    included: 'Memory modules only', metafields: { brand: 'SK hynix', ram: '64GB', mpn: 'HMA84GR7AFR4N-VK', gpu: 'N/A', bogus: 'x' },
    missing: [], filled_from_knowledge: [{ field: 'Speed', value: 'PC4-2933Y' }], flags: []
  }, inputs());
  assert.deepEqual(out.rows.map(r => r.label), ['Brand', 'MPN']);
  assert.deepEqual(Object.keys(out.metafields).sort(), ['brand', 'ebay_condition', 'mpn', 'ram', 'type']);
  assert.equal(out.metafields.ebay_condition, 'Used');
  assert.equal(out.ebay.ebay_category_id, '170083');
  assert.equal(out.ebay.ebay_returns_within, '30 Days');
});

test("the lister's For Parts wins and the For Parts sentence is added", () => {
  const out = L.normalizeListing({ type: 'Phone', title: 'Unlocked Apple iPhone 13 128GB', grade: 'Used – Good', condition_text: 'cracked back glass, broken camera', rows: [] }, inputs({ condition: 'For Parts' }));
  assert.equal(out.grade, 'For Parts');
  assert.match(out.conditionText, /^For Parts; cracked back glass, for parts camera\. Sold for parts or repair\.$/);
  assert.equal(out.ebay.ebay_condition_code, '7000');
  assert.ok(out.flags.some(f => /For Parts/.test(f)));
});

test('HTML follows the template: navy bars, fixed rows, escaped values, no scripts', () => {
  const listing = L.normalizeListing({ type: 'RAM', title: 't', grade: 'Used – Good', condition_text: 'Used – Good; tested <script>x</script>', rows: [{ label: 'Brand', value: 'SK hynix' }], included: 'Modules only' }, inputs());
  const html = L.renderHtml(listing, { standardWear: true });
  assert.match(html, /^<div style="font-family:Arial,sans-serif;max-width:800px;">/);
  assert.equal((html.match(/#1F4E79/g) || []).length, 2);
  assert.match(html, />Product Details</);
  assert.match(html, />Shipping &amp; Returns</);
  assert.match(html, /Free Shipping/);
  assert.match(html, /30 Days Free Return/);
  assert.match(html, /consistent with normal use/);
  assert.doesNotMatch(html, /<script|rgb\(|Item Specifications|height=/i);
  assert.ok(html.indexOf('>Condition<') < html.indexOf('>Included<'));
});

test('JSON is extracted from the tagged reply', () => {
  assert.deepEqual(L.extractJson('thinking… <listing_json>{"a":1}</listing_json>'), { a: 1 });
  assert.throws(() => L.extractJson('no json here'));
});
