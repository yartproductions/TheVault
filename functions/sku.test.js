const test = require('node:test');
const assert = require('node:assert/strict');
const { vaultSku } = require('./sku');

test('Shopify SKU is the immutable VR code', () => {
  assert.equal(vaultSku('vr-00042'), 'VR-00042');
  assert.throws(() => vaultSku('42'));
  assert.throws(() => vaultSku('VR-42'));
});
