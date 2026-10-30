const test = require('node:test');
const assert = require('node:assert/strict');
const { vaultSku } = require('./sku');

test('Shopify SKU is the immutable VR code', () => {
  assert.equal(vaultSku('vr-00042'), 'VR-00042');
  assert.throws(() => vaultSku('42'));
  assert.throws(() => vaultSku('VR-42'));
});

test('listing units start with the main record and drop bad or duplicate codes', () => {
  const { listingUnits } = require('./sku');
  assert.deepEqual(listingUnits('VR-00002', ['VR-00003', 'vr-00002', 'junk', 'VR-00003', 'VR-00004']), ['VR-00002', 'VR-00003', 'VR-00004']);
  assert.deepEqual(listingUnits('VR-00002', undefined), ['VR-00002']);
});
