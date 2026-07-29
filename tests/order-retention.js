'use strict';

const assert = require('node:assert/strict');
const {
  orderExpiryCutoff,
  isExpiredOrder,
  millisecondsUntilShanghaiOrderReset
} = require('../shared/order-retention.js');

const beforeReset = Date.UTC(2026, 6, 24, 21, 59, 0); // 北京时间 7 月 25 日 05:59
assert.equal(orderExpiryCutoff(beforeReset).toISOString(), '2026-07-23T22:00:00.000Z');
assert.equal(isExpiredOrder({ createdAt: '2026-07-23T21:59:59.999Z' }, beforeReset), true);
assert.equal(isExpiredOrder({ createdAt: '2026-07-23T22:00:00.001Z' }, beforeReset), false);

const atReset = Date.UTC(2026, 6, 24, 22, 0, 0); // 北京时间 7 月 25 日 06:00
assert.equal(orderExpiryCutoff(atReset).toISOString(), '2026-07-24T22:00:00.000Z');
assert.equal(isExpiredOrder({ createdAt: '2026-07-24T21:59:59.999Z' }, atReset), true);
assert.equal(millisecondsUntilShanghaiOrderReset(Date.UTC(2026, 6, 24, 21, 0, 0)), 60 * 60 * 1000);
assert.equal(millisecondsUntilShanghaiOrderReset(Date.UTC(2026, 6, 24, 23, 0, 0)), 23 * 60 * 60 * 1000);
console.log('PASS daily 06:00 Shanghai order reset');
