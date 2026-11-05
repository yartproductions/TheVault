const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./products');

test('webhook bodies map to the stored product id', () => {
  assert.equal(P.productGid({ id: 123 }), 'gid://shopify/Product/123');
  assert.equal(P.productGid({ id: 123, admin_graphql_api_id: 'gid://shopify/Product/123' }), 'gid://shopify/Product/123');
  assert.equal(P.productGid({}), '');
  assert.equal(P.restStatus('archived'), 'ARCHIVED');
});

test('Vault statuses follow Shopify, never touching sold or archived units', () => {
  const units = [
    { code: 'VR-1', status: 'list' },
    { code: 'VR-2', status: 'list', listedIn: 'VR-1' },
    { code: 'VR-3', status: 'sold', listedIn: 'VR-1' },
    { code: 'VR-4', status: 'prep', listedIn: 'VR-1' }
  ];
  assert.deepEqual(P.unitChanges('DELETED', units, 'VR-1'), [
    { code: 'VR-1', status: 'prep' },
    { code: 'VR-2', status: 'prep' }
  ]);
  assert.deepEqual(P.unitChanges('DRAFT', units, 'VR-1'), [{ code: 'VR-1', status: 'prep' }, { code: 'VR-2', status: 'prep' }]);
  assert.deepEqual(P.unitChanges('ACTIVE', units, 'VR-1'), [{ code: 'VR-4', status: 'list' }]);
  assert.deepEqual(P.unitChanges('ACTIVE', [{ code: 'VR-9', status: 'sold' }], 'VR-9'), []);
});
