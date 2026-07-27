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

function semanticOrderFingerprint(order = {}) {
  const district = canonicalOrderText(order.district).replace(/区$/, '');
  const place = canonicalOrderText(order.place || order.address);
  const grade = canonicalOrderText(order.grade);
  const subject = canonicalOrderText(order.subject);
  const schedule = canonicalOrderText(order.schedule);
  if (!place || !grade || !subject || !schedule || grade === '其他' || subject === '其他') return '';

  const monthly = Number(order.monthly || 0);
  let compensation = '';
  if (monthly > 0) {
    compensation = `monthly:${Math.round(monthly / 100)}`;
  } else {
    const price = Number(order.price || 0);
    const priceMin = Number(order.priceMin || price);
    const priceMax = Number(order.priceMax || price);
    if (!(priceMin > 0) || !(priceMax > 0)) return '';
    const hourlyPrice = Number(order.hourlyPrice || 0);
    const unit = canonicalOrderText(order.priceUnit) || '未标明';
    compensation = [
      `price:${Math.round(priceMin / 5)}-${Math.round(priceMax / 5)}`,
      `hourly:${hourlyPrice > 0 ? Math.round(hourlyPrice / 5) : 'unknown'}`,
      `unit:${unit}`
    ].join('|');
  }

  return [`location:${district}|${place}`, `grade:${grade}`, `subject:${subject}`, compensation, `schedule:${schedule}`].join('|');
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

module.exports = { canonicalOrderText, orderRawText, semanticOrderFingerprint, dedupeOrdersByCanonicalRaw };
