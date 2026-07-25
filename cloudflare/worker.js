'use strict';

const { createRepository } = require('./storage.js');
const { proofCredential, verifyProofCredential, sha256, randomToken, cookieValue, sessionCookie } = require('./auth.js');
const { createAmapService } = require('./amap-service.js');
const { scoreOrder } = require('../shared/order-score.js');
const { sanitizeImportedOrder, canReuseVerifiedLocation, markRoutePending } = require('../shared/order-import.js');
const { canonicalOrderText } = require('../shared/order-dedupe.js');
const { orderExpiryCutoff, isExpiredOrder } = require('../shared/order-retention.js');

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const LISTS = {
  districts: ['罗湖', '福田', '南山', '盐田', '宝安', '龙岗', '龙华', '坪山', '光明', '大鹏'],
  subjects: ['语文', '数学', '英语', '物理', '化学', '生物', '道法', '政治', '历史', '地理', '科学', '信息技术', '编程', '奥数', '全科', '陪读', '体育', '音乐', '美术', '书法', '其他'],
  grades: ['幼儿园', '一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '小学', '初一', '初二', '初三', '初中', '高一', '高二', '高三', '高中', '中考', '高考', '大学', '成人', '其他']
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function error(message, status = 400) { return json({ error: message }, status); }
function text(value) { return String(value == null ? '' : value).trim(); }
function mapConfigured(env) { return Boolean(text(env.AMAP_JS_API_KEY) && text(env.AMAP_JS_SECURITY_CODE)); }

async function proxyAmapJsService(request, env, fetchImpl = fetch) {
  if (!mapConfigured(env)) return error('高德地图 JS API 尚未配置', 503);
  if (request.method !== 'GET') return error('地图代理只接受 GET 请求', 405);
  const incoming = new URL(request.url);
  const suffix = incoming.pathname.replace(/^\/_AMapService\/?/, '');
  if (!/^(?:v3|v4|v5)\/[A-Za-z0-9_./-]+$/.test(suffix) || suffix.includes('..')) return error('地图代理路径无效', 400);
  const host = suffix.startsWith('v4/map/styles') ? 'https://webapi.amap.com/'
    : suffix.startsWith('v3/vectormap') ? 'https://fmap01.amap.com/' : 'https://restapi.amap.com/';
  const target = new URL(suffix, host);
  target.search = incoming.search;
  target.searchParams.set('jscode', text(env.AMAP_JS_SECURITY_CODE));
  try {
    const upstream = await fetchImpl(target.toString(), { headers: { accept: request.headers.get('accept') || '*/*' } });
    return new Response(upstream.body, { status: upstream.status, headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': upstream.headers.get('cache-control') || 'private, max-age=300'
    } });
  } catch (_) {
    return error('高德地图代理暂时不可用', 503);
  }
}
function publicUser(user) { return user ? { id: user.id, role: user.role, name: user.name, phone: user.phone || '' } : null; }
function validPhone(phone) { return /^1[3-9]\d{9}$/.test(phone); }

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

async function prepareCloudflareImportedOrder(item, agency, amap) {
  const order = sanitizeImportedOrder(item);
  if (!canReuseVerifiedLocation(order)) {
    order.locationVerified = false;
    order.locationStatus = order.locationQuery ? 'unverified' : 'missing';
    order.locationPoiId = '';
    order.locationCoordinates = '';
    order.locationAddress = '';
    order.locationConfidence = 0;
    if (order.locationQuery) {
      try {
        const result = await amap.candidates(order.locationQuery, order.district);
        const candidate = result.candidates?.[0];
        if (candidate) Object.assign(order, amap.confirm(candidate, order.district), { locationCandidates: result.candidates });
        else order.locationStatus = 'not_found';
      } catch (_) {
        order.locationStatus = 'unverified';
      }
    }
  }
  markRoutePending(order);
  return { ...order, id: undefined, agencyId: agency.id, source: agency.name, status: 'open', structured: order.structured || order };
}

async function bodyJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 10 * 1024 * 1024) throw Object.assign(new Error('请求内容过大'), { status: 413 });
  try { return await request.json(); } catch (_) { throw Object.assign(new Error('请求必须是有效的 JSON'), { status: 400 }); }
}

async function issueSession(repo, request, user) {
  const token = randomToken();
  await repo.createSession({
    tokenHash: await sha256(token), userId: user.id, expiresAt: Date.now() + SESSION_MS,
    ip: request.headers.get('cf-connecting-ip') || '', userAgent: request.headers.get('user-agent') || ''
  });
  return token;
}

async function actorOf(repo, request) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : cookieValue(request, 'tutor_session');
  if (!token) return null;
  const session = await repo.getSessionByTokenHash(await sha256(token));
  if (!session) return null;
  const user = await repo.getUserById(session.userId);
  return user ? publicUser(user) : null;
}

async function requireRole(repo, request, role) {
  const actor = await actorOf(repo, request);
  return actor && (!role || actor.role === role) ? actor : null;
}

async function deterministicUserId(role, phone) { return `u-${role}-${(await sha256(phone)).slice(0, 24)}`; }

async function getRoleUser(repo, role, phone) {
  const deterministic = await repo.getUserById(await deterministicUserId(role, phone));
  if (deterministic) return deterministic;
  const byPhone = await repo.getUserByPhone(phone);
  return byPhone && byPhone.role === role ? byPhone : null;
}

function suppliedProof(data) { return text(data.passwordProof); }
function requirePepper(env) {
  const pepper = text(env.AUTH_PEPPER);
  if (!pepper) throw Object.assign(new Error('登录服务尚未完成安全配置'), { status: 503 });
  return pepper;
}

async function loginOne(repo, request, data, env) {
  const role = text(data.role) || 'teacher', name = text(data.name), phone = text(data.phone), passwordProof = suppliedProof(data);
  if (!['teacher', 'agency'].includes(role)) return error('身份类型不正确');
  if (!name) return error('请填写名称');
  if (!validPhone(phone)) return error('请输入正确的11位中国大陆手机号');
  if (text(data.password).length < 6) return error('密码至少需要6位');
  if (!passwordProof) return error('登录页面版本过旧，请刷新后重试');
  const pepper = requirePepper(env);
  let user = await getRoleUser(repo, role, phone);
  if (user && (user.name !== name || !(await verifyProofCredential(passwordProof, user.passwordHash, pepper)))) return error('名称、手机号或密码不正确', 401);
  if (!user) user = await repo.createUser({ id: await deterministicUserId(role, phone), role, name, phone, passwordHash: await proofCredential(passwordProof, pepper) });
  const token = await issueSession(repo, request, user);
  return json({ user: publicUser(user), token }, 200, { 'set-cookie': sessionCookie(token) });
}

async function pairedLogin(repo, request, data, env) {
  const name = text(data.name), phone = text(data.phone), passwordProof = suppliedProof(data);
  if (!name) return error('请填写姓名或机构名称');
  if (!validPhone(phone)) return error('请输入正确的11位中国大陆手机号');
  if (text(data.password).length < 6) return error('密码至少需要6位');
  if (!passwordProof) return error('登录页面版本过旧，请刷新后重试');
  const pepper = requirePepper(env);
  let teacher = await getRoleUser(repo, 'teacher', phone);
  let agency = await getRoleUser(repo, 'agency', phone);
  for (const user of [teacher, agency].filter(Boolean)) {
    if (user.name !== name || !(await verifyProofCredential(passwordProof, user.passwordHash, pepper))) return error('名称、手机号或密码不正确', 401);
  }
  const passwordHash = teacher?.passwordHash || agency?.passwordHash || await proofCredential(passwordProof, pepper);
  if (!teacher) teacher = await repo.createUser({ id: await deterministicUserId('teacher', phone), role: 'teacher', name, phone, passwordHash });
  if (!agency) agency = await repo.createUser({ id: await deterministicUserId('agency', phone), role: 'agency', name, phone, passwordHash });
  const [teacherToken, agencyToken] = await Promise.all([issueSession(repo, request, teacher), issueSession(repo, request, agency)]);
  return json({ teacher: publicUser(teacher), agency: publicUser(agency), teacherToken, agencyToken }, 200,
    { 'set-cookie': sessionCookie(agencyToken) });
}

function cleanOrder(order, applications, viewer) {
  const canSee = viewer && (viewer.role === 'admin' || (viewer.role === 'agency' && viewer.id === order.agencyId));
  const copy = { ...order, applicantCount: applications.length, applicants: canSee ? applications : [] };
  delete copy.sourceImages; delete copy.importFingerprint; delete copy.passwordHash;
  if (!canSee) {
    delete copy.address; delete copy.locationAddress; delete copy.locationCoordinates;
    delete copy.locationQuery; delete copy.locationQueries; delete copy.locationCandidates; delete copy.structured;
    copy.locationOptions = (copy.locationOptions || []).map(option => {
      const { address: _address, coordinates: _coordinates, candidates: _candidates, query: _query, locationQueries: _queries, routeOptions: _routes, ...safe } = option;
      return safe;
    });
  }
  return copy;
}

function createWorker(dependencies = {}) {
  return {
    async scheduled(controller, env, ctx) {
      const repo = dependencies.createRepository ? dependencies.createRepository(env) : createRepository(env);
      const cutoff = orderExpiryCutoff(controller?.scheduledTime || Date.now()).toISOString();
      const cleanup = async () => {
        if (typeof repo.deleteOrdersOlderThan === 'function') return repo.deleteOrdersOlderThan(cutoff);
        const orders = await repo.listOrders({ limit: 500 });
        const expired = orders.filter(order => isExpiredOrder(order, controller?.scheduledTime || Date.now()));
        await Promise.all(expired.map(order => repo.deleteOrder(order.id)));
        return expired.length;
      };
      if (ctx?.waitUntil) ctx.waitUntil(cleanup());
      else await cleanup();
    },
    async fetch(request, env, ctx) {
      const repo = dependencies.createRepository ? dependencies.createRepository(env) : createRepository(env);
      const url = new URL(request.url), path = url.pathname, method = request.method.toUpperCase();
      const amap = createAmapService({ key: env.AMAP_WEB_SERVICE_KEY, fetchImpl: dependencies.fetchImpl || fetch, timeoutMs: dependencies.amapTimeoutMs || 7000 });
      try {
        if (path.startsWith('/_AMapService/')) return proxyAmapJsService(request, env, dependencies.fetchImpl || fetch);
        if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
        if (method === 'OPTIONS') return new Response(null, { status: 204 });
        if (method === 'POST' && path === '/api/account/login') return pairedLogin(repo, request, await bodyJson(request), env);
        if (method === 'POST' && path === '/api/login') return loginOne(repo, request, await bodyJson(request), env);
        if (method === 'POST' && path === '/api/account/remember-login') {
          const remembered = await actorOf(repo, request);
          if (!remembered || !['teacher', 'agency'].includes(remembered.role)) return error('记住的登录已失效，请重新输入密码', 401);
          const current = await repo.getUserById(remembered.id);
          const teacher = current.role === 'teacher' ? current : await getRoleUser(repo, 'teacher', current.phone);
          const agency = current.role === 'agency' ? current : await getRoleUser(repo, 'agency', current.phone);
          if (!teacher || !agency) return error('记住的账号已经不存在', 401);
          const [teacherToken, agencyToken] = await Promise.all([issueSession(repo, request, teacher), issueSession(repo, request, agency)]);
          return json({ teacher: publicUser(teacher), agency: publicUser(agency), teacherToken, agencyToken }, 200,
            { 'set-cookie': sessionCookie(agencyToken) });
        }

        if (method === 'POST' && path === '/api/admin/setup') {
          const data = await bodyJson(request), settings = await repo.getSettings();
          if (settings.adminPasswordHash) return error('管理员密码已经设置', 409);
          if (text(data.password).length < 8) return error('管理员密码至少需要8位');
          if (!suppliedProof(data)) return error('登录页面版本过旧，请刷新后重试');
          let admin = await repo.getUserById('admin');
          const passwordHash = await proofCredential(suppliedProof(data), requirePepper(env));
          if (!admin) admin = await repo.createUser({ id: 'admin', role: 'admin', name: '管理员', phone: '', passwordHash });
          else await repo.updateUser('admin', { passwordHash });
          await repo.setSetting('adminPasswordHash', passwordHash);
          const token = await issueSession(repo, request, admin);
          return json({ token }, 200, { 'set-cookie': sessionCookie(token) });
        }
        if (method === 'POST' && path === '/api/admin/login') {
          const data = await bodyJson(request), settings = await repo.getSettings();
          if (!settings.adminPasswordHash) return error('请先设置管理员密码', 409);
          if (!(await verifyProofCredential(suppliedProof(data), settings.adminPasswordHash, requirePepper(env)))) return error('管理员密码不正确', 401);
          const admin = await repo.getUserById('admin');
          if (!admin) return error('管理员账号未初始化', 409);
          const token = await issueSession(repo, request, admin);
          return json({ token }, 200, { 'set-cookie': sessionCookie(token) });
        }

        const viewer = await actorOf(repo, request);
        if (method === 'GET' && path === '/api/map-config') {
          return json(mapConfigured(env)
            ? { configured: true, key: text(env.AMAP_JS_API_KEY), version: '2.0', serviceHost: `${url.origin}/_AMapService` }
            : { configured: false, reason: '高德地图 JS API 尚未配置' });
        }
        if (method === 'GET' && path === '/api/map-orders') {
          const teacher = await requireRole(repo, request, 'teacher');
          if (!teacher) return error('请先以老师身份登录', 401);
          const orders = (await repo.listOrders({ limit: 500 })).filter(order => order.status === 'open').map(order => ({
            id: order.id,
            locations: Array.isArray(order.locationOptions) && order.locationOptions.length > 1
              ? order.locationOptions.filter(option => option.verified && option.coordinates).map(option => option.coordinates)
              : order.locationVerified && order.locationCoordinates ? [order.locationCoordinates] : []
          })).filter(order => order.locations.length);
          return json({ orders });
        }
        if (method === 'GET' && path === '/api/state') {
          const state = await repo.getPublicState();
          const visibleOrders = viewer ? await repo.listOrders({ limit: 500 }) : (state.orders || []);
          const orders = await Promise.all(visibleOrders.map(async order => cleanOrder(order, await repo.listApplications({ orderId: order.id }), viewer)));
          const settings = state.settings || {};
          const announcements = viewer?.role === 'admin' ? await repo.listAnnouncements() : null;
          const allUsers = viewer?.role === 'admin' ? await repo.listUsers() : [];
          const identities = new Set(allUsers.filter(user => ['teacher', 'agency'].includes(user.role)).map(user => `${user.name}\u0000${user.phone}`));
          return json({ ...state, announcement: announcements ? (announcements[0] || null) : state.announcement,
            settings: { homeAddress: settings.homeAddress || '', maxBikeKm: settings.maxBikeKm || 12 }, viewer,
            adminConfigured: Boolean(state.adminConfigured), orders,
            users: allUsers.map(user => ({ id: user.id, role: user.role, name: user.name, phone: user.phone, passwordSet: Boolean(user.passwordHash), createdAt: user.createdAt })),
            feedback: viewer?.role === 'admin' ? await repo.listFeedback() : [],
            stats: { registeredUsers: identities.size, onlineUsers: 0 }, lists: LISTS });
        }
        if (method === 'GET' && path === '/api/stats') {
          const users = await repo.listUsers();
          const identities = new Set(users.filter(user => ['teacher', 'agency'].includes(user.role)).map(user => `${user.name}\u0000${user.phone}`));
          return json({ registeredUsers: identities.size, onlineUsers: 0 });
        }
        if (method === 'POST' && path === '/api/feedback') {
          const data = await bodyJson(request), content = text(data.content);
          if (content.length < 2) return error('请填写反馈内容');
          await repo.createFeedback({ name: text(data.name), contact: text(data.contact), content });
          return json({ ok: true });
        }
        if (path === '/api/teacher/preferences' && ['GET', 'PUT'].includes(method)) {
          const teacher = await requireRole(repo, request, 'teacher');
          if (!teacher) return error('请先以老师身份登录', 401);
          const user = await repo.getUserById(teacher.id);
          if (method === 'GET') return json({ exists: Boolean(user.preferences && Object.keys(user.preferences).length), preferences: user.preferences || {} });
          const preferences = await bodyJson(request);
          await repo.updateUser(teacher.id, { preferences });
          return json({ ok: true, preferences });
        }
        if (method === 'POST' && path === '/api/account/password') {
          if (!viewer || !['teacher', 'agency'].includes(viewer.role)) return error('请先登录账号', 401);
          const data = await bodyJson(request), user = await repo.getUserById(viewer.id);
          if (text(data.newPassword).length < 6) return error('新密码至少需要6位');
          if (!text(data.newPasswordProof)) return error('登录页面版本过旧，请刷新后重试');
          if (!user || !(await verifyProofCredential(text(data.oldPasswordProof), user.passwordHash, requirePepper(env)))) return error('原密码不正确', 401);
          const passwordHash = await proofCredential(text(data.newPasswordProof), requirePepper(env));
          const pair = await repo.listUsers({ phone: user.phone, name: user.name });
          await Promise.all(pair.filter(item => ['teacher', 'agency'].includes(item.role)).map(item => repo.updateUser(item.id, { passwordHash })));
          return json({ ok: true });
        }
        if (method === 'POST' && path === '/api/account/password-by-identity') {
          const data = await bodyJson(request), name = text(data.name), phone = text(data.phone);
          if (!name || !validPhone(phone)) return error('请填写姓名和正确手机号');
          if (text(data.newPassword).length < 6) return error('新密码至少需要6位');
          if (!text(data.newPasswordProof)) return error('登录页面版本过旧，请刷新后重试');
          const pair = await repo.listUsers({ phone, name });
          if (!pair.length || !(await verifyProofCredential(text(data.oldPasswordProof), pair[0].passwordHash, requirePepper(env)))) return error('姓名、手机号或原密码不正确', 401);
          const passwordHash = await proofCredential(text(data.newPasswordProof), requirePepper(env));
          await Promise.all(pair.map(item => repo.updateUser(item.id, { passwordHash })));
          return json({ ok: true });
        }
        if (method === 'GET' && path === '/api/location-suggestions') {
          const result = await amap.candidates(url.searchParams.get('q'), url.searchParams.get('district'));
          return json({ status: result.status, suggestions: result.candidates });
        }
        if (method === 'POST' && path === '/api/distance-preview') {
          const teacher = await requireRole(repo, request, 'teacher');
          if (!teacher) return error('请先以老师身份登录', 401);
          const data = await bodyJson(request), origin = text(data.origin);
          if (!origin) return error('请填写你的位置');
          const orders = (await repo.listOrders({ limit: 500 })).filter(order => order.status !== 'closed');
          const settings = await repo.getSettings();
          const distances = await mapWithConcurrency(orders, 4, async order => {
            const destinations = Array.isArray(order.locationOptions) && order.locationOptions.length > 1
              ? order.locationOptions.filter(option => option.verified && option.coordinates).map(option => ({ option, value: option.coordinates }))
              : order.locationVerified && order.locationCoordinates ? [{ value: order.locationCoordinates }] : [];
            if (!destinations.length) {
              return { id: order.id, status: 'location_unconfirmed', distanceKm: '', routeOptions: {}, locationOptionRoutes: [], score: scoreOrder(order, settings) };
            }
            const routed = await mapWithConcurrency(destinations, 2, async destination => ({
              ...destination,
              route: await amap.route(origin, destination.value, data.mode)
            }));
            const best = routed.slice().sort((a, b) => a.route.km - b.route.km)[0];
            return { id: order.id, status: 'verified', distanceKm: best.route.km, routeMode: best.route.label,
              routeOptions: { [best.route.mode]: best.route }, locationOptionRoutes: routed.map(item => ({ ...item.option, routeOptions: { [item.route.mode]: item.route } })),
              score: scoreOrder({ ...order, distanceKm: best.route.km }, settings) };
          });
          return json({ status: 'verified', distances });
        }
        if (method === 'POST' && path === '/api/parse') {
          const agency = await requireRole(repo, request, 'agency');
          if (!agency) return error('请先以中介身份登录', 401);
          if (typeof dependencies.parseOrders === 'function') return json(await dependencies.parseOrders(await bodyJson(request), { agency, env, ctx }));
          return error(dependencies.parseLoadError ? `订单解析适配加载失败：${dependencies.parseLoadError}` : '订单解析服务尚未部署，请稍后再试', 503);
        }
        if (method === 'POST' && path === '/api/orders') {
          const agency = await requireRole(repo, request, 'agency');
          if (!agency) return error('请先以中介身份登录', 401);
          const data = await bodyJson(request);
          const { images: _images, pages: _pages, sourceImages: _sourceImages, ...orderData } = data;
          return json(await repo.createOrder({ ...orderData, id: undefined, agencyId: agency.id, source: agency.name, status: data.status || 'open', structured: orderData }));
        }
        if (method === 'POST' && path === '/api/import') {
          const agency = await requireRole(repo, request, 'agency');
          if (!agency) return error('请先以中介身份登录', 401);
          const data = await bodyJson(request);
          const incoming = Array.isArray(data.orders) ? data.orders.slice(0, 200) : [];
          if (!incoming.length) return error('请先识别并确认要导入的订单');
          const existingOrders = await repo.listOrders({ agencyId: agency.id, limit: 500 });
          const knownFingerprints = new Set((await Promise.all(existingOrders.map(async order => {
            const raw = text(order.raw || order.structured?.raw);
            return [
              text(order.importFingerprint),
              raw ? await sha256(`${agency.id}|${canonicalOrderText(raw)}`) : ''
            ];
          }))).flat().filter(Boolean));
          const fingerprinted = await Promise.all(incoming.map(async item => {
            const raw = text(item.raw);
            return { item, importFingerprint: raw ? await sha256(`${agency.id}|${canonicalOrderText(raw)}`) : '' };
          }));
          const accepted = [];
          let duplicatesSkipped = 0;
          for (const entry of fingerprinted) {
            if (entry.importFingerprint && knownFingerprints.has(entry.importFingerprint)) {
              duplicatesSkipped++;
              continue;
            }
            if (entry.importFingerprint) knownFingerprints.add(entry.importFingerprint);
            accepted.push(entry);
          }
          const prepared = await mapWithConcurrency(accepted, 3, entry => prepareCloudflareImportedOrder(entry.item, agency, amap));
          const outcomes = await mapWithConcurrency(prepared, 3, async (orderData, index) => {
            const importFingerprint = accepted[index].importFingerprint;
            try {
              return { order: await repo.createOrder({ ...orderData, importFingerprint }) };
            } catch (caught) {
              if (/unique|constraint|fingerprint/i.test(String(caught?.message || ''))) return { duplicate: true };
              else throw caught;
            }
          });
          const created = outcomes.filter(result => result.order).map(result => result.order);
          duplicatesSkipped += outcomes.filter(result => result.duplicate).length;
          return json({ created, duplicatesSkipped, incompleteSkipped: 0 });
        }
        if (method === 'POST' && path === '/api/agency/orders/bulk') {
          const agency = await requireRole(repo, request, 'agency');
          if (!agency) return error('请先以中介身份登录', 401);
          const data = await bodyJson(request);
          if (!['close', 'delete'].includes(data.action)) return error('不支持的批量操作');
          const orders = await repo.listOrders({ agencyId: agency.id, limit: 500 });
          const targets = data.action === 'close' ? orders.filter(order => order.status !== 'closed') : orders;
          if (data.action === 'close') await Promise.all(targets.map(order => repo.updateOrder(order.id, { status: 'closed' })));
          else await Promise.all(targets.map(order => repo.deleteOrder(order.id)));
          return json({ action: data.action, affected: targets.length });
        }
        const apply = path.match(/^\/api\/orders\/([^/]+)\/apply$/);
        if (method === 'POST' && apply) {
          const teacher = await requireRole(repo, request, 'teacher');
          if (!teacher) return error('请先以老师身份登录', 401);
          const order = await repo.getOrderById(apply[1]);
          if (!order) return error('订单不存在', 404);
          if (order.status === 'closed') return error('这个订单已经下架');
          const existing = (await repo.listApplications({ orderId: order.id })).find(item => item.teacherId === teacher.id);
          const data = await bodyJson(request);
          const applicant = existing || await repo.createApplication({ orderId: order.id, teacherId: teacher.id, name: teacher.name, phone: teacher.phone, note: text(data.note) });
          const agency = await repo.getUserById(order.agencyId);
          return json({ ok: true, alreadyApplied: Boolean(existing), contact: { name: agency?.name || order.source || '发单人', phone: agency?.phone || '' },
            applicant: { name: applicant.name, phone: applicant.phone, at: applicant.createdAt } });
        }
        const locationConfirmation = path.match(/^\/api\/orders\/([^/]+)\/location\/confirm$/);
        if (method === 'POST' && locationConfirmation) {
          const order = await repo.getOrderById(locationConfirmation[1]);
          if (!order) return error('订单不存在', 404);
          if (!viewer || !(viewer.role === 'admin' || (viewer.role === 'agency' && viewer.id === order.agencyId))) return error('你只能确认自己发布订单的地点', 403);
          const data = await bodyJson(request);
          const confirmed = amap.confirm(data.candidate, data.district || order.district);
          return json(await repo.updateOrder(order.id, { ...confirmed, locationCandidates: order.locationCandidates || [] }));
        }
        const orderRoute = path.match(/^\/api\/orders\/([^/]+)$/);
        if (orderRoute && ['PATCH', 'DELETE'].includes(method)) {
          const order = await repo.getOrderById(orderRoute[1]);
          if (!order) return error('订单不存在', 404);
          if (!viewer || !(viewer.role === 'admin' || (viewer.role === 'agency' && viewer.id === order.agencyId))) return error('你只能管理自己发布的订单', 403);
          if (method === 'DELETE') {
            await repo.deleteOrder(order.id); return json({ ok: true });
          }
          const data = await bodyJson(request);
          const allowed = viewer.role === 'admin' ? ['status'] : ['status', 'district', 'place', 'placeOriginal', 'address', 'subject', 'grade', 'gradeDescription', 'price', 'priceMin', 'priceMax', 'priceUnit', 'hourlyPrice', 'priceText', 'monthly', 'schedule', 'gender', 'student', 'studentGender', 'requirements', 'raw'];
          const patch = {}; for (const key of allowed) if (Object.prototype.hasOwnProperty.call(data, key)) patch[key] = data[key];
          return json(await repo.updateOrder(order.id, patch));
        }
        if (method === 'POST' && path === '/api/admin/announcement') {
          if (!(await requireRole(repo, request, 'admin'))) return error('需要管理员权限', 401);
          const data = await bodyJson(request), content = text(data.content), title = text(data.title);
          if (data.active && !content) return error('请填写公告内容');
          return json(await repo.createAnnouncement({ title: title.slice(0, 60), content: content.slice(0, 2000), active: Boolean(data.active) }));
        }
        if (method === 'POST' && path === '/api/settings') {
          if (!(await requireRole(repo, request, 'admin'))) return error('需要管理员权限', 401);
          const data = await bodyJson(request);
          for (const key of ['homeAddress', 'maxBikeKm']) if (Object.prototype.hasOwnProperty.call(data, key)) await repo.setSetting(key, data[key]);
          return json(await repo.getSettings());
        }
        return error('接口不存在', 404);
      } catch (caught) {
        if (caught?.code) return json({ error: caught.message, code: caught.code, details: caught.details || {} }, caught.status || 500);
        return error(caught && caught.message ? caught.message : '服务器错误', caught && caught.status ? caught.status : 500);
      }
    }
  };
}

const worker = createWorker();
module.exports = worker;
module.exports.createWorker = createWorker;
