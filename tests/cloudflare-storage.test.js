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
    this.tables = { users: [], sessions: [], orders: [], order_locations: [], settings: [], feedback: [], announcements: [], clipboard_captures: [], visitor_activity: [], amap_usage: [], publisher_access: [] };
  }
  prepare(sql) { return new MockStatement(this, sql); }
  async batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
  async execute(sql, values) {
    const insert = sql.match(/^INSERT INTO (\w+) \(([^)]+)\)/i);
    if (insert) {
      const table = insert[1];
      const columns = insert[2].split(',').map(value => value.trim());
      const row = table === 'publisher_access'
        ? { user_id: values[0], display_name: values[1], contact: values[2], status: 'pending', requested_at: values[3], reviewed_at: null, updated_at: values[4] }
        : Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      if (table === 'visitor_activity') row.visit_count = 1;
      if (table === 'amap_usage') { row.call_count = 1; row.updated_at = values[3]; }
      const key = table === 'settings' ? 'key' : table === 'sessions' ? 'token_hash' : table === 'order_locations' ? 'order_id' : table === 'clipboard_captures' ? 'capture_id' : table === 'visitor_activity' ? 'visitor_id' : table === 'amap_usage' ? 'usage_date' : table === 'publisher_access' ? 'user_id' : 'id';
      const existing = this.tables[table].find(item => item[key] === row[key]);
      if (existing && /ON CONFLICT/i.test(sql)) {
        if (table === 'settings' && /CAST\(COALESCE\(CAST\(settings\.value_json AS INTEGER\)/i.test(sql)) {
          existing.value_json = String(Math.max(0, Number(existing.value_json) || 0) + 1);
          existing.updated_at = row.updated_at;
        } else if (table === 'visitor_activity') {
          existing.last_seen_at = row.last_seen_at;
          if (/visit_count=visitor_activity\.visit_count \+ 1/i.test(sql)) existing.visit_count++;
        } else if (table === 'amap_usage') {
          const match = this.tables.amap_usage.find(item => item.usage_date === row.usage_date && item.endpoint === row.endpoint && item.outcome === row.outcome);
          if (match) { match.call_count = Number(match.call_count || 0) + 1; match.updated_at = row.updated_at; }
          else this.tables.amap_usage.push(row);
        } else if (table === 'publisher_access') {
          const approved = existing.status === 'approved';
          Object.assign(existing, row, {
            status: approved ? 'approved' : 'pending',
            requested_at: approved ? existing.requested_at : row.requested_at,
            reviewed_at: approved ? existing.reviewed_at : null
          });
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
      const idColumn = /WHERE id\s*=\s*\?/i.test(sql) ? 'id' : /WHERE capture_id\s*=\s*\?/i.test(sql) ? 'capture_id' : /WHERE user_id\s*=\s*\?/i.test(sql) ? 'user_id' : null;
      if (!idColumn) return { success: true };
      const row = this.tables[table].find(item => item[idColumn] === values.at(-1));
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
    const tableMatch = sql.match(/FROM (users|sessions|settings|feedback|announcements|clipboard_captures|visitor_activity|amap_usage|publisher_access)/i);
    if (!tableMatch) throw new Error(`Unsupported mock query: ${sql}`);
    let rows = this.tables[tableMatch[1]].map(row => tableMatch[1] === 'amap_usage' ? { ...row, count: row.call_count } : { ...row });
    if (tableMatch[1] === 'publisher_access' && /display_name = \?.*contact = \?.*status = 'approved'/i.test(sql)) {
      rows = rows.filter(row => row.display_name === values[0] && row.contact === values[1] && row.status === 'approved');
    }
    if (/SELECT COUNT\(\*\) AS count FROM visitor_activity/i.test(sql)) {
      if (/last_seen_at >= \?/i.test(sql)) rows = rows.filter(row => row.last_seen_at >= values[0]);
      return [{ count: rows.length }];
    }
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
  const clipboardMigration = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'migrations', '0002_clipboard_shared.sql'), 'utf8');
  assert.match(clipboardMigration, /CREATE TABLE IF NOT EXISTS clipboard_captures\b/);
    const visitorMigration = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'migrations', '0003_visitor_activity.sql'), 'utf8');
  assert.match(visitorMigration, /CREATE TABLE IF NOT EXISTS visitor_activity\b/);
  const amapMigration = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'migrations', '0004_amap_usage.sql'), 'utf8');
  assert.match(amapMigration, /CREATE TABLE IF NOT EXISTS amap_usage\b/);
  const publisherMigration = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'migrations', '0005_publisher_access.sql'), 'utf8');
  assert.match(publisherMigration, /CREATE TABLE IF NOT EXISTS publisher_access\b/);
  const dropApplicationsMigration = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'migrations', '0006_drop_applications.sql'), 'utf8');
  assert.match(dropApplicationsMigration, /DROP TABLE IF EXISTS applications\b/);

  const db = new MockD1();
  const repo = createRepository({ DB: db });
  await repo.recordAmapUsage({ endpoint: '/v3/place/text', outcome: 'success', date: '2026-07-26' });
  await repo.recordAmapUsage({ endpoint: '/v3/place/text', outcome: 'success', date: '2026-07-26' });
  await repo.recordAmapUsage({ endpoint: '/v3/place/text', outcome: 'rate_limited', date: '2026-07-26' });
  assert.equal((await repo.getAmapUsage('2026-07-26')).total, 3);
  assert.equal((await repo.getAmapUsage('2026-07-26')).limited, 1);
  const agency = await repo.createUser({ id: 'u-agency', role: 'agency', name: '测试机构', phone: ['138', '0000', '0000'].join(''), passwordHash: 'salt:hash' });
  const teacher = await repo.createUser({ id: 'u-teacher', role: 'teacher', name: '测试老师', phone: ['139', '0000', '0000'].join(''), preferences: { minPrice: 300 } });
  assert.equal((await repo.getUserByPhone(agency.phone)).id, agency.id);
  assert.deepEqual(teacher.preferences, { minPrice: 300 });
  assert.equal((await repo.listUsers({ role: 'teacher' }))[0].id, teacher.id);

  const pendingAccess = await repo.submitPublisherAccess(agency.id, '测试称呼', 'wechat-test');
  assert.equal(pendingAccess.status, 'pending');
  assert.equal((await repo.listPublisherAccess())[0].userId, agency.id);
  const approvedAccess = await repo.setPublisherAccessStatus(agency.id, 'approved');
  assert.equal(approvedAccess.status, 'approved');
  assert.ok(approvedAccess.reviewedAt);
  assert.equal((await repo.findApprovedPublisherAccess('测试称呼', 'wechat-test')).userId, agency.id);
  assert.equal(await repo.findApprovedPublisherAccess('测试称呼', 'wrong-contact'), null);
  assert.equal((await repo.submitPublisherAccess(agency.id, '新称呼', 'new-contact')).status, 'approved');

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
  assert.equal(db.tables.orders[0].structured_json.includes('合成测试订单'), true);
  assert.equal(order.place, '科技园');
  assert.equal(order.locationVerified, true);
  assert.deepEqual(order.locationCandidates, [{ name: '科技园' }]);
  assert.equal(db.tables.orders[0].status, 'open');
  assert.equal((await repo.listOrders({ status: 'open' })).length, 1);

  const flatSnapshot = db.tables.orders[0].structured_json;
  db.tables.orders[0].structured_json = JSON.stringify({
    rawText: '宝安区科技园，高三数学，300元每2小时。', normalizedText: '宝安区科技园，高三数学，300元每2小时。',
    parserVersion: '2.2.0', gradeContext: { value: '高三', confidence: 0.9 },
    studentSituation: { value: '女生，基础一般', confidence: 0.75 }, studentGender: { value: '女', confidence: 0.95 },
    teacherGender: { value: '女老师', confidence: 0.95 }, priceMin: { value: 300, rawEvidence: '300元每2小时' },
    priceMax: { value: 300 }, priceApproximate: { value: false }, priceUnit: { value: '2小时', rawEvidence: '300元每2小时' },
    schedulePhases: [{ rawEvidence: '每周两次' }], requirements: { value: ['有经验', '认真负责'] }
  });
  const evidenceOrder = await repo.getOrderById(order.id);
  assert.equal(evidenceOrder.raw, '宝安区科技园，高三数学，300元每2小时。');
  assert.equal(evidenceOrder.priceUnit, '2小时');
  assert.equal(evidenceOrder.studentGender, '女');
  assert.equal(evidenceOrder.student, '女生，基础一般');
  assert.equal(evidenceOrder.requirements, '有经验、认真负责');
  assert.equal(evidenceOrder.structured.parserVersion, '2.2.0');
  db.tables.orders[0].structured_json = flatSnapshot;

  await repo.setSetting('maxBikeKm', 12);
  await repo.setSetting('adminPasswordHash', 'must-not-leak');
  assert.equal(await repo.incrementSetting('totalVisits'), 1);
  assert.equal(await repo.incrementSetting('totalVisits'), 2);
  await repo.recordVisitorVisit('visitor-one', 1000);
  await repo.recordVisitorVisit('visitor-one', 2000);
  await repo.touchVisitor('visitor-two', 2500);
  assert.deepEqual(await repo.getVisitorStats(1500), { totalVisitors: 2, onlineVisitors: 2 });
  assert.equal(db.tables.visitor_activity.find(row => row.visitor_id === 'visitor-one').visit_count, 2);
  await repo.createAnnouncement({ id: 'n-one', title: '测试公告', content: '仅合成内容', active: true });
  const state = await repo.getPublicState();
  assert.equal(state.settings.maxBikeKm, 12);
  assert.equal(state.settings.adminPasswordHash, undefined);
  assert.equal(state.adminConfigured, true);
  assert.equal(state.announcement.title, '测试公告');
  assert.equal(state.orders[0].id, order.id);

  const capture = await repo.createClipboardCapture({ captureId: 'capture-storage-1', text: 'clipboard order' });
  assert.equal(capture.status, 'pending');
  assert.equal((await repo.listClipboardCaptures()).length, 1);
  await repo.completeClipboardCapture(capture.captureId);
  assert.equal((await repo.getClipboardCapture(capture.captureId)).status, 'completed');

  console.log('cloudflare storage tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
