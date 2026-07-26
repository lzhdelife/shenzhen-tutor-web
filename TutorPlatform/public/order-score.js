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

  return { hourlyRate, pricePoints, distancePoints, scoreOrder };
}));
