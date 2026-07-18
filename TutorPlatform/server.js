const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runParserPipeline } = require('./parser/pipeline');
const { sanitizeImportedOrder, canReuseVerifiedLocation, markRoutePending } = require('../shared/order-import');
const { isNumberedOrderStart, splitOrdersDetailed } = require('./parser/splitter');
const { recognizeOrders } = require('./parser/recognizer');
const { scoreOrder } = require('../shared/order-score');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.TUTOR_DATA_DIR ? path.resolve(process.env.TUTOR_DATA_DIR) : path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const SOURCE_IMAGE_DIR = path.join(DATA_DIR, 'source-images');
const MAX_SOURCE_IMAGES = 40;
const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
const MAX_CLIPBOARD_TEXT_BYTES = 512 * 1024;
const MAX_CLIPBOARD_INBOX = 500;
const sessions = new Map();
const visitors = new Map();
const ACTIVE_VISITOR_MS = 5 * 60 * 1000;
const REMEMBER_COOKIE = 'tutor_remember';
const REMEMBER_LOGIN_MS = 30 * 24 * 60 * 60 * 1000;
const SMS_CODE_TTL_MS = 5 * 60 * 1000;
const SMS_RESEND_MS = 60 * 1000;
const SMS_MAX_ATTEMPTS = 5;
const WECHAT_FLOW_TTL_MS = 10 * 60 * 1000;
const smsChallenges = new Map();
const wechatOAuthStates = new Map();
const wechatTickets = new Map();
const geocodeCache = new Map();
const routeCache = new Map();
const MAP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ROUTE_MODES = ['walking', 'cycling', 'driving', 'transit'];

const LISTS = {
  districts: ['罗湖', '福田', '南山', '盐田', '宝安', '龙岗', '龙华', '坪山', '光明', '大鹏'],
  subjects: ['语文', '数学', '英语', '物理', '化学', '生物', '道法', '政治', '历史', '地理', '科学', '信息技术', '编程', '奥数', '全科', '陪读', '体育', '音乐', '美术', '书法', '油画', '心理', '作业辅导', '托管', '陪玩', 'p5.js', '雅思', '托福', '日语', '德语', '俄语', '其他'],
  grades: ['幼儿园', '一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '小学', '初一', '初二', '初三', '初中', '高一', '高二', '高三', '高中', '中考', '高考', '大一', '大二', '大三', '大四', '大学', '成人', '其他']
};

const LANDMARK_DISTRICTS = {
  桃源村: '南山', 农林: '福田', 华侨城: '南山', 白石洲: '南山', 西丽: '南山',
  后海: '南山', 南油: '南山', 蛇口: '南山', 车公庙: '福田', 香蜜湖: '福田',
  景田: '福田', 岗厦: '福田', 侨香: '福田', 笔架山: '福田', 孖岭: '福田', 布吉: '龙岗', 坂田: '龙岗', 大运: '龙岗',
  民治: '龙华', 红山: '龙华', 公明: '光明', 西乡: '宝安', 固戍: '宝安', 福永: '宝安', 怀德: '宝安', 流塘: '宝安', 盐田墟: '盐田'
};

const AMAP_DISTRICT_ADCODES = {
  罗湖: '440303', 福田: '440304', 南山: '440305', 宝安: '440306',
  龙岗: '440307', 盐田: '440308', 龙华: '440309', 坪山: '440310', 光明: '440311'
};

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify({ settings: {}, users: [], orders: [] }, null, 2), 'utf8');
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  db.settings ||= {};
  db.users ||= [];
  db.orders ||= [];
  db.feedback ||= [];
  db.clipboardInbox ||= [];
  db.clipboardReceipts ||= [];
  db.rememberSessions ||= [];
  db.announcement ||= { title: '', content: '', active: false, updatedAt: '' };
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function passwordMatches(password, stored) {
  if (!stored || !password) return false;
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function envValue(name) {
  return textOf(process.env[name]);
}

function validMainlandPhone(phone) {
  return /^1[3-9]\d{9}$/.test(textOf(phone));
}

function smsConfiguration() {
  const config = {
    secretId: envValue('TENCENT_SMS_SECRET_ID'),
    secretKey: envValue('TENCENT_SMS_SECRET_KEY'),
    appId: envValue('TENCENT_SMS_APP_ID'),
    signName: envValue('TENCENT_SMS_SIGN_NAME'),
    templateId: envValue('TENCENT_SMS_TEMPLATE_ID'),
    region: envValue('TENCENT_SMS_REGION') || 'ap-guangzhou'
  };
  config.enabled = Boolean(config.secretId && config.secretKey && config.appId && config.signName && config.templateId);
  config.devMode = process.env.SMS_DEV_MODE === '1';
  return config;
}

function wechatConfiguration() {
  const config = {
    appId: envValue('WECHAT_OPEN_APP_ID'),
    appSecret: envValue('WECHAT_OPEN_APP_SECRET'),
    redirectUri: envValue('WECHAT_REDIRECT_URI')
  };
  config.enabled = Boolean(config.appId && config.appSecret && config.redirectUri);
  return config;
}

function authConfiguration() {
  const sms = smsConfiguration();
  const wechat = wechatConfiguration();
  return {
    smsEnabled: sms.enabled || sms.devMode,
    wechatEnabled: wechat.enabled,
    smsResendSeconds: Math.ceil(SMS_RESEND_MS / 1000),
    smsExpiresMinutes: Math.ceil(SMS_CODE_TTL_MS / 60000)
  };
}

function sha256(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value).digest(encoding);
}

function hmacSha256(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function templateParameters(code) {
  const configured = envValue('TENCENT_SMS_TEMPLATE_PARAMS');
  if (configured) {
    try {
      const values = JSON.parse(configured);
      if (Array.isArray(values) && values.length) {
        return values.map(value => String(value).replaceAll('{code}', code).replaceAll('{minutes}', String(Math.ceil(SMS_CODE_TTL_MS / 60000))));
      }
    } catch (_) {}
  }
  return [code, String(Math.ceil(SMS_CODE_TTL_MS / 60000))];
}

async function sendTencentSms(phone, code, config) {
  const service = 'sms';
  const host = 'sms.tencentcloudapi.com';
  const action = 'SendSms';
  const version = '2021-01-11';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify({
    PhoneNumberSet: [`+86${phone}`],
    SmsSdkAppId: config.appId,
    SignName: config.signName,
    TemplateId: config.templateId,
    TemplateParamSet: templateParameters(code)
  });
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(payload)}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const secretDate = hmacSha256(`TC3${config.secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = hmacSha256(secretSigning, stringToSign, 'hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${config.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': version,
      'X-TC-Region': config.region
    },
    body: payload,
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json();
  if (result.Response?.Error) throw new Error(result.Response.Error.Message || '短信发送失败');
  const status = result.Response?.SendStatusSet?.[0];
  if (!status || status.Code !== 'Ok') throw new Error(status?.Message || '短信发送失败');
}

function challengeHash(phone, code, nonce) {
  return sha256(`${phone}|${code}|${nonce}`);
}

function pruneTemporaryAuth() {
  const now = Date.now();
  for (const [phone, item] of smsChallenges) if (item.expiresAt <= now) smsChallenges.delete(phone);
  for (const [state, item] of wechatOAuthStates) if (item.expiresAt <= now) wechatOAuthStates.delete(state);
  for (const [ticket, item] of wechatTickets) if (item.expiresAt <= now) wechatTickets.delete(ticket);
}

function consumeSmsChallenge(phone, code) {
  pruneTemporaryAuth();
  const challenge = smsChallenges.get(phone);
  if (!challenge) return { ok: false, error: '验证码已过期，请重新获取' };
  if (challenge.attempts >= SMS_MAX_ATTEMPTS) {
    smsChallenges.delete(phone);
    return { ok: false, error: '验证码尝试次数过多，请重新获取' };
  }
  challenge.attempts++;
  const actual = Buffer.from(challengeHash(phone, code, challenge.nonce), 'hex');
  const expected = Buffer.from(challenge.codeHash, 'hex');
  const matches = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (!matches) return { ok: false, error: '验证码不正确' };
  smsChallenges.delete(phone);
  return { ok: true };
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const item of cookies) {
    const [key, ...parts] = item.trim().split('=');
    if (key === name) return decodeURIComponent(parts.join('='));
  }
  return '';
}

function rememberCookieHeader(req, token, maxAgeSeconds) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' || Boolean(req.socket.encrypted);
  return `${REMEMBER_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function pruneRememberSessions(db) {
  const before = db.rememberSessions.length;
  const now = Date.now();
  db.rememberSessions = db.rememberSessions.filter(item => Number(item.expiresAt || 0) > now);
  return db.rememberSessions.length !== before;
}

function issueRememberLogin(db, name, phone) {
  pruneRememberSessions(db);
  const token = crypto.randomBytes(32).toString('hex');
  db.rememberSessions.push({
    tokenHash: tokenHash(token),
    name,
    phone,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + REMEMBER_LOGIN_MS
  });
  db.rememberSessions = db.rememberSessions.slice(-500);
  return token;
}

function revokeRememberToken(db, token) {
  if (!token) return false;
  const hash = tokenHash(token);
  const before = db.rememberSessions.length;
  db.rememberSessions = db.rememberSessions.filter(item => item.tokenHash !== hash);
  return db.rememberSessions.length !== before;
}

function revokeRememberIdentity(db, name, phone) {
  const before = db.rememberSessions.length;
  db.rememberSessions = db.rememberSessions.filter(item => item.name !== name || item.phone !== phone);
  return db.rememberSessions.length !== before;
}

function createSession(identity) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { ...identity, createdAt: Date.now(), lastSeen: Date.now() });
  return token;
}

function publicUser(user) {
  return { id: user.id, role: user.role, name: user.name, phone: user.phone };
}

function identityAccounts(db, name, phone) {
  return ['teacher', 'agency'].map(role => db.users.find(user => (
    user.role === role && user.name === name && user.phone === phone
  )) || null);
}

function phoneIdentityConflict(db, name, phone) {
  return db.users.find(user => ['teacher', 'agency'].includes(user.role) && user.phone === phone && user.name !== name) || null;
}

function createIdentityUser(role, name, phone, password = '') {
  return {
    id: 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    role,
    name,
    phone,
    ...(password ? { passwordHash: passwordHash(password) } : {}),
    createdAt: new Date().toISOString()
  };
}

function ensurePairedIdentity(db, name, phone, options = {}) {
  const password = textOf(options.password);
  const accounts = identityAccounts(db, name, phone);
  if (options.requirePassword) {
    const existing = accounts.filter(Boolean);
    if (existing.some(user => user.passwordHash && !passwordMatches(password, user.passwordHash))) {
      return { error: '姓名、电话或密码不正确' };
    }
  }
  let changed = false;
  const paired = accounts.map((user, index) => {
    if (user) {
      if (password && !user.passwordHash) {
        user.passwordHash = passwordHash(password);
        changed = true;
      }
      return user;
    }
    const created = createIdentityUser(index === 0 ? 'teacher' : 'agency', name, phone, password);
    db.users.push(created);
    changed = true;
    return created;
  });
  return { teacher: paired[0], agency: paired[1], changed };
}

function memberLoginResponse(db, teacher, agency, rememberAccount, req) {
  const existingRememberToken = cookieValue(req, REMEMBER_COOKIE);
  let changed = false;
  let rememberCookie = rememberCookieHeader(req, '', 0);
  if (rememberAccount) {
    const token = issueRememberLogin(db, teacher.name, teacher.phone);
    rememberCookie = rememberCookieHeader(req, token, Math.floor(REMEMBER_LOGIN_MS / 1000));
    changed = true;
  } else if (revokeRememberToken(db, existingRememberToken)) {
    changed = true;
  }
  return {
    body: {
      teacher: publicUser(teacher),
      agency: publicUser(agency),
      teacherToken: createSession({ id: teacher.id, role: teacher.role, name: teacher.name }),
      agencyToken: createSession({ id: agency.id, role: agency.role, name: agency.name })
    },
    rememberCookie,
    changed
  };
}

function bindWechatIdentity(db, teacher, agency, ticket) {
  if (!ticket) return { changed: false };
  pruneTemporaryAuth();
  const pending = wechatTickets.get(ticket);
  if (!pending || pending.kind !== 'bind') return { error: '微信绑定已过期，请重新扫码' };
  const conflict = db.users.find(user => user.wechatIdentityHash === pending.identityHash && ![teacher.id, agency.id].includes(user.id));
  if (conflict) return { error: '这个微信已经绑定了其他账号' };
  teacher.wechatIdentityHash = pending.identityHash;
  agency.wechatIdentityHash = pending.identityHash;
  wechatTickets.delete(ticket);
  return { changed: true };
}

function agencyContactForOrder(db, order) {
  const agency = db.users.find(user => user.id === order.agencyId && user.role === 'agency');
  return {
    name: agency?.name || order.source || '发单人',
    phone: agency?.phone || ''
  };
}

function touchVisitor(req) {
  const visitorId = textOf(req.headers['x-visitor-id']);
  if (/^[A-Za-z0-9-]{8,80}$/.test(visitorId)) visitors.set(visitorId, Date.now());
}

function platformStats(db) {
  const now = Date.now();
  for (const [visitorId, lastSeen] of visitors) {
    if (now - lastSeen > ACTIVE_VISITOR_MS) visitors.delete(visitorId);
  }
  const registered = new Set();
  for (const user of db.users) {
    if (!['teacher', 'agency'].includes(user.role)) continue;
    const phone = textOf(user.phone);
    const name = textOf(user.name);
    registered.add(`identity:${name}|${phone}`);
  }
  return { registeredUsers: registered.size, onlineUsers: visitors.size };
}

function sessionOf(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = token ? sessions.get(token) || null : null;
  if (session) session.lastSeen = Date.now();
  return session;
}

function requireRole(req, res, role) {
  const session = sessionOf(req);
  if (!session || (role && session.role !== role)) {
    send(res, 401, { error: '请先登录后再操作' });
    return null;
  }
  return session;
}

function isLoopbackRequest(req) {
  const address = textOf(req.socket?.remoteAddress).toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
}

function isClipboardBridgeRequest(req) {
  return isLoopbackRequest(req) && req.headers['x-clipboard-bridge'] === 'shenzhen-tutor-local-v1';
}

function send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(type.includes('json') ? JSON.stringify(body) : body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        req.destroy();
        reject(new Error('上传内容过大，请减少每次读取的屏数'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (err) { reject(err); }
    });
  });
}

function saveSourceImages(values) {
  const items = Array.isArray(values) ? values.slice(0, MAX_SOURCE_IMAGES) : [];
  if (!items.length) return [];
  fs.mkdirSync(SOURCE_IMAGE_DIR, { recursive: true });
  const stored = [];
  for (const item of items) {
    const source = textOf(typeof item === 'string' ? item : item?.data);
    const match = source.match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\r\n]+)$/i);
    if (!match) continue;
    const extension = match[1].toLowerCase() === 'png' ? 'png' : 'jpg';
    const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
    if (!buffer.length || buffer.length > MAX_SOURCE_IMAGE_BYTES) continue;
    const validPng = extension === 'png' && buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const validJpeg = extension === 'jpg' && buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (!validPng && !validJpeg) continue;
    const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
    const fileName = `source-${digest}.${extension}`;
    const target = path.join(SOURCE_IMAGE_DIR, fileName);
    if (!fs.existsSync(target)) fs.writeFileSync(target, buffer);
    stored.push(fileName);
  }
  return uniq(stored);
}

function ocrComparable(value) {
  return textOf(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function textNgrams(value, size = 2) {
  const text = ocrComparable(value);
  const grams = new Set();
  for (let index = 0; index <= text.length - size; index++) grams.add(text.slice(index, index + size));
  return grams;
}

function sourcePageScore(orderText, pageText) {
  const order = ocrComparable(orderText);
  const page = ocrComparable(pageText);
  if (!order || !page) return 0;
  if (page.includes(order)) return 1000 + order.length;
  const orderGrams = textNgrams(orderText);
  const pageGrams = textNgrams(pageText);
  if (!orderGrams.size || !pageGrams.size) return 0;
  let common = 0;
  for (const gram of orderGrams) if (pageGrams.has(gram)) common++;
  const coverage = common / orderGrams.size;
  const precision = common / pageGrams.size;
  const anchors = [...textOf(orderText).matchAll(/(?:深圳)?[A-Z]{0,4}\d{6,}[A-Z]?|[\u4e00-\u9fff]{2,12}(?:小区|花园|公馆|中心|地铁站|学校|酒店|大厦|广场|村|城)/gi)]
    .map(match => ocrComparable(match[0]));
  const anchorHits = anchors.filter(anchor => anchor && page.includes(anchor)).length;
  return (coverage * 100) + (precision * 20) + (anchorHits * 25);
}

function saveSourcePages(pages, fallbackImages = []) {
  const result = [];
  const items = Array.isArray(pages) ? pages.slice(0, MAX_SOURCE_IMAGES) : [];
  for (const item of items) {
    const data = typeof item === 'string' ? item : item?.image || item?.data || item?.images?.[0];
    const fileName = saveSourceImages([data])[0];
    if (!fileName) continue;
    result.push({ text: textOf(item?.text), fileName });
  }
  if (result.length) return result;
  const stored = saveSourceImages(fallbackImages);
  return stored.map(fileName => ({ text: '', fileName }));
}

function sourceImageForOrder(orderText, sourcePages) {
  if (!sourcePages.length) return [];
  if (sourcePages.length === 1) return [sourcePages[0].fileName];
  let best = sourcePages[0];
  let bestScore = -1;
  for (const page of sourcePages) {
    const pageScore = sourcePageScore(orderText, page.text);
    if (pageScore > bestScore) {
      best = page;
      bestScore = pageScore;
    }
  }
  return best?.fileName ? [best.fileName] : [];
}

function removeUnreferencedSourceImages(db, candidates) {
  const referenced = new Set(db.orders.flatMap(order => Array.isArray(order.sourceImages) ? order.sourceImages : []));
  for (const candidate of uniq(Array.isArray(candidates) ? candidates : [])) {
    const fileName = path.basename(textOf(candidate));
    if (!fileName || referenced.has(fileName)) continue;
    const target = path.join(SOURCE_IMAGE_DIR, fileName);
    if (target.startsWith(SOURCE_IMAGE_DIR + path.sep)) fs.rmSync(target, { force: true });
  }
}

function textOf(value) {
  return String(value || '').trim();
}

function amapServiceKey(settings = {}) {
  return envValue('AMAP_WEB_SERVICE_KEY') || textOf(settings.amapWebServiceKey);
}

function stripLeadingDistrict(value, district = '') {
  const text = textOf(value);
  const name = textOf(district).replace(/区$/, '');
  if (!name) return text;
  // “盐田墟”是盐田区内的正式地名，不能被误删成单字“墟”。
  if (name === '盐田' && /^盐田墟/.test(text)) return text;
  return text.replace(new RegExp(`^${name}区?`), '');
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

function firstMatch(text, pattern) {
  const m = text.match(pattern);
  return m ? m[0] : '';
}

function sanitizeImportedText(value) {
  const lines = textOf(value).replace(/\r/g, '').split('\n');
  const result = [];
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) {
      result.push('');
      continue;
    }
    line = line
      .replace(/娄攵学央讠吾|娄攵学英讠吾/g, '数学英语')
      .replace(/(【科目】|科目\s*[:：])\s*数子/g, '$1数学')
      .replace(/高俄1/g, '高一俄语')
      .replace(/幼丿[Ll]?园/g, '幼儿园')
      .replace(/幼丿[Ll]/g, '幼儿')
      .replace(/口讠吾/g, '口语')
      .replace(/校夕卜/g, '校外')
      .replace(/(?<=\d)\s*一\s*(?=\d)/g, '-')
      .replace(/准高(?=语文|数学|英语|物理|化学|生物|政治|历史|地理)/g, '准高一')
      .replace(/(\d+(?:\.\d+)?)\s*h[yv]\s*\/\s*次/gi, '$1h/次')
      .replace(/(\d)\s*[,，]\s*(\d)(?=\s*(?:小时|h))/gi, '$1.$2')
      .replace(/((?:每次)?时?长\s*[:：])\s*巧\s*小时/g, '$1 1.5小时')
      .replace(/(?<=\d)\s*\/\s*[Kk](?=\s|$)/g, '/天')
      .replace(/(?<=点)\s*一\s*(?=\d)/g, '-')
      .replace(/(\d{2,4})\s*巾(?=\s|$|[，,。；;])/g, '$1/h')
      .replace(/^(?:情况|要求|时间|上课时间|科目|地址|薪酬|薪资|课酬|报酬|年级学科)\s*[,，]\s*/, match => match.replace(/[,，]/, '：'))
      .replace(/^(\s*(?:学员地址|辅导地址|上课地址|联系地址|家教地点|地址|地点|辅导科目|科目|学员情况|学生情况|学员|学生|情况|时间安排|时间次数|时间|老师要求|教师要求|教员要求|要求|老师薪水|薪水|课酬|薪酬|薪资|时薪|报酬))\s*[》>★☆*·|｜]\s*/, '$1：')
      .replace(/^[0O囗\s]+(?=今日新单)/, '');
    if (/^(?:.*家教群.*[（(]\d+[）)]|.*一群禁[。.]?|\d{1,2}\s*[:：]\s*\d{2}|(?:全\s*)?\d+\s*条新消息)$/.test(line)) continue;
    if (/肖老师接单|接单\s*\+?\s*[vV]|喜报喜报|招肖肖老师发单|动动手指|拿提成|扫码.*家教群|招小代理|招代理/.test(line)) continue;
    if (/^新单\s*[!！0\s]*$/.test(line)) continue;
    if (/^(?:语文|数学|英语|物理|化学|生物|政治|历史|地理|科学|全科)[】〕〗]$/.test(line)) continue;
    const garbageCount = (line.match(/[丷丿亇卜刭朩氵讠丨囗刀丫]/g) || []).length;
    if (garbageCount >= 3 && !/(地址|地点|科目|时间|薪酬|薪资|要求|学生|学员)/.test(line)) continue;
    result.push(line);
  }
  return result.join('\n')
    .replace(/^[（(〖〔]\s*([gGlLzZ][^\n〕〗）)]{4,90})\n[一—-]?\s*([^\n〕〗）)]{1,50})\s*[〕〗）)]$/gm, '【$1$2】')
    .replace(/(\d+(?:[.,，]\d+)?小)\n时\b/g, '$1时')
    .replace(/(h|小时|\/)\n次\b/gi, '$1次')
    .replace(/每次时\s*\n\s*长/g, '每次时长')
    .replace(/(\d)\s*[,，]\s*(\d)(?=\s*小时)/g, '$1.$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeFieldHeader(line) {
  const value = String(line || '').trim()
    .replace(/^[【\[]\s*/, '')
    .replace(/\s*[】\]]\s*[:：]?\s*/, '：');
  return /^(?:编号|家教编号|家教内容|家教地点|家教时间|家教薪酬|家教要求|学员地址|辅导地址|辅导地点|上课地址|联系地址|地址|地点|辅导科目|科目内容|科目|学员情况|学生情况|情况|学员|学生|年级性别|孩子性别|年级科目|年级学科|年级|时间安排|时间次数|时间次數|课时次数|时间|次数|次數|课时价格|课时报酬|课费报酬|课费薪酬|课酬薪资|课酬报酬|老师薪水|薪水|老师课费|老师报酬|教师报酬|课酬|薪酬|薪资|时薪|报酬|老师要求|教师要求|教员要求|教员|老师|要求|BR)\s*[:：]?/i.test(value);
}

function lineField(text, names) {
  const lines = textOf(text).split(/\n/).map(line => line.trim());
  const labels = [...names].sort((a, b) => b.length - a.length);
  const hardStop = /^(?:WY深圳\d|SZ\d|lw\d|(?:急|妃)\s*\d{8,}|深圳[A-Za-z]{0,5}\d|订单\s*[:：]?\s*\d|家教编号\s*[:：]?\s*\d|编号\s*[:：]?\s*[A-Z0-9]|[【(（〖]?通勤时间|#\s*暑假)/i;
  for (let i = 0; i < lines.length; i++) {
    let match = null;
    for (const name of labels) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      match = lines[i].match(new RegExp(`^[【\\[]\\s*${escaped}\\s*[:：]?[】\\]]\\s*[:：]?\\s*(.*)$`, 'i'))
        || lines[i].match(new RegExp(`^${escaped}(?:\\s*[:：\\-]\\s*|\\s+)(.*)$`, 'i'))
        || lines[i].match(new RegExp(`^${escaped}$`, 'i'));
      if (match) break;
    }
    if (!match) continue;
    const parts = [];
    if (match[1] && match[1].trim()) parts.push(match[1].replace(/\s*[【\[].*$/, '').trim());
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next) continue;
      if (looksLikeFieldHeader(next) || /^[【\[][^】\]]{1,18}[】\]]/.test(next) || hardStop.test(next)) break;
      parts.push(next);
      if (parts.join(' ').length >= 160) break;
    }
    const value = parts.join(' ').trim();
    if (value) return value;
  }
  return '';
}

function field(text, name) {
  const reg = new RegExp(`[【\\[]${name}\\s*[：:]?[】\\]]\\s*[：:]?\\s*([\\s\\S]*?)(?=\\s*[【\\[][^】\\]]{1,18}[】\\]]|\\n\\s*(?:[\\u4e00-\\u9fa5]{1,8}[：:]|[A-Z]{2,}\\d|深圳S\\d|#)|$)`);
  const m = text.match(reg);
  return m ? m[1].trim() : '';
}

function anyField(text, names) {
  const byLine = lineField(text, names);
  if (byLine) return byLine;
  for (const name of names) {
    const bracket = field(text, name);
    if (bracket) return bracket;
    const reg = new RegExp(`(?:^|\\n)\\s*${name}\\s*[：:\\-]\\s*([\\s\\S]*?)(?=\\n\\s*(?:联系地址|学员地址|辅导科目|学员情况|时间安排|教员要求|老师要求|老师薪水|薪水|老师报酬|教师要求|家教要求|地点|地址|科目|时间|时薪|报酬|薪资|薪酬|要求|学员|学生|老师|上课|辅导|课时|年级|年级性别|孩子性别|成绩|课酬薪资|课酬报酬|老师报酬|教师报酬|编号|订单|[A-Z]{1,5}\\d|[A-Z]{1,4}深圳\\d|SZ\\d|lw\\d|深圳[^\u4e00-\u9fa5A-Za-z0-9]{0,4}[A-Z]{0,5}\\d|深圳S\\d|深圳\\d|深圳家教|深圳线下TCZ|深圳TCZ|深圳星禾|深圳质优|深圳hs|#|【|\\[)|$)`, 'i');
    const m = text.match(reg);
    if (m) return m[1].trim();
  }
  return '';
}

function looksLikeOrderBlock(text) {
  return /(数学|英语|物理|化学|语文|生物|全科|陪读|作业|德语|俄语|自然拼读|体育|油画|编程|p5\.js)/i.test(text)
    && /(深圳|罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏|地点|上课地址|辅导地点|\d{1,2}号线|地铁站|小区|花园|村|附近|区)/.test(text)
    && /(\d{2,5}\s*[-—~～]?\s*\d{0,5}\s*(元|\/|每|h|小时|天|次|节|月)|时薪|薪酬|课酬|课费|报酬)/i.test(text);
}

function looksLikeJunkImport(text) {
  const s = textOf(text).replace(/\s+/g, ' ');
  if (!s) return true;
  // WeChat's forwarded "chat history" cards expose only short previews. OCR
  // can concatenate previews from different orders into one plausible-looking
  // block, but the missing tail fields make that data unsafe to publish.
  if (/(?:群聊的)?聊天记录/.test(s)) return true;
  if (/微信家教订单搬运助手|家教订单自动采集助手|网站中介账号|中介账号密码|自动定位读取|自动定位并查看截图|识别并上传一次|开始自动搬运|停止自动搬运|localhost:8787|alhost:8787|问题反馈|申请接单|复制原文|搜索\s*视频\s*问一问|扫码立即进入家教群|群聊满了|二维码过期/.test(s)) return true;
  const fieldSignals = /(家教内容|家教地点|家教时间|家教薪酬|学员地址|辅导地址|上课地址|辅导科目|科目内容|学员情况|年级性别|时间安排|时间次数|老师薪水|薪水|薪资|课时价格|老师要求|课酬|薪酬)/.test(s);
  const subjectSignals = /(语文|数学|英语|物理|化学|生物|全科|语数英|数理化|作业辅导|俄语|自然拼读)/.test(s);
  const placeSignals = /(深圳|宝安|南山|福田|罗湖|龙华|龙岗|光明|坪山|盐田|大鹏|\d{1,2}号线|地铁站|小区|花园|桃源村|附近)/.test(s);
  const priceSignals = /(\d{2,5}\s*(元|\/|每|h|小时|次|节|天)|老师薪水|薪水|薪资|课时价格|课酬|薪酬|自报(?:价)?|面议)/i.test(s);
  const scheduleSignals = /(一周|每周|每次|小时|暑假|八月|七月|周一|周二|周三|周四|周五|周六|周日|白天|下午|晚上)/.test(s);
  const gradeSignals = /(小学|一年级|二年级|三年级|四年级|五年级|六年级|初一|初二|初三|初中|新初|高一|高二|高三|新高|七年级|八年级|九年级)/.test(s);
  const looseOrderSignals = /(大学生|在校生|老师|补习|辅导|试课|上课频率|一对一)/.test(s);
  return !((fieldSignals && (subjectSignals || placeSignals) && priceSignals)
    || (subjectSignals && placeSignals && priceSignals && (scheduleSignals || gradeSignals))
    || (subjectSignals && placeSignals && gradeSignals && looseOrderSignals));
}

function looksLikeIncompleteStructuredImport(text) {
  const s = textOf(text).replace(/\s+/g, ' ').trim();
  if (!s) return true;
  const fieldNames = '学生|学员|学生情况|学员情况|情况|家教时间|时间|时间安排|时间次数|次数|家教薪酬|薪酬|薪资|薪水|时薪|报酬|课酬|课费|课费报酬|课费薪酬|课时价格|老师薪水|老师课费|教员|老师|要求|老师要求|教师要求|教员要求|家教要求';
  const fieldMatches = s.match(new RegExp(`(?:[【\\[](?:${fieldNames})\\s*[:：]?[】\\]]|(?:${fieldNames})\\s*[:：])`, 'g')) || [];
  if (!fieldMatches.length) return false;

  const hasPlace = /(深圳|罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏|\d{1,2}号线|地铁站|小区|花园|家园|公园|中心|附近|街道|村)/.test(s);
  const hasGrade = /(\d{1,2}\s*岁|幼儿园|幼小衔接|小学|小[一二三四五六]|[一二三四五六]年级|初[一二三]|[七八九]年级|高[一二三]|中考|高考|成人)/.test(s);
  const hasSubject = /(语文|数学|英语|物理|化学|生物|全科|语数英|数理化|作业辅导|科学|奥数|编程|陪读|陪玩|体育|美术|油画|俄语|自然拼读)/i.test(s);
  const addressNames = '家教地点|学员地址|辅导地址|上课地址|联系地址|辅导地点|地址|地点';
  const hasAddressField = new RegExp(`(?:[【\\[](?:${addressNames})\\s*[:：]?[】\\]]|(?:${addressNames})\\s*[:：])\\s*[^【\\[][\\s\\S]{1,80}`).test(s);
  const hasOrderCode = /(?:WY深圳\d{6,}|深圳BY\d{6,}|深圳线下[A-Z]{1,5}\d{5,}|(?:家教编号|编号|订单)\s*[:：]?\s*[A-Z0-9]{4,})/i.test(s);
  const bracketSegments = [...s.matchAll(/[【\[]([^】\]]{4,120})[】\]]/g)].map(match => match[1]);
  const hasBracketIdentity = bracketSegments.some(segment => (
    /(深圳|罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏|\d{1,2}号线|地铁站|小区|花园|家园|公园|中心|附近|村)/.test(segment)
    && /(小学|小[一二三四五六]|[一二三四五六]年级|初[一二三]|高[一二三]|成人)/.test(segment)
    && /(语文|数学|英语|物理|化学|生物|全科|科学|奥数|编程|陪读|陪玩|体育|美术|油画|俄语|自然拼读)/i.test(segment)
  ));
  const hasIdentity = hasBracketIdentity
    || (hasAddressField && hasGrade && hasSubject)
    || (hasOrderCode && hasAddressField && hasSubject)
    || (hasPlace && hasGrade && hasSubject)
    || (/线上/.test(s) && hasGrade && hasSubject);
  const tailNames = '薪酬|薪资|薪水|时薪|报酬|课酬|课费|课费报酬|课费薪酬|课时价格|老师薪水|老师课费|教员|老师|要求|老师要求|教师要求|教员要求|家教要求';
  const hasTail = new RegExp(`(?:[【\\[](?:${tailNames})\\s*[:：]?[】\\]]|(?:${tailNames})\\s*[:：])`).test(s) || /\\bBR\\s*[:：]/i.test(s);
  if (fieldMatches.length === 1 && !hasBracketIdentity && !hasAddressField) return false;
  return !hasIdentity || !hasTail;
}

function importBlockRichness(raw) {
  const s = textOf(raw);
  const fieldCount = (s.match(/[【\[](?:学生|学员|时间|次数|薪酬|薪资|薪水|课酬|要求|老师要求|教师要求|教员要求)[：:]?[】\]]/g) || []).length;
  const hasRequirement = /[【\[](?:要求|老师要求|教师要求|教员要求)[：:]?[】\]]/.test(s);
  const hasDuration = /\d+(?:\.\d+)?\s*(?:h|小时)\s*\/\s*次/i.test(s);
  const hasClosedTitle = /[【\[][^】\]]{5,120}[】\]]/.test(s);
  return Math.min(s.length, 800) + (fieldCount * 120) + (hasRequirement ? 260 : 0) + (hasDuration ? 100 : 0) + (hasClosedTitle ? 80 : 0);
}

function dedupeImportBlocks(blocks, source = '', agencyId = '') {
  const selected = [];
  const selectedByIdentity = new Map();
  for (const raw of blocks) {
    const order = parseOrder(raw, source, agencyId);
    const orderCode = extractOrderCode(raw);
    const place = textOf(order.place).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const grade = textOf(order.grade).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const subject = textOf(order.subject).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const price = Number(order.price || 0);
    const hasIdentity = place && grade && grade !== '其他' && subject && subject !== '其他' && price > 0;
    const identity = orderCode ? `code:${orderCode}` : (hasIdentity ? `order:${place}|${grade}|${subject}|${price}` : '');
    if (!identity) {
      selected.push(raw);
      continue;
    }
    const existingIndex = selectedByIdentity.get(identity);
    if (existingIndex === undefined) {
      selectedByIdentity.set(identity, selected.length);
      selected.push(raw);
      continue;
    }
    if (importBlockRichness(raw) > importBlockRichness(selected[existingIndex])) {
      selected[existingIndex] = raw;
    }
  }
  return selected;
}

function isLooseOrderStartLine(line) {
  const value = normalizeGrade(textOf(line)).replace(/\s+/g, ' ');
  if (!value || value.length > 90 || looksLikeFieldHeader(value)) return false;
  const hasGrade = /(幼儿园|小学|[一二三四五六]年级|初[一二三]|[七八九]年级|高[一二三]|中考|高考)/.test(value);
  const hasSubject = /(语文|数学|英语|物理|化学|生物|数理化|语数英|全科|奥数|科学|编程)/.test(value);
  return hasGrade && hasSubject;
}

function extractLooseOrderLine(text) {
  return textOf(text).split(/\n/).map(line => line.trim()).find(isLooseOrderStartLine) || '';
}

function extractLooseLocationLine(text) {
  const lines = textOf(text).split(/\n/).map(line => line.trim()).filter(Boolean);
  return lines.find(line => (
    line.length <= 80
    && /(\d{1,2}号线|地铁站|小区|花园|村|附近|街道|(?:路|大道|街|巷)(?:口|段)?|中心|公馆|家园|华府|学校|医院|酒店)/.test(line)
    && !/(课酬|薪酬|元\/?小时|老师要求|教师要求)/.test(line)
  )) || '';
}

function cleanLooseOrderBlock(lines) {
  return lines
    .filter(line => !/^(?:站?更新需求|查看详情|展开|收起|全\s*\d+\s*人提到|\d{1,2}:\d{2})$/.test(line.trim()))
    .join('\n')
    .trim();
}

function splitImportBlocksSoft(input) {
  const normalized = sanitizeImportedText(input)
    .replace(/\r/g, '')
    .replace(/\u200d/g, '')
    .replace(/^(\s*\d{8,})(?=\s*(?:地址|地点)\s*[:：])/gm, '$1\n')
    .replace(/深圳\s*[|｜ⅠI]\s*(?=BY\d)/gi, '深圳')
    .replace(/BY(\d{6,})\s*[．.]\s*(\d+)\b/gi, 'BY$1-$2')
    .replace(/[ \t]*[,，;；|｜]?[ \t]*(?=深圳\s*BY\d{6,}(?:-\d+)?\s*#)/gi, '\n')
    .replace(/^\s*(?:全\s*)?\d+\s*条新消息\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return [];

  const titleLine = /^\s*[^\u4e00-\u9fa5A-Za-z0-9]{0,8}\s*(?:[①②③④⑤⑥⑦⑧⑨⑩]\s*)?(?:[&＆]\s*)?(?:大学生上门|上门辅导|暑假预约|今日新单|大学生|专职老师|全职老师|暑假单|长期单|线上|广东线上)/;
  const bracketTitle = /^\s*【\s*[LZ]\s*[^】]+】/i;
  const looseTitle = /^\s*(?:[①②③④⑤⑥⑦⑧⑨⑩]\s*)?【[^】]*(?:深圳|南山|宝安|福田|龙华|龙岗|罗湖|盐田|光明|坪山|大鹏)[^】]+】/;
  const codeTitle = /^\s*(?:编号\s*[:：]?\s*)?(?:[A-Z]{1,5}\d{4,}[A-ZQ]?|[A-Z]{1,4}深圳\d{5,}[A-ZQ]?|SZ\d{5,}[A-Z]?|lw\d{3,}|(?:深圳|香港)[^\u4e00-\u9fa5A-Za-z0-9]{0,4}[A-Z]{0,5}\d{5,}[A-Z]*|深圳[a-zA-Z]{1,5}\d+|深圳线下[A-Z]{1,5}\d+|深圳TCZ\d+|深圳S?\d{5,}[A-Z]?|深圳家教\s*【?\s*\d{3,}\s*】?\s*号?家教|深圳家教\s*[:：]?\s*H?\d{3,}|深圳星禾家教\d+号?家教?|深圳质优家教\d+号?家教?|订单\s*[:：]?\s*\d+)/i;
  const byTitle = /^\s*[^\u4e00-\u9fa5A-Za-z0-9]{0,8}\s*深圳\s*BY\d{6,}(?:-\d+)?\s*#/i;
  const urgentTitle = /^\s*(?:急|妃)\s*\d{8,}/i;
  const numericCodeTitle = /^\s*\d{8,}(?=\s*(?:#|地址|地点|$))/i;
  const hashTitle = /^\s*#?(?:暑假单|暑假预约|开学单|深圳线下|龙华区|宝安区|福田区|南山区|罗湖区|龙岗区|光明区|坪山区|盐田区|大鹏区)/;
  const fieldLine = /^\s*(?:【(?:编号|学生|学员|学员情况|学生情况|时间|时间安排|时间次数|时间次數|课时次数|薪酬|薪水|课酬|老师课费|要求|老师要求|教师要求|教员要求|家教要求|次數|次数|年级科目|年级学科|辅导地点|上课地址|课时报酬|课费薪酬|课酬薪资|课酬报酬|老师报酬|教师报酬|老师薪水|地址|科目|年级|年级性别|孩子性别|成绩)】|\[(?:编号|学生|学员|科目|课酬|课酬薪资|时间|地址|要求|教师要求|教员要求|家教要求|年级|成绩|孩子性别)\]|(?:编号|家教编号|家教内容|家教地点|家教时间|家教薪酬|家教要求|联系地址|学员地址|辅导科目|学员情况|时间安排|教员要求|老师要求|老师薪水|薪水|老师报酬|教师报酬|老师报酬|地点|地址|科目|情况|时间|时薪|要求|报酬|薪酬|薪资|课酬|学员|学生|老师|上课地址|辅导地点|课时[报酬]*|年级科目|年级学科|年级性别|孩子性别|成绩)\s*[：:\\-])/;

  const compactLines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
  const hasStructuredMarkers = compactLines.some(line => (
    fieldLine.test(line) || bracketTitle.test(line) || looseTitle.test(line) || codeTitle.test(line) || byTitle.test(line) || urgentTitle.test(line) || numericCodeTitle.test(line)
  ));
  if (!hasStructuredMarkers) {
    const looseStartIndexes = [];
    compactLines.forEach((line, index) => {
      if (isLooseOrderStartLine(line)) looseStartIndexes.push(index);
    });
    if (looseStartIndexes.length) {
      const looseBlocks = looseStartIndexes.map((start, index) => {
        const end = looseStartIndexes[index + 1] ?? compactLines.length;
        return cleanLooseOrderBlock(compactLines.slice(start, end));
      }).filter(block => block.length > 10);
      if (looseBlocks.length) return looseBlocks;
    }
  }
  const compactPriceCount = (normalized.replace(/\s+/g, '').match(/\d{2,4}元\/?(?:小时|h)/gi) || []).length;
  if (!hasStructuredMarkers && compactPriceCount >= 2) {
    const compactBlocks = [];
    let compactCurrent = [];
    for (const line of compactLines) {
      if (/^(?:全\s*)?\d+\s*条新消息$/.test(line)) continue;
      compactCurrent.push(line);
      const joined = compactCurrent.join('\n').trim();
      const squashed = joined.replace(/\s+/g, '');
      if (/\d{2,4}元\/?(?:小时|h)/i.test(squashed) && looksLikeOrderBlock(joined)) {
        compactBlocks.push(joined);
        compactCurrent = [];
      }
    }
    if (compactCurrent.length) {
      const tail = compactCurrent.join('\n').trim();
      if (looksLikeOrderBlock(tail)) compactBlocks.push(tail);
    }
    const usefulCompactBlocks = compactBlocks.filter(block => !looksLikeJunkImport(block));
    if (usefulCompactBlocks.length >= 2) return usefulCompactBlocks;
  }

  const blocks = [];
  let current = [];
  const bareIdentityField = /^(?:地点|地址|上课地址|辅导地点|辅导地址|学员地址|联系地址)\s*[:：\-]/;
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (current.length && looksLikeOrderBlock(current.join('\n'))) {
        blocks.push(current.join('\n').trim());
        current = [];
      } else if (current.length) {
        current.push('');
      }
      continue;
    }
    const startsNewNumberedBlock = isNumberedOrderStart(line)
      || /^(?:【编号】|\[编号\]|家教编号\s*[：:]|编号\s*[：:]|订单\s*[：:]|SZ\d|lw\d|(?:急|妃)\s*\d{8,}|\d{8,}(?=\s*(?:#|地址|地点|$)))/i.test(line);
    const isTitle = startsNewNumberedBlock || titleLine.test(line) || bracketTitle.test(line) || looseTitle.test(line) || codeTitle.test(line) || byTitle.test(line) || urgentTitle.test(line) || numericCodeTitle.test(line) || hashTitle.test(line);
    const isField = fieldLine.test(line);
    const previousNeedsValue = current.length && looksLikeFieldHeader(current[current.length - 1]) && /[:：]\s*$/.test(current[current.length - 1]);
    const currentHasOrder = current.some(l => fieldLine.test(l) || bracketTitle.test(l) || looseTitle.test(l) || codeTitle.test(l) || byTitle.test(l) || urgentTitle.test(l) || numericCodeTitle.test(l) || looksLikeOrderBlock(l));
    const startsBareOrderAfterBracketOrder = bareIdentityField.test(line)
      && current.some(existing => /^【(?:地址|科目|学员|学生|时间|教员|薪资)】/.test(existing));
    const repeatedBareIdentity = !previousNeedsValue
      && bareIdentityField.test(line)
      && ((current.some(existing => bareIdentityField.test(existing))
        && current.some(existing => /^(?:科目|辅导科目|家教内容)\s*[:：\-]/.test(existing)))
        || startsBareOrderAfterBracketOrder);
    if (repeatedBareIdentity) {
      blocks.push(current.join('\n').trim());
      current = [line];
    } else if (!previousNeedsValue && isTitle && current.length && !currentHasOrder) {
      current = [line];
    } else if (!previousNeedsValue && isTitle && currentHasOrder) {
      blocks.push(current.join('\n').trim());
      current = [line];
    } else if (!previousNeedsValue && (bracketTitle.test(line) || looseTitle.test(line) || codeTitle.test(line) || byTitle.test(line) || urgentTitle.test(line) || numericCodeTitle.test(line)) && current.length && current.some(l => fieldLine.test(l))) {
      blocks.push(current.join('\n').trim());
      current = [line];
    } else {
      current.push(line);
    }
    if (!isField && /^[-—]{3,}$/.test(line) && current.length) {
      blocks.push(current.join('\n').trim());
      current = [];
    }
  }
  if (current.length) blocks.push(current.join('\n').trim());

  const expanded = [];
  for (const block of blocks) {
    const paragraphs = block.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    if (paragraphs.length > 1 && paragraphs.every(p => looksLikeOrderBlock(p))) expanded.push(...paragraphs);
    else expanded.push(block);
  }

  const cleaned = expanded
    .map(block => block.replace(/\n{3,}/g, '\n\n').trim())
    .filter(block => block.length > 10 && /【|学生|学员|时间|薪酬|课酬|时薪|要求|数学|英语|物理|化学|语文|生物|深圳|南山|宝安|福田|龙华|龙岗|罗湖|光明|地点/.test(block));
  return cleaned.length ? cleaned : [normalized];
}

function splitImportBlocksDetailed(input) {
  return splitOrdersDetailed(input, { softSplit: splitImportBlocksSoft });
}

function splitImportBlocks(input) {
  return splitImportBlocksDetailed(input).blocks;
}

function normalizeGrade(value) {
  if (!value) return '';
  return value
    .replace(/幼小衔接|幼升小/g, '幼儿园')
    .replace(/一升二/g, '二年级').replace(/二升三/g, '三年级').replace(/三升四/g, '四年级')
    .replace(/四升五/g, '五年级').replace(/五升六/g, '六年级').replace(/六升(?:初一|七)/g, '初一')
    .replace(/(?:准|新)?九年级/g, '初三').replace(/(?:准|新)?八年级/g, '初二').replace(/(?:准|新)?七年级/g, '初一')
    .replace(/下学期初三/g, '初三').replace(/下学期初二/g, '初二').replace(/下学期初一/g, '初一')
    .replace(/下学期五年级/g, '五年级').replace(/下学期四年级/g, '四年级').replace(/下学期二年级/g, '二年级')
    .replace(/新高三/g, '高三').replace(/新高二/g, '高二').replace(/新高一/g, '高一')
    .replace(/新初三/g, '初三').replace(/新初二/g, '初二').replace(/新初一/g, '初一')
    .replace(/中4/g, '初四').replace(/初四/g, '初三')
    .replace(/小一/g, '一年级').replace(/小二/g, '二年级').replace(/小三/g, '三年级')
    .replace(/小四/g, '四年级').replace(/小五/g, '五年级').replace(/小六/g, '六年级');
}

function extractNumberedSection(text, number) {
  const pattern = new RegExp(`(?:^|\\n)\\s*${number}\\s*[、.．)]\\s*([\\s\\S]*?)(?=\\n\\s*\\d+\\s*[、.．)]|\\n\\s*(?:ps|备注)\\s*[:：]|$)`, 'i');
  const match = textOf(text).match(pattern);
  return match ? match[1].replace(/\s*\n\s*/g, ' ').trim() : '';
}

function extractTitle(text) {
  const byTitle = text.match(/深圳\s*BY\d{6,}(?:-\d+)?\s*#\s*([^\n]+)/i);
  if (byTitle) return byTitle[1].replace(/[-—_]{3,}\s*$/, '').trim();
  const bracket = text.match(/【\s*[A-Z]\s*([^】]+)】/i) || text.match(/【\s*([^】]*(?:数学|英语|物理|化学|语文|生物|油画|p5\.js|编程|体育|陪玩|全科)[^】]*)】/i);
  if (bracket) return bracket[1].trim();
  const square = text.match(/\[\s*([A-Z])\s*([^\]]+)\]/i);
  if (square) return square[2].trim();
  const location = anyField(text, ['上课地址', '辅导地点', '学员地址', '联系地址', '家教地点', '地址', '地点']);
  const gradeSubject = anyField(text, ['年级科目', '年级学科', '年级性别', '年级', '家教内容', '辅导科目', '科目']);
  if (location || gradeSubject) return `${location} ${gradeSubject}`.trim();
  const looseOrderLine = extractLooseOrderLine(text);
  const looseLocationLine = extractLooseLocationLine(text);
  if (looseOrderLine) return `${looseLocationLine} ${looseOrderLine}`.trim();
  const line = text.split('\n').map(s => s.trim()).find(s => /深圳|南山|宝安|福田|龙华|龙岗|罗湖|盐田|光明|坪山|大鹏/.test(s));
  return line || text.slice(0, 80);
}

function extractDistrict(text) {
  const raw = firstMatch(text, /罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏|前海|深圳湾/);
  if (raw === '前海' || raw === '深圳湾') return '南山';
  if (!raw) {
    for (const [landmark, district] of Object.entries(LANDMARK_DISTRICTS)) {
      if (text.includes(landmark)) return district;
    }
  }
  return raw;
}

function extractPlace(title, district) {
  let t = textOf(title)
    .replace(/^\s*\d+\s*[、.．)]\s*/, '')
    .replace(/^[#＃]+\s*/, '')
    .replace(/^深圳市?/, '');
  t = stripLeadingDistrict(t, district);
  if (/^深圳市?/.test(t)) {
    t = stripLeadingDistrict(t.replace(/^深圳市?/, ''), district);
  }
  t = t.replace(/(?:准|升|新)(?=小|初|高|一|二|三|四|五|六|七|八|九)/g, '');
  t = t.replace(/(幼儿园|幼儿|小[一二三四五六]|一年级|二年级|三年级|四年级|五年级|六年级|小学|初一|初二|初三|初中|高一|高二|高三|高中|成人|大学|全职住家|语文|数学|英语|物理|化学|生物|政治|历史|地理|科学|体育|音乐|美术|书法|油画|p5\.js|编程|陪玩|托管|作业辅导).*$/i, '');
  return t
    .replace(/^市/, '')
    .replace(/^[#＃.。·\-—–\s]+/, '')
    .replace(/^(附近|地铁站)/, '')
    .replace(/[（(].*$/, '')
    .replace(/[，,。；;].*$/, '')
    .replace(/[#＃].*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSubjects(text) {
  const matches = [];
  if (/自然拼读|音标|phonics/i.test(text)) matches.push('英语');
  if (/数理化/.test(text)) matches.push('数学', '物理', '化学');
  if (/语数英/.test(text)) matches.push('语文', '数学', '英语');
  if (/全科/.test(text)) matches.push('全科');
  if (/陪读|陪学/.test(text)) matches.push('陪读');
  for (const subject of LISTS.subjects) {
    if (subject !== '其他' && new RegExp(subject.replace('.', '\\.'), 'i').test(text)) matches.push(subject);
  }
  if (/p5\.?js/i.test(text) && !matches.includes('p5.js')) matches.push('p5.js');
  if (/油画/.test(text) && !matches.includes('油画')) matches.push('油画');
  return uniq(matches).slice(0, 3).join('/');
}

function extractGrades(text) {
  const normalized = normalizeGrade(text);
  const found = [];
  if (/(?:[2-6]|[二三四五六])\s*岁/.test(normalized)) found.push('幼儿园');
  if (/(?:[7-9]|1[0-2]|[七八九十十一十二])\s*岁/.test(normalized)) found.push('小学');
  for (const grade of LISTS.grades) {
    if (grade !== '其他' && new RegExp(grade).test(normalized)) found.push(grade);
  }
  if (/准大一/.test(normalized) && !found.includes('大一')) found.push('大一');
  const unique = uniq(found);
  if (unique.some(g => /年级/.test(g))) {
    return unique.filter(g => g !== '小学').slice(0, 3).join('/');
  }
  return unique.slice(0, 3).join('/');
}

function extractStudent(text) {
  const labeled = anyField(text, ['学生', '学员情况', '学生情况', '学员', '情况', '年级性别', '孩子性别', '成绩']);
  if (labeled) return labeled;
  const numbered = extractNumberedSection(text, 2);
  if (numbered && /(?:\d{1,2}\s*岁|年级|男生|女生|男孩|女孩)/.test(numbered)) return numbered;
  const ageLine = textOf(text).split(/\n/).map(line => line.trim()).find(line => /\d{1,2}\s*岁[^\n]*(?:男|女)/.test(line));
  return ageLine ? ageLine.replace(/^\d+\s*[、.．)]\s*/, '') : firstMatch(text, /男生|女生|男孩|女孩|男士|女士|成人男性|成人女性|成人/);
}

function extractStudentGender(text, student = '') {
  const studentText = textOf(student);
  if (/女生|女孩|女学生|女学员/.test(studentText)) return '女';
  if (/男生|男孩|男学生|男学员/.test(studentText)) return '男';
  const source = textOf(text);
  if (/(?:学生|学员|孩子|初[一二三]|高[一二三]|小学|年级|毕业)[^，。；;\n]{0,18}(?:女生|女孩)/.test(source)) return '女';
  if (/(?:学生|学员|孩子|初[一二三]|高[一二三]|小学|年级|毕业)[^，。；;\n]{0,18}(?:男生|男孩)/.test(source)) return '男';
  if (/(?:初[一二三]|高[一二三]|小学|年级)[^，。；;\n]{0,12}女(?:[，,。；;\s]|$)/.test(source)) return '女';
  if (/(?:初[一二三]|高[一二三]|小学|年级)[^，。；;\n]{0,12}男(?:[，,。；;\s]|$)/.test(source)) return '男';
  return '';
}

function extractGradeDescription(text, grade = '') {
  const source = textOf(text);
  const juniorGraduate = /初三(?:刚)?毕业|初中(?:刚)?毕业|中考(?:刚)?结束/.test(source);
  const reviewJunior = /初三[^，。；;\n]{0,20}(?:查漏补缺|复习|巩固)|(?:查漏补缺|复习|巩固)[^，。；;\n]{0,20}初三/.test(source);
  const previewSenior = /(?:提前)?(?:熟悉|预习|衔接)[^，。；;\n]{0,16}高一|高一[^，。；;\n]{0,16}(?:熟悉|预习|衔接)/.test(source);
  if (juniorGraduate && reviewJunior && previewSenior) return '初三毕业，复习初三并预习高一';
  if (juniorGraduate && previewSenior) return '初三毕业，预习高一';
  return textOf(grade);
}

function extractSchedule(text) {
  const labeled = anyField(text, ['家教时间', '上课时间', '时间', '时间安排', '时间次数', '课时次数', '次数', '时间次數']);
  if (labeled) return labeled;
  const numbered = extractNumberedSection(text, 4);
  if (numbered && /(?:\d{1,2}月|一周|每周|每天|连续|上午|下午|晚上|时段|\d+\s*次)/.test(numbered)) return numbered;
  const scheduleLine = textOf(text).split(/\n/).map(line => line.trim()).find(line => /(?:\d{1,2}月\d{1,2}[号日]|一周|每周|每天|上午|下午|晚上)[^\n]*(?:次|小时|h|时段)/i.test(line));
  const phaseIndex = textOf(text).search(/暑假|暑期/);
  if (phaseIndex >= 0 && /开学(?:后)?/.test(textOf(text).slice(phaseIndex))) {
    return textOf(text).slice(phaseIndex)
      .split(/(?=(?:罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏)区?\s*\d{1,2}号线)|，(?=\s*(?:\d{2,5}\s*[-—~～]|要求|老师要求|课费|报酬|薪酬|【薪酬】|【要求】))/)[0]
      .trim();
  }
  return scheduleLine ? scheduleLine.replace(/^\d+\s*[、.．)]\s*/, '') : firstMatch(text, /周[一二三四五六日天末][^，。；;\n]{0,30}|工作日[^，。；;\n]{0,30}|暑期[^，。；;\n]{0,40}|暑假[^，。；;\n]{0,40}|包月[^，。；;\n]{0,30}|明天试课[^，。；;\n]{0,30}|晚上|晚间|下午|上午|寒暑假|寒假/);
}

function extractGender(text) {
  const teacherText = anyField(text, ['要求', '老师要求', '教师要求', '教员要求', '家教要求', '教员']) || extractNumberedSection(text, 5);
  if (teacherText) {
    if (/男女不限|男女皆可|男女都可|男女均可|不限性别/.test(teacherText)) return '不限';
    if (/女老师|女在职老师|女教员|女大学生|女在校生|女专职|女性|(?:^|[，,、\s])女(?:[，,、\s]|$)/.test(teacherText)) return '女老师';
    if (/男老师|男在职老师|男教员|男大学生|男大[一二三四]|男在校生|男专职|男性|(?:^|[，,、\s])男(?:[，,、\s]|$)/.test(teacherText)) return '男老师';
  }
  if (/男女不限|男女皆可|男女都可|男女均可|男女老师|男女教员|不限/.test(text)) return '不限';
  if (/女老师|女教员/.test(text)) return '女老师';
  if (/男老师|男教员/.test(text)) return '男老师';
  return '';
}

function extractRequirements(text) {
  return anyField(text, ['要求', '老师要求', '教师要求', '教员要求', '家教要求', '教员']) || extractNumberedSection(text, 5);
}

function extractLocationHierarchy(text, explicitLocation = '', district = '') {
  const source = textOf(text);
  const looksLikeLocationEvidence = value => {
    const candidate = textOf(value);
    if (/^(?:编号|学生|学员|学生情况|学员情况|时间|次数|薪酬|薪资|薪水|课酬|要求|老师要求|教师要求|教员要求|成绩)$/.test(candidate)) return false;
    return /(深圳|罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏|坂田|西乡|福永|街道|社区|花园|小区|公馆|家园|华府|新村|地铁站|中心|广场|大厦|公寓|苑|城|村|墟|塘|(?:路|大道|街|巷)(?:口|段)?)/.test(candidate);
  };
  const bracketSources = [...source.matchAll(/[【\[]([^】\]]{2,80})[】\]]/g)]
    .map(match => match[1])
    .filter(looksLikeLocationEvidence);
  const firstSentence = source.split(/[，,。；;\n]/)[0];
  const leadingBody = source.replace(/^(?:深圳市?)?[A-Za-z]{0,4}\d{5,}[A-Za-z]?\s*(?:【[^】]+】)?/, '').split(/[，,。；;\n]/)[0];
  const sources = uniq([
    explicitLocation,
    ...bracketSources,
    looksLikeLocationEvidence(leadingBody) ? leadingBody : '',
    looksLikeLocationEvidence(firstSentence) ? firstSentence : ''
  ]);
  const parts = [];
  const cleanPart = value => {
    let item = textOf(value)
      .replace(/^(?:[1-9]\ufe0f?\u20e3|[①②③④⑤⑥⑦⑧⑨⑩])\s*/, '')
      .replace(/^[【\[]\s*[A-Z]?\s*/i, '')
      .replace(/[】\]]\s*$/, '')
      .replace(/^(?:深圳市?)?[A-Za-z]{0,4}\d{5,}[A-Za-z]?/i, '')
      .replace(/^[A-Za-z]{1,3}(?=深圳市?)/i, '')
      .replace(/(?:准|新)?(?:幼儿园|小[一二三四五六]|[一二三四五六]年级|小学|初[一二三]|初中|高[一二三]|高中|大学|成人)/g, '')
      .replace(/(?:语数英|数理化|语文|数学|英语|物理|化学|生物|政治|历史|地理|科学|全科|编程|体育)/g, '')
      .replace(/(?:男生|女生|男孩|女孩|男学员|女学员|学生|学员|孩子|男性|女性|男|女)/g, '')
      .replace(/(?:刚毕业|毕业|基础.*|想提高.*|需要.*|课费.*|报酬.*|暑假.*|开学.*|上课.*|时间.*|要求.*)$/g, '')
      .replace(/^(?:地址|地点|上课地址|辅导地点)\s*[:：]?/, '')
      .replace(/^深圳市?/, '')
      .replace(/[\s#＃|｜:：]+/g, '')
      .trim();
    item = stripLeadingDistrict(item, district);
    return item.replace(/^[区县]/, '').replace(/[（(].*$/, '').replace(/[\/、,，]+$/, '').trim();
  };
  for (const candidateSource of sources) {
    const cleaned = cleanPart(candidateSource);
    if (!cleaned || cleaned.length < 2 || cleaned.length > 24) continue;
    const knownNames = Object.keys(LANDMARK_DISTRICTS).filter(name => cleaned.includes(name));
    const suffixNames = [...cleaned.matchAll(/[\u4e00-\u9fff]{2,12}(?:街道|社区|花园|小区|公馆|家园|华府|新村|地铁站|中心|广场|大厦|公寓|苑|城|村|墟|塘)/g)].map(match => match[0]);
    const fullCandidate = cleaned.length <= 16 && !/(一般|提高|成绩|连续|周末|专业|老师|前十|知识点)/.test(cleaned) ? cleaned : '';
    const names = uniq([fullCandidate, ...knownNames, ...suffixNames]);
    if (names.length) {
      for (const name of names) if (!parts.some(part => part.includes(name) || name.includes(part))) parts.push(name);
    } else if (!/(一般|提高|成绩|连续|周末|专业|老师|前十|知识点)/.test(cleaned)) {
      parts.push(cleaned);
    }
  }
  const normalizedParts = uniq(parts.map(part => cleanPart(part)).filter(part => part.length >= 2));
  const place = normalizedParts.join('·');
  const compactPlace = normalizedParts.join('');
  const searchablePlace = compactPlace.replace(/[·•・]/g, '');
  const poiAfterRoad = searchablePlace.match(/(?:路|大道|街|巷)([^路街巷]{2,}(?:花园|小区|公馆|家园|华府|大厦|公寓|苑|城|村))$/)?.[1] || '';
  const districtPrefix = district ? `深圳市${district}区` : '深圳市';
  const queries = uniq([
    searchablePlace ? `${districtPrefix}${searchablePlace}` : '',
    poiAfterRoad ? `${districtPrefix}${poiAfterRoad}` : '',
    searchablePlace,
    poiAfterRoad,
    compactPlace,
    normalizedParts.length > 1 ? normalizedParts.slice(-2).join('') : '',
    normalizedParts.at(-1) || ''
  ].filter(query => query.length >= 2));
  return { raw: textOf(explicitLocation) || sources.filter(Boolean).join(' | '), parts: normalizedParts, place, queries };
}

function canonicalLocationPlace(place, district = '') {
  const nearby = /附近|周边/.test(place);
  let value = textOf(place).replace(/附近|周边/g, '');
  if (district === '宝安' && /^(?:深圳)?(?:国际)?会展(?:中心)?$/.test(value)) value = '深圳国际会展中心';
  return `${value}${nearby ? '附近' : ''}`;
}

function extractLocationOptions(text) {
  const source = textOf(text);
  const containers = [...source.matchAll(/[【\[]([^】\]]{2,80})[】\]]/g)].map(match => match[1]);
  const multi = containers.find(value => /或|或者|二选一|均可/.test(value));
  if (!multi) return [];
  const segments = multi.replace(/(?:二选一|均可)/g, '').split(/\s*(?:或(?:者)?|、(?=[^、]{2,20}(?:地点|附近|区)))\s*/).filter(Boolean);
  if (segments.length < 2) return [];
  return segments.map(segment => {
    const district = extractDistrict(segment);
    const hierarchy = extractLocationHierarchy(segment, segment, district);
    const rawPlace = hierarchy.place || extractPlace(segment, district);
    const place = canonicalLocationPlace(rawPlace, district);
    const precisePlace = place.replace(/附近|周边/g, '');
    return {
      raw: segment,
      district,
      place,
      nearby: /附近|周边/.test(place),
      query: `深圳市${district ? `${district}区` : ''}${precisePlace}`,
      locationQueries: uniq([`深圳市${district ? `${district}区` : ''}${precisePlace}`, precisePlace])
    };
  }).filter(option => option.district && option.place.length >= 2);
}

function extractTransitLocation(text) {
  const source = textOf(text).replace(/\s+/g, '');
  const match = source.match(/(罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏)区?(\d{1,2})号线([\u4e00-\u9fff]{2,14}?)(?:地铁站|站)/);
  if (!match) return null;
  const district = match[1];
  const transitLine = `${match[2]}号线`;
  const body = match[3];
  const knownAreas = Object.keys(LANDMARK_DISTRICTS)
    .filter(name => LANDMARK_DISTRICTS[name] === district && body.startsWith(name) && body.length > name.length)
    .sort((a, b) => b.length - a.length);
  const area = knownAreas[0] || '';
  const stationCore = body.slice(area.length) || body;
  const place = `${stationCore}地铁站`;
  return {
    district,
    area,
    place,
    transitLine,
    raw: match[0],
    queries: uniq([
      `深圳市${district}区${area}${place}`,
      `深圳地铁${transitLine}${stationCore}站`,
      place
    ])
  };
}

function extractLearningProfile(text) {
  const source = textOf(text);
  return {
    studentLevel: firstMatch(source, /基础薄弱|基础一般|中等|优秀|基础较好/),
    studentType: firstMatch(source, /艺术生|国际生|双语学校学生|体育生/),
    optionalSubjects: /后续可能[^，。；;\n]{0,12}(?:历政地|历史.*政治.*地理)/.test(source) ? '历史/政治/地理' : ''
  };
}

function extractTeacherRequirementSummary(text, existing = '') {
  if (textOf(existing)) return textOf(existing);
  const source = textOf(text);
  const schools = [];
  if (/深大|深圳大学/.test(source)) schools.push('深大');
  if (/哈工大|哈尔滨工业大学/.test(source)) schools.push('哈工大');
  const traits = [];
  if (/负责|责任心/.test(source)) traits.push('负责');
  return [schools.length > 1 ? schools.join('或') : schools[0], ...traits].filter(Boolean).join('、');
}

function lessonDurationHours(text) {
  const source = textOf(text)
    .replace(/每次时\s*长/g, '每次时长')
    .replace(/(\d)\s*[,，]\s*(\d)(?=\s*(?:小时|h))/gi, '$1.$2');
  let match = source.match(/(?:每次(?:时长)?|一次|时长)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*[-~～至到]\s*(\d+(?:\.\d+)?)\s*(?:h|小时|时)/i);
  if (match) return (Number(match[1]) + Number(match[2])) / 2;
  match = source.match(/(?:每次(?:时长)?|一次|时长)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:h|小时|时)/i)
    || source.match(/(\d+(?:\.\d+)?)\s*(?:h|小时|时)\s*\/\s*次/i);
  return match ? Number(match[1]) : 0;
}

function dailyDurationHours(text) {
  let total = 0;
  const source = textOf(text).replace(/(\d{1,2})\s*点/g, '$1:00');
  for (const match of source.matchAll(/(\d{1,2})(?:\s*[:：]\s*(\d{2}))?\s*[-~～至到]\s*(\d{1,2})(?:\s*[:：]\s*(\d{2}))?/g)) {
    const start = Number(match[1]) + Number(match[2] || 0) / 60;
    const end = Number(match[3]) + Number(match[4] || 0) / 60;
    const duration = end - start;
    if (duration > 0 && duration <= 12) total += duration;
  }
  return total;
}

function extractPrice(text) {
  const salary = anyField(text, ['家教薪酬', '薪酬', '课酬', '老师课费', '课时薪酬', '课时报酬', '课费报酬', '课费薪酬', '课酬薪资', '课酬报酬', '老师薪水', '薪水', '老师报酬', '教师报酬', '老师报酬', '时薪', '报酬', '薪资', '薪资待遇']);
  const source = salary || text;
  let priceText = salary;
  let monthly = 0;
  const validPrice = value => Number(value) >= 50 && Number(value) <= 100000;
  const validHourly = value => Number(value) >= 50 && Number(value) <= 3000;
  const finish = (value, matchedText, monthValue = 0, unit = '小时', hourlyValue = value) => ({
    price: validPrice(value) ? Math.round(Number(value)) : 0,
    priceText: textOf(matchedText || priceText),
    monthly: monthValue,
    priceUnit: unit,
    hourlyPrice: validHourly(hourlyValue) ? Math.round(Number(hourlyValue)) : 0,
    priceApproximate: /左右|约|大概/.test(textOf(matchedText || priceText))
  });
  let m = source.match(/(\d+(?:\.\d+)?)\s*[-~～]\s*(\d+(?:\.\d+)?)\s*w\s*\/?\s*月/i);
  if (/自报|报价|面议|待定/.test(source)) {
    const quoted = source.match(/(?:老师)?自报(?:价)?(?:\s*\/\s*(?:次|小时|h|2h))?|报价|面议|待定/i);
    return { price: 0, priceText: textOf(quoted?.[0] || salary), monthly: 0, priceUnit: '', hourlyPrice: 0 };
  }
  if (m) {
    monthly = Math.round((Number(m[1]) + Number(m[2])) / 2 * 10000);
    return finish(0, m[0], monthly, '月', 0);
  }
  m = source.match(/(\d{3,6})\s*[-—~～]\s*(\d{3,6})\s*\/?\s*月/);
  if (m) {
    monthly = Math.round((Number(m[1]) + Number(m[2])) / 2);
    return finish(0, m[0], monthly, '月', 0);
  }
  m = source.match(/(\d{2,5})\s*[-—~～]\s*(\d{2,5})\s*(?:元)?\s*(?:\/|一次课\/?)?\s*(\d+(?:\.\d+)?)\s*(?:h|小时|时)/i);
  if (m) {
    const priceMin = Number(m[1]);
    const priceMax = Number(m[2]);
    const duration = Number(m[3]);
    const sessionPrice = (priceMin + priceMax) / 2;
    return { ...finish(sessionPrice, m[0], 0, `${duration}小时`, sessionPrice / duration), priceMin, priceMax };
  }

  m = source.match(/(\d{2,5})\s*[-—~～]\s*(\d{2,5})\s*(?:元)?\s*\/?\s*(?:次|节)/i);
  if (m) {
    const duration = lessonDurationHours(text);
    const sessionPrice = (Number(m[1]) + Number(m[2])) / 2;
    return finish(sessionPrice, m[0], 0, '次', duration ? sessionPrice / duration : 0);
  }
  m = source.match(/(\d{2,5})\s*(?:元)?\s*(?:左右|约|大概)?\s*(?:\/\s*(?:次|节)|(?:一|每)\s*(?:次|节|次课))/i);
  if (m) {
    const duration = lessonDurationHours(text);
    return finish(Number(m[1]), m[0], 0, '次', duration ? Number(m[1]) / duration : 0);
  }
  m = source.match(/(\d{2,5})\s*(?:元)?\s*\/\s*天/i);
  if (m) {
    const duration = dailyDurationHours(text);
    return finish(Number(m[1]), m[0], 0, '天', duration ? Number(m[1]) / duration : 0);
  }
  m = source.match(/(\d{2,5})\s*[、,，]\s*(\d{2,5})\s*(?:元)?\s*(?:\/\s*(?:小时|时|h)|每小时)/i);
  if (m) return finish((Number(m[1]) + Number(m[2])) / 2, m[0]);
  m = source.match(/(\d{2,5})\s*[-—~～]+\s*(\d{2,5})\s*(?:元)?\s*(?:\/?\s*(?:1)?\s*(小时|时|h)|每小时|元每小时|元1小时|元\/小时)/i);
  if (!m && salary) m = source.match(/(\d{2,5})\s*[-—~～]+\s*(\d{2,5})/);
  if (m) return finish((Number(m[1]) + Number(m[2])) / 2, m[0]);
  m = source.match(/(\d{2,5})\s*\/\s*(\d+(?:\.\d+)?)\s*(?:h|小时|时)/i);
  if (m) return finish(Number(m[1]) / Number(m[2]), m[0]);
  m = source.match(/(\d{2,5})\s*(?:元|块)?\s*(?:\/\s*(?:小时|h|时)|每小时)/i)
    || source.match(/(\d{2,5})\s*(元|块)?\s*(?:每|一)?\s*(小时|h|时)/i);
  if (m) return finish(Number(m[1]), m[0]);
  m = salary ? source.match(/(\d{2,5})/) : source.match(/(?:时薪|课酬|薪酬|课费|报酬)[^0-9]{0,8}(\d{2,5})/);
  if (m) return finish(Number(m[1]), m[0]);
  return { price: 0, priceText: textOf(priceText), monthly: 0, priceUnit: '', hourlyPrice: 0 };
}

function parseOrder(raw, source = '', agencyId = '') {
  const original = sanitizeImportedText(raw);
  const text = original
    .replace(/深圳\s*[|｜ⅠI]\s*(?=BY\d)/gi, '深圳')
    .replace(/BY(\d{6,})\s*[．.]\s*(\d+)\b/gi, 'BY$1-$2')
    .replace(/(\d{2,})\s*[．.]\s*(\d{2,})(?=\s*(?:\/|元))/g, '$1-$2')
    .replace(/\bBARK\s*[:：]?/gi, '老师要求：')
    .replace(/\bBAR\s*[:：]?/gi, '老师要求：')
    .replace(/(?:^|\n)\s*BR\s*[:：]\s*/gi, '\n老师要求：')
    .replace(/[【\[]\s*([^】\]：:]{1,12})\s*[：:]\s*[】\]]/g, '【$1】')
    .replace(/\[\s*([^】\]]{1,12})\s*】/g, '【$1】')
    .replace(/【\s*([^】\]]{1,12})\s*\]/g, '【$1】')
    .replace(/#{1,3}\s*襄田(?=侨香)/g, '福田')
    .replace(/襄田(?=侨香)/g, '福田')
    .replace(/孑子岭|子子岭/g, '孖岭')
    .replace(/京基白纳/g, '京基百纳')
    .replace(/龙[离寓]楼/g, '龙宫楼')
    .replace(/伊墩酒店/g, '伊敦酒店')
    .replace(/纟屯正/g, '纯正')
    .replace(/#{1,3}(?=(?:罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏))/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  const title = extractTitle(text);
  const locationField = anyField(text, ['上课地址', '辅导地点', '学员地址', '联系地址', '家教地点', '地址', '地点']);
  const numberedLocation = extractNumberedSection(text, 1);
  const gradeSubjectField = anyField(text, ['年级科目', '年级学科', '年级性别', '年级', '家教内容', '辅导科目', '科目']);
  const looseOrderLine = extractLooseOrderLine(text);
  const looseLocationLine = extractLooseLocationLine(text);
  const locationText = locationField
    || (numberedLocation && /(深圳|罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏|酒店|小区|花园|公馆|中心|地铁|附近)/.test(numberedLocation) ? numberedLocation : '')
    || title
    || looseLocationLine;
  const transitLocation = extractTransitLocation(text);
  const district = transitLocation?.district || extractDistrict(locationText + '\n' + title + '\n' + text);
  const locationOptions = extractLocationOptions(text);
  const locationHierarchy = extractLocationHierarchy(text, locationField || looseLocationLine, district);
  const place = transitLocation
    ? [transitLocation.area, transitLocation.place].filter(Boolean).join('·')
    : locationHierarchy.place || (locationText ? extractPlace(locationText, district) : extractPlace(title, district));
  const student = extractStudent(text);
  const studentGender = extractStudentGender(text, student);
  const subject = extractSubjects(gradeSubjectField) || extractSubjects(looseOrderLine) || extractSubjects(title) || extractSubjects(student) || extractSubjects(text) || '其他';
  let grade = extractGrades(gradeSubjectField) || extractGrades(looseOrderLine) || extractGrades(title + '\n' + student) || extractGrades(title) || '其他';
  if (['小学', '初中', '高中'].includes(grade)) {
    grade = extractGrades(student + '\n' + title) || grade;
  }
  const gradeDescription = extractGradeDescription(text, grade);
  const schedule = extractSchedule(text);
  const gender = extractGender(text);
  const priceInfo = extractPrice(text);
  const requirements = extractTeacherRequirementSummary(text, extractRequirements(text)) || text.replace(/\n/g, ' ').slice(0, 260);
  const learningProfile = extractLearningProfile(text);
  const address = buildAddress(district, place, locationText || title);
  return {
    id: 'o-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    agencyId,
    district, place, placeOriginal: locationHierarchy.raw || place, address, subject, grade, gradeDescription,
    locationQuery: transitLocation?.queries[0] || locationHierarchy.queries[0] || address,
    locationQueries: transitLocation?.queries || locationHierarchy.queries,
    area: transitLocation?.area || '',
    transitLine: transitLocation?.transitLine || '',
    locationOptions,
    locationRelation: locationOptions.length > 1 ? 'OR' : '',
    price: priceInfo.price,
    priceText: priceInfo.priceText,
    monthly: priceInfo.monthly,
    priceMin: priceInfo.priceMin || priceInfo.price || 0,
    priceMax: priceInfo.priceMax || priceInfo.price || 0,
    priceUnit: priceInfo.priceUnit,
    hourlyPrice: priceInfo.hourlyPrice,
    priceApproximate: Boolean(priceInfo.priceApproximate),
    schedule, gender, student, studentGender, requirements, teacherRequirement: requirements,
    ...learningProfile,
    source: source || '网站发布',
    raw: original,
    status: 'open',
    distanceKm: '',
    routeMode: '待计算',
    applicants: [],
    createdAt: new Date().toISOString()
  };
}

function extractOrderCode(raw) {
  const source = sanitizeImportedText(raw).replace(/\s+/g, ' ');
  const labeled = source.match(/(?:家教编号|编号|订单)\s*[:：]?\s*([A-Z0-9\u4e00-\u9fff-]{4,32})/i);
  if (labeled) return ocrComparable(labeled[1]);
  const standalone = source.match(/(?:WY深圳\d{6,}[A-Z]?|SZ\d{5,}[A-Z]?|lw\d{3,}|深圳BY\d{6,}(?:-\d+)?|深圳线下[A-Z]{1,5}\d{5,})/i);
  if (standalone) return ocrComparable(standalone[0]);
  const numeric = source.match(/(?:^|\s)(\d{8,})(?=\s*(?:#|地址|地点))/i);
  if (numeric) return numeric[1];
  const urgent = source.match(/(?:急|妃)\s*(\d{8,})/);
  return urgent ? urgent[1] : '';
}

function rawOrderFingerprint(raw) {
  return crypto.createHash('sha1').update(textOf(raw).replace(/\s+/g, '')).digest('hex');
}

function semanticOrderFingerprint(order) {
  const place = ocrComparable(cleanLocationCandidate(order.place || order.address || '', order.district || ''));
  const grade = ocrComparable(order.grade);
  const subject = ocrComparable(order.subject);
  if (!place || !grade || !subject || grade === ocrComparable('其他') || subject === ocrComparable('其他')) return '';
  const compensation = Number(order.monthly) > 0
    ? `m${Math.round(Number(order.monthly) / 100)}`
    : `h${Math.round(Number(order.price || 0) / 5)}`;
  const schedule = ocrComparable(order.schedule).slice(0, 36);
  return `${place}|${grade}|${subject}|${compensation}|${schedule}`;
}

function buildAddress(district, place, raw = '') {
  const city = '深圳市';
  const addressPlace = textOf(place).replace(/^\d{1,2}号线\s*/, '');
  if (district && addressPlace) return `${city}${district.endsWith('区') ? district : district + '区'}${addressPlace}`;
  if (district) return `${city}${district.endsWith('区') ? district : district + '区'}`;
  const short = raw.replace(/(家教|老师|学生|男生|女生|上门|课酬|薪酬|周末|工作日|数学|英语|物理|化学|语文|生物|初一|初二|初三|高一|高二|高三|小学|初中|高中).*/, '').trim();
  return short.length > 2 && short.length < 50 ? `深圳市${short}` : '';
}

function estimateKm(district, place) {
  const places = { 西乡: 2.8, 固戍: 5.2, 宝体: 6.0, 翻身: 7.0, 新安: 8.0, 灵芝: 8.6, 坪洲: 3.6, 碧海湾: 4.0, 沙井: 19, 福永: 13, 松岗: 25, 石岩: 18, 前海: 10.8, 后海: 16.2, 海岸城: 16, 蛇口: 20, 西丽: 12, 桃源村: 16, 科技园: 14.5, 南山地铁站: 14, 湾厦: 19, 松坪山: 13, 农林: 24, 景田: 24, 香蜜湖: 23, 车公庙: 24, 岗厦: 27, 会展中心: 28, 民治: 16, 红山: 18.5, 深圳北: 17, 坂田: 23, 布吉: 31, 大运: 37, 龙城: 40, 公明: 26 };
  for (const key of Object.keys(places)) {
    if (place && place.includes(key)) return places[key];
  }
  const districts = { 宝安: 7, 南山: 15, 福田: 24, 龙华: 20, 光明: 25, 罗湖: 31, 龙岗: 38, 盐田: 42, 坪山: 48, 大鹏: 65 };
  return district && districts[district] ? districts[district] : '';
}

function cleanLocationCandidate(value, district = '') {
  let cleaned = textOf(value)
    .replace(/^[【\[（(《<]+|[】\]）)》>]+$/g, '')
    .replace(/^(?:学员地址|辅导地址|上课地址|联系地址|地址|地点)\s*[:：]?\s*/, '')
    .replace(/^(?:深圳)?[A-Za-z]{0,4}\d{6,}[A-Za-z]?\s*/i, '')
    .replace(/^\d{1,3}(?=深圳市|[\u4e00-\u9fff]{2,4}区)/, '')
    .replace(/^深圳市?/, '');
  cleaned = stripLeadingDistrict(cleaned, district)
    .replace(/(?:准|新)?(?:幼儿园|小[一二三四五六]|[一二三四五六]年级|小学|初[一二三四]|[七八九]年级|初中|高[一二三]|高中|大学|成人).*$/i, '')
    .replace(/(?:语文|数学|英语|物理|化学|生物|政治|历史|地理|科学|全科|编程|体育).*$/i, '')
    .replace(/古城附近老师找地方/g, '南头古城')
    .replace(/(?:附近|最近|周边|老师找地方)\s*$/g, '')
    .replace(/^[#＃A-Za-z\d._-]{1,8}\s*(?=[\u4e00-\u9fff])/, '')
    .replace(/^深圳市?/, '');
  cleaned = stripLeadingDistrict(cleaned, district)
    .replace(/襄田(?=侨香)/g, '福田')
    .replace(/香密湖/g, '香蜜湖')
    .replace(/此口(?=中心路)/g, '蛇口')
    .replace(/恒容滨城/g, '恒裕滨城')
    .replace(/孑子岭|子子岭/g, '孖岭')
    .replace(/京基白纳/g, '京基百纳')
    .replace(/龙[离寓]楼/g, '龙宫楼')
    .replace(/伊墩酒店/g, '伊敦酒店')
    .replace(/润销二期/g, '润玺二期')
    .replace(/泰富华\s*[.．·]?\s*天[弯峦]湖/g, '泰富华天峦湖')
    .replace(/汉园车范/g, '汉园茗院')
    .replace(/[-—]?\s*(?:东|南|西|北|东北|东南|西北|西南)\s*\d*\s*门\s*$/g, '')
    .replace(/[|｜].*$/, '')
    .replace(/[，,。；;].*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(?:学生|学员|男生|女生|男孩|女孩|老师|要求|时间|薪酬|课酬)/.test(cleaned)) return '';
  if (/^(?:男|女|男生|女生|男孩|女孩)$/.test(cleaned)) return '';
  if (/^(?:区委|区政府|人民政府)$/.test(cleaned) && district) return `${textOf(district).replace(/区$/, '')}${cleaned}`;
  return cleaned;
}

function amapDistrictName(value) {
  const match = textOf(value).match(/罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏/);
  return match ? match[0] : '';
}

function locationNameSimilarity(query, name) {
  const q = ocrComparable(query);
  const n = ocrComparable(name);
  if (!q || !n) return 0;
  if (q === n) return 100;
  if (q.includes(n) || n.includes(q)) return 82 + (Math.min(q.length, n.length) / Math.max(q.length, n.length) * 15);
  const qGrams = textNgrams(q);
  const nGrams = textNgrams(n);
  let common = 0;
  for (const gram of nGrams) if (qGrams.has(gram)) common++;
  const nCoverage = nGrams.size ? common / nGrams.size : 0;
  const qCoverage = qGrams.size ? common / qGrams.size : 0;
  return (nCoverage * 62) + (qCoverage * 28);
}

function normalizeLocationDisplayName(value) {
  return textOf(value)
    .replace(/鸿威\s*de\s*森林/gi, '鸿威的森林')
    .replace(/[（(]建设中[）)]\s*$/g, '')
    .trim();
}

function isUnexpectedCompanyCandidate(query, candidate) {
  const requested = textOf(query);
  if (!requested || /公司|企业|集团|工厂|厂区|工作室/.test(requested)) return false;
  const candidateName = textOf(candidate?.name);
  const candidateType = textOf(candidate?.type);
  const explicitlyCorporate = /(?:有限责任公司|股份有限公司|有限公司|公司|企业|集团)(?:$|[（(])/.test(candidateName);
  const companyTypeWithExtraName = /公司企业/.test(candidateType)
    && ocrComparable(candidateName) !== ocrComparable(requested)
    && ocrComparable(candidateName).length > ocrComparable(requested).length + 2;
  return explicitlyCorporate || companyTypeWithExtraName;
}

function isUnexpectedLocationDetail(query, candidate) {
  const requested = textOf(query);
  const candidateText = `${candidate?.name || ''}|${candidate?.type || ''}`;
  const categories = [
    [/停车|停车场/, /停车场/],
    [/公交|公交站/, /公交站|公交车站/],
    [/地铁|站口|出入口|[A-Z]\d?口/i, /出入口/],
    [/物业/, /物业/],
    [/销售中心|售楼处/, /销售中心|售楼处/],
    [/租售中心/, /租售中心/],
    [/酒店|宾馆/, /酒店|宾馆/],
    [/餐厅|餐饮|饭店|美食/, /餐饮服务|餐厅|饭店/],
    [/商店|门店|购物/, /购物服务|商店|门店/],
    [/营业厅|服务厅/, /营业厅|服务厅/],
    [/办公楼|写字楼/, /办公楼|写字楼/],
    [/警务室|派出所/, /警务室/],
    [/公厕|厕所|卫生间|洗手间/, /公共厕所|公厕|厕所|卫生间|洗手间/]
  ];
  return categories.some(([requestedPattern, candidatePattern]) => (
    !requestedPattern.test(requested) && candidatePattern.test(candidateText)
  ));
}

function normalizeResolvedLocationName(query, value) {
  let name = normalizeLocationDisplayName(value).replace(/[（(]地铁站[）)]/g, '地铁站');
  const requested = textOf(query);
  const requestsGenericMetroExit = /地铁(?:站)?(?:口|口旁|附近|旁)/.test(requested) && !/[A-Z]\d?口/i.test(requested);
  if (requestsGenericMetroExit) name = name.replace(/(地铁站)[A-Z]\d?口(?:[（(].*?[）)])?$/i, '$1');
  return name;
}

function isGenericLocationValue(value) {
  const normalized = textOf(value).replace(/\s+/g, '');
  if (/^(?:深圳市?)?(?:罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏)区?$/.test(normalized)) return true;
  return /^(?:深圳市?)?(?:(?:罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏)区?)?[·:：-]?(?:具体)?(?:地点|地址)?(?:未提供|未知|待定|待确认|不详)$/.test(normalized);
}

function refreshLocationEvidenceFromRaw(order) {
  if (!textOf(order?.raw)) return false;
  const reparsed = parseOrder(order.raw, order.source || '', order.agencyId || '');
  if (!reparsed.place || isGenericLocationValue(reparsed.place)) return false;
  for (const key of ['place', 'placeOriginal', 'address', 'locationQuery', 'locationQueries', 'locationOptions', 'locationRelation', 'transitLine']) {
    if (reparsed[key] !== undefined && reparsed[key] !== '') order[key] = reparsed[key];
  }
  if (reparsed.district) order.district = reparsed.district;
  return true;
}

function invalidateDerivedLocationData(order) {
  order.locationVerified = false;
  order.locationStatus = 'unverified';
  order.locationPoiId = '';
  order.locationCoordinates = '';
  order.locationAddress = '';
  order.locationConfidence = 0;
  order.locationCandidates = [];
  order.distanceKm = '';
  order.routeMode = '待计算';
  order.routeStatus = 'pending';
  order.routeOptions = {};
  if (Array.isArray(order.locationOptions)) {
    order.locationOptions = order.locationOptions.map(option => ({ ...option, routeOptions: {} }));
  }
}

async function repairPersistedOpenOrderLocations(db) {
  const candidates = (db.orders || []).filter(order => (
    order.status === 'open'
    && textOf(order.raw)
    && (isGenericLocationValue(order.place) || isGenericLocationValue(order.address))
  ));
  let repaired = 0;
  await mapWithConcurrency(candidates, 2, async order => {
    if (!refreshLocationEvidenceFromRaw(order)) return;
    const recoveredPlace = order.place;
    const recoveredPlaceOriginal = order.placeOriginal;
    const recoveredAddress = order.address;
    invalidateDerivedLocationData(order);
    await resolveOrderLocation(order, db.settings || {});
    order.place = recoveredPlace;
    order.placeOriginal = recoveredPlaceOriginal;
    order.address = recoveredAddress || buildAddress(order.district, recoveredPlace, order.raw);
    order.structured = await runParserPipeline({ rawText: order.raw, ruleOrder: order });
    if (!order.address) order.address = buildAddress(order.district, order.place, order.raw);
    order.score = score(order, db.settings || {});
    order.locationEvidenceRepairedAt = new Date().toISOString();
    repaired += 1;
  });
  return repaired;
}

function isExplicitTransitCandidateMatch(query, candidate) {
  const requested = textOf(query);
  const candidateText = `${candidate?.name || ''}|${candidate?.type || ''}`;
  if (!/地铁/.test(requested) || !/地铁站/.test(candidateText)) return false;
  const core = textOf(candidate?.name)
    .replace(/[（(]?地铁站[）)]?/g, '')
    .replace(/[A-Z]\d?口$/i, '')
    .trim();
  return ocrComparable(core).length >= 2 && ocrComparable(requested).includes(ocrComparable(core));
}

function consensusCandidateDistrict(candidates) {
  const counts = new Map();
  for (const candidate of candidates || []) {
    const district = textOf(candidate?.district);
    if (district) counts.set(district, (counts.get(district) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return '';
  const [district, count] = ranked[0];
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return count >= 3 && count / total >= 0.7 ? district : '';
}

function locationQueryCharacterCoverage(query, candidate) {
  const requested = ocrComparable(query).replace(/深圳市|附近|周边|最近|街道/g, '');
  const candidateText = ocrComparable(`${candidate?.name || ''}${candidate?.address || ''}`);
  const requestedChars = [...new Set([...requested])];
  if (requestedChars.length < 4) return 1;
  const matched = requestedChars.filter(char => candidateText.includes(char)).length;
  return matched / requestedChars.length;
}

function extractTransitLandmarkQuery(query) {
  const requested = textOf(query);
  const marker = requested.match(/地铁(?:站|口)/);
  if (!marker) return '';
  let prefix = requested.slice(0, marker.index);
  prefix = prefix.replace(/^.*(?:街道|大道|公路|路|街|巷|号线|号)/, '');
  prefix = prefix.replace(/^(?:深圳市?)?(?:罗湖|福田|南山|盐田|宝安|龙岗|龙华|坪山|光明|大鹏)区?/, '');
  prefix = prefix.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
  if (prefix.length < 2 || prefix.length > 10) return '';
  return `${prefix}地铁站`;
}

async function amapPlaceCandidates(settings, query, districtHint = '') {
  const key = amapServiceKey(settings);
  if (!key || query.length < 2) return [];
  const candidates = [];
  try {
    const searchQueries = uniq([extractTransitLandmarkQuery(query), query].filter(Boolean));
    const searchScopes = uniq([AMAP_DISTRICT_ADCODES[districtHint], '440300']);
    const seen = new Set();
    for (const searchScope of searchScopes) {
      for (const searchQuery of searchQueries) {
        const url = `https://restapi.amap.com/v3/place/text?key=${encodeURIComponent(key)}&keywords=${encodeURIComponent(searchQuery)}&city=${encodeURIComponent(searchScope)}&citylimit=true&offset=12&page=1&extensions=base&output=JSON`;
        const data = await fetch(url, { signal: AbortSignal.timeout(7000) }).then(response => response.json());
        if (data.status !== '1' || !Array.isArray(data.pois)) continue;
        for (const poi of data.pois) {
          if (!poi?.name || !poi?.location) continue;
          const candidateKey = textOf(poi.id) || `${textOf(poi.name)}|${textOf(poi.location)}`;
          if (seen.has(candidateKey)) continue;
          seen.add(candidateKey);
          candidates.push({
            id: textOf(poi.id),
            name: textOf(poi.name),
            district: amapDistrictName(poi.adname),
            address: Array.isArray(poi.address) ? '' : textOf(poi.address),
            location: textOf(poi.location),
            type: textOf(poi.type),
            rank: candidates.length
          });
        }
      }
    }
  } catch (_) {}
  if (candidates.length) return candidates;
  try {
    const url = `https://restapi.amap.com/v3/assistant/inputtips?key=${encodeURIComponent(key)}&keywords=${encodeURIComponent(query)}&city=${encodeURIComponent('深圳')}&citylimit=true&datatype=all&output=JSON`;
    const data = await fetch(url, { signal: AbortSignal.timeout(6000) }).then(response => response.json());
    if (data.status === '1' && Array.isArray(data.tips)) {
      for (const tip of data.tips) {
        if (!tip?.name || !tip?.location || tip.location === '[]') continue;
        candidates.push({
          id: textOf(tip.id),
          name: textOf(tip.name),
          district: amapDistrictName(tip.district),
          address: Array.isArray(tip.address) ? '' : textOf(tip.address),
          location: textOf(tip.location),
          type: '',
          rank: candidates.length
        });
      }
    }
  } catch (_) {}
  return candidates;
}

async function amapGeocodeCandidate(settings, query, districtHint) {
  const key = amapServiceKey(settings);
  if (!key || query.length < 2) return null;
  try {
    const address = `深圳市${districtHint ? `${districtHint}区` : ''}${query}`;
    const url = `https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(key)}&address=${encodeURIComponent(address)}&city=${encodeURIComponent('深圳')}&output=JSON`;
    const data = await fetch(url, { signal: AbortSignal.timeout(7000) }).then(response => response.json());
    const result = data.status === '1' && Array.isArray(data.geocodes) ? data.geocodes[0] : null;
    if (!result?.location || /^(?:国家|省|市|区县|未知)$/.test(textOf(result.level))) return null;
    const district = amapDistrictName(result.district);
    if (districtHint && district && district !== districtHint) return null;
    const formatted = textOf(result.formatted_address);
    const name = normalizeLocationDisplayName(formatted
      .replace(/^广东省深圳市|^深圳市/, '')
      .replace(new RegExp(`^${district || districtHint || ''}区?`), '')
      .replace(/[（(]地铁站[）)]/g, '地铁站')
      .trim());
    if (!name || name === district || name === `${district}区`) return null;
    return { name, district: district || districtHint, address: formatted, location: textOf(result.location), level: textOf(result.level) };
  } catch (_) {
    return null;
  }
}

async function resolveOrderLocation(order, settings) {
  if (Array.isArray(order.locationOptions) && order.locationOptions.length > 1) {
    const resolvedOptions = [];
    for (const option of order.locationOptions) {
      const resolved = await resolveOrderLocation({
        district: option.district,
        place: option.place,
        placeOriginal: option.raw || option.place,
        address: option.query,
        locationQuery: option.query,
        locationQueries: option.locationQueries || [option.query],
        raw: order.raw
      }, settings);
      resolvedOptions.push({
        ...option,
        district: resolved.district || option.district,
        place: resolved.locationVerified ? resolved.place : option.place,
        poiId: resolved.locationPoiId || '',
        coordinates: resolved.locationCoordinates || '',
        confidence: resolved.locationConfidence || 0,
        verified: Boolean(resolved.locationVerified),
        status: resolved.locationStatus || '',
        candidates: resolved.locationCandidates || []
      });
    }
    order.locationOptions = resolvedOptions;
    order.locationRelation = 'OR';
    const primary = resolvedOptions[0];
    order.district = primary.district;
    order.place = primary.place;
    order.address = primary.query;
    order.locationQuery = primary.query;
    order.locationCoordinates = primary.coordinates;
    order.locationPoiId = primary.poiId;
    order.locationConfidence = primary.confidence;
    order.locationVerified = resolvedOptions.some(option => option.verified);
    order.locationStatus = resolvedOptions.every(option => option.verified) ? 'verified' : 'options_unverified';
    return order;
  }
  const normalizedPlace = textOf(order.place);
  const originalPlace = textOf(order.placeOriginal || order.place);
  const districtHint = textOf(order.district).replace(/区$/, '');
  const fallbackQuery = isGenericLocationValue(normalizedPlace)
    ? (districtHint ? `${districtHint}区` : '')
    : cleanLocationCandidate(order.place || originalPlace || order.address, districtHint);
  const locationQueries = uniq([...(Array.isArray(order.locationQueries) ? order.locationQueries : []), order.locationQuery, fallbackQuery]
    .map(value => textOf(value)).filter(value => value.length >= 2 && !isGenericLocationValue(value)));
  const query = locationQueries[0] || fallbackQuery;
  const usesDistrictFallback = Boolean(districtHint && query === `${districtHint}区` && isGenericLocationValue(normalizedPlace));
  order.locationQuery = query;
  order.locationQueries = uniq([query, ...locationQueries].filter(Boolean));
  order.placeOriginal ||= originalPlace;
  const clearResolvedLocation = (status, keepOriginal = true) => {
    order.place = keepOriginal ? normalizedPlace : '';
    order.address = buildAddress(districtHint, order.place, order.raw);
    order.locationVerified = false;
    order.locationStatus = status;
    order.locationPoiId = '';
    order.locationCoordinates = '';
    order.locationAddress = '';
    order.locationConfidence = 0;
    order.locationCandidates = order.locationQueries.slice(0, 3).map(name => ({ name, district: districtHint, location: '' }));
  };
  if (!amapServiceKey(settings) || query.length < 2) {
    clearResolvedLocation(query ? 'unverified' : 'missing', Boolean(query));
    return order;
  }
  const candidates = [];
  const seenCandidates = new Set();
  for (const searchQuery of order.locationQueries.slice(0, 4)) {
    const found = await amapPlaceCandidates(settings, searchQuery, districtHint);
    for (const candidate of found) {
      const key = candidate.id || `${candidate.name}|${candidate.location}`;
      if (seenCandidates.has(key)) continue;
      seenCandidates.add(key);
      candidates.push({ ...candidate, searchQuery });
    }
  }
  const consensusDistrict = consensusCandidateDistrict(candidates);
  let best = null;
  let bestScore = -Infinity;
  const scoredCandidates = [];
  for (const candidate of candidates) {
    const districtMatch = districtHint && candidate.district === districtHint;
    const districtConflict = districtHint && candidate.district && candidate.district !== districtHint;
    const candidateQuery = candidate.searchQuery || query;
    const similarity = Math.max(...locationQueries.map(searchQuery => locationNameSimilarity(searchQuery, candidate.name)));
    const residentialBonus = /商务住宅;住宅区|住宅小区/.test(candidate.type) ? 18 : 0;
    const requestedTransit = /地铁|公交|车站/.test(query);
    const transitBonus = requestedTransit && /交通设施服务/.test(candidate.type) ? 12 : 0;
    const explicitTransitMatch = isExplicitTransitCandidateMatch(candidateQuery, candidate);
    const trustedDistrictCorrection = districtConflict && explicitTransitMatch && candidate.district === consensusDistrict;
    const retailRequested = /广场|商场|购物中心|百货|门店|商店/.test(query);
    const unwantedDetail = isUnexpectedLocationDetail(query, candidate);
    const unwantedRetail = !retailRequested && /购物服务/.test(candidate.type);
    const detailPenalty = unwantedDetail ? 80 : unwantedRetail ? 40 : 0;
    const companyPenalty = isUnexpectedCompanyCandidate(query, candidate) ? 145 : 0;
    const queryCoverage = locationQueryCharacterCoverage(candidateQuery, candidate);
    const coveragePenalty = queryCoverage < 0.65 && !explicitTransitMatch ? 90 : 0;
    const districtConflictPenalty = districtConflict ? (trustedDistrictCorrection ? 12 : 55) : 0;
    const broadAreaRequest = /(?:街道|社区|片区|乡|塘)$/.test(ocrComparable(normalizedPlace).replace(/西乡流塘$/, '流塘')) || /·/.test(normalizedPlace);
    const unwantedSpecificBuilding = broadAreaRequest && /大厦|写字楼|商务中心|产业园|商业城|酒店/.test(candidate.name)
      && !textOf(normalizedPlace).includes(candidate.name);
    const administrativeBonus = broadAreaRequest && /社区中心|村庄级地名|普通地名|政府机构|地名地址信息/.test(`${candidate.type}|${candidate.name}`) ? 22 : 0;
    const scoreValue = similarity + residentialBonus + transitBonus + (explicitTransitMatch ? 45 : 0) + (districtMatch ? 24 : 0)
      + administrativeBonus - districtConflictPenalty - detailPenalty - companyPenalty - coveragePenalty
      - (unwantedSpecificBuilding ? 95 : 0) - (candidate.rank * 1.5);
    scoredCandidates.push({ ...candidate, confidence: Math.max(0, Math.min(100, Math.round(scoreValue))) });
    if (scoreValue > bestScore) {
      best = candidate;
      bestScore = scoreValue;
    }
  }
  const shortQueryMismatch = ocrComparable(query).length <= 2 && ocrComparable(query) !== ocrComparable(best?.name);
  const trustedBestDistrictCorrection = best && best.district === consensusDistrict && isExplicitTransitCandidateMatch(query, best);
  const rankedCandidates = scoredCandidates.sort((a, b) => b.confidence - a.confidence);
  const broadAreaRequest = /·/.test(normalizedPlace) || /(?:街道|社区|片区|乡|塘)$/.test(normalizedPlace);
  const closeAreaCandidates = rankedCandidates.filter(candidate => candidate.confidence >= (rankedCandidates[0]?.confidence || 0) - 10);
  const ambiguousArea = broadAreaRequest && candidates.length > 0 && (
    /大厦|写字楼|商务中心|产业园|商业城|酒店/.test(best?.name || '')
    || new Set(closeAreaCandidates.map(candidate => ocrComparable(candidate.name))).size >= 2
  );
  const useCandidate = (candidate, status) => {
    order.district = candidate.district || districtHint;
    order.place = normalizeResolvedLocationName(query, candidate.name);
    order.address = `深圳市${order.district ? `${order.district}区` : ''}${order.place}`;
    order.locationVerified = Boolean(candidate.location);
    order.locationStatus = status;
    order.locationPoiId = candidate.id || '';
    order.locationCoordinates = candidate.location || '';
    order.locationAddress = candidate.address || '';
    order.locationConfidence = Number(candidate.confidence || 0);
    order.locationCandidates = rankedCandidates.slice(0, 3);
    return order;
  };
  if (ambiguousArea) {
    const defaultCandidate = rankedCandidates.find(candidate => candidate.location
      && (!districtHint || !candidate.district || candidate.district === districtHint));
    if (defaultCandidate) return useCandidate(defaultCandidate, 'defaulted');
    clearResolvedLocation('ambiguous');
    order.locationCandidates = rankedCandidates.slice(0, 3);
    return order;
  }
  const acceptable = best && bestScore >= 52 && !shortQueryMismatch
    && (!districtHint || !best.district || best.district === districtHint || trustedBestDistrictCorrection);
  if (usesDistrictFallback) {
    const defaultCandidate = rankedCandidates.find(candidate => candidate.location
      && (!candidate.district || candidate.district === districtHint));
    if (defaultCandidate) return useCandidate(defaultCandidate, 'defaulted');
  }
  if (!acceptable) {
    const defaultCandidate = rankedCandidates.find(candidate => candidate.location
      && (!districtHint || !candidate.district || candidate.district === districtHint));
    if (defaultCandidate) return useCandidate(defaultCandidate, 'defaulted');
    const geocoded = await amapGeocodeCandidate(settings, query, districtHint);
    if (geocoded) {
      order.district = geocoded.district || districtHint;
      order.place = geocoded.name;
      order.address = geocoded.address || buildAddress(order.district, geocoded.name, order.raw);
      order.locationVerified = true;
      order.locationStatus = 'geocoded';
      order.locationPoiId = '';
      order.locationCoordinates = geocoded.location;
      order.locationAddress = geocoded.address;
      order.locationConfidence = 65;
      order.locationCandidates = rankedCandidates.slice(0, 3);
      return order;
    }
    clearResolvedLocation(candidates.length ? 'ambiguous' : 'not_found');
    return order;
  }
  order.district = best.district || districtHint;
  order.place = normalizeResolvedLocationName(query, best.name);
  order.address = `深圳市${order.district ? `${order.district}区` : ''}${order.place}`;
  order.locationVerified = true;
  order.locationStatus = 'verified';
  order.locationPoiId = best.id;
  order.locationCoordinates = best.location;
  order.locationAddress = best.address;
  order.locationConfidence = Math.max(0, Math.min(100, Math.round(bestScore)));
  order.locationCandidates = rankedCandidates.slice(0, 3);
  return order;
}

async function geocode(key, address) {
  if (!key || !address) return null;
  const normalized = textOf(address);
  if (/^\d{2,3}(?:\.\d+)?,\d{1,2}(?:\.\d+)?$/.test(normalized)) return normalized;
  const cached = geocodeCache.get(normalized);
  if (cached && Date.now() - cached.createdAt < MAP_CACHE_TTL_MS) return cached.value;
  let value = null;
  try {
    const url = `https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(key)}&address=${encodeURIComponent(normalized)}&city=${encodeURIComponent('深圳')}&output=JSON`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.status === '1' && Number(data.count) > 0) value = data.geocodes[0].location;
  } catch (_) {}
  geocodeCache.set(normalized, { value, createdAt: Date.now() });
  return value;
}

async function locationSuggestions(settings, query) {
  const keywords = textOf(query).slice(0, 60);
  if (keywords.length < 2) return [];
  const suggestions = [];
  const seen = new Set();
  const add = (name, district = '', address = '', location = '') => {
    const cleanName = textOf(name);
    if (!cleanName) return;
    const cleanDistrict = textOf(district).replace(/^广东省深圳市|^深圳市|^广东省/, '');
    const rawAddress = textOf(address).replace(/^广东省深圳市|^深圳市|^广东省/, '');
    const cleanAddress = (rawAddress.match(/;/g) || []).length > 3 || rawAddress.length > 80
      ? ''
      : rawAddress;
    const value = `深圳市${cleanDistrict}${cleanName}`
      .replace(/深圳市深圳市/g, '深圳市')
      .replace(/(.{2,12})\1+/g, '$1');
    const key = `${cleanName}|${cleanDistrict}|${cleanAddress}`;
    if (seen.has(key)) return;
    seen.add(key);
    suggestions.push({
      name: cleanName,
      district: cleanDistrict,
      address: cleanAddress,
      location: textOf(location),
      label: [cleanName, cleanDistrict, cleanAddress].filter(Boolean).join(' · '),
      value
    });
  };

  const key = amapServiceKey(settings);
  if (key) {
    try {
      const url = `https://restapi.amap.com/v3/assistant/inputtips?key=${encodeURIComponent(key)}&keywords=${encodeURIComponent(keywords)}&city=${encodeURIComponent('深圳')}&citylimit=true&datatype=all`;
      const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const data = await response.json();
      if (data.status === '1' && Array.isArray(data.tips)) {
        for (const tip of data.tips) {
          if (!tip || !tip.name || !tip.location || tip.location === '[]') continue;
          add(tip.name, tip.district, tip.address, tip.location);
          if (suggestions.length >= 8) break;
        }
      }
    } catch (_) {}
  }

  return suggestions.slice(0, 8);
}

async function routeKm(settings, address, destinationCoordinates = '') {
  const key = amapServiceKey(settings);
  const home = settings.routeOrigin || settings.homeAddress || '';
  if (!key || !home || !address) return null;
  const routes = await routeOptions(settings, home, destinationCoordinates || address, ['cycling']);
  return routes.cycling || routes.driving || routes.walking || routes.transit || null;
}

function minutesFromSeconds(value) {
  return Math.max(1, Math.round(Number(value || 0) / 60));
}

function kmFromMeters(value) {
  return Math.round(Number(value || 0) / 100) / 10;
}

function estimatedRoutes(km) {
  const distance = Number(km || 0);
  if (!distance) return {};
  return {
    walking: { km: distance, minutes: Math.max(1, Math.round(distance / 4.5 * 60)), mode: '步行', estimated: true },
    cycling: { km: distance, minutes: Math.max(1, Math.round(distance / 14 * 60)), mode: '骑行', estimated: true },
    driving: { km: distance, minutes: Math.max(1, Math.round(distance / 28 * 60)), mode: '开车', estimated: true },
    transit: { km: distance, minutes: Math.max(1, Math.round(distance / 22 * 60 + 12)), mode: '公共交通', estimated: true }
  };
}

async function fetchAmapRoute(label, url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const path = data.route && data.route.paths && data.route.paths[0];
      if (data.status === '1' && path && path.distance) {
        return {
          km: kmFromMeters(path.distance),
          minutes: minutesFromSeconds(path.duration || path.cost?.duration),
          mode: label
        };
      }
      const transit = data.route && data.route.transits && data.route.transits[0];
      if (data.status === '1' && transit && transit.distance) {
        return {
          km: kmFromMeters(transit.distance),
          minutes: minutesFromSeconds(transit.duration),
          mode: label
        };
      }
    } catch (_) {}
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
  }
  return null;
}

function sanitizeRouteMode(value) {
  return ROUTE_MODES.includes(textOf(value)) ? textOf(value) : 'cycling';
}

function routeRequest(mode, key, origin, destination) {
  const shared = `key=${encodeURIComponent(key)}&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
  if (mode === 'walking') return ['步行', `https://restapi.amap.com/v5/direction/walking?${shared}&show_fields=cost&output=JSON`];
  if (mode === 'driving') return ['开车', `https://restapi.amap.com/v5/direction/driving?${shared}&show_fields=cost&strategy=32&output=JSON`];
  if (mode === 'transit') return ['公共交通', `https://restapi.amap.com/v3/direction/transit/integrated?${shared}&city=${encodeURIComponent('深圳')}&cityd=${encodeURIComponent('深圳')}&strategy=0&output=JSON`];
  return ['骑行', `https://restapi.amap.com/v5/direction/bicycling?${shared}&show_fields=cost&output=JSON`];
}

async function routeOptions(settings, originAddress, destinationAddress, requestedModes = ROUTE_MODES) {
  const key = amapServiceKey(settings);
  if (!key || !originAddress || !destinationAddress) return {};
  const modes = [...new Set((Array.isArray(requestedModes) ? requestedModes : [requestedModes])
    .map(sanitizeRouteMode))];
  const [origin, destination] = await Promise.all([
    geocode(key, originAddress),
    geocode(key, destinationAddress)
  ]);
  if (!origin || !destination) return {};
  const result = {};
  await Promise.all(modes.map(async mode => {
    const cacheKey = `${mode}|${origin}|${destination}`;
    const cached = routeCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < MAP_CACHE_TTL_MS) {
      result[mode] = cached.value;
      return;
    }
    const [label, url] = routeRequest(mode, key, origin, destination);
    const value = await fetchAmapRoute(label, url);
    if (value) routeCache.set(cacheKey, { value, createdAt: Date.now() });
    result[mode] = value;
  }));
  return result;
}

function score(order, settings) {
  return scoreOrder(order, settings);
}

async function enrichOrder(order, settings) {
  await resolveOrderLocation(order, settings);
  order.structured = await runParserPipeline({ rawText: order.raw, ruleOrder: order });
  if (Array.isArray(order.locationOptions) && order.locationOptions.length > 1) {
    order.locationOptions = await mapWithConcurrency(order.locationOptions, 2, async option => {
      const routes = await routeOptions(settings, settings.routeOrigin || settings.homeAddress || '', option.coordinates || option.query, ['cycling']);
      return { ...option, routeOptions: routes };
    });
  }
  if (!order.address) order.address = buildAddress(order.district, order.place, order.raw);
  const routed = await routeKm(settings, order.address, order.locationCoordinates);
  if (routed) {
    order.distanceKm = routed.km;
    order.routeMode = routed.mode;
  } else {
    order.distanceKm = estimateKm(order.district, order.place);
    order.routeMode = '估算';
  }
  order.score = score(order, settings);
  return order;
}

async function prepareImportedOrder(item, agency, settings, dependencies = {}) {
  const resolveLocation = dependencies.resolveLocation || resolveOrderLocation;
  const buildStructured = dependencies.buildStructured || runParserPipeline;
  const sanitized = sanitizeImportedOrder(item);
  const ruleOrder = parseOrder(sanitized.raw, agency.name, agency.id);
  const reusableLocation = canReuseVerifiedLocation(sanitized, ruleOrder);
  const order = { ...ruleOrder, ...sanitized, agencyId: agency.id, source: agency.name };
  if (!reusableLocation) {
    invalidateDerivedLocationData(order);
    await resolveLocation(order, settings);
  }
  order.structured = await buildStructured({ rawText: order.raw, ruleOrder: order });
  if (!order.address) order.address = buildAddress(order.district, order.place, order.raw);
  markRoutePending(order);
  order.score = score(order, settings);
  return order;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function previewDistances(settings, origin, orders, requestedMode = 'cycling') {
  const mode = sanitizeRouteMode(requestedMode);
  const scopedSettings = { ...settings, routeOrigin: textOf(origin) };
  const key = amapServiceKey(settings);
  const originCoordinates = key ? await geocode(key, scopedSettings.routeOrigin) : '';
  return mapWithConcurrency(orders, 2, async order => {
    if (Array.isArray(order.locationOptions) && order.locationOptions.length > 1) {
      const locationOptionRoutes = await mapWithConcurrency(order.locationOptions, 2, async option => ({
        ...option,
        routeOptions: await routeOptions(scopedSettings, originCoordinates || scopedSettings.routeOrigin, option.coordinates || option.query, [mode])
      }));
      const available = locationOptionRoutes.map(option => option.routeOptions?.[mode]).filter(Boolean).sort((a, b) => a.km - b.km);
      const preferred = available[0] || {};
      return {
        id: order.id,
        distanceKm: preferred.km || '',
        routeMode: preferred.mode || '多地点待计算',
        routeOptions: preferred.km ? { [mode]: preferred } : {},
        locationOptionRoutes,
        score: score({ ...order, distanceKm: preferred.km || '' }, scopedSettings)
      };
    }
    if (order.locationVerified === false && ['ambiguous', 'not_found', 'missing'].includes(order.locationStatus)) {
      return {
        id: order.id,
        distanceKm: '',
        routeMode: '地点待核实',
        routeOptions: {},
        score: score({ ...order, distanceKm: '' }, scopedSettings)
      };
    }
    const liveRoutes = await routeOptions(
      scopedSettings,
      originCoordinates || scopedSettings.routeOrigin,
      order.locationCoordinates || order.address,
      [mode]
    );
    const routes = liveRoutes[mode] ? liveRoutes : {};
    const preferred = routes[mode] || {};
    const distanceKm = preferred.km || '';
    return {
      id: order.id,
      distanceKm,
      routeMode: preferred.mode || (key ? '路线不可用' : '地图服务未配置'),
      routeStatus: preferred.km ? 'verified' : (key ? 'unavailable' : 'not_configured'),
      routeOptions: routes,
      score: score({ ...order, distanceKm }, scopedSettings)
    };
  });
}

function sanitizeTeacherPreferences(value = {}) {
  const filters = value.filters && typeof value.filters === 'object' ? value.filters : {};
  const allowed = {
    district: new Set(LISTS.districts),
    subject: new Set(['语文', '数学', '英语', '物理', '化学', '生物', '历史', '政治', '地理', '体育', '其他']),
    grade: new Set(['小学', '初中', '高中', '其他']),
    gender: new Set(['男老师', '女老师', '男女不限', '教师性别未说明'])
  };
  const selected = {};
  for (const group of Object.keys(allowed)) {
    selected[group] = uniq((Array.isArray(filters[group]) ? filters[group] : []).map(textOf))
      .filter(item => allowed[group].has(item));
  }
  return {
    filters: selected,
    minPrice: Math.max(0, Math.min(100000, Number(value.minPrice || 0))) || 0,
    onlyRange: Boolean(value.onlyRange),
    origin: textOf(value.origin).slice(0, 100),
    routeMode: ['walking', 'cycling', 'driving', 'transit'].includes(value.routeMode) ? value.routeMode : 'cycling',
    updatedAt: new Date().toISOString()
  };
}

function publicDb(db, viewer = null) {
  const orders = db.orders.map(order => {
    const copy = { ...order, score: score(order, db.settings) };
    const canSeeApplicants = viewer && (
      viewer.role === 'admin' ||
      (viewer.role === 'agency' && order.agencyId === viewer.id)
    );
    copy.applicantCount = order.applicants?.length || 0;
    copy.applicants = canSeeApplicants ? (order.applicants || []) : [];
    delete copy.sourceImages;
    delete copy.importFingerprint;
    return copy;
  });
  return {
    viewer: viewer ? { id: viewer.id, role: viewer.role, name: viewer.name } : null,
    announcement: db.announcement && (db.announcement.active || viewer?.role === 'admin')
      ? {
          title: db.announcement.title || '',
          content: db.announcement.content || '',
          active: Boolean(db.announcement.active),
          updatedAt: db.announcement.updatedAt || ''
        }
      : null,
    settings: {
      homeAddress: db.settings.homeAddress || '',
      maxBikeKm: db.settings.maxBikeKm || 12
    },
    adminConfigured: Boolean(db.settings.adminPasswordHash),
    users: viewer && viewer.role === 'admin'
      ? db.users.map(user => ({
          id: user.id,
          role: user.role,
          name: user.name,
          phone: user.phone,
          passwordSet: Boolean(user.passwordHash),
          createdAt: user.createdAt
        }))
      : [],
    feedback: viewer && viewer.role === 'admin' ? db.feedback || [] : [],
    stats: platformStats(db),
    orders,
    lists: LISTS
  };
}

function serveStatic(req, res) {
  const clean = decodeURIComponent(req.url.split('?')[0]);
  const file = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  const ext = path.extname(full).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  send(res, 200, fs.readFileSync(full), types[ext] || 'application/octet-stream');
}

async function handleApi(req, res) {
  const db = readDb();
  touchVisitor(req);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/auth/')) return send(res, 404, { error: '该登录方式已移除，请使用昵称、手机号和密码登录' });
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const repaired = await repairPersistedOpenOrderLocations(db);
    if (repaired) writeDb(db);
    return send(res, 200, publicDb(db, sessionOf(req)));
  }

  if (req.method === 'POST' && url.pathname === '/api/clipboard/capture') {
    if (!isClipboardBridgeRequest(req)) return send(res, 403, { error: '剪贴板桥接仅允许本机程序访问' });
    const data = await bodyJson(req);
    const text = String(data.text || '');
    if (!text.trim()) return send(res, 400, { error: '剪贴板原文不能为空' });
    if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_TEXT_BYTES) return send(res, 413, { error: '单条剪贴板内容过大' });
    const captureId = /^[A-Za-z0-9_-]{8,100}$/.test(textOf(data.captureId)) ? textOf(data.captureId) : crypto.randomUUID();
    const completed = db.clipboardReceipts.find(item => item.captureId === captureId);
    if (completed) return send(res, 200, { ok: true, captureId, status: 'completed', duplicate: true });
    const existing = db.clipboardInbox.find(item => item.captureId === captureId);
    if (existing) return send(res, 200, { ok: true, captureId, status: 'pending', duplicate: true });
    if (db.clipboardInbox.length >= MAX_CLIPBOARD_INBOX) return send(res, 507, { error: '网站待处理队列已满，请先打开发单端完成导入' });
    db.clipboardInbox.push({
      captureId,
      text,
      capturedAt: textOf(data.capturedAt) || new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
      lastError: ''
    });
    writeDb(db);
    return send(res, 200, { ok: true, captureId, status: 'pending', duplicate: false, pending: db.clipboardInbox.length });
  }

  if (req.method === 'GET' && url.pathname === '/api/clipboard/status') {
    if (!isClipboardBridgeRequest(req)) return send(res, 403, { error: '剪贴板桥接仅允许本机程序访问' });
    const captureId = textOf(url.searchParams.get('captureId'));
    if (db.clipboardReceipts.some(item => item.captureId === captureId)) return send(res, 200, { captureId, status: 'completed' });
    if (db.clipboardInbox.some(item => item.captureId === captureId)) return send(res, 200, { captureId, status: 'pending' });
    return send(res, 200, { captureId, status: 'unknown' });
  }

  if (req.method === 'GET' && url.pathname === '/api/clipboard/inbox') {
    const agency = requireRole(req, res, 'agency');
    if (!agency) return;
    const now = Date.now();
    const items = db.clipboardInbox
      .filter(item => Number(item.nextAttemptAt || 0) <= now)
      .sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)))
      .slice(0, 10)
      .map(item => ({ captureId: item.captureId, text: item.text, capturedAt: item.capturedAt, attempts: item.attempts || 0 }));
    return send(res, 200, { items, pending: db.clipboardInbox.length });
  }

  const clipboardAction = url.pathname.match(/^\/api\/clipboard\/([A-Za-z0-9_-]{8,100})\/(complete|fail)$/);
  if (req.method === 'POST' && clipboardAction) {
    const agency = requireRole(req, res, 'agency');
    if (!agency) return;
    const captureId = clipboardAction[1];
    const action = clipboardAction[2];
    const index = db.clipboardInbox.findIndex(item => item.captureId === captureId);
    if (index < 0) return send(res, 200, { ok: true, captureId, status: db.clipboardReceipts.some(item => item.captureId === captureId) ? 'completed' : 'unknown' });
    if (action === 'complete') {
      db.clipboardInbox.splice(index, 1);
      db.clipboardReceipts.push({ captureId, completedAt: new Date().toISOString(), agencyId: agency.id });
      db.clipboardReceipts = db.clipboardReceipts.slice(-500);
      writeDb(db);
      return send(res, 200, { ok: true, captureId, status: 'completed' });
    }
    const data = await bodyJson(req);
    const item = db.clipboardInbox[index];
    item.attempts = Number(item.attempts || 0) + 1;
    item.lastError = textOf(data.error).slice(0, 300);
    item.nextAttemptAt = Date.now() + Math.min(60000, 2000 * (2 ** Math.min(item.attempts, 5)));
    writeDb(db);
    return send(res, 200, { ok: true, captureId, status: 'pending', attempts: item.attempts, nextAttemptAt: item.nextAttemptAt });
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    sessionOf(req);
    return send(res, 200, platformStats(db));
  }

  if (req.method === 'GET' && url.pathname === '/api/location-suggestions') {
    const suggestions = await locationSuggestions(db.settings, url.searchParams.get('q') || '');
    return send(res, amapServiceKey(db.settings) ? 200 : 503, { suggestions, status: amapServiceKey(db.settings) ? (suggestions.length ? 'candidates' : 'not_found') : 'not_configured',
      ...(amapServiceKey(db.settings) ? {} : { error: '地图服务尚未配置' }) });
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/config') {
    return send(res, 200, authConfiguration());
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/sms/send') {
    const data = await bodyJson(req);
    const phone = textOf(data.phone);
    if (!validMainlandPhone(phone)) return send(res, 400, { error: '请输入正确的中国大陆手机号' });
    pruneTemporaryAuth();
    const previous = smsChallenges.get(phone);
    if (previous && Date.now() - previous.sentAt < SMS_RESEND_MS) {
      const wait = Math.ceil((SMS_RESEND_MS - (Date.now() - previous.sentAt)) / 1000);
      return send(res, 429, { error: `请等待 ${wait} 秒后再获取验证码`, retryAfter: wait });
    }
    const config = smsConfiguration();
    if (!config.enabled && !config.devMode) {
      return send(res, 503, { error: '短信验证码服务正在配置中，请先使用密码登录' });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    if (config.enabled) {
      try {
        await sendTencentSms(phone, code, config);
      } catch (error) {
        return send(res, 502, { error: `验证码发送失败：${error.message}` });
      }
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    smsChallenges.set(phone, {
      codeHash: challengeHash(phone, code, nonce),
      nonce,
      attempts: 0,
      sentAt: Date.now(),
      expiresAt: Date.now() + SMS_CODE_TTL_MS
    });
    return send(res, 200, {
      ok: true,
      expiresIn: Math.floor(SMS_CODE_TTL_MS / 1000),
      resendAfter: Math.floor(SMS_RESEND_MS / 1000),
      ...(config.devMode && !config.enabled ? { debugCode: code } : {})
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/sms/verify') {
    const data = await bodyJson(req);
    const name = textOf(data.name);
    const phone = textOf(data.phone);
    const code = textOf(data.code);
    if (!name) return send(res, 400, { error: '请填写老师姓名或机构名称' });
    if (!validMainlandPhone(phone)) return send(res, 400, { error: '请输入正确的中国大陆手机号' });
    if (!/^\d{6}$/.test(code)) return send(res, 400, { error: '请输入6位验证码' });
    const verified = consumeSmsChallenge(phone, code);
    if (!verified.ok) return send(res, 401, { error: verified.error });
    if (!identityAccounts(db, name, phone).some(Boolean) && phoneIdentityConflict(db, name, phone)) {
      return send(res, 409, { error: '姓名与这个手机号已绑定的账号不一致' });
    }
    const paired = ensurePairedIdentity(db, name, phone);
    const bound = bindWechatIdentity(db, paired.teacher, paired.agency, textOf(data.wechatBindTicket));
    if (bound.error) return send(res, 400, { error: bound.error });
    const login = memberLoginResponse(db, paired.teacher, paired.agency, Boolean(data.rememberAccount || data.autoLogin), req);
    if (paired.changed || bound.changed || login.changed) writeDb(db);
    return send(res, 200, login.body, 'application/json; charset=utf-8', { 'Set-Cookie': login.rememberCookie });
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/wechat/start') {
    const config = wechatConfiguration();
    if (!config.enabled) return redirect(res, '/?wechat_error=' + encodeURIComponent('微信扫码登录尚未完成平台配置'));
    pruneTemporaryAuth();
    const state = crypto.randomBytes(24).toString('hex');
    wechatOAuthStates.set(state, { expiresAt: Date.now() + WECHAT_FLOW_TTL_MS });
    const target = `https://open.weixin.qq.com/connect/qrconnect?appid=${encodeURIComponent(config.appId)}&redirect_uri=${encodeURIComponent(config.redirectUri)}&response_type=code&scope=snsapi_login&state=${encodeURIComponent(state)}#wechat_redirect`;
    return redirect(res, target);
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/wechat/callback') {
    const config = wechatConfiguration();
    const stateValue = textOf(url.searchParams.get('state'));
    const code = textOf(url.searchParams.get('code'));
    pruneTemporaryAuth();
    const stateRecord = wechatOAuthStates.get(stateValue);
    wechatOAuthStates.delete(stateValue);
    if (!config.enabled || !stateRecord || !code) {
      return redirect(res, '/?wechat_error=' + encodeURIComponent('微信扫码已失效，请重新尝试'));
    }
    try {
      const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${encodeURIComponent(config.appId)}&secret=${encodeURIComponent(config.appSecret)}&code=${encodeURIComponent(code)}&grant_type=authorization_code`;
      const tokenData = await fetch(tokenUrl, { signal: AbortSignal.timeout(10000) }).then(response => response.json());
      if (!tokenData.openid || tokenData.errcode) throw new Error(tokenData.errmsg || '微信授权失败');
      const identityHash = sha256(`${config.appId}|${tokenData.unionid || tokenData.openid}`);
      const linked = db.users.find(user => ['teacher', 'agency'].includes(user.role) && user.wechatIdentityHash === identityHash);
      const ticket = crypto.randomBytes(32).toString('hex');
      if (linked) {
        wechatTickets.set(ticket, {
          kind: 'login',
          identityHash,
          name: linked.name,
          phone: linked.phone,
          expiresAt: Date.now() + WECHAT_FLOW_TTL_MS
        });
        return redirect(res, '/?wechat_ticket=' + encodeURIComponent(ticket));
      }
      wechatTickets.set(ticket, { kind: 'bind', identityHash, expiresAt: Date.now() + WECHAT_FLOW_TTL_MS });
      return redirect(res, '/?wechat_bind=' + encodeURIComponent(ticket));
    } catch (error) {
      return redirect(res, '/?wechat_error=' + encodeURIComponent(error.message || '微信登录失败'));
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/wechat/complete') {
    const data = await bodyJson(req);
    const ticketValue = textOf(data.ticket);
    pruneTemporaryAuth();
    const ticket = wechatTickets.get(ticketValue);
    if (!ticket || ticket.kind !== 'login') return send(res, 401, { error: '微信登录已过期，请重新扫码' });
    const paired = ensurePairedIdentity(db, ticket.name, ticket.phone);
    wechatTickets.delete(ticketValue);
    const login = memberLoginResponse(db, paired.teacher, paired.agency, Boolean(data.rememberAccount || data.autoLogin), req);
    if (paired.changed || login.changed) writeDb(db);
    return send(res, 200, login.body, 'application/json; charset=utf-8', { 'Set-Cookie': login.rememberCookie });
  }

  if (req.method === 'POST' && url.pathname === '/api/account/login') {
    const data = await bodyJson(req);
    const name = textOf(data.name);
    const phone = textOf(data.phone);
    const password = textOf(data.password);
    const rememberAccount = Boolean(data.rememberAccount || data.autoLogin);
    if (!name) return send(res, 400, { error: '请填写姓名或机构名称' });
    if (!validMainlandPhone(phone)) return send(res, 400, { error: '请输入正确的11位中国大陆手机号' });
    if (password.length < 6) return send(res, 400, { error: '密码至少需要6位' });

    const paired = ensurePairedIdentity(db, name, phone, { password, requirePassword: true });
    if (paired.error) return send(res, 401, { error: paired.error });
    const login = memberLoginResponse(db, paired.teacher, paired.agency, rememberAccount, req);
    if (paired.changed || login.changed) writeDb(db);
    return send(res, 200, login.body, 'application/json; charset=utf-8', { 'Set-Cookie': login.rememberCookie });
  }

  if (req.method === 'POST' && url.pathname === '/api/account/remember-login') {
    const rememberedToken = cookieValue(req, REMEMBER_COOKIE);
    const rememberedHash = tokenHash(rememberedToken);
    const remembered = rememberedToken
      ? db.rememberSessions.find(item => item.tokenHash === rememberedHash && Number(item.expiresAt || 0) > Date.now())
      : null;
    if (!remembered) {
      const changed = revokeRememberToken(db, rememberedToken) || pruneRememberSessions(db);
      if (changed) writeDb(db);
      return send(res, 401, { error: '记住的登录已失效，请重新输入密码' }, 'application/json; charset=utf-8', {
        'Set-Cookie': rememberCookieHeader(req, '', 0)
      });
    }

    const teacher = db.users.find(user => user.role === 'teacher' && user.name === remembered.name && user.phone === remembered.phone);
    const agency = db.users.find(user => user.role === 'agency' && user.name === remembered.name && user.phone === remembered.phone);
    if (!teacher || !agency) {
      revokeRememberToken(db, rememberedToken);
      writeDb(db);
      return send(res, 401, { error: '记住的账号已经不存在' }, 'application/json; charset=utf-8', {
        'Set-Cookie': rememberCookieHeader(req, '', 0)
      });
    }

    revokeRememberToken(db, rememberedToken);
    const nextToken = issueRememberLogin(db, remembered.name, remembered.phone);
    writeDb(db);
    return send(res, 200, {
      teacher: publicUser(teacher),
      agency: publicUser(agency),
      teacherToken: createSession({ id: teacher.id, role: teacher.role, name: teacher.name }),
      agencyToken: createSession({ id: agency.id, role: agency.role, name: agency.name })
    }, 'application/json; charset=utf-8', {
      'Set-Cookie': rememberCookieHeader(req, nextToken, Math.floor(REMEMBER_LOGIN_MS / 1000))
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const data = await bodyJson(req);
    const role = textOf(data.role) || 'teacher';
    const name = textOf(data.name);
    const phone = textOf(data.phone);
    const password = textOf(data.password);
    if (!name) return send(res, 400, { error: '请填写名称' });
    if (!validMainlandPhone(phone)) return send(res, 400, { error: '请输入正确的11位中国大陆手机号' });
    if (!['teacher', 'agency'].includes(role)) return send(res, 400, { error: '身份类型不正确' });
    if (password.length < 6) return send(res, 400, { error: role === 'agency' ? '中介密码至少需要6位' : '老师密码至少需要6位' });
    let user = db.users.find(u => u.role === role && u.name === name && (!phone || u.phone === phone));
    if (!user) {
      user = {
        id: 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        role, name, phone,
        passwordHash: passwordHash(password),
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
      writeDb(db);
    } else {
      if (user.passwordHash && !passwordMatches(password, user.passwordHash)) {
        return send(res, 401, { error: role === 'agency' ? '中介密码不正确' : '老师密码不正确' });
      }
      if (!user.passwordHash) {
        if (user.phone && phone !== user.phone) return send(res, 401, { error: '原联系方式不正确，无法升级账号' });
        user.passwordHash = passwordHash(password);
        writeDb(db);
      }
    }
    const token = createSession({ id: user.id, role: user.role, name: user.name });
    return send(res, 200, { user: { id: user.id, role: user.role, name: user.name, phone: user.phone }, token });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/setup') {
    const data = await bodyJson(req);
    const password = textOf(data.password);
    if (db.settings.adminPasswordHash) return send(res, 409, { error: '管理员密码已经设置，请直接登录' });
    if (password.length < 8) return send(res, 400, { error: '管理员密码至少需要8位' });
    db.settings.adminPasswordHash = passwordHash(password);
    writeDb(db);
    const token = createSession({ id: 'admin', role: 'admin', name: '管理员' });
    return send(res, 200, { token });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    const data = await bodyJson(req);
    if (!db.settings.adminPasswordHash) return send(res, 409, { error: '请先设置管理员密码' });
    if (!passwordMatches(textOf(data.password), db.settings.adminPasswordHash)) {
      return send(res, 401, { error: '管理员密码不正确' });
    }
    const token = createSession({ id: 'admin', role: 'admin', name: '管理员' });
    return send(res, 200, { token });
  }

  if (req.method === 'POST' && url.pathname === '/api/feedback') {
    const data = await bodyJson(req);
    const content = textOf(data.content);
    if (content.length < 2) return send(res, 400, { error: '请填写反馈内容' });
    db.feedback ||= [];
    db.feedback.unshift({
      id: 'f-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      name: textOf(data.name),
      contact: textOf(data.contact),
      content,
      createdAt: new Date().toISOString()
    });
    db.feedback = db.feedback.slice(0, 200);
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/distance-preview') {
    const teacher = requireRole(req, res, 'teacher');
    if (!teacher) return;
    const data = await bodyJson(req);
    const origin = textOf(data.origin);
    if (!origin) return send(res, 400, { error: '请填写你的位置' });
    const openOrders = db.orders.filter(order => order.status !== 'closed');
    const unresolved = openOrders.filter(order => order.locationVerified === false
      && order.district
      && (isGenericLocationValue(order.place) || (order.locationCandidates || []).some(candidate => candidate?.location)));
    let defaultedExistingLocation = false;
    await mapWithConcurrency(unresolved, 2, async order => {
      const reparsedPreciseLocation = refreshLocationEvidenceFromRaw(order);
      await resolveOrderLocation(order, db.settings);
      if (reparsedPreciseLocation) order.structured = await runParserPipeline({ rawText: order.raw, ruleOrder: order });
      if (order.locationVerified || reparsedPreciseLocation) defaultedExistingLocation = true;
    });
    if (defaultedExistingLocation) writeDb(db);
    const distances = await previewDistances(db.settings, origin, openOrders, data.mode);
    return send(res, 200, { distances });
  }

  if (req.method === 'GET' && url.pathname === '/api/teacher/preferences') {
    const teacher = requireRole(req, res, 'teacher');
    if (!teacher) return;
    const user = db.users.find(item => item.id === teacher.id && item.role === 'teacher');
    if (!user) return send(res, 404, { error: '老师账号不存在' });
    return send(res, 200, { exists: Boolean(user.preferences), preferences: sanitizeTeacherPreferences(user.preferences || {}) });
  }

  if (req.method === 'PUT' && url.pathname === '/api/teacher/preferences') {
    const teacher = requireRole(req, res, 'teacher');
    if (!teacher) return;
    const user = db.users.find(item => item.id === teacher.id && item.role === 'teacher');
    if (!user) return send(res, 404, { error: '老师账号不存在' });
    const data = await bodyJson(req);
    user.preferences = sanitizeTeacherPreferences(data);
    writeDb(db);
    return send(res, 200, { ok: true, preferences: user.preferences });
  }

  if (req.method === 'POST' && url.pathname === '/api/account/password') {
    const actor = sessionOf(req);
    if (!actor || !['teacher', 'agency'].includes(actor.role)) {
      return send(res, 401, { error: '请先登录账号' });
    }
    const data = await bodyJson(req);
    const oldPassword = textOf(data.oldPassword);
    const newPassword = textOf(data.newPassword);
    if (newPassword.length < 6) return send(res, 400, { error: '新密码至少需要6位' });
    const user = db.users.find(u => u.id === actor.id && u.role === actor.role);
    if (!user) return send(res, 404, { error: '账号不存在' });
    if (user.passwordHash && !passwordMatches(oldPassword, user.passwordHash)) {
      return send(res, 401, { error: '原密码不正确' });
    }
    user.passwordHash = passwordHash(newPassword);
    revokeRememberIdentity(db, user.name, user.phone);
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/account/password-by-identity') {
    const data = await bodyJson(req);
    const name = textOf(data.name);
    const phone = textOf(data.phone);
    const oldPassword = textOf(data.oldPassword);
    const newPassword = textOf(data.newPassword);
    if (!name || !phone) return send(res, 400, { error: '请填写姓名和手机号' });
    if (newPassword.length < 6) return send(res, 400, { error: '新密码至少需要6位' });
    const users = db.users.filter(user => ['teacher', 'agency'].includes(user.role) && user.name === name && user.phone === phone);
    if (!users.length) return send(res, 404, { error: '没有找到这个账号' });
    if (!users.some(user => user.passwordHash && passwordMatches(oldPassword, user.passwordHash))) {
      return send(res, 401, { error: '原密码不正确' });
    }
    for (const user of users) user.passwordHash = passwordHash(newPassword);
    revokeRememberIdentity(db, name, phone);
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/reset-password') {
    if (!requireRole(req, res, 'admin')) return;
    const data = await bodyJson(req);
    const userId = textOf(data.userId);
    const newPassword = textOf(data.newPassword);
    if (newPassword.length < 6) return send(res, 400, { error: '新密码至少需要6位' });
    const user = db.users.find(u => u.id === userId && ['teacher', 'agency'].includes(u.role));
    if (!user) return send(res, 404, { error: '账号不存在' });
    const identityUsers = db.users.filter(candidate => (
      candidate.id === user.id || (
        user.phone && candidate.name === user.name && candidate.phone === user.phone
      )
    ));
    for (const identityUser of identityUsers) identityUser.passwordHash = passwordHash(newPassword);
    revokeRememberIdentity(db, user.name, user.phone);
    writeDb(db);
    return send(res, 200, { ok: true, updatedUsers: identityUsers.length });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/batch-delete-orders') {
    if (!requireRole(req, res, 'admin')) return;
    const data = await bodyJson(req);
    const orderIds = uniq((Array.isArray(data.orderIds) ? data.orderIds : []).map(textOf)).slice(0, 5000);
    if (!orderIds.length) return send(res, 400, { error: '请先选择要删除的订单' });
    const selectedIds = new Set(orderIds);
    const before = db.orders.length;
    const removedImages = db.orders.filter(order => selectedIds.has(order.id)).flatMap(order => order.sourceImages || []);
    db.orders = db.orders.filter(order => !selectedIds.has(order.id));
    const deletedOrders = before - db.orders.length;
    if (!deletedOrders) return send(res, 404, { error: '所选订单已经不存在' });
    removeUnreferencedSourceImages(db, removedImages);
    writeDb(db);
    return send(res, 200, { ok: true, deletedOrders });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/batch-delete-users') {
    if (!requireRole(req, res, 'admin')) return;
    const data = await bodyJson(req);
    const userIds = uniq((Array.isArray(data.userIds) ? data.userIds : []).map(textOf)).slice(0, 5000);
    if (!userIds.length) return send(res, 400, { error: '请先选择要删除的账号' });

    const requestedIds = new Set(userIds);
    const selectedUsers = db.users.filter(user => requestedIds.has(user.id) && ['teacher', 'agency'].includes(user.role));
    if (!selectedUsers.length) return send(res, 404, { error: '所选账号已经不存在' });

    const belongsToSelectedIdentity = user => selectedUsers.some(selected => (
      user.id === selected.id || (
        selected.phone && user.name === selected.name && user.phone === selected.phone
      )
    ));
    const usersToDelete = db.users.filter(user => ['teacher', 'agency'].includes(user.role) && belongsToSelectedIdentity(user));
    const deletedUserIds = new Set(usersToDelete.map(user => user.id));
    const deletedAgencyIds = new Set(usersToDelete.filter(user => user.role === 'agency').map(user => user.id));
    const deletedTeacherIds = new Set(usersToDelete.filter(user => user.role === 'teacher').map(user => user.id));
    const deletedIdentityKeys = new Set(usersToDelete.map(user => `${textOf(user.name)}\u0000${textOf(user.phone)}`));

    db.users = db.users.filter(user => !deletedUserIds.has(user.id));
    const orderCountBefore = db.orders.length;
    const removedImages = db.orders.filter(order => deletedAgencyIds.has(order.agencyId)).flatMap(order => order.sourceImages || []);
    db.orders = db.orders.filter(order => !deletedAgencyIds.has(order.agencyId));
    const deletedOrders = orderCountBefore - db.orders.length;
    removeUnreferencedSourceImages(db, removedImages);
    let deletedApplications = 0;
    for (const order of db.orders) {
      const beforeApplicants = order.applicants?.length || 0;
      order.applicants = (order.applicants || []).filter(applicant => {
        const identityKey = `${textOf(applicant.name)}\u0000${textOf(applicant.phone)}`;
        return !deletedTeacherIds.has(applicant.teacherId) && !deletedIdentityKeys.has(identityKey);
      });
      deletedApplications += beforeApplicants - order.applicants.length;
    }
    db.rememberSessions = (db.rememberSessions || []).filter(item => (
      !deletedIdentityKeys.has(`${textOf(item.name)}\u0000${textOf(item.phone)}`)
    ));
    for (const [token, session] of sessions) {
      if (deletedUserIds.has(session.id)) sessions.delete(token);
    }

    writeDb(db);
    return send(res, 200, {
      ok: true,
      deletedAccounts: deletedIdentityKeys.size,
      deletedUserRecords: usersToDelete.length,
      deletedOrders,
      deletedApplications
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/announcement') {
    if (!requireRole(req, res, 'admin')) return;
    const data = await bodyJson(req);
    const title = textOf(data.title);
    const content = textOf(data.content);
    const active = Boolean(data.active);
    if (active && !content) return send(res, 400, { error: '请填写公告内容' });
    if (title.length > 60) return send(res, 400, { error: '公告标题不能超过60个字' });
    if (content.length > 2000) return send(res, 400, { error: '公告内容不能超过2000个字' });
    db.announcement = {
      title,
      content,
      active,
      updatedAt: new Date().toISOString()
    };
    writeDb(db);
    return send(res, 200, db.announcement);
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    if (!requireRole(req, res, 'admin')) return;
    const data = await bodyJson(req);
    db.settings = {
      ...db.settings,
      homeAddress: textOf(data.homeAddress),
      maxBikeKm: Number(data.maxBikeKm || 12)
    };
    delete db.settings.amapKey;
    db.orders.forEach(o => o.score = score(o, db.settings));
    writeDb(db);
    return send(res, 200, { homeAddress: db.settings.homeAddress, maxBikeKm: db.settings.maxBikeKm });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/reconcile-locations') {
    if (!requireRole(req, res, 'admin')) return;
    const data = await bodyJson(req);
    const requested = new Set((Array.isArray(data.orderIds) ? data.orderIds : []).map(textOf).filter(Boolean));
    const targets = requested.size ? db.orders.filter(order => requested.has(order.id)) : db.orders;
    let verified = 0;
    for (const order of targets) {
      await resolveOrderLocation(order, db.settings);
      if (!order.address) order.address = buildAddress(order.district, order.place, order.raw);
      if (order.locationVerified) verified++;
      order.score = score(order, db.settings);
    }
    writeDb(db);
    return send(res, 200, { ok: true, checked: targets.length, verified });
  }

  if (req.method === 'POST' && url.pathname === '/api/orders') {
    const agency = requireRole(req, res, 'agency');
    if (!agency) return;
    const data = await bodyJson(req);
    const source = agency.name;
    const { images: _images, pages: _pages, sourceImages: _sourceImages, ...orderData } = data;
    const order = await enrichOrder({ ...parseOrder(orderData.raw || '', source, agency.id), ...orderData, agencyId: agency.id, source, id: undefined }, db.settings);
    order.id = 'o-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    order.createdAt = new Date().toISOString();
    order.applicants = [];
    db.orders.unshift(order);
    writeDb(db);
    return send(res, 200, order);
  }

  if (req.method === 'POST' && url.pathname === '/api/parse') {
    const agency = requireRole(req, res, 'agency');
    if (!agency) return;
    const data = await bodyJson(req);
    const result = await recognizeOrders({
      text: data.text || '',
      source: agency.name,
      agencyId: agency.id,
      settings: db.settings
    }, {
      splitDetailed: splitImportBlocksDetailed,
      parseRuleOrder: parseOrder,
      resolveLocation: resolveOrderLocation,
      buildStructured: runParserPipeline
    });
    return send(res, 200, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/import') {
    const agency = requireRole(req, res, 'agency');
    if (!agency) return;
    const data = await bodyJson(req);
    const incoming = data.orders && Array.isArray(data.orders)
      ? data.orders.map(item => ({ ...item, raw: item.raw || JSON.stringify(item) }))
      : dedupeImportBlocks(splitImportBlocks(data.text || ''), agency.name, agency.id).map(raw => ({ raw }));
    let duplicatesSkipped = 0;
    let incompleteSkipped = 0;
    const fingerprints = new Set(db.orders
      .filter(order => order.agencyId === agency.id)
      .map(order => rawOrderFingerprint(order.raw)));
    const orderCodes = new Set(db.orders
      .filter(order => order.agencyId === agency.id)
      .map(order => extractOrderCode(order.raw))
      .filter(Boolean));
    const recentCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const semanticFingerprints = new Set(db.orders
      .filter(order => order.agencyId === agency.id && order.status === 'open' && Date.parse(order.createdAt || 0) >= recentCutoff)
      .map(order => order.importFingerprint || semanticOrderFingerprint(parseOrder(order.raw, agency.name, agency.id)))
      .filter(Boolean));
    const accepted = [];
    for (const item of incoming) {
      const raw = textOf(item.raw);
      if (looksLikeIncompleteStructuredImport(raw)) {
        incompleteSkipped++;
        continue;
      }
      if (looksLikeJunkImport(raw)) {
        duplicatesSkipped++;
        continue;
      }
      const fingerprint = rawOrderFingerprint(raw);
      const orderCode = extractOrderCode(raw);
      const base = { ...parseOrder(raw, agency.name, agency.id), ...sanitizeImportedOrder(item), agencyId: agency.id, source: agency.name };
      const semanticFingerprint = semanticOrderFingerprint(base);
      if (fingerprints.has(fingerprint)
        || (orderCode && orderCodes.has(orderCode))
        || (semanticFingerprint && semanticFingerprints.has(semanticFingerprint))) {
        duplicatesSkipped++;
        continue;
      }
      const meaningful = Boolean(base.district || base.price || base.monthly || (base.subject && base.subject !== '其他') || (base.grade && base.grade !== '其他'));
      if (!meaningful) {
        incompleteSkipped++;
        continue;
      }
      accepted.push({ item: { ...item, raw }, semanticFingerprint });
      fingerprints.add(fingerprint);
      if (orderCode) orderCodes.add(orderCode);
      if (semanticFingerprint) semanticFingerprints.add(semanticFingerprint);
    }
    const created = await mapWithConcurrency(accepted, 3, async entry => {
      const order = await prepareImportedOrder(entry.item, agency, db.settings);
      order.importFingerprint = entry.semanticFingerprint;
      return order;
    });
    if (created.length) {
      db.orders.unshift(...created);
      writeDb(db);
    }
    return send(res, 200, { created, duplicatesSkipped, incompleteSkipped });
  }

  if (req.method === 'POST' && url.pathname === '/api/agency/orders/bulk') {
    const agency = requireRole(req, res, 'agency');
    if (!agency) return;
    const data = await bodyJson(req);
    if (!['close', 'delete'].includes(data.action)) return send(res, 400, { error: '不支持的批量操作' });
    const ownedOrders = db.orders.filter(order => order.agencyId === agency.id);
    let affected = 0;
    if (data.action === 'close') {
      for (const order of ownedOrders) {
        if (order.status === 'closed') continue;
        order.status = 'closed';
        affected++;
      }
    } else {
      affected = ownedOrders.length;
      db.orders = db.orders.filter(order => order.agencyId !== agency.id);
      for (const order of ownedOrders) removeUnreferencedSourceImages(db, order.sourceImages || []);
    }
    if (affected) writeDb(db);
    return send(res, 200, { action: data.action, affected });
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/orders\/[^/]+\/apply$/)) {
    const teacher = requireRole(req, res, 'teacher');
    if (!teacher) return;
    const id = url.pathname.split('/')[3];
    const data = await bodyJson(req);
    const order = db.orders.find(o => o.id === id);
    if (!order) return send(res, 404, { error: '订单不存在' });
    if (order.status === 'closed') return send(res, 400, { error: '这个订单已经下架' });
    const teacherUser = db.users.find(user => user.id === teacher.id && user.role === 'teacher');
    if (!teacherUser) return send(res, 404, { error: '老师账号不存在' });
    order.applicants ||= [];
    const name = textOf(teacherUser.name) || '未命名老师';
    const phone = textOf(teacherUser.phone);
    let applicant = order.applicants.find(item => item.teacherId === teacher.id || (phone && item.phone === phone));
    const alreadyApplied = Boolean(applicant);
    if (!applicant) {
      applicant = { teacherId: teacher.id, name, phone, note: textOf(data.note), at: new Date().toISOString(), status: 'pending' };
      order.applicants.push(applicant);
      writeDb(db);
    }
    return send(res, 200, {
      ok: true,
      alreadyApplied,
      contact: agencyContactForOrder(db, order),
      applicant: { name: applicant.name, phone: applicant.phone, at: applicant.at }
    });
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/orders\/[^/]+$/)) {
    const id = url.pathname.split('/')[3];
    const data = await bodyJson(req);
    const order = db.orders.find(o => o.id === id);
    if (!order) return send(res, 404, { error: '订单不存在' });
    const actor = sessionOf(req);
    const allowed = actor && (actor.role === 'admin' || (actor.role === 'agency' && order.agencyId === actor.id));
    if (!allowed) return send(res, 403, { error: '你只能管理自己发布的订单' });
    const allowedFields = actor.role === 'admin'
      ? ['status']
      : ['status', 'district', 'place', 'placeOriginal', 'address', 'subject', 'grade', 'gradeDescription', 'price', 'priceMin', 'priceMax', 'priceUnit', 'hourlyPrice', 'priceText', 'monthly', 'schedule', 'gender', 'student', 'studentGender', 'requirements', 'raw'];
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(data, key)) order[key] = data[key];
    }
    const locationChanged = ['district', 'place', 'address'].some(key => Object.prototype.hasOwnProperty.call(data, key));
    if (locationChanged) await enrichOrder(order, db.settings);
    else order.score = score(order, db.settings);
    writeDb(db);
    return send(res, 200, order);
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/orders\/[^/]+$/)) {
    const id = url.pathname.split('/')[3];
    const index = db.orders.findIndex(o => o.id === id);
    if (index < 0) return send(res, 404, { error: '订单不存在' });
    const actor = sessionOf(req);
    const order = db.orders[index];
    const allowed = actor && (actor.role === 'admin' || (actor.role === 'agency' && order.agencyId === actor.id));
    if (!allowed) return send(res, 403, { error: '你只能删除自己发布的订单' });
    db.orders.splice(index, 1);
    removeUnreferencedSourceImages(db, order.sourceImages || []);
    writeDb(db);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: '接口不存在' });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.url.startsWith('/api/')) {
    handleApi(req, res).catch(err => send(res, 500, { error: err.message }));
  } else {
    serveStatic(req, res);
  }
});

function startServer() {
  if (server.listening) return server;
  server.listen(PORT, () => {
    console.log(`深圳家教接单平台已启动：http://localhost:${PORT}`);
    console.log('局域网访问：把 localhost 换成这台电脑的局域网 IP。');
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  splitImportBlocks,
  splitImportBlocksDetailed,
  dedupeImportBlocks,
  importBlockRichness,
  parseOrder,
  looksLikeIncompleteStructuredImport,
  looksLikeJunkImport,
  cleanLocationCandidate,
  locationNameSimilarity,
  amapPlaceCandidates,
  extractTransitLandmarkQuery,
  sanitizeImportedText,
  extractOrderCode,
  semanticOrderFingerprint,
  sourcePageScore,
  sourceImageForOrder,
  validMainlandPhone,
  resolveOrderLocation,
  normalizeLocationDisplayName,
  isUnexpectedCompanyCandidate,
  isUnexpectedLocationDetail,
  normalizeResolvedLocationName,
  isGenericLocationValue,
  refreshLocationEvidenceFromRaw,
  repairPersistedOpenOrderLocations,
  prepareImportedOrder,
  isExplicitTransitCandidateMatch,
  consensusCandidateDistrict,
  locationQueryCharacterCoverage,
  score,
  previewDistances,
  locationSuggestions,
  sanitizeRouteMode
};
