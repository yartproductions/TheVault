// Biweekly photo cleanup rules. Pure functions (no Firebase / network), tested in photos.test.js.
//
// A Firebase photo is only ever removed when it is safe to:
//   swap   — the item's photos are on Shopify and Shopify finished copying them (READY):
//            the Vault switches to Shopify's copies, then the Firebase files go.
//   delete — the item has been sold or archived for `soldDays`, and its photos aren't on Shopify.
//   orphan — a file in photos/ that no item references, older than `orphanDays`.
// Photos of in-stock items that aren't confirmed on Shopify are never touched.

const STOCK = new Set(['new', 'proc', 'prep', 'list']);

// "https://firebasestorage.googleapis.com/v0/b/<bucket>/o/photos%2Fa.jpg?alt=media&token=…" → "photos/a.jpg"
function storagePath(url) {
  const m = String(url || '').match(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/([^?]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
const isFirebasePhoto = url => !!storagePath(url);
const isShopifyCdn = url => /^https:\/\/cdn\.shopify\.com\//i.test(String(url || ''));

// When the item stopped being stock (sale date, else last update).
function endedAt(item) {
  const d = (item.sale && item.sale.date) || item.archivedAt || item.updatedAt || '';
  const t = Date.parse(d);
  return isFinite(t) ? t : null;
}

// What to do with one item's photos.
function planItem(item, now, opts = {}) {
  const soldDays = opts.soldDays || 30;
  const pk = item.packet || {};
  const photos = (pk.photos || []).filter(isFirebasePhoto);
  if (!photos.length) return { action: 'keep', reason: 'no Firebase photos' };
  const sent = new Set(pk.shopifyMediaSent || []);
  if (pk.shopifyId && photos.every(u => sent.has(u))) return { action: 'swap', photos, shopifyId: pk.shopifyId };
  if (!STOCK.has(item.status)) {
    const ended = endedAt(item);
    if (ended != null && now - ended >= soldDays * 864e5) return { action: 'delete', photos };
    return { action: 'keep', reason: `${item.status === 'arch' ? 'archived' : 'sold'} less than ${soldDays} days ago` };
  }
  return { action: 'keep', reason: 'in stock and not on Shopify yet' };
}

// Shopify's copies, in order, once every one of them is READY and there are at least as many as we sent.
function shopifyCopies(mediaNodes, expected) {
  const images = (mediaNodes || []).filter(n => n && n.image && n.image.url);
  if (images.length < expected) return null;
  if (images.some(n => n.status !== 'READY')) return null;
  return images.map(n => n.image.url);
}

// Files in photos/ that no item uses, older than orphanDays.
function orphanFiles(files, referencedPaths, now, orphanDays = 14) {
  return (files || []).filter(f => f.name.startsWith('photos/') && !referencedPaths.has(f.name) && now - Date.parse(f.created) >= orphanDays * 864e5);
}

// ── Matching Vault photos to the images already on a Shopify product ──
// Vault uploads are named photos/<ms>-<id>.<ext>; Shopify keeps that file name (adding _<uuid> when
// the same name is uploaded again), so the name tells us which photos a product already has.
const baseName = path => String(path || '').split('?')[0].split('/').pop().replace(/\.[a-z0-9]+$/i, '').toLowerCase();
function photoKey(url) { const p = storagePath(url); return p ? baseName(p) : ''; }
function shopifyKey(url) { return isShopifyCdn(url) ? baseName(url).replace(/_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, '').replace(/_[0-9a-f]{6,}$/i, '') : ''; }
const VAULT_NAME = /^\d{12,}-[a-z0-9]+$/i;

// Which Vault photos still need sending, and which Shopify images are repeat copies of a Vault photo.
// nodes: product media [{ id, status, image: { url }, preview: { image: { url } } }].
function planMedia(photoUrls, nodes, sentUrls) {
  const sent = new Set(sentUrls || []);
  const groups = new Map();
  for (const n of nodes || []) {
    const url = (n.image && n.image.url) || (n.preview && n.preview.image && n.preview.image.url) || '';
    const key = shopifyKey(url);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const toAdd = (photoUrls || []).filter(url => !sent.has(url) && !groups.has(photoKey(url)));
  const duplicates = [];
  for (const [key, list] of groups) {
    if (!VAULT_NAME.test(key) || list.length < 2) continue;
    list.slice(1).filter(n => n.status === 'READY').forEach(n => duplicates.push(n.id));
  }
  return { toAdd, duplicates };
}

module.exports = { photoKey, shopifyKey, planMedia, storagePath, isFirebasePhoto, isShopifyCdn, planItem, shopifyCopies, orphanFiles };
