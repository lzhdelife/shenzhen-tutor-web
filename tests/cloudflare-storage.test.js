'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRepository } = require('../cloudflare/storage');

class MockStatement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() { return this.db.execute(this.sql, this.values); }
  async first() { return (await this.db.query(this.sql, this.values))[0] || null; }
  async all() { return { results: await this.db.query(this.sql, this.values) }; }
}

class MockD1 {
  constructor() {
    this.tables = { users: [], sessions: [], orders: [], order_locations: [], settings: [], applications: [], feedback: [], announcements: [] };
  }
  prepare(sql) { return new MockStatement(this, sql); }
  async batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
  async execute(sql, values) {
    const insert = sql.match(/^INSERT INTO (\w+) \(([^)]+)\)/i);
    if (insert) {
      const table = insert[1];
      const columns = insert[2].split(',').map(value => value.trim());
      const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      const key = table === 'settings' ? 'key' : table === 'sessions' ? 'token_hash' : table === 'order_locations' ? 'order_id' : 'id';
      const existing = this.tables[table].find(item => item[key] === row[key]);
      if (existing && /ON CONFLICT/i.test(sql)) {
        if (table === 'settings' && /CAST\(COALESCE\(CAST\(settings\.value_json AS INTEGER\)/i.test(sql)) {
          existing.value_json = String(Math.max(0, Number(existing.value_json) || 0) + 1);
          existing.updated_at = row.updated_at;
        } else Object.assign(existing, row);
      }
      else if (existing) throw new Error(`mock unique constraint: ${table}.${key}`);
      else this.tables[table].push(row);
      return { success: true, meta: { changes: 1 } };
    }
    const update = sql.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/i);
    if (update) {
      const table = update[1];
      if (table === 'announcements' && /active = 0 WHERE active = 1/i.test(sql)) {
        this.tables.announcements.filter(row => row.active === 1).forEach(row => { row.active = 0; });
        return { success: true };
      }
      const idColumn = /WHERE id\s*=\s*\?/i.test(sql) ? 'id' : null;
      if (!idColumn) return { success: true };
      const row = this.tables[table].find(item => item.id === values.at(-1));
      if (row) {
        const assignments = update[2].split(',').map(value => value.trim()).filter(value => /\?/.test(value));
        assignments.forEach((assignment, index) => { row[assignment.split('=')[0].trim()] = values[index]; });
      }
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    const deletion = sql.match(/^DELETE FROM (\w+) WHERE (\w+) = \?/i);
    if (deletion) {
      const [, table, key] = deletion;
      this.tables[table] = this.tables[table].filter(row => row[key] !== values[0]);
      return { success: true };
    }
    throw new Error(`Unsupported mock SQL: ${sql}`);
  }
  async query(sql, values) {
    if (/FROM orders o LEFT JOIN order_locations/i.test(sql)) {
      let rows = this.tables.orders.map(order => {
        const location = this.tables.order_locations.find(item => item.order_id === order.id) || {};
        const { status: location_row_status, order_id: _orderId, ...locationColumns } = location;
        return { ...order, ...locationColumns, location_row_status };
      });
      if (/WHERE o.id = \?/i.test(sql)) rows = rows.filter(row => row.id === values[0]);
      if (/WHERE o.status = \?/i.test(sql)) rows = rows.filter(row => row.status === values[0]);
      return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    const tableMatch = sql.match(/FROM (users|sessions|settings|applications|feedback|announcements)/i);
    if (!tableMatch) throw new Error(`Unsupported mock query: ${sql}`);
    let rows = this.tables[tableMatch[1]].map(row => ({ ...row }));
    const where = sql.match(/WHERE (\w+) = \?/i);
    if (where) rows = rows.filter(row => row[where[1]] === values[0]);
    if (/sessions/i.test(tableMatch[1]) && /expires_at > \?/i.test(sql)) rows = rows.filter(row => row.expires_at > values[1]);
    return rows;
  }
}

async function run() {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'migrations', '0001_initial.sql'), 'utf8');
  for (const table of ['users', 'orders', 'order_locations', 'applications', 'sessions', 'settings', 'feedback', 'announcements']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(migration, /structured_json TEXT NOT NULL/);
  assert.match(migration, /token_hash TEXT PRIMARY KEY/);

  const db = new MockD1();
  const repo = createRepository({ DB: db });
  const agency = await repo.createUser({ id: 'u-agency', role: 'agency', name: '测试机构', phone: ['138', '0000', '0000'].join(''), passwordHash: 'salt:hash' });
  const teacher = await repo.createUser({ id: 'u-teacher', role: 'teacher', name: '测试老师', phone: ['139', '0000', '0000'].join(''), preferences: { minPrice: 300 } });
  assert.equal((await repo.getUserByPhone(agency.phone)).id, agency.id);
  assert.deepEqual(teacher.preferences, { minPrice: 300 });
  assert.equal((await repo.listUsers({ role: 'teacher' }))[0].id, teacher.id);

  await assert.rejects(() => repo.createSession({ userId: teacher.id, expiresAt: Date.now() + 1000 }), /tokenHash is required/);
  await repo.createSession({ tokenHash: 'sha256-only', userId: teacher.id, expiresAt: Date.now() + 60_000 });
  assert.equal((await repo.getSessionByTokenHash('sha256-only')).userId, teacher.id);
  assert.equal(db.tables.sessions[0].token_hash, 'sha256-only');

  const order = await repo.createOrder({
    id: 'o-one', agencyId: agency.id, source: agency.name, status: 'open', district: '南山', subject: '数学',
    grade: '高一', price: 500, raw: '合成测试订单', schedule: '周末', place: '科技园', address: '深圳市南山区科技园',
    locationVerified: true, locationCoordinates: '113.9,22.5', locationCandidates: [{ name: '科技园' }]
  });
  assert.equal(order.raw, '合成测试订单');
  assert.equal(order.place, '科技园');
  assert.equal(order.locationVerified, true);
  assert.deepEqual(order.locationCandidates, [{ name: '科技园' }]);
  assert.equal(db.tables.orders[0].status, 'open');
  assert.equal((await repo.listOrders({ status: 'open' })).length, 1);

  const application = await repo.createApplication({ id: 'a-one', orderId: order.id, teacherId: teacher.id, name: teacher.name, phone: teacher.phone, note: '有经验' });
  assert.equal(application.status, 'pending');
  assert.equal((await repo.listApplications({ orderId: order.id })).length, 1);

  await repo.setSetting('maxBikeKm', 12);
  await repo.setSetting('adminPasswordHash', 'must-not-leak');
  assert.equal(await repo.incrementSetting('totalVisits'), 1);
  assert.equal(await repo.incrementSetting('totalVisits'), 2);
  await repo.createAnnouncement({ id: 'n-one', title: '测试公告', content: '仅合成内容', active: true });
  await repo.createFeedback({ id: 'f-one', name: '访客', content: '测试反馈' });
  const state = await repo.getPublicState();
  assert.equal(state.settings.maxBikeKm, 12);
  assert.equal(state.settings.adminPasswordHash, undefined);
  assert.equal(state.adminConfigured, true);
  assert.equal(state.announcement.title, '测试公告');
  assert.equal(state.orders[0].id, order.id);
  assert.equal((await repo.listFeedback())[0].content, '测试反馈');

  console.log('cloudflare storage tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
