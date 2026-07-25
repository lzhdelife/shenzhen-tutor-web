'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { buildImportSql, orderFingerprint } = require('../scripts/build-d1-import.js');
const { canonicalOrderText } = require('../shared/order-dedupe.js');

test('D1 import converts local orders into idempotent private SQL', () => {
  const raw = '【南山区】初二数学，200 元 / 小时';
  const db = {
    settings: { maxBikeKm: 12, adminPasswordHash: 'must-not-migrate' },
    users: [{ id: 'agency-1', role: 'agency', name: "测试'机构", phone: '', passwordHash: 'legacy-hash', preferences: {} }],
    orders: [{
      id: 'order-1', agencyId: 'agency-1', source: "测试'机构", status: 'open', district: '南山',
      subject: '数学', grade: '初二', price: 200, raw, applicants: [], createdAt: '2026-07-25T00:00:00.000Z'
    }]
  };
  const result = buildImportSql(db, { generatedAt: '2026-07-25T01:00:00.000Z' });
  const expected = crypto.createHash('sha256').update(canonicalOrderText(raw)).digest('hex');
  assert.equal(orderFingerprint(db.orders[0]), expected);
  assert.deepEqual(result.summary, { users: 1, orders: 1, feedback: 0 });
  assert.match(result.sql, /INSERT OR IGNORE INTO users/);
  assert.match(result.sql, /INSERT OR IGNORE INTO orders/);
  assert.match(result.sql, new RegExp(expected));
  assert.match(result.sql, /测试''机构/);
  assert.doesNotMatch(result.sql, /legacy-hash|must-not-migrate/);
});

test('D1 import rejects orders whose owner is missing', () => {
  assert.throws(() => buildImportSql({ users: [], orders: [{ id: 'order-1', agencyId: 'missing' }] }), /missing users/i);
});
