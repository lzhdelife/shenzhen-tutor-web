(function exposeOrderScore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TutorOrderScore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createOrderScore() {
  'use strict';

  function hourlyRate(order = {}) {
    const explicit = Number(order.hourlyPrice);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;

    const price = Number(order.price);
    if (!Number.isFinite(price) || price <= 0) return 0;
    const duration = String(order.priceUnit || '').match(/^(\d+(?:\.\d+)?)\s*小时$/);
    if (duration && Number(duration[1]) > 0) return price / Number(duration[1]);
    return price;
  }

  function formatMoney(value) {
    const amount = Math.round(Number(value) * 100) / 100;
    return Number.isInteger(amount) ? String(amount) : String(amount).replace(/0+$/, '').replace(/\.$/, '');
  }

  function lessonPrice(order = {}) {
    const unit = String(order.priceUnit || '').trim();
    const monthly = Number(order.monthly);
    if (unit === '月' || (Number.isFinite(monthly) && monthly > 0)) {
      return monthly > 0 ? { min: monthly, max: monthly, unit: '月', hours: 0 } : null;
    }

    const min = Number(order.priceMin);
    const max = Number(order.priceMax);
    const price = Number(order.price);
    const hasRange = Number.isFinite(min) && min > 0 && Number.isFinite(max) && max > 0 && min !== max;
    const sessionUnit = /^(?:次|节|次课|节课)$/.test(unit);
    const durationMatch = unit.match(/^(\d+(?:\.\d+)?)\s*(?:小时|时|h)$/i);

    if (sessionUnit) {
      const sessionMin = hasRange ? min : price;
      const sessionMax = hasRange ? max : price;
      return sessionMin > 0 ? { min: sessionMin, max: sessionMax, unit: '次', hours: 0 } : null;
    }

    if (unit === '天') {
      return price > 0 ? { min: price, max: price, unit: '天', hours: 0 } : null;
    }

    if (hasRange) {
      const duration = durationMatch ? Number(durationMatch[1]) : 1;
      const factor = duration > 0 ? 2 / duration : 2;
      return { min: min * factor, max: max * factor, unit: '次', hours: 2 };
    }

    const hourly = hourlyRate(order);
    return hourly > 0 ? { min: hourly * 2, max: hourly * 2, unit: '次', hours: 2 } : null;
  }

  function lessonPriceLabel(order = {}) {
    const normalized = lessonPrice(order);
    if (!normalized) return '';
    const amount = normalized.min === normalized.max
      ? formatMoney(normalized.min)
      : `${formatMoney(normalized.min)}-${formatMoney(normalized.max)}`;
    return normalized.hours
      ? `${amount}元/次（2小时）`
      : `${amount}元/${normalized.unit}`;
  }

  function lessonPriceAmount(order = {}) {
    const normalized = lessonPrice(order);
    return normalized ? (normalized.min + normalized.max) / 2 : 0;
  }

  function pricePoints(order = {}) {
    const hourly = hourlyRate(order);
    if (hourly >= 300) return 50;
    if (hourly >= 250) return 45;
    if (hourly >= 200) return 40;
    if (hourly >= 150) return 30;
    if (hourly >= 100) return 20;
    if (hourly >= 50) return 10;
    return 0;
  }

  function distancePoints(distanceKm) {
    const km = Number(distanceKm);
    if (!Number.isFinite(km) || km <= 0) return 0;
    if (km <= 3) return 50;
    if (km <= 5) return 45;
    if (km <= 10) return 35;
    if (km <= 15) return 25;
    if (km <= 20) return 15;
    if (km <= 30) return 5;
    return 0;
  }

  function scoreOrder(order = {}) {
    return pricePoints(order) + distancePoints(order.distanceKm);
  }

  return { hourlyRate, lessonPrice, lessonPriceLabel, lessonPriceAmount, pricePoints, distancePoints, scoreOrder };
}));
