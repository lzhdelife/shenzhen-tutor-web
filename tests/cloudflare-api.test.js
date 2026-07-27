'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorker } = require('../cloudflare/worker.js');
const { sha256, clientPasswordProof } = require('../cloudflare/auth.js');

function memoryRepository() {
  const state = { users: new Map(), sessions: new Map(), orders: new Map(), settings: {}, objects: new Map(), announcements: [], clipboard: new Map(), visitors: new Map(), publisherAccess: new Map(), orderIssueReports: new Map() };
  return {
    state,
    async getUserById(id) { return state.users.get(id) || null; },
    async getUserByPhone(phone) { return [...state.users.values()].find(user => user.phone === phone) || null; },
    async createUser(input) { const user = { preferences: {}, createdAt: new Date().toISOString(), ...input }; state.users.set(user.id, user); return user; },
    async updateUser(id, patch) { Object.assign(state.users.get(id), patch); return state.users.get(id); },
    async createSession(input) { state.sessions.set(input.tokenHash, input); return input; },
    async getSessionByTokenHash(hash) { const session = state.sessions.get(hash); return session && session.expiresAt > Date.now() ? session : null; },
    async deleteSessionByTokenHash(hash) { state.sessions.delete(hash); },
    async getPublicState() { return { settings: state.settings, orders: [...state.orders.values()], announcement: state.announcements.at(-1) || null }; },
    async createOrder(input) { const order = { ...input, id: input.id || `o-${state.orders.size + 1}`, createdAt: new Date().toISOString() }; state.orders.set(order.id, order); return order; },
    async getOrderById(id) { return state.orders.get(id) || null; },
    async listOrders() { return [...state.orders.values()]; },
    async updateOrder(id, patch) { Object.assign(state.orders.get(id), patch); return state.orders.get(id); },
    async deleteOrder(id) { state.orders.delete(id); },
    async deleteOrdersByIds(ids) {
      let deleted = 0;
      for (const id of new Set(ids)) {
        if (!state.orders.delete(id)) continue;
        deleted++;
      }
      return deleted;
    },
    async getSettings() { return { ...state.settings }; },
    async setSetting(key, value) { state.settings[key] = value; return value; },
    async incrementSetting(key) { state.settings[key] = Math.max(0, Number(state.settings[key]) || 0) + 1; return state.settings[key]; },
    async recordVisitorVisit(id) { const item = state.visitors.get(id); state.visitors.set(id, item ? { ...item, lastSeenAt: Date.now(), visits: item.visits + 1 } : { lastSeenAt: Date.now(), visits: 1 }); },
    async touchVisitor(id) { const item = state.visitors.get(id); state.visitors.set(id, { ...item, lastSeenAt: Date.now(), visits: item?.visits || 1 }); },
    async getVisitorStats(since) { const values = [...state.visitors.values()]; return { totalVisitors: values.length, onlineVisitors: values.filter(item => item.lastSeenAt >= since).length }; },
    async getPublisherAccess(userId) { return state.publisherAccess.get(userId) || null; },
    async findApprovedPublisherAccess(displayName, contact) { return [...state.publisherAccess.values()].find(item => item.displayName === displayName && item.contact === contact && item.status === 'approved') || null; },
    async submitPublisherAccess(userId, displayName, contact) {
      const existing = state.publisherAccess.get(userId);
      const item = { userId, displayName, contact, status: existing?.status === 'approved' ? 'approved' : 'pending', requestedAt: existing?.requestedAt || new Date().toISOString(), reviewedAt: existing?.reviewedAt || null, updatedAt: new Date().toISOString() };
      state.publisherAccess.set(userId, item);
      return item;
    },
    async listPublisherAccess() { return [...state.publisherAccess.values()].sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1)); },
    async setPublisherAccessStatus(userId, status) { const item = state.publisherAccess.get(userId); if (!item) return null; Object.assign(item, { status, reviewedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); return item; },
    async upsertOrderIssueReport(input) {
      const key = `${input.targetKey}|${input.reporterKey}`;
      const existing = state.orderIssueReports.get(key);
      const timestamp = new Date().toISOString();
      const report = existing ? Object.assign(existing, input, { updatedAt: timestamp })
        : { id: `oir-${state.orderIssueReports.size + 1}`, ...input, createdAt: timestamp, updatedAt: timestamp };
      state.orderIssueReports.set(key, report);
      return report;
    },
    async listOrderIssueReports() { return [...state.orderIssueReports.values()]; },
    async deleteExportedOrderIssueReports(reports) {
      const refs = new Set(reports.map(report => `${report.id}\n${report.updatedAt}`));
      let deleted = 0;
      for (const [key, report] of state.orderIssueReports) {
        if (!refs.has(`${report.id}\n${report.updatedAt}`)) continue;
        state.orderIssueReports.delete(key);
        deleted++;
      }
      return deleted;
    },
    async listAnnouncements() { return state.announcements; },
    async createAnnouncement(input) { state.announcements.push(input); return input; },
    async createClipboardCapture(input) { const existing = state.clipboard.get(input.captureId); if (existing) return existing; const capture = { ...input, status: 'pending', attempts: 0 }; state.clipboard.set(input.captureId, capture); return capture; },
    async getClipboardCapture(id) { return state.clipboard.get(id) || null; },
    async listClipboardCaptures() { return [...state.clipboard.values()].filter(item => item.status === 'pending'); },
    async completeClipboardCapture(id, outcome = 'completed') { const item = state.clipboard.get(id); if (item) item.status = outcome; return item || null; },
    async failClipboardCapture(id, message) { const item = state.clipboard.get(id); if (item) { item.attempts++; item.lastError = message; } return item || null; },
    async deleteClipboardCapturesOlderThan() { return 0; },
  };
}

function approvePublisher(repo, agency) {
  repo.state.publisherAccess.set(agency.id, { userId: agency.id, displayName: agency.name || '测试发单人', contact: 'test-contact', status: 'approved', requestedAt: new Date().toISOString(), reviewedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

test('访问量按页面打开持久累计并出现在公共状态中', async () => {
  const { call } = harness();
  assert.deepEqual(await (await call('/api/visit', { method: 'POST' })).json(), { totalVisits: 1 });
  assert.deepEqual(await (await call('/api/visit', { method: 'POST' })).json(), { totalVisits: 2 });
  assert.deepEqual(await (await call('/api/stats')).json(), { totalVisits: 2 });
  const state = await (await call('/api/state')).json();
  assert.deepEqual(state.stats, { totalVisits: 2 });
});

test('管理端统计按访客去重并通过心跳计算在线人数', async () => {
  const { call, repo } = harness();
  const headers = id => ({ 'x-visitor-id': id });
  await call('/api/visit', { method: 'POST', headers: headers('visitor-one') });
  await call('/api/visit', { method: 'POST', headers: headers('visitor-one') });
  await call('/api/presence', { method: 'POST', headers: headers('visitor-two') });
  assert.equal((await call('/api/admin/stats')).status, 401);

  const password = 'admin-test-password';
  const setupResponse = await call('/api/admin/setup', { method: 'POST', body: {
    password,
    passwordProof: await clientPasswordProof(password, 'admin', '')
  } });
  const setupCookie = setupResponse.headers.get('set-cookie').split(';')[0];
  const setup = await setupResponse.json();
  const rememberedResponse = await call('/api/admin/remember-login', { method: 'POST', headers: { cookie: setupCookie } });
  assert.equal(rememberedResponse.status, 200);
  assert.match(rememberedResponse.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.ok((await rememberedResponse.json()).token);
  assert.equal((await call('/api/admin/remember-login', { method: 'POST' })).status, 401);
  const response = await call('/api/admin/stats', { headers: { authorization: `Bearer ${setup.token}` } });
  assert.deepEqual(await response.json(), { totalVisitors: 2, onlineVisitors: 2, totalVisits: 2 });

  await repo.createOrder({ id: 'quality-order', agencyId: 'missing-agency', rawText: '南山区科技园，初二数学，每周两次。', district: '南山', place: '科技园', subject: '数学', grade: '初二' });

  const adminState = await (await call('/api/state', { headers: { authorization: `Bearer ${setup.token}` } })).json();
  assert.equal(adminState.orders[0].raw, '南山区科技园，初二数学，每周两次。');
  assert.deepEqual(adminState.orders[0].qualityIssues.map(issue => issue.code), ['raw_recovered']);
  assert.equal('users' in adminState, false);
  assert.equal('feedback' in adminState, false);
  assert.equal((await call('/api/feedback', { method: 'POST', body: { content: 'test' } })).status, 404);
  assert.equal((await call('/api/admin/reset-password', { method: 'POST', headers: { authorization: `Bearer ${setup.token}` }, body: {} })).status, 404);
  assert.equal((await call('/api/admin/batch-delete-users', { method: 'POST', headers: { authorization: `Bearer ${setup.token}` }, body: {} })).status, 404);
});

function harness(extra = {}, envOverrides = {}) {
  const repo = memoryRepository();
  const worker = createWorker({ createRepository: () => repo, ...extra });
  const call = (path, init = {}) => worker.fetch(new Request(`https://example.test${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    body: init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body
  }), { AUTH_PEPPER: 'unit-test-pepper', ASSETS: { fetch: () => new Response('asset') }, ...envOverrides }, {});
  return { repo, call, worker };
}

test('万科天誉地点下拉返回多个真实候选且无 Key 明确失败', async () => {
  const pois = [
    { id: 'vanke-longgang', name: '万科天誉花园', adname: '龙岗区', address: '龙岗大道与吉祥路交汇处', location: '114.2471,22.7208', type: '商务住宅;住宅区' },
    { id: 'vanke-plaza', name: '万科广场(龙岗店)', adname: '龙岗区', address: '龙翔大道7188号', location: '114.2463,22.7201', type: '购物服务;商场' }
  ];
  const configured = harness({ fetchImpl: async url => {
    assert.match(decodeURIComponent(url), /深圳市万科天誉/);
    return new Response(JSON.stringify({ status: '1', pois }), { status: 200, headers: { 'content-type': 'application/json' } });
  } }, { AMAP_WEB_SERVICE_KEY: 'synthetic-test-value' });
  const response = await configured.call('/api/location-suggestions?q=%E6%B7%B1%E5%9C%B3%E5%B8%82%E4%B8%87%E7%A7%91%E5%A4%A9%E8%AA%89');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'candidates');
  assert.equal(body.suggestions.length, 2);
  assert.deepEqual(body.suggestions.map(item => [item.name, item.district, item.address]), [
    ['万科天誉花园', '龙岗', '龙岗大道与吉祥路交汇处'],
    ['万科广场(龙岗店)', '龙岗', '龙翔大道7188号']
  ]);
  assert.equal(body.suggestions[0].value, '深圳市龙岗区龙岗大道与吉祥路交汇处');
  assert.equal(body.suggestions[0].location, '114.2471,22.7208');

  const missing = harness();
  const missingResponse = await missing.call('/api/location-suggestions?q=%E6%B7%B1%E5%9C%B3%E5%B8%82%E4%B8%87%E7%A7%91%E5%A4%A9%E8%AA%89');
  assert.equal(missingResponse.status, 503);
  assert.deepEqual(await missingResponse.json(), { error: '高德服务未配置', code: 'AMAP_NOT_CONFIGURED', details: {} });
});

test('地点候选缓存相同查询且不在缓存键中暴露地址', async () => {
  const entries = new Map();
  const cacheKeys = [];
  const locationCache = {
    async match(request) { return entries.get(request.url)?.clone(); },
    async put(request, response) {
      cacheKeys.push(request.url);
      entries.set(request.url, response.clone());
    }
  };
  let upstreamCalls = 0;
  const configured = harness({
    locationCache,
    fetchImpl: async () => {
      upstreamCalls++;
      return new Response(JSON.stringify({
        status: '1',
        pois: [{ id: 'houhai', name: '后海地铁站', adname: '南山区', address: '后海大道', location: '113.9426,22.5180' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }, { AMAP_WEB_SERVICE_KEY: 'synthetic-test-value' });

  const path = '/api/location-suggestions?q=%E6%B7%B1%E5%9C%B3%E5%B8%82%E5%8D%97%E5%B1%B1%E5%8C%BA%E5%90%8E%E6%B5%B7';
  const first = await configured.call(path);
  const second = await configured.call(path);
  assert.equal(first.headers.get('x-location-cache'), 'miss');
  assert.equal(second.headers.get('x-location-cache'), 'hit');
  assert.match(first.headers.get('cache-control'), /max-age=300/);
  assert.match(first.headers.get('cache-control'), /s-maxage=86400/);
  assert.equal(upstreamCalls, 1);
  assert.equal(cacheKeys.length, 1);
  assert.doesNotMatch(decodeURIComponent(cacheKeys[0]), /深圳市南山区后海/);
});

test('地图配置仅公开 JS API Key 并通过同源代理保护安全密钥', async () => {
  const missing = harness();
  assert.deepEqual(await (await missing.call('/api/map-config')).json(), { configured: false, reason: '高德地图 JS API 尚未配置' });

  let proxiedUrl = '';
  const configured = harness({ fetchImpl: async url => {
    proxiedUrl = url;
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  } }, { AMAP_JS_API_KEY: 'synthetic-js-key', AMAP_JS_SECURITY_CODE: 'synthetic-security-value' });
  const config = await (await configured.call('/api/map-config')).json();
  assert.deepEqual(config, { configured: true, key: 'synthetic-js-key', version: '2.0', serviceHost: 'https://example.test/_AMapService' });
  assert.equal(JSON.stringify(config).includes('synthetic-security-value'), false);

  const proxyResponse = await configured.call('/_AMapService/v3/place/text?keywords=test');
  assert.equal(proxyResponse.status, 200);
  const target = new URL(proxiedUrl);
  assert.equal(target.origin, 'https://restapi.amap.com');
  assert.equal(target.searchParams.get('jscode'), 'synthetic-security-value');
});

test('订单地图坐标仅通过老师鉴权接口返回且公开状态裁剪精确地址', async () => {
  const { call, repo } = harness();
  const name = '地图测试老师', phone = ['137', '0013', '7000'].join(''), password = 'secret1';
  const login = await (await call('/api/account/login', { method: 'POST', body: { name, phone, password, passwordProof: await clientPasswordProof(password, name, phone) } })).json();
  approvePublisher(repo, login.agency);
  const order = await (await call('/api/orders', { method: 'POST', headers: { authorization: `Bearer ${login.agencyToken}` }, body: {
    district: '南山', place: '测试小区', address: '深圳市南山区测试路1号', status: 'open', locationVerified: true,
    locationCoordinates: '113.9000,22.5000', locationAddress: '测试路1号'
  } })).json();
  assert.equal((await call('/api/map-orders')).status, 401);
  const mapBody = await (await call('/api/map-orders', { headers: { authorization: `Bearer ${login.teacherToken}` } })).json();
  assert.deepEqual(mapBody.orders, [{ id: order.id, locations: ['113.9000,22.5000'] }]);
  const teacherState = await (await call('/api/state', { headers: { authorization: `Bearer ${login.teacherToken}` } })).json();
  assert.equal(teacherState.orders[0].source, '');
  assert.equal('locationCoordinates' in teacherState.orders[0], false);
  assert.equal('address' in teacherState.orders[0], false);
  assert.equal('locationCandidates' in teacherState.orders[0], false);
  assert.equal('structured' in teacherState.orders[0], false);
});

test('老师复用公共订单读取，发单者只额外读取私有订单', async () => {
  const { call, repo } = harness();
  const name = '列表性能测试', phone = ['136', '0013', '6000'].join(''), password = 'secret1';
  const login = await (await call('/api/account/login', { method: 'POST', body: {
    name, phone, password, passwordProof: await clientPasswordProof(password, name, phone)
  } })).json();
  await repo.createOrder({ id: 'list-order-one', agencyId: login.agency.id, status: 'open', district: '南山', subject: '数学' });
  await repo.createOrder({ id: 'list-order-two', agencyId: 'another-agency', status: 'open', district: '福田', subject: '英语' });
  let privateOrderReads = 0;
  const listOrders = repo.listOrders.bind(repo);
  repo.listOrders = async filters => {
    privateOrderReads++;
    return listOrders(filters);
  };

  const teacherState = await (await call('/api/state', {
    headers: { authorization: `Bearer ${login.teacherToken}` }
  })).json();
  assert.equal(teacherState.orders.length, 2);
  assert.equal(privateOrderReads, 0, '老师复用公共订单读取结果');
  assert.equal('applicantCount' in teacherState.orders[0], false);
  assert.equal('applicants' in teacherState.orders[0], false);

  const agencyState = await (await call('/api/state', { headers: { authorization: `Bearer ${login.agencyToken}` } })).json();
  assert.equal(privateOrderReads, 1, '发单者仍读取包含私有字段的订单');
  assert.equal('applicantCount' in agencyState.orders[0], false);
  assert.equal('applicants' in agencyState.orders[0], false);
});

test('account login creates paired roles and persists only token hashes', async () => {
  const { repo, call } = harness();
  const name = '测试用户', phone = ['138', '0013', '8000'].join(''), password = 'secret1';
  const response = await call('/api/account/login', { method: 'POST', body: { name, phone, password, passwordProof: await clientPasswordProof(password, name, phone) } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.teacher.role, 'teacher');
  assert.equal(body.agency.role, 'agency');
  assert.equal(repo.state.users.size, 2);
  assert.equal(repo.state.sessions.has(body.teacherToken), false);
  assert.equal(repo.state.sessions.has(await sha256(body.teacherToken)), true);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);

  const denied = await call('/api/account/login', { method: 'POST', body: { name, phone, password: 'wrong-password', passwordProof: await clientPasswordProof('wrong-password', name, phone) } });
  assert.equal(denied.status, 401);
});

test('publisher access requires an application and admin approval before publishing', async () => {
  const { call } = harness({ parseOrders: async data => ({ parsed: [{ raw: data.text }], ignoredBlocks: [] }) });
  const guestResponse = await call('/api/account/guest', { method: 'POST', body: { deviceId: 'publisher_access_browser_1234' } });
  assert.match(guestResponse.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const guest = await guestResponse.json();
  const agencyHeaders = { authorization: `Bearer ${guest.agencyToken}` };

  assert.equal((await call('/api/parse', { method: 'POST', headers: agencyHeaders, body: { text: '南山区初二数学家教' } })).status, 403);
  assert.equal((await call('/api/orders', { method: 'POST', headers: agencyHeaders, body: { district: '南山', subject: '数学' } })).status, 403);
  const publicState = await (await call('/api/state')).json();
  assert.ok(Array.isArray(publicState.orders), 'public order browsing remains available');

  const submitted = await (await call('/api/publisher-access', { method: 'POST', headers: agencyHeaders, body: {
    displayName: '申请人', contact: 'wechat-publisher'
  } })).json();
  assert.equal(submitted.access.status, 'pending');
  const agencyState = await (await call('/api/state', { headers: agencyHeaders })).json();
  assert.equal(agencyState.publisherAccess.contact, 'wechat-publisher');

  const password = 'publisher-admin-password';
  const admin = await (await call('/api/admin/setup', { method: 'POST', body: {
    password, passwordProof: await clientPasswordProof(password, 'admin', '')
  } })).json();
  const adminHeaders = { authorization: `Bearer ${admin.token}` };
  const adminState = await (await call('/api/state', { headers: adminHeaders })).json();
  assert.equal(adminState.publisherRequests[0].status, 'pending');
  assert.equal((await call(`/api/admin/publisher-access/${guest.agency.id}`, { method: 'PATCH', headers: adminHeaders, body: { status: 'approved' } })).status, 200);

  assert.equal((await call('/api/parse', { method: 'POST', headers: agencyHeaders, body: { text: '南山区初二数学家教' } })).status, 200);
  const published = await (await call('/api/orders', { method: 'POST', headers: agencyHeaders, body: {
    district: '南山', subject: '数学', raw: '南山区初二数学家教，200元每小时'
  } })).json();
  assert.equal((await call(`/api/orders/${published.id}/contact`)).status, 401);
  const contact = await (await call(`/api/orders/${published.id}/contact`, {
    headers: { authorization: `Bearer ${guest.teacherToken}` }
  })).json();
  assert.deepEqual(contact.publisher, { name: '申请人', contact: 'wechat-publisher' });
  assert.equal(contact.raw, '南山区初二数学家教，200元每小时');
  assert.deepEqual(contact.admin, { name: '吴老师', contact: ['187', '1937', '1936'].join('') });
  const teacherState = await (await call('/api/state', { headers: { authorization: `Bearer ${guest.teacherToken}` } })).json();
  assert.equal(JSON.stringify(teacherState).includes('wechat-publisher'), false, 'publisher contact is revealed only after an explicit contact request');
  assert.deepEqual(teacherState.publisherProfiles, [{ userId: guest.agency.id, displayName: '申请人' }]);
  assert.equal('contact' in teacherState.publisherProfiles[0], false);

  const otherBrowser = await (await call('/api/account/guest', { method: 'POST', body: { deviceId: 'publisher_access_other_browser' } })).json();
  const restored = await (await call('/api/publisher-access', { method: 'POST', headers: { authorization: `Bearer ${otherBrowser.agencyToken}` }, body: {
    displayName: '申请人', contact: 'wechat-publisher'
  } })).json();
  assert.equal(restored.recognized, true);
  assert.equal(restored.agency.id, guest.agency.id);
  assert.equal((await call('/api/orders', { method: 'POST', headers: { authorization: `Bearer ${restored.agencyToken}` }, body: { district: '福田', subject: '英语' } })).status, 200);
  assert.equal((await call('/api/state', { headers: { authorization: `Bearer ${restored.agencyToken}` } })).status, 200);
  assert.equal((await call('/api/state', { headers: adminHeaders }).then(response => response.json())).publisherRequests.length, 1);
});

test('shared clipboard bridge requires its program token and exposes a common queue', async () => {
  const { call } = harness({}, { CLIPBOARD_BRIDGE_TOKEN: 'shared-test-token' });
  const deviceId = 'browser_clipboard_test_1234';
  const guest = await (await call('/api/account/guest', { method: 'POST', body: { deviceId } })).json();
  const anonymous = await call('/api/clipboard/inbox');
  assert.equal(anonymous.status, 401);
  const response = await call('/api/clipboard/inbox', { headers: { authorization: `Bearer ${guest.agencyToken}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [], pending: 0 });
  const denied = await call('/api/clipboard/capture', { method: 'POST', body: { captureId: 'capture_denied_1234', text: '订单' } });
  assert.equal(denied.status, 401);
  const captured = await call('/api/clipboard/capture', { method: 'POST', headers: { 'x-clipboard-bridge-token': 'shared-test-token' }, body: { captureId: 'capture_shared_1234', text: '订单' } });
  assert.equal(captured.status, 200);
  const inbox = await (await call('/api/clipboard/inbox', { headers: { authorization: `Bearer ${guest.agencyToken}` } })).json();
  assert.equal(inbox.pending, 1);
});

test('agency creates and batch deletes orders while the legacy application route is absent', async () => {
  const { repo, call } = harness();
  const loginName = '张老师', loginPhone = ['139', '0013', '9000'].join('');
  const login = await (await call('/api/account/login', { method: 'POST', body: { name: loginName, phone: loginPhone, password: 'secret1', passwordProof: await clientPasswordProof('secret1', loginName, loginPhone) } })).json();
  approvePublisher(repo, login.agency);
  const createdResponse = await call('/api/orders', { method: 'POST', headers: { authorization: `Bearer ${login.agencyToken}` }, body: { district: '南山', subject: '数学', price: 200 } });
  assert.equal(createdResponse.status, 200);
  const order = await createdResponse.json();
  assert.equal(order.agencyId, login.agency.id);

  assert.equal((await call(`/api/orders/${order.id}/apply`, {
    method: 'POST', headers: { authorization: `Bearer ${login.teacherToken}` }, body: { contact: 'legacy-contact' }
  })).status, 404);

  assert.equal((await call('/api/agency/orders/bulk', { method: 'POST', headers: { authorization: `Bearer ${login.agencyToken}` }, body: { action: 'close' } })).status, 400);
  assert.equal((await call(`/api/orders/${order.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${login.agencyToken}` }, body: { status: 'closed' } })).status, 404);
  const deleteAll = await (await call('/api/agency/orders/bulk', { method: 'POST', headers: { authorization: `Bearer ${login.agencyToken}` }, body: { action: 'delete' } })).json();
  assert.equal(deleteAll.affected, 1);
  assert.equal(repo.state.orders.size, 0);
});

test('guest device receives stable paired roles without a login form', async () => {
  const { repo, call } = harness();
  const body = { deviceId: 'browser_1234567890abcdef' };
  const first = await (await call('/api/account/guest', { method: 'POST', body })).json();
  const second = await (await call('/api/account/guest', { method: 'POST', body })).json();
  assert.equal(first.guest, true);
  assert.equal(first.teacher.id, second.teacher.id);
  assert.equal(first.agency.id, second.agency.id);
  assert.equal(repo.state.users.size, 2);

  const other = await (await call('/api/account/guest', { method: 'POST', body: {
    deviceId: 'browser_fedcba0987654321'
  } })).json();
  approvePublisher(repo, first.agency);
  const order = await (await call('/api/orders', {
    method: 'POST', headers: { authorization: `Bearer ${first.agencyToken}` },
    body: { district: '南山', subject: '物理', grade: '高二', price: 300 }
  })).json();
  const ownerState = await (await call('/api/state', { headers: { authorization: `Bearer ${first.agencyToken}` } })).json();
  assert.equal(ownerState.orders[0].agencyId, first.agency.id);
  const otherState = await (await call('/api/state', { headers: { authorization: `Bearer ${other.agencyToken}` } })).json();
  assert.equal(otherState.orders[0].source, '');
});

test('password login and injectable parser have explicit behavior', async () => {
  const disabled = harness();
  assert.equal((await disabled.call('/api/auth/sms/send', { method: 'POST', body: {} })).status, 404);
  const disabledName = '机构', disabledPhone = ['136', '0013', '6000'].join('');
  const login = await (await disabled.call('/api/login', { method: 'POST', body: { role: 'agency', name: disabledName, phone: disabledPhone, password: 'secret1', passwordProof: await clientPasswordProof('secret1', disabledName, disabledPhone) } })).json();
  approvePublisher(disabled.repo, login.user);
  assert.equal((await disabled.call('/api/parse', { method: 'POST', headers: { authorization: `Bearer ${login.token}` }, body: { text: '测试' } })).status, 503);

  const injected = harness({ parseOrders: async data => ({ parserVersion: 'test', parsed: [{ raw: data.text }], splitDiagnostics: [] }) });
  const injectedName = '机构', injectedPhone = ['135', '0013', '5000'].join('');
  const injectedLogin = await (await injected.call('/api/login', { method: 'POST', body: { role: 'agency', name: injectedName, phone: injectedPhone, password: 'secret1', passwordProof: await clientPasswordProof('secret1', injectedName, injectedPhone) } })).json();
  approvePublisher(injected.repo, injectedLogin.user);
  const parsed = await (await injected.call('/api/parse', { method: 'POST', headers: { authorization: `Bearer ${injectedLogin.token}` }, body: { text: '合成订单' } })).json();
  assert.equal(parsed.parserVersion, 'test');
  assert.equal(parsed.parsed[0].raw, '合成订单');
});

test('import reuses verified preview locations and resolves only unverified orders without routing', async () => {
  let amapCalls = 0;
  const { call, repo } = harness({ fetchImpl: async url => {
    amapCalls++;
    const keywords = new URL(String(url)).searchParams.get('keywords');
    assert.equal(keywords, '深圳市宝安区待核实花园');
    return new Response(JSON.stringify({ status: '1', pois: [{
      id: 'resolved-poi', name: '待核实花园', adname: '宝安区', address: '测试路2号',
      location: '113.8501,22.5801', type: '商务住宅;住宅区'
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  } }, { AMAP_WEB_SERVICE_KEY: 'synthetic-test-value' });
  const name = '导入测试机构', phone = ['137', '0013', '7000'].join(''), password = 'secret1';
  const login = await (await call('/api/login', { method: 'POST', body: {
    role: 'agency', name, phone, password, passwordProof: await clientPasswordProof(password, name, phone)
  } })).json();
  approvePublisher(repo, login.user);
  const verifiedQuery = '深圳市宝安区已确认花园';
  const response = await call('/api/import', { method: 'POST', headers: { authorization: `Bearer ${login.token}` }, body: { orders: [{
    raw: '宝安区已确认花园，高二数学', district: '宝安', place: '已确认花园', locationQuery: verifiedQuery,
    locationQueries: [verifiedQuery], locationVerified: true, locationStatus: 'verified', locationPoiId: 'verified-poi',
    locationCoordinates: '113.8500,22.5800', locationCandidates: [{ id: 'verified-poi', name: '已确认花园', district: '宝安',
      location: '113.8500,22.5800', searchQuery: verifiedQuery }], structured: { locations: { value: [{ query: verifiedQuery }] } }
  }, {
    raw: '宝安区待核实花园，高三物理', district: '宝安', place: '待核实花园', locationQuery: '深圳市宝安区待核实花园',
    locationQueries: ['深圳市宝安区待核实花园'], locationVerified: false, structured: { locations: { value: [{ query: '深圳市宝安区待核实花园' }] } }
  }] } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.created.length, 2);
  assert.equal(amapCalls, 1, 'only the unverified order should call Amap during import');
  assert.equal(body.created[0].locationPoiId, 'verified-poi');
  assert.equal(body.created[1].locationPoiId, 'resolved-poi');
  assert.deepEqual(body.created.map(order => [order.distanceKm, order.routeMode, order.routeStatus]), [
    ['', '待计算', 'pending'], ['', '待计算', 'pending']
  ]);
});

test('import enriches every location option after fast parsing', async () => {
  const requested = [];
  const { call, repo } = harness({ fetchImpl: async url => {
    const keywords = new URL(String(url)).searchParams.get('keywords');
    requested.push(keywords);
    const second = keywords.includes('会展');
    return new Response(JSON.stringify({ status: '1', pois: [{
      id: second ? 'option-b' : 'option-a',
      name: second ? '深圳国际会展中心' : '科技园',
      adname: second ? '宝安区' : '南山区',
      address: second ? '展城路1号' : '科苑路1号',
      location: second ? '113.7760,22.7070' : '113.9460,22.5400',
      type: '商务住宅;住宅区'
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  } }, { AMAP_WEB_SERVICE_KEY: 'synthetic-test-value' });
  const name = '双地点测试机构', phone = ['138', '0013', '8000'].join(''), password = 'secret1';
  const login = await (await call('/api/login', { method: 'POST', body: {
    role: 'agency', name, phone, password, passwordProof: await clientPasswordProof(password, name, phone)
  } })).json();
  approvePublisher(repo, login.user);
  const response = await call('/api/import', { method: 'POST', headers: { authorization: `Bearer ${login.token}` }, body: { orders: [{
    raw: '南山区科技园或宝安区国际会展中心附近，高一数学，200元/小时',
    district: '南山', place: '科技园', locationQuery: '深圳市南山区科技园', locationVerified: false,
    locationOptions: [
      { district: '南山', place: '科技园', query: '深圳市南山区科技园' },
      { district: '宝安', place: '深圳国际会展中心附近', query: '深圳市宝安区国际会展中心' }
    ]
  }] } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(requested.sort(), ['深圳市南山区科技园', '深圳市宝安区国际会展中心'].sort());
  assert.deepEqual(body.created[0].locationOptions.map(option => [option.verified, option.coordinates]), [
    [true, '113.9460,22.5400'], [true, '113.7760,22.7070']
  ]);
  assert.equal(body.created[0].locationCoordinates, '113.9460,22.5400');
});

test('admin can retry and persist coordinates for a stored unverified location', async () => {
  const { call, repo } = harness({ fetchImpl: async url => {
    assert.equal(new URL(String(url)).searchParams.get('keywords'), '深圳市光明区峰荟花园');
    return new Response(JSON.stringify({ status: '1', pois: [{
      id: 'fenghui-poi', name: '峰荟花园', adname: '光明区', address: '马田街道',
      location: '113.9000,22.7500', type: '商务住宅;住宅区'
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  } }, { AMAP_WEB_SERVICE_KEY: 'synthetic-test-value' });
  const password = 'admin-location-password';
  const setup = await (await call('/api/admin/setup', { method: 'POST', body: {
    password, passwordProof: await clientPasswordProof(password, 'admin', '')
  } })).json();
  await repo.createOrder({
    id: 'stored-unverified', agencyId: 'legacy-agency', raw: '光明区峰荟花园，初二英语',
    district: '光明', place: '峰荟花园', subject: '英语', grade: '初二',
    locationQuery: '深圳市光明区峰荟花园', locationStatus: 'unverified', locationCoordinates: ''
  });

  const response = await call('/api/admin/orders/stored-unverified/location/retry', {
    method: 'POST', headers: { authorization: `Bearer ${setup.token}` }
  });
  assert.equal(response.status, 200);
  const stored = await repo.getOrderById('stored-unverified');
  assert.equal(stored.locationVerified, true);
  assert.equal(stored.locationCoordinates, '113.9000,22.7500');
  assert.equal(stored.locationPoiId, 'fenghui-poi');
});

test('admin can batch delete selected orders', async () => {
  const { call, repo } = harness();
  await repo.createOrder({ id: 'batch-order-one', agencyId: 'agency-one', raw: '合成订单一' });
  await repo.createOrder({ id: 'batch-order-two', agencyId: 'agency-one', raw: '合成订单二' });
  const path = '/api/admin/batch-delete-orders';
  assert.equal((await call(path, { method: 'POST', body: { orderIds: ['batch-order-one'] } })).status, 401);
  const password = 'admin-batch-delete-password';
  const admin = await (await call('/api/admin/setup', { method: 'POST', body: {
    password, passwordProof: await clientPasswordProof(password, 'admin', '')
  } })).json();
  const response = await call(path, {
    method: 'POST', headers: { authorization: `Bearer ${admin.token}` },
    body: { orderIds: ['batch-order-one', 'batch-order-two', 'batch-order-one', 'missing-order'] }
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deletedOrders, 2);
  assert.equal(repo.state.orders.size, 0);
});

test('import skips the same order despite whitespace punctuation and emoji differences', async () => {
  const { call, repo } = harness();
  const name = '去重测试机构', phone = ['136', '0013', '6000'].join(''), password = 'secret1';
  const login = await (await call('/api/login', { method: 'POST', body: {
    role: 'agency', name, phone, password, passwordProof: await clientPasswordProof(password, name, phone)
  } })).json();
  approvePublisher(repo, login.user);
  const headers = { authorization: `Bearer ${login.token}` };
  const base = {
    district: '宝安', place: '西乡测试花园', grade: '高二', subject: '物理', price: 300,
    locationVerified: true, locationStatus: 'verified', locationPoiId: 'dedupe-poi',
    locationCoordinates: '113.8600,22.5800'
  };
  const first = await (await call('/api/import', { method: 'POST', headers, body: { orders: [{
    ...base, raw: '宝安区·西乡测试花园，高二物理，300元/小时'
  }] } })).json();
  const repeated = await (await call('/api/import', { method: 'POST', headers, body: { orders: [{
    ...base, raw: '📚 宝安区 西乡测试花园  高二物理；300元／小时！！！'
  }] } })).json();
  assert.equal(first.created.length, 1);
  assert.equal(repeated.created.length, 0);
  assert.equal(repeated.duplicatesSkipped, 1);
});

test('scheduled cleanup deletes orders older than three days', async () => {
  const { repo, worker } = harness();
  const now = Date.UTC(2026, 6, 25, 4, 0, 0);
  repo.state.orders.set('old', { id: 'old', createdAt: new Date(now - (3 * 24 * 60 * 60 * 1000) - 1).toISOString() });
  repo.state.orders.set('fresh', { id: 'fresh', createdAt: new Date(now - (3 * 24 * 60 * 60 * 1000) + 1).toISOString() });
  await worker.scheduled({ scheduledTime: now }, { AUTH_PEPPER: 'unit-test-pepper' }, {});
  assert.equal(repo.state.orders.has('old'), false);
  assert.equal(repo.state.orders.has('fresh'), true);
});

test('识别有误反馈保存快照、同人去重且仅管理员可读取', async () => {
  const { call, repo } = harness();
  const guest = await (await call('/api/account/guest', { method: 'POST', body: { deviceId: 'issue_report_browser_123456' } })).json();
  approvePublisher(repo, guest.agency);
  await repo.createOrder({
    id: 'issue-order', agencyId: guest.agency.id, raw: '南山区测试花园，初二数学，200元/小时',
    district: '南山', place: '错误地点', subject: '数学', grade: '初二', price: 200,
    structured: { parserVersion: '2.2.1', rawText: '南山区测试花园，初二数学，200元/小时' }
  });
  assert.equal((await call('/api/order-issues', { method: 'POST', body: { orderId: 'issue-order' } })).status, 401);
  const teacherHeaders = { authorization: `Bearer ${guest.teacherToken}` };
  assert.equal((await call('/api/order-issues', { method: 'POST', headers: teacherHeaders, body: {
    orderId: 'issue-order', parsedSnapshot: { place: '伪造地点' }
  } })).status, 200);
  await call('/api/order-issues', { method: 'POST', headers: teacherHeaders, body: { orderId: 'issue-order' } });
  assert.equal(repo.state.orderIssueReports.size, 1);
  const published = [...repo.state.orderIssueReports.values()][0];
  assert.equal(published.parsedSnapshot.place, '错误地点');
  assert.equal(published.parserVersion, '2.2.1');

  const agencyHeaders = { authorization: `Bearer ${guest.agencyToken}` };
  const preview = { raw: '宝安区合成小区，高一物理', place: '识别地点', structured: { parserVersion: '2.2.1' } };
  assert.equal((await call('/api/order-issues', { method: 'POST', headers: agencyHeaders, body: {
    raw: preview.raw, parsedSnapshot: preview, parserVersion: '2.2.1'
  } })).status, 200);
  assert.equal(repo.state.orderIssueReports.size, 2);

  const publicState = await (await call('/api/state', { headers: teacherHeaders })).json();
  assert.equal('orderIssueReports' in publicState, false);
  const password = 'admin-issue-password';
  const admin = await (await call('/api/admin/setup', { method: 'POST', body: {
    password, passwordProof: await clientPasswordProof(password, 'admin', '')
  } })).json();
  const adminState = await (await call('/api/state', { headers: { authorization: `Bearer ${admin.token}` } })).json();
  assert.equal(adminState.orderIssueReports.length, 2);
  assert.equal(adminState.orderIssueReports.find(item => item.source === 'preview').rawText, preview.raw);
  const clearPath = '/api/admin/order-issues/clear-exported';
  const exported = adminState.orderIssueReports;
  assert.equal((await call(clearPath, { method: 'POST', headers: teacherHeaders, body: { reports: exported } })).status, 401);
  const clearResult = await (await call(clearPath, { method: 'POST', headers: { authorization: `Bearer ${admin.token}` }, body: {
    reports: [
      { id: exported[0].id, updatedAt: exported[0].updatedAt },
      { id: exported[1].id, updatedAt: '2099-01-01T00:00:00.000Z' }
    ]
  } })).json();
  assert.equal(clearResult.deletedReports, 1);
  assert.equal(repo.state.orderIssueReports.size, 1);
  assert.equal([...repo.state.orderIssueReports.values()][0].id, exported[1].id);
});
