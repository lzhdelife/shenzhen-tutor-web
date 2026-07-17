'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorker } = require('../cloudflare/worker.js');
const { sha256, clientPasswordProof } = require('../cloudflare/auth.js');

function memoryRepository() {
  const state = { users: new Map(), sessions: new Map(), orders: new Map(), applications: [], feedback: [], settings: {}, objects: new Map(), announcements: [] };
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
    async createApplication(input) { const application = { id: `a-${state.applications.length + 1}`, createdAt: new Date().toISOString(), ...input }; state.applications.push(application); return application; },
    async listApplications(filters = {}) { return state.applications.filter(item => (!filters.orderId || item.orderId === filters.orderId) && (!filters.teacherId || item.teacherId === filters.teacherId)); },
    async updateApplication(id, patch) { const item = state.applications.find(value => value.id === id); Object.assign(item, patch); return item; },
    async getSettings() { return { ...state.settings }; },
    async setSetting(key, value) { state.settings[key] = value; return value; },
    async listFeedback() { return state.feedback; },
    async createFeedback(input) { state.feedback.push(input); return input; },
    async listAnnouncements() { return state.announcements; },
    async createAnnouncement(input) { state.announcements.push(input); return input; },
  };
}

function harness(extra = {}, envOverrides = {}) {
  const repo = memoryRepository();
  const worker = createWorker({ createRepository: () => repo, ...extra });
  const call = (path, init = {}) => worker.fetch(new Request(`https://example.test${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    body: init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body
  }), { AUTH_PEPPER: 'unit-test-pepper', ASSETS: { fetch: () => new Response('asset') }, ...envOverrides }, {});
  return { repo, call };
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

test('agency creates an order and teacher applies without duplicate application', async () => {
  const { repo, call } = harness();
  const loginName = '张老师', loginPhone = ['139', '0013', '9000'].join('');
  const login = await (await call('/api/account/login', { method: 'POST', body: { name: loginName, phone: loginPhone, password: 'secret1', passwordProof: await clientPasswordProof('secret1', loginName, loginPhone) } })).json();
  const createdResponse = await call('/api/orders', { method: 'POST', headers: { authorization: `Bearer ${login.agencyToken}` }, body: { district: '南山', subject: '数学', price: 200 } });
  assert.equal(createdResponse.status, 200);
  const order = await createdResponse.json();
  assert.equal(order.agencyId, login.agency.id);

  const apply = () => call(`/api/orders/${order.id}/apply`, { method: 'POST', headers: { authorization: `Bearer ${login.teacherToken}` }, body: { note: '可周末上课' } });
  assert.equal((await (await apply()).json()).alreadyApplied, false);
  assert.equal((await (await apply()).json()).alreadyApplied, true);
  assert.equal(repo.state.applications.length, 1);

  const state = await (await call('/api/state', { headers: { authorization: `Bearer ${login.agencyToken}` } })).json();
  assert.equal(state.orders[0].applicantCount, 1);
  assert.equal(state.orders[0].applicants.length, 1);

  const closeAll = await (await call('/api/agency/orders/bulk', { method: 'POST', headers: { authorization: `Bearer ${login.agencyToken}` }, body: { action: 'close' } })).json();
  assert.equal(closeAll.affected, 1);
  assert.equal(repo.state.orders.get(order.id).status, 'closed');
  const deleteAll = await (await call('/api/agency/orders/bulk', { method: 'POST', headers: { authorization: `Bearer ${login.agencyToken}` }, body: { action: 'delete' } })).json();
  assert.equal(deleteAll.affected, 1);
  assert.equal(repo.state.orders.size, 0);
});

test('password login and injectable parser have explicit behavior', async () => {
  const disabled = harness();
  assert.equal((await disabled.call('/api/auth/sms/send', { method: 'POST', body: {} })).status, 404);
  const disabledName = '机构', disabledPhone = ['136', '0013', '6000'].join('');
  const login = await (await disabled.call('/api/login', { method: 'POST', body: { role: 'agency', name: disabledName, phone: disabledPhone, password: 'secret1', passwordProof: await clientPasswordProof('secret1', disabledName, disabledPhone) } })).json();
  assert.equal((await disabled.call('/api/parse', { method: 'POST', headers: { authorization: `Bearer ${login.token}` }, body: { text: '测试' } })).status, 503);

  const injected = harness({ parseOrders: async data => ({ parserVersion: 'test', parsed: [{ raw: data.text }], splitDiagnostics: [] }) });
  const injectedName = '机构', injectedPhone = ['135', '0013', '5000'].join('');
  const injectedLogin = await (await injected.call('/api/login', { method: 'POST', body: { role: 'agency', name: injectedName, phone: injectedPhone, password: 'secret1', passwordProof: await clientPasswordProof('secret1', injectedName, injectedPhone) } })).json();
  const parsed = await (await injected.call('/api/parse', { method: 'POST', headers: { authorization: `Bearer ${injectedLogin.token}` }, body: { text: '合成订单' } })).json();
  assert.equal(parsed.parserVersion, 'test');
  assert.equal(parsed.parsed[0].raw, '合成订单');
});
