'use strict';

const ORDER_RETENTION_DAYS = 2;
const ORDER_RETENTION_MS = ORDER_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function orderExpiryCutoff(now = Date.now()) {
  return new Date(Number(now) - ORDER_RETENTION_MS);
}

function isExpiredOrder(order, now = Date.now()) {
  const createdAt = Date.parse(order?.createdAt || order?.created_at || '');
  return Number.isFinite(createdAt) && createdAt <= orderExpiryCutoff(now).getTime();
}

function millisecondsUntilShanghaiNoon(now = Date.now()) {
  const chinaOffset = 8 * 60 * 60 * 1000;
  const shifted = new Date(Number(now) + chinaOffset);
  let target = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 12) - chinaOffset;
  if (target <= Number(now)) target += 24 * 60 * 60 * 1000;
  return target - Number(now);
}

module.exports = {
  ORDER_RETENTION_DAYS,
  ORDER_RETENTION_MS,
  orderExpiryCutoff,
  isExpiredOrder,
  millisecondsUntilShanghaiNoon
};
