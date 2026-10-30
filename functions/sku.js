function vaultSku(code) {
  const sku = String(code || '').trim().toUpperCase();
  if (!/^VR-\d{5}$/.test(sku)) throw new Error('A valid VR record code is required.');
  return sku;
}

module.exports = { vaultSku };
