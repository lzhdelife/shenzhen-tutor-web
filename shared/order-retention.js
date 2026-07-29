'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAILY_ORDER_RESET_HOUR = 6;

function orderExpiryCutoff(now = Date.now()) {
  const timestamp = Number(now);
  const shifted = new Date(timestamp + SHANGHAI_OFFSET_MS);
  let cutoff = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    DAILY_ORDER_RESET_HOUR
  ) - SHANGHAI_OFFSET_MS;
  if (cutoff > timestamp) cutoff -= DAY_MS;
  return new Date(cutoff);
}

function isExpiredOrder(order, now = Date.now()) {
  const createdAt = Date.parse(order?.createdAt || order?.created_at || '');
  return Number.isFinite(createdAt) && createdAt <= orderExpiryCutoff(now).getTime();
}

function millisecondsUntilShanghaiOrderReset(now = Date.now()) {
  const timestamp = Number(now);
  const shifted = new Date(timestamp + SHANGHAI_OFFSET_MS);
  let target = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    DAILY_ORDER_RESET_HOUR
  ) - SHANGHAI_OFFSET_MS;
  if (target <= timestamp) target += DAY_MS;
  return target - timestamp;
}

module.exports = {
  DAILY_ORDER_RESET_HOUR,
  orderExpiryCutoff,
  isExpiredOrder,
  millisecondsUntilShanghaiOrderReset
};
