'use strict';

const assert = require('node:assert/strict');
const {
  ORDER_RETENTION_MS,
  isExpiredOrder,
  millisecondsUntilShanghaiNoon
} = require('../shared/order-retention.js');

const now = Date.UTC(2026, 6, 25, 5, 0, 0);
assert.equal(isExpiredOrder({ createdAt: new Date(now - ORDER_RETENTION_MS - 1).toISOString() }, now), true);
assert.equal(isExpiredOrder({ createdAt: new Date(now - ORDER_RETENTION_MS + 1).toISOString() }, now), false);
assert.equal(millisecondsUntilShanghaiNoon(Date.UTC(2026, 6, 25, 3, 0, 0)), 60 * 60 * 1000);
assert.equal(millisecondsUntilShanghaiNoon(Date.UTC(2026, 6, 25, 5, 0, 0)), 23 * 60 * 60 * 1000);
console.log('PASS order retention and Shanghai noon schedule');
