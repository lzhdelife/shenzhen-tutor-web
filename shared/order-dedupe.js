'use strict';

function canonicalOrderText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

module.exports = { canonicalOrderText };
