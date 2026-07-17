'use strict';

function distancePoints(distanceKm, maxDistanceKm = 12) {
  const km = Number(distanceKm);
  if (!Number.isFinite(km) || km <= 0) return 0;

  const max = Math.max(1, Number(maxDistanceKm) || 12);
  if (km <= 3) return 30;
  if (km <= 5) return 25;
  if (km <= Math.min(8, max)) return 18;
  if (km <= max) return 10;
  if (km <= max * 1.5) return -10;
  if (km <= max * 2) return -22;
  return -35;
}

function scoreOrder(order = {}, settings = {}) {
  let value = 35;
  if (['宝安', '南山'].includes(order.district)) value += 10;
  if (/数学|物理|化学/.test(order.subject || '')) value += 12;
  if (/初|高|中考|高考/.test(order.grade || '')) value += 8;
  if (Number(order.price) >= 180 || Number(order.monthly) >= 20000) value += 10;
  else if (Number(order.price) > 0 && Number(order.price) < 140) value -= 10;

  value += distancePoints(order.distanceKm, settings.maxBikeKm);
  return Math.max(0, Math.min(100, Math.round(value)));
}

module.exports = { distancePoints, scoreOrder };
