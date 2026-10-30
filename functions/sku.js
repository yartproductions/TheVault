function vaultSku(code) {
  const sku = String(code || '').trim().toUpperCase();
  if (!/^VR-\d{5}$/.test(sku)) throw new Error('A valid VR record code is required.');
  return sku;
}

// The units a listing covers: always the listing's own record first, then
// any other valid VR codes, de-duplicated, capped at 100.
function listingUnits(main, units) {
  const sku = vaultSku(main);
  const out = [sku];
  for (const code of Array.isArray(units) ? units : []) {
    let c; try { c = vaultSku(code); } catch (e) { continue; }
    if (!out.includes(c)) out.push(c);
    if (out.length >= 100) break;
  }
  return out;
}

module.exports = { vaultSku, listingUnits };
