const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./photos');

const fb = n => `https://firebasestorage.googleapis.com/v0/b/obsidian-vault-38dfd.firebasestorage.app/o/photos%2F${n}.jpg?alt=media&token=abc`;
const DAY = 864e5;
const now = Date.parse('2026-11-15T09:00:00Z');

test('storage paths are read from download URLs', () => {
  assert.equal(P.storagePath(fb('123-x')), 'photos/123-x.jpg');
  assert.equal(P.storagePath('https://cdn.shopify.com/s/files/a.jpg'), '');
  assert.equal(P.isShopifyCdn('https://cdn.shopify.com/s/files/a.jpg'), true);
});

test('photos already on Shopify are swapped, not lost', () => {
  const item = { status: 'list', packet: { photos: [fb('a'), fb('b')], shopifyId: 'gid://shopify/Product/1', shopifyMediaSent: [fb('a'), fb('b')] } };
  assert.equal(P.planItem(item, now).action, 'swap');
});

test('in-stock photos not on Shopify are never touched', () => {
  const item = { status: 'prep', packet: { photos: [fb('a')] } };
  assert.deepEqual(P.planItem(item, now), { action: 'keep', reason: 'in stock and not on Shopify yet' });
  // a photo added after the draft was created isn't on Shopify yet either
  const partly = { status: 'list', packet: { photos: [fb('a'), fb('new')], shopifyId: 'gid://shopify/Product/1', shopifyMediaSent: [fb('a')] } };
  assert.equal(P.planItem(partly, now).action, 'keep');
});

test('sold or archived photos are deleted only after the waiting period', () => {
  const sold = d => ({ status: 'sold', sale: { date: new Date(now - d * DAY).toISOString().slice(0, 10) }, packet: { photos: [fb('a')] } });
  assert.equal(P.planItem(sold(45), now).action, 'delete');
  assert.equal(P.planItem(sold(10), now).action, 'keep');
  assert.equal(P.planItem(sold(10), now, { soldDays: 7 }).action, 'delete');
  assert.equal(P.planItem({ status: 'arch', updatedAt: new Date(now - 40 * DAY).toISOString(), packet: { photos: [fb('a')] } }, now).action, 'delete');
});

test("Shopify's copies are used only when all are READY", () => {
  const ready = [{ status: 'READY', image: { url: 'https://cdn.shopify.com/1.jpg' } }, { status: 'READY', image: { url: 'https://cdn.shopify.com/2.jpg' } }];
  assert.deepEqual(P.shopifyCopies(ready, 2), ['https://cdn.shopify.com/1.jpg', 'https://cdn.shopify.com/2.jpg']);
  assert.equal(P.shopifyCopies(ready, 3), null);
  assert.equal(P.shopifyCopies([{ status: 'PROCESSING', image: { url: 'x' } }, ...ready], 2), null);
});

test('orphans are unreferenced files older than the waiting period', () => {
  const files = [
    { name: 'photos/a.jpg', created: new Date(now - 20 * DAY).toISOString() },
    { name: 'photos/b.jpg', created: new Date(now - 20 * DAY).toISOString() },
    { name: 'photos/c.jpg', created: new Date(now - 2 * DAY).toISOString() },
    { name: 'other/d.jpg', created: new Date(now - 90 * DAY).toISOString() }
  ];
  assert.deepEqual(P.orphanFiles(files, new Set(['photos/a.jpg']), now).map(f => f.name), ['photos/b.jpg']);
});
