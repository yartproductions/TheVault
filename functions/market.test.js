const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const m = require('./market');

test('model key and query keep storage, drop color', () => {
  assert.equal(m.marketQuery('Apple iPhone 14 Pro', '128GB · Midnight'), 'Apple iPhone 14 Pro 128GB');
  assert.equal(m.marketQuery('Apple iPhone 14 Pro 128GB', '128 gb black'), 'Apple iPhone 14 Pro 128GB');
  assert.equal(m.marketKey('Apple iPhone 14 Pro', '128GB · Midnight', 'Good'), 'apple-iphone-14-pro-128gb--used');
  assert.equal(m.marketKey('Apple iPhone 14 Pro', '128GB', 'For Parts'), 'apple-iphone-14-pro-128gb--parts');
  assert.equal(m.marketKey('  ', '', 'Good'), '');
});

test('the Vault page computes the same key as the backend', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const src = html.match(/\/\/ market-key:start([\s\S]*?)\/\/ market-key:end/);
  assert.ok(src, 'index.html must contain the market-key block');
  const clientKey = new Function(`${src[1]}; return marketKeyOf;`)();
  for (const [t, s, c] of [['Apple iPhone 14 Pro', '128GB · Midnight', 'Good'], ['Samsung Galaxy S23 Ultra', '256 gb', 'For Parts'], ['iPad 9th gen', '', 'Fair'], ['MacBook Air M2 512GB', '512GB', 'Excellent']]) {
    assert.equal(clientKey({ title: t, specs: s, condition: c }), m.marketKey(t, s, c));
  }
});

test('categories are eBay leaf categories', () => {
  assert.equal(m.ebayCategory('Smartphone', 'iPhone'), '9355');
  assert.equal(m.ebayCategory('Laptop', 'Apple MacBook Pro'), '111422');
  assert.equal(m.ebayCategory('Laptop', 'Dell XPS'), '177');
  assert.equal(m.ebayCategory('Audio', 'AirPods'), '');
  assert.match(m.ebayFilter('parts'), /conditionIds:\{7000\}/);
  assert.match(m.ebayFilter('used'), /conditions:\{USED\}/);
});

test('landed price adds shipping', () => {
  assert.equal(m.landedPrice({ price: { value: '400.00' }, shippingOptions: [{ shippingCost: { value: '9.99' } }] }), 409.99);
  assert.equal(m.landedPrice({ price: { value: '400.00' } }), 400);
  assert.equal(m.landedPrice({ price: { value: '0' } }), null);
});

test('price stats drop accessories and silly outliers', () => {
  const s = m.priceStats([15, 20, 380, 400, 410, 420, 450, 5000]);
  assert.equal(s.n, 5);
  assert.equal(s.low, 380);
  assert.equal(s.median, 410);
  assert.equal(s.high, 450);
  assert.deepEqual(m.priceStats([]).median, null);
});

test('listing diff counts gone and new', () => {
  assert.deepEqual(m.diffListings(['a', 'b', 'c'], ['b', 'c', 'd', 'e']), { gone: 1, added: 2 });
  assert.deepEqual(m.diffListings(null, ['a']), { gone: 0, added: 1 });
});

test('weekly gone uses only complete recent snapshots', () => {
  const now = Date.parse('2026-11-15T00:00:00Z');
  const h = [
    { t: '2026-11-01T00:00:00Z', gone: 99 },
    { t: '2026-11-08T00:00:00Z', gone: null },
    { t: '2026-11-08T00:00:00Z', gone: 0 },
    { t: '2026-11-11T12:00:00Z', gone: 4 },
    { t: '2026-11-14T00:00:00Z', gone: 3 }
  ];
  assert.equal(m.weeklyGone(h, now), 3.5);
  assert.equal(m.weeklyGone([{ t: '2026-11-14T00:00:00Z', gone: 3 }], now), null);
});

test('eBay challenge response is sha256(code + token + endpoint)', () => {
  const expected = crypto.createHash('sha256').update('abc' + 'tok' + 'https://x/y').digest('hex');
  assert.equal(m.ebayChallengeResponse('abc', 'tok', 'https://x/y'), expected);
});

test('junk titles are dropped (parts listings keep broken phones)', () => {
  assert.equal(m.junkTitle('Apple iPhone 14 Pro 128GB Unlocked Deep Purple', 'used'), false);
  assert.equal(m.junkTitle('Clear Case for iPhone 14 Pro', 'used'), true);
  assert.equal(m.junkTitle('iPhone 14 Pro 128GB iCloud Locked for parts', 'used'), true);
  assert.equal(m.junkTitle('iPhone 14 Pro 128GB cracked screen for parts', 'parts'), false);
  assert.equal(m.junkTitle('iPhone 14 Pro box only', 'parts'), true);
});

test('picks the eBay Model value that matches the Vault title', () => {
  const dist = [
    { localizedAspectName: 'Model', aspectValueDistributions: [
      { localizedAspectValue: 'Apple iPhone 14 Pro Max', matchCount: 900 },
      { localizedAspectValue: 'Apple iPhone 14 Pro', matchCount: 700 },
      { localizedAspectValue: 'Apple iPhone 14', matchCount: 1200 },
      { localizedAspectValue: 'Unknown', matchCount: 50 }] },
    { localizedAspectName: 'Storage Capacity', aspectValueDistributions: [
      { localizedAspectValue: '256 GB', matchCount: 400 }, { localizedAspectValue: '128 GB', matchCount: 500 }] },
    { localizedAspectName: 'Network', aspectValueDistributions: [
      { localizedAspectValue: 'Unlocked', matchCount: 800 }, { localizedAspectValue: 'Verizon', matchCount: 200 }] }
  ];
  assert.equal(m.pickAspect(dist, /^model$/i, 'Apple iPhone 14 Pro').value, 'Apple iPhone 14 Pro');
  assert.equal(m.pickAspect(dist, /^model$/i, 'Apple iPhone 14 Pro Max 256').value, 'Apple iPhone 14 Pro Max');
  assert.equal(m.pickAspect(dist, /^model$/i, 'iPhone 14').value, '');
  assert.ok(!m.pickAspect(dist, /^model$/i, 'x').options.includes('Unknown'));
  assert.equal(m.pickStorage(dist, '128GB · Black', '').value, '128 GB');
  assert.equal(m.pickNetwork(dist, '128GB Unlocked').value, 'Unlocked');
  assert.equal(m.pickNetwork(dist, '128GB').value, '');
});

test('aspect filter escapes values and names the category', () => {
  assert.equal(m.aspectFilter('9355', { model: 'Apple iPhone 14 Pro', storage: '128 GB' }), 'categoryId:9355,Model:{Apple iPhone 14 Pro},Storage Capacity:{128 GB}');
  assert.equal(m.aspectFilter('9355', { model: 'A|B' }), 'categoryId:9355,Model:{A\\|B}');
  assert.equal(m.aspectFilter('', { model: 'x' }), '');
});
