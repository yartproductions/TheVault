const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./ebaysell');
const L = require('./listing');

const gen = L.normalizeListing({
  type: 'Storage', title: 'Seagate Constellation ES.3 ST2000NM0033 2TB 3.5in SATA HDD', grade: 'For Parts',
  condition_text: 'untested drive with unknown health', included: 'Drive only',
  rows: [{ label: 'Brand', value: 'Seagate' }, { label: 'MPN', value: 'ST2000NM0033' }, { label: 'Capacity', value: '2TB' }, { label: 'Interface', value: 'SATA III' }, { label: 'Form Factor', value: '3.5"' }],
  metafields: { brand: 'Seagate', mpn: 'ST2000NM0033', storage: '2TB' }
}, L.listingInputs({ code: 'VR-00042', title: 'Seagate 2TB', condition: 'For Parts' }, { description: 'untested', returnPolicy: 'For parts / no returns' }));

const aspects = [
  { localizedAspectName: 'Brand', aspectConstraint: { aspectRequired: true, aspectMode: 'FREE_TEXT' } },
  { localizedAspectName: 'MPN', aspectConstraint: { aspectRequired: true, aspectMode: 'FREE_TEXT' } },
  { localizedAspectName: 'Storage Capacity', aspectConstraint: { aspectRequired: true, aspectMode: 'SELECTION_ONLY' }, aspectValues: [{ localizedValue: '1 TB' }, { localizedValue: '2TB' }, { localizedValue: '4 TB' }] },
  { localizedAspectName: 'Form Factor', aspectConstraint: { aspectRequired: true, aspectMode: 'FREE_TEXT' } },
  { localizedAspectName: 'Color', aspectConstraint: { aspectRequired: true, aspectMode: 'FREE_TEXT' } },
  { localizedAspectName: 'Interface', aspectConstraint: { aspectRequired: false, aspectUsage: 'RECOMMENDED', aspectMode: 'FREE_TEXT' } },
  { localizedAspectName: 'Features', aspectConstraint: { aspectRequired: false, aspectUsage: 'OPTIONAL' } }
];

test('item details are filled from the listing; what is missing is named', () => {
  const r = E.fillAspects(aspects, gen, {});
  assert.deepEqual(r.aspects.Brand, ['Seagate']);
  assert.deepEqual(r.aspects.MPN, ['ST2000NM0033']);
  assert.deepEqual(r.aspects['Storage Capacity'], ['2TB']);
  assert.deepEqual(r.aspects['Form Factor'], ['3.5"']);
  assert.deepEqual(r.aspects.Interface, ['SATA III']);
  assert.equal(r.aspects.Features, undefined);
  assert.deepEqual(r.missing.map(m => m.name), ['Color']);
  // the lister's own answer fills it
  assert.deepEqual(E.fillAspects(aspects, gen, { Color: 'Silver' }).missing, []);
});

test('selection-only details must use one of eBay’s values', () => {
  const r = E.fillAspects([{ localizedAspectName: 'Storage Capacity', aspectConstraint: { aspectRequired: true, aspectMode: 'SELECTION_ONLY' }, aspectValues: [{ localizedValue: '8 TB' }] }], gen, {});
  assert.deepEqual(r.missing.map(m => m.name), ['Storage Capacity']);
  assert.deepEqual(r.missing[0].options, ['8 TB']);
});

test('inventory item and offer bodies', () => {
  const item = E.inventoryItem({ gen, quantity: 1, photos: ['https://x/a.jpg', 'blob:bad'], aspects: { Brand: ['Seagate'] }, packageInfo: { weightLb: 1.5, lengthIn: 8, widthIn: 6, heightIn: 3 } });
  assert.equal(item.condition, 'FOR_PARTS_OR_NOT_WORKING');
  assert.match(item.conditionDescription, /Sold for parts or repair/);
  assert.deepEqual(item.product.imageUrls, ['https://x/a.jpg']);
  assert.equal(item.availability.shipToLocationAvailability.quantity, 1);
  assert.equal(item.packageWeightAndSize.weight.unit, 'POUND');
  assert.equal(item.product.brand, 'Seagate');
  assert.equal(item.product.mpn, 'ST2000NM0033');
  assert.deepEqual(item.product.aspects.MPN, ['ST2000NM0033']);
  assert.deepEqual(E.inventoryItem({ gen: { ...gen, metafields: { brand: 'Dell' } }, quantity: 1, photos: [], aspects: {} }).product, { title: gen.title, aspects: { Brand: ['Dell'], MPN: ['Does Not Apply'] }, imageUrls: [], brand: 'Dell', mpn: 'Does Not Apply' });
  const o = E.offer({ sku: 'VR-00042', categoryId: '56083', price: 44.9, quantity: 1, policies: { fulfillment: 'f', payment: 'p', returns: 'r' }, locationKey: 'main', descriptionHtml: '<p>x</p>' });
  assert.equal(o.pricingSummary.price.value, '44.90');
  assert.equal(o.marketplaceId, 'EBAY_US');
  assert.equal(o.listingPolicies.returnPolicyId, 'r');
  assert.equal(E.conditionFor({ ebay: { ebay_condition_code: '1000' } }), 'NEW');
});

test('readiness explains what stops a publish', () => {
  const p = E.readiness({ gen, price: 0, photos: [], settings: {}, connected: false, missingAspects: [{ name: 'Color' }] });
  assert.ok(p.some(x => /Connect eBay/.test(x)));
  assert.ok(p.some(x => /price/.test(x)));
  assert.ok(p.some(x => /photo/.test(x)));
  assert.ok(p.some(x => /policies/.test(x)));
  assert.ok(p.some(x => /Color/.test(x)));
  assert.deepEqual(E.readiness({ gen, price: 10, photos: ['https://x/a.jpg'], settings: { fulfillmentPolicyId: 1, paymentPolicyId: 2, returnPolicyId: 3, locationKey: 'main' }, connected: true, missingAspects: [], packageInfo: { lb: 1, oz: 8, l: 8, w: 6, h: 3 } }), []);
  assert.ok(p.some(x => /weight/.test(x)) && p.some(x => /box size/.test(x)));
  assert.deepEqual(E.packageOf({ lb: 1, oz: 8, l: 8, w: 6, h: 3 }), { weightLb: 1.5, lengthIn: 8, widthIn: 6, heightIn: 3 });
});

test('description uses the template with the report, photos and no-returns wording', () => {
  const html = E.descriptionHtml(gen, { photos: ['https://x/a.jpg', 'https://x/b.jpg'] });
  assert.match(html, /Gadget <b[^>]*>Flippers<\/b>/);
  assert.match(html, /Seagate Constellation ES\.3/);
  assert.match(html, /class="gf-report-parts"/);
  assert.match(html, /src="https:\/\/x\/a\.jpg"/);
  assert.match(html, /gf-gallery/);
  assert.match(html, /eBay buyer protection/);
  assert.doesNotMatch(html, /\{\{|\{if |Codisto|<script/i);
});

test('orders: paid lines with Vault SKUs, cancelled orders skipped, fees', () => {
  const order = { orderId: '1', orderPaymentStatus: 'PAID', lineItems: [
    { sku: 'VR-00042', quantity: 2, lineItemCost: { value: '90.00' }, deliveryCost: { shippingCost: { value: '20.00' } } },
    { sku: '', quantity: 1, lineItemCost: { value: '5.00' } }] };
  assert.deepEqual(E.orderLines(order).map(l => [l.sku, l.qty, l.price, l.shipping]), [['VR-00042', 2, 45, 10]]);
  assert.deepEqual(E.orderLines({ ...order, cancelStatus: { cancelState: 'CANCELED' } }), []);
  assert.deepEqual(E.orderLines({ ...order, orderPaymentStatus: 'PENDING' }), []);
  assert.equal(E.ebayFee(45, 10, 13.25), 7.59);
  assert.match(E.consentUrl('production', 'id', 'Ru-Name', 'st'), /^https:\/\/auth\.ebay\.com\/oauth2\/authorize\?client_id=id&redirect_uri=Ru-Name&response_type=code&scope=.*sell\.inventory/);
  assert.equal(E.listingUrl('sandbox', '123'), 'https://www.sandbox.ebay.com/itm/123');
});
