// Pure helpers for turning Shopify orders into Vault sales. No Firebase or network here,
// so everything in this file is covered by orders.test.js.
const crypto = require('node:crypto');

const IN_STOCK = new Set(['new', 'proc', 'prep', 'list']);
const VR_SKU = /^VR-\d{5}$/;

// Shopify signs each webhook with the app's client secret: base64(HMAC-SHA256(rawBody)).
function validShopifyHmac(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(String(header), 'base64'); } catch (e) { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const cents = n => Math.round(Number(n || 0) * 100);
const dollars = c => +(c / 100).toFixed(2);

// What one unit of a line actually sold for, after line-level and order-level discounts.
function unitPrice(line) {
  const qty = Math.max(1, Number(line.quantity) || 1);
  const allocations = Array.isArray(line.discount_allocations) ? line.discount_allocations : null;
  const discount = allocations
    ? allocations.reduce((sum, a) => sum + cents(a.amount), 0)
    : cents(line.total_discount);
  return dollars(Math.max(0, cents(line.price) * qty - discount) / qty);
}

// Same fee rule the Vault uses for the Shopify channel: 2.9% + $0.30.
function shopifyFee(price) {
  return price > 0 ? +(price * 0.029 + 0.3).toFixed(2) : 0;
}

// The Vault SKU on a line, if it has one.
function lineSku(line) {
  const sku = String(line && line.sku || '').trim().toUpperCase();
  return VR_SKU.test(sku) ? sku : '';
}

// Choose which in-stock units of a listing a line sold: lowest codes first, so the
// listing's own record (usually the lowest) goes last only if it is not the lowest.
function pickUnits(units, quantity) {
  return units
    .filter(u => u && IN_STOCK.has(u.status))
    .map(u => u.code)
    .sort()
    .slice(0, Math.max(0, quantity));
}

function buyerName(order) {
  const c = order.customer || {};
  const b = order.billing_address || {};
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || b.name || '';
  return String(name).trim() || 'Shopify customer';
}

// The local calendar date the order was placed, from Shopify's offset timestamp.
function orderDate(order) {
  const stamp = String(order.processed_at || order.created_at || '');
  return /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

module.exports = { IN_STOCK, validShopifyHmac, unitPrice, shopifyFee, lineSku, pickUnits, buyerName, orderDate };
