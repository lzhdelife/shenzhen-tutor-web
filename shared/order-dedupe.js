'use strict';

function canonicalOrderText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function orderRawText(order) {
  return String(order?.raw || order?.structured?.raw || order?.structured?.rawText || '');
}

function dedupeOrdersByCanonicalRaw(orders) {
  const seen = new Set();
  return (Array.isArray(orders) ? orders : []).filter(order => {
    const canonical = canonicalOrderText(orderRawText(order));
    if (!canonical) return true;
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

module.exports = { canonicalOrderText, orderRawText, dedupeOrdersByCanonicalRaw };
