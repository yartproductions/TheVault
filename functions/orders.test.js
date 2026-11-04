const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validShopifyHmac, unitPrice, shopifyFee, lineSku, pickUnits, buyerName, orderDate } = require('./orders');

test('accepts only webhooks signed with the client secret', () => {
  const body = Buffer.from('{"id":1}');
  const good = crypto.createHmac('sha256', 'secret').update(body).digest('base64');
  assert.equal(validShopifyHmac(body, good, 'secret'), true);
  assert.equal(validShopifyHmac(body, good, 'other'), false);
  assert.equal(validShopifyHmac(Buffer.from('{"id":2}'), good, 'secret'), false);
  assert.equal(validShopifyHmac(body, '', 'secret'), false);
  assert.equal(validShopifyHmac(body, 'not-base64!!', 'secret'), false);
});

test('unit price subtracts discounts spread across the units', () => {
  assert.equal(unitPrice({ price: '500.00', quantity: 1 }), 500);
  assert.equal(unitPrice({ price: '100.00', quantity: 2, discount_allocations: [{ amount: '20.00' }, { amount: '5.00' }] }), 87.5);
  assert.equal(unitPrice({ price: '100.00', quantity: 3, total_discount: '10.00' }), 96.67);
  assert.equal(unitPrice({ price: '10.00', quantity: 1, discount_allocations: [{ amount: '50.00' }] }), 0);
});

test('fees match the Vault Shopify rule', () => {
  assert.equal(shopifyFee(500), 14.8);
  assert.equal(shopifyFee(0), 0);
});

test('only Vault SKUs are matched', () => {
  assert.equal(lineSku({ sku: ' vr-00012 ' }), 'VR-00012');
  assert.equal(lineSku({ sku: 'CASE-1' }), '');
  assert.equal(lineSku({}), '');
});

test('picks in-stock units, lowest code first', () => {
  const units = [
    { code: 'VR-00003', status: 'list' },
    { code: 'VR-00001', status: 'sold' },
    { code: 'VR-00002', status: 'prep' },
    { code: 'VR-00004', status: 'arch' },
    { code: 'VR-00005', status: 'new' }
  ];
  assert.deepEqual(pickUnits(units, 2), ['VR-00002', 'VR-00003']);
  assert.deepEqual(pickUnits(units, 9), ['VR-00002', 'VR-00003', 'VR-00005']);
  assert.deepEqual(pickUnits(units, 0), []);
});

test('buyer name and order date fall back sensibly', () => {
  assert.equal(buyerName({ customer: { first_name: 'Ana', last_name: 'Ruiz' } }), 'Ana Ruiz');
  assert.equal(buyerName({ billing_address: { name: 'Lee' } }), 'Lee');
  assert.equal(buyerName({}), 'Shopify customer');
  assert.equal(orderDate({ created_at: '2026-11-03T23:30:00-05:00' }), '2026-11-03');
});
