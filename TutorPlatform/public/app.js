let state = { viewer: null, announcement: null, settings: {}, users: [], orders: [], feedback: [], stats: { registeredUsers: 0, onlineUsers: 0 }, lists: { districts: [], subjects: [], grades: [] } };
let currentTeacher = JSON.parse(localStorage.getItem('teacherUser') || 'null');
let currentAgency = JSON.parse(localStorage.getItem('agencyUser') || 'null');
let teacherToken = sessionStorage.getItem('teacherToken') || '';
let agencyToken = sessionStorage.getItem('agencyToken') || '';
let adminToken = sessionStorage.getItem('adminToken') || '';
let parsedImport = [];
let ignoredImportBlocks = [];
let teacherOrigin = localStorage.getItem('teacherOrigin') || '';
let routeMode = localStorage.getItem('routeMode') || 'cycling';
let distanceOverrides = {};
let activeView = sessionStorage.getItem('activeView') || 'teacher';
let locationSuggestionTimer = 0;
let locationSuggestionRequest = 0;
let selectedOriginCoordinates = localStorage.getItem('teacherOriginCoordinates') || '';
let teacherViewMode = localStorage.getItem('teacherViewMode') === 'map' ? 'map' : 'list';
let orderMap = null;
let orderMapCluster = null;
let orderMapInfoWindow = null;
let orderMapApi = null;
let orderMapLocations = null;
let orderMapRouteService = null;
let activeMapRouteOrderId = '';
let feedbackHideTimer = 0;
let activeAgencyContact = null;
let activeRawText = '';
let rememberedCredentialActive = false;
let loginBusy = false;
let teacherPreferenceSaveTimer = 0;
let teacherPreferencesLoaded = false;
let ordersRefreshBusy = false;
let clipboardBridgeBusy = false;
let clipboardBridgeUnavailable = false;
let backgroundStateRefreshTimer = 0;

const LOGIN_PREFERENCE_KEY = 'tutorPlatformLoginPreference';
const REMEMBERED_PASSWORD_MASK = 'remembered-login';
const CLIPBOARD_AUTOMATION_KEY = 'clipboardAutomationEnabled';
const GUEST_DEVICE_KEY = 'tutorPlatformGuestDeviceId';
const BROWSER_PREFERENCES_KEY = 'tutorPlatformBrowserPreferences';
const APPLICANT_PROFILE_KEY = 'tutorPlatformApplicantProfile';
const requestedView = new URLSearchParams(location.search).get('view');
if (['teacher', 'agency'].includes(requestedView)) activeView = requestedView;

const visitorId = localStorage.getItem('tutorPlatformVisitorId')
  || (crypto.randomUUID ? crypto.randomUUID() : `visitor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
localStorage.setItem('tutorPlatformVisitorId', visitorId);

const K12_FILTER_SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '政治', '地理', '体育'];
const TEACHER_FILTER_OPTIONS = {
  district: [],
  subject: [...K12_FILTER_SUBJECTS, '其他'],
  grade: ['小学', '初中', '高中', '其他'],
  gender: ['男老师', '女老师', '男女不限', '教师性别未说明']
};
const teacherFilterSelections = {
  district: new Set(),
  subject: new Set(),
  grade: new Set(),
  gender: new Set()
};

const routeLabels = {
  walking: '步行',
  cycling: '骑行',
  driving: '开车',
  transit: '公共交通'
};

const $ = (s, root = document) => root ? root.querySelector(s) : null;
const $$ = (s, root = document) => root ? [...root.querySelectorAll(s)] : [];

async function api(path, options = {}, token = '') {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Visitor-Id': visitorId,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    let message = '请求失败';
    try { message = (await res.json()).error || message; } catch {}
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function passwordProof(password, name, phone) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(password || '')), 'PBKDF2', false, ['deriveBits']);
  const salt = encoder.encode(`shenzhen-tutor-v1|${String(name || '').trim()}|${String(phone || '').trim()}`);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 210000 }, key, 256);
  let binary = '';
  for (const byte of new Uint8Array(bits)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

async function load() {
  orderMapLocations = null;
  state = await api('/api/state', {}, adminToken || agencyToken || teacherToken);
  applyDistanceOverrides();
  fillSelects();
  fillSettings();
  fillTeacherLocation();
  renderBadges();
  renderOrders();
  renderAgencyOrders();
  renderAdmin();
  renderAdminUsers();
  renderFeedbackList();
  renderAnnouncement();
  renderPlatformStats();
  syncShell();
}

function mergeCreatedOrders(created = []) {
  if (!created.length) return;
  const ids = new Set(created.map(order => order.id));
  state.orders = [...created, ...state.orders.filter(order => !ids.has(order.id))];
  renderOrders();
  renderAgencyOrders();
}

function scheduleBackgroundStateRefresh() {
  clearTimeout(backgroundStateRefreshTimer);
  backgroundStateRefreshTimer = setTimeout(() => load().catch(error => console.warn('后台刷新失败', error)), 1500);
}

function setView(name) {
  const target = $('#' + name);
  if (!target) return;
  activeView = name;
  sessionStorage.setItem('activeView', name);
  $$('.tabs button').forEach(button => {
    const teacherModeMatches = name !== 'teacher'
      || !button.dataset.teacherMode
      || button.dataset.teacherMode === teacherViewMode;
    button.classList.toggle('active', button.dataset.view === name && teacherModeMatches);
  });
  $$('.view').forEach(view => view.classList.toggle('active', view.id === name));
}

function syncShell() {
  const isAdmin = Boolean(state.viewer?.role === 'admin' && adminToken);
  const hasMemberSession = Boolean(state.viewer && !isAdmin && teacherToken && agencyToken);
  // 普通访问始终进入订单页；登录壳只在用户主动打开管理员入口时显示。
  $('#authScreen').classList.add('hidden');
  $('#appShell').classList.remove('hidden');

  $$('.tabs button[data-view="teacher"]').forEach(button => button.classList.toggle('hidden', isAdmin));
  $('.tabs button[data-view="agency"]').classList.toggle('hidden', isAdmin || !hasMemberSession);
  $('#adminTab').classList.toggle('hidden', !isAdmin);
  $('#accountBadge').textContent = isAdmin
    ? '管理员已登录'
    : hasMemberSession
      ? '打开即用 · 设置保存在本浏览器'
      : '共享订单 · 当前为只读模式';
  const adminEntry = $('#logoutButton');
  adminEntry.textContent = isAdmin ? '退出管理端' : '⋯';
  adminEntry.classList.toggle('admin-session', isAdmin);
  adminEntry.setAttribute('aria-label', isAdmin ? '退出管理端' : '管理员入口');
  adminEntry.title = isAdmin ? '退出管理端' : '系统管理';
  if (isAdmin) setView('admin');
  else setView(hasMemberSession && ['teacher', 'agency'].includes(activeView) ? activeView : 'teacher');
}

function renderPlatformStats() {
  $$('[data-stat="registered"]').forEach(node => { node.textContent = Number(state.stats?.registeredUsers || 0).toLocaleString(); });
  $$('[data-stat="online"]').forEach(node => { node.textContent = Number(state.stats?.onlineUsers || 0).toLocaleString(); });
}

async function refreshPlatformStats() {
  state.stats = await api('/api/stats', {}, adminToken || agencyToken || teacherToken);
  renderPlatformStats();
}

async function refreshOrderList() {
  if (ordersRefreshBusy) return;
  const button = $('#refreshOrdersButton');
  ordersRefreshBusy = true;
  button.disabled = true;
  button.classList.add('loading');
  try {
    await load();
    toast('家教单已刷新');
  } finally {
    ordersRefreshBusy = false;
    button.disabled = false;
    button.classList.remove('loading');
  }
}

function renderAnnouncement() {
  const bar = $('#announcementBar');
  if (!bar) return;
  const announcement = state.announcement;
  const visible = Boolean(announcement?.active && announcement.content);
  bar.classList.toggle('hidden', !visible);
  if (visible) {
    $('#announcementTitle').textContent = announcement.title || '平台公告';
    $('#announcementContent').textContent = announcement.content;
    $('#announcementTime').textContent = announcement.updatedAt
      ? `更新于 ${new Date(announcement.updatedAt).toLocaleString()}`
      : '';
  }

  const form = $('#announcementForm');
  if (!form || !adminToken) return;
  form.elements.title.value = announcement?.title || '';
  form.elements.content.value = announcement?.content || '';
  $('#announcementAdminStatus').textContent = announcement?.active
    ? '当前状态：已发布，所有用户可见'
    : '当前状态：未发布';
}

function selectedRoute(order) {
  const routes = distanceOverrides[order.id]?.routeOptions || order.routeOptions || {};
  return routes[routeMode] || null;
}

function routeText(order) {
  if (order.locationVerified === false && ['ambiguous', 'not_found', 'missing'].includes(order.locationStatus)) {
    return '地点待核实，距离暂不可计算';
  }
  const straightKm = Number(distanceOverrides[order.id]?.distanceKm || 0);
  if (straightKm) return `直线约 ${straightKm.toFixed(1)}公里`;
  return teacherOrigin ? '直线距离待计算' : '设置“我的位置”后显示直线距离';
}

function applyDistanceOverrides() {
  if (!Object.keys(distanceOverrides).length) return;
  state.orders = state.orders.map(order => {
    const override = distanceOverrides[order.id];
    if (!override) return order;
    const route = override.routeOptions?.[routeMode];
    return {
      ...order,
      ...override,
      distanceKm: route?.km || override.distanceKm,
      routeMode: route?.mode || override.routeMode || '直线'
    };
  });
}

function setOptions(select, values, first = '') {
  if (!select) return;
  const old = select.value;
  const list = first ? [first, ...values] : values;
  select.innerHTML = list.map(v => `<option>${escapeHtml(v)}</option>`).join('');
  if (list.includes(old)) select.value = old;
}

function fillSelects() {
  TEACHER_FILTER_OPTIONS.district = [...state.lists.districts];
  fillTeacherFilters();
  setOptions($('[name="district"]', $('#orderForm')), state.lists.districts, '选择区域');
  setOptions($('[name="subject"]', $('#orderForm')), state.lists.subjects, '选择科目');
  setOptions($('[name="grade"]', $('#orderForm')), state.lists.grades, '选择年级');
}

function fillTeacherFilters() {
  for (const [group, options] of Object.entries(TEACHER_FILTER_OPTIONS)) {
    const root = $(`[data-filter-options="${group}"]`);
    if (!root) continue;
    root.innerHTML = options.map(option => `<label class="multi-option">
      <input type="checkbox" value="${escapeHtml(option)}" data-filter-option="${group}"${teacherFilterSelections[group].has(option) ? ' checked' : ''}>
      <span>${escapeHtml(option)}</span>
    </label>`).join('');
    updateFilterSummary(group);
  }
}

function updateFilterSummary(group) {
  const selected = [...teacherFilterSelections[group]];
  const summary = $(`#filter${group === 'gender' ? 'Gender' : group[0].toUpperCase() + group.slice(1)}Summary`);
  if (!summary) return;
  summary.textContent = !selected.length ? '不限' : selected.length <= 2 ? selected.join('、') : `已选${selected.length}项`;
  summary.title = selected.join('、');
}

function clearFilterGroup(group) {
  teacherFilterSelections[group].clear();
  $$(`input[data-filter-option="${group}"]`).forEach(input => { input.checked = false; });
  updateFilterSummary(group);
}

function currentTeacherPreferences() {
  return {
    filters: Object.fromEntries(Object.entries(teacherFilterSelections).map(([group, selected]) => [group, [...selected]])),
    minPrice: Number($('#filterMinPrice')?.value || 0),
    onlyRange: Boolean($('#filterBike')?.checked),
    origin: String($('#teacherOrigin')?.value || teacherOrigin || '').trim(),
    originCoordinates: selectedOriginCoordinates,
    routeMode
  };
}

function applyTeacherPreferences(preferences = {}) {
  const filters = preferences.filters || {};
  for (const group of Object.keys(teacherFilterSelections)) {
    teacherFilterSelections[group].clear();
    for (const item of Array.isArray(filters[group]) ? filters[group] : []) teacherFilterSelections[group].add(item);
  }
  teacherOrigin = String(preferences.origin || '');
  selectedOriginCoordinates = String(preferences.originCoordinates || '');
  routeMode = ['walking', 'cycling', 'driving', 'transit'].includes(preferences.routeMode) ? preferences.routeMode : 'cycling';
  localStorage.setItem('teacherOrigin', teacherOrigin);
  if (selectedOriginCoordinates) localStorage.setItem('teacherOriginCoordinates', selectedOriginCoordinates);
  else localStorage.removeItem('teacherOriginCoordinates');
  localStorage.setItem('routeMode', routeMode);
  $('#filterMinPrice').value = Number(preferences.minPrice || 0) || '';
  $('#filterBike').checked = Boolean(preferences.onlyRange);
  fillTeacherFilters();
  fillTeacherLocation();
  renderOrders();
}

async function saveTeacherPreferences() {
  if (!teacherPreferencesLoaded) return;
  localStorage.setItem(BROWSER_PREFERENCES_KEY, JSON.stringify(currentTeacherPreferences()));
}

function queueTeacherPreferencesSave() {
  if (!teacherToken || !teacherPreferencesLoaded) return;
  clearTimeout(teacherPreferenceSaveTimer);
  teacherPreferenceSaveTimer = setTimeout(() => saveTeacherPreferences().catch(() => {}), 450);
}

async function loadTeacherPreferences() {
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_KEY) || '{}'); } catch {}
  if (!Object.keys(preferences).length) {
    preferences = { origin: teacherOrigin, originCoordinates: selectedOriginCoordinates, routeMode };
  }
  applyTeacherPreferences(preferences);
  teacherPreferencesLoaded = true;
  if (teacherOrigin) {
    $('#teacherLocationStatus').textContent = '正在计算直线距离…';
    setTimeout(() => updateTeacherDistances($('#teacherLocationForm'), { silent: true }).catch(error => {
      $('#teacherLocationStatus').textContent = `直线距离计算失败：${error.message}`;
    }), 0);
  }
}

function fillSettings() {
  const form = $('#settingsForm');
  if (!form) return;
  form.homeAddress.value = state.settings.homeAddress || '';
  form.maxBikeKm.value = state.settings.maxBikeKm || 12;
}

function fillTeacherLocation() {
  const form = $('#teacherLocationForm');
  if (!form) return;
  form.origin.value = teacherOrigin;
  $('#routeModeSelect').value = routeMode;
  $('#teacherLocationStatus').textContent = teacherOrigin
    ? `当前按“${teacherOrigin}”显示直线距离；真实路线请进入地图查看。`
    : '选择位置后，本地显示所有订单的直线距离。';
}

function renderBadges() {
  const adminButton = $('#adminLoginButton');
  if (adminButton) adminButton.textContent = state.adminConfigured ? '登录管理端' : '首次设置管理员密码';
}

function genderBucket(order) {
  const requirement = requirementSource(order);
  const text = repairCommonOcr(`${order.gender || ''} ${requirement || ''}`);
  const wantsFemale = /女老师|女教员|女大学生|女老师优先|教师性别\s*女/.test(text);
  const wantsMale = /男老师|男教员|男大学生|男老师优先|教师性别\s*男/.test(text);
  if (wantsMale && !wantsFemale) return '男老师';
  if (wantsFemale && !wantsMale) return '女老师';
  if (/男女不限|性别不限|不限性别|男女都可|男老师女老师都可以/.test(text)) return '男女不限';
  return '教师性别未说明';
}

function subjectBuckets(order) {
  const text = repairCommonOcr(String(order.subject || ''));
  const buckets = new Set();
  for (const subject of K12_FILTER_SUBJECTS) {
    if (subject === '政治' ? /政治|道法/.test(text) : text.includes(subject)) buckets.add(subject);
  }
  const tokens = text.split(/[\/、，,]+/).map(token => token.trim()).filter(Boolean);
  const hasOther = !tokens.length || tokens.some(token => !K12_FILTER_SUBJECTS.some(subject => (
    subject === '政治' ? /政治|道法/.test(token) : token.includes(subject)
  )));
  if (hasOther) buckets.add('其他');
  return buckets;
}

function gradeBuckets(order) {
  const text = repairCommonOcr(String(order.grade || ''));
  const buckets = new Set();
  if (/小学|小[一二三四五六]|[一二三四五六]年级/.test(text)) buckets.add('小学');
  if (/初[一二三]|初中|中考/.test(text)) buckets.add('初中');
  if (/高[一二三]|高中|高考/.test(text)) buckets.add('高中');
  if (/幼儿|大学|大[一二三四]|成人|其他/.test(text) || !buckets.size) buckets.add('其他');
  return buckets;
}

function matchesSelection(values, selected) {
  return !selected.size || [...selected].some(value => values.has(value));
}

function filteredOrders() {
  const minPrice = Number($('#filterMinPrice').value || 0);
  const onlyRange = $('#filterBike').checked;
  const maxKm = Number(state.settings.maxBikeKm || 12);
  return state.orders
    .filter(o => o.status !== 'closed')
    .filter(o => o.teacherVisible !== false)
    .filter(o => !teacherFilterSelections.district.size || teacherFilterSelections.district.has(String(o.district || '').replace(/区$/, '')))
    .filter(o => matchesSelection(subjectBuckets(o), teacherFilterSelections.subject))
    .filter(o => matchesSelection(gradeBuckets(o), teacherFilterSelections.grade))
    .filter(o => !teacherFilterSelections.gender.size || teacherFilterSelections.gender.has(genderBucket(o)))
    .filter(o => !minPrice || Number(o.hourlyPrice || o.price) >= minPrice || Number(o.monthly) >= minPrice)
    .filter(o => !onlyRange || (Number(o.distanceKm) && Number(o.distanceKm) <= maxKm))
    .sort((a, b) => {
      const distanceDifference = Number(a.distanceKm || Number.MAX_SAFE_INTEGER)
        - Number(b.distanceKm || Number.MAX_SAFE_INTEGER);
      if (teacherOrigin && distanceDifference) return distanceDifference;
      return Number(b.score || 0) - Number(a.score || 0);
    });
}

function compactText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '')
    .replace(/((?:每次|一次|时长\s*[:：]?))\s+(?=\d)/g, '$1')
    .replace(/(?<=\d)\s+(?=(?:h|小时))/gi, '')
    .replace(/\s+([，。；、：！？])/g, '$1')
    .replace(/([，。；、：！？])\s+/g, '$1')
    .trim();
}

function repairCommonOcr(value) {
  return String(value || '')
    .replace(/([一二三四五六])\uFFFD+级/g, '$1年级')
    .replace(/[署团哮嗜]假/g, '暑假')
    .replace(/男女不上限/g, '男女不限')
    .replace(/次次课/g, '次课')
    .replace(/2h[yv]/gi, '2h')
    .replace(/香密湖/g, '香蜜湖')
    .replace(/襄田(?=侨香)/g, '福田')
    .replace(/孑子岭|子子岭/g, '孖岭')
    .replace(/京基白纳/g, '京基百纳')
    .replace(/龙[离寓]楼/g, '龙宫楼')
    .replace(/伊墩酒店/g, '伊敦酒店')
    .replace(/口讠吾/g, '口语')
    .replace(/校夕卜/g, '校外')
    .replace(/赋分后七\s+八十/g, '赋分后七八十')
    .replace(/口\s+语好/g, '口语好');
}

function cleanDisplayText(value, maxLength = 120) {
  const allowedLatin = new Set(['SAT', 'IELTS', 'TOEFL', 'DSE', 'RMB', 'AP', 'IB', 'AMC', 'A-LEVEL', 'P5.JS', 'JS', 'RE3', 'M2', 'H', 'KM', 'K', 'W']);
  let text = compactText(repairCommonOcr(value))
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/微信家教订单搬运助手|家教订单自动采集助手|自动定位读取|识别并上传一次|开始自动搬运|停止自动搬运/gi, ' ')
    .replace(/(?:深圳)?(?:优质)?家教群(?:\[[^\]]*\]|【[^】]*】|\([^)]*\)|\s*\d+\s*)*/gi, ' ')
    .replace(/家教程老师\s*\([^)]*\)|家教小慧老师[^，。；]{0,18}|换群\s*[-&＆]?\s*招小助手/gi, ' ')
    .replace(/(?:今日新单|暑假单|长期单|上门辅导|大学生家教|大学生上门)\s*[&＆|/\\-]*/gi, ' ')
    .replace(/(?:接单中?|接单路?)群主|接单私聊我(?:\([^)]*\))?|需信息费\s*[:：]?\s*私[^【《]{0,20}|可回收家教/gi, ' ')
    .replace(/共\s*\d+\s*条(?:新消息)?|\d+\s*条新消息|进入聊天|查看全部/gi, ' ')
    .replace(/[\uE000-\uF8FF\uFFFD■□▇◆◇©®™¢¤¥]+/g, ' ')
    .replace(/[A-Za-z][A-Za-z0-9._-]*/g, (token, offset, source) => {
      const before = source[offset - 1] || '';
      const after = source[offset + token.length] || '';
      const addressMarker = /[\u4e00-\u9fff]/.test(before) && /[\u4e00-\u9fff]/.test(after) && /^(?:[A-Z]|[A-Z]\d+)$/i.test(token);
      return allowedLatin.has(token.toUpperCase()) || addressMarker ? token : ' ';
    })
    .replace(/[@#$^_=+\\&＆]+/g, ' ')
    .replace(/[|｜]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。；、：])/g, '$1')
    .replace(/^[，。；、：\-~…\s]+|[，；、：\-~\s]+$/g, '')
    .trim();
  const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const strayLatinCount = (text.match(/[A-Za-z]/g) || []).length;
  if (chineseCount < 3 && strayLatinCount > chineseCount * 2) return '';
  if (text.length > maxLength) text = `${text.slice(0, maxLength).replace(/[，；、\s]+$/, '')}…`;
  return text;
}

function structuredFieldCount(value) {
  return (String(value || '').match(/(?:【|《)?(?:学生|学员|时间|次数|薪酬|课酬|薪资|地址|地点|科目|要求|老师要求|教员要求)(?:】|》)?\s*[:：]?/g) || []).length;
}

function usefulChineseText(value, minimum = 2) {
  const text = String(value || '');
  const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  const oddCount = (text.match(/[©®™@#$^_=+\\\[\]{}]/g) || []).length;
  return chineseCount >= minimum && latinCount <= Math.max(8, chineseCount / 2) && oddCount < 3;
}

function categoryLabel(value, options, fallback) {
  const repaired = compactText(repairCommonOcr(value));
  let found = options.filter(option => repaired.includes(option));
  if (found.some(item => /^初[一二三]$/.test(item))) found = found.filter(item => item !== '初中');
  if (found.some(item => /^高[一二三]$/.test(item))) found = found.filter(item => item !== '高中');
  if (found.some(item => /^[一二三四五六]年级$/.test(item))) found = found.filter(item => item !== '小学');
  if (found.length > 1) found = found.filter(item => item !== '其他');
  return [...new Set(found)].join('/') || fallback;
}

function priceLabel(o) {
  const fieldPrice = fieldFromRaw(o.raw, ['老师薪水', '老师课费', '课时价格', '课费报酬', '课费薪酬', '薪酬', '课酬', '薪资', '时薪']);
  let text = cleanDisplayText(fieldPrice || o.priceText || '', 80)
    .replace(/^(?:老师薪水|老师课费|课时价格|课费报酬|课费薪酬|薪酬|课酬|薪资|时薪)\s*[:：]?\s*/, '')
    .split(/(?:学生|学员|老师要求|教员要求|要求|地址|地点|科目|时间)\s*[:：]/)[0]
    .trim();
  if (Number(o.priceMin) && Number(o.priceMax) && Number(o.priceMin) !== Number(o.priceMax) && o.priceUnit) {
    return `${o.priceMin}-${o.priceMax}元/${o.priceUnit}`;
  }
  if (Number(o.price) >= 50 && o.priceUnit) return `${o.price}元/${o.priceUnit}`;
  const direct = text.match(/(?:￥|¥)?\s*\d{2,6}(?:\.\d+)?\s*(?:[-~～—至到一]\s*\d{2,6}(?:\.\d+)?)?\s*(?:元|万|[kKwW])?\s*(?:\/|每|一)\s*(?:小时|时|h|次|节|天|月|2h)/i)
    || text.match(/(?:￥|¥)?\s*\d{2,6}(?:\.\d+)?\s*(?:[-~～—至到一]\s*\d{2,6}(?:\.\d+)?)?\s*元\s*(?:左右)?/i)
    || text.match(/\d+(?:\.\d+)?\s*[-~～—至到]\s*\d+(?:\.\d+)?\s*[万wWkK]\s*\/?\s*月/i);
  if (direct) return compactText(direct[0]).replace(/\s+/g, '').replace(/元?一次(?:课)?$/, '元/次');

  const ranges = [...text.matchAll(/(\d{2,6}\s*[-~～—至到一]\s*\d{2,6})/g)];
  if (ranges.length && /一次课|每次|\/次/.test(text)) return `${ranges.at(-1)[1].replace(/\s+/g, '')}/次`;
  if (ranges.length && /时薪|小时|\/h/i.test(text)) return `${ranges.at(-1)[1].replace(/\s+/g, '')}元/小时`;
  if (/老师自报价|老师报价|自报价|老师自带价|接受报价|价格面议|薪资面议|课酬面议/.test(text)) {
    return text.match(/老师自报价|老师报价|自报价|老师自带价|接受报价|价格面议|薪资面议|课酬面议/)[0];
  }
  if (Number(o.monthly) >= 1000) return `${o.monthly}元/月`;
  if (Number(o.price) >= 50) return `${o.price}元/小时`;
  return '课酬待定';
}

function displayPlace(order) {
  const district = compactText(order.district || '').replace(/区$/, '');
  let place = cleanDisplayText(order.place || '', 60)
    .replace(/^(?:【|《)?(?:学员地址|辅导地址|上课地址|地址|地点)(?:】|》)?\s*[:：]?\s*/, '')
    .replace(/^(?:【[^】]{0,18}】|《[^》]{0,18}》)\s*/, '')
    .replace(/^[^\u4e00-\u9fff0-9]+/, '')
    .replace(/^[【[(<]?\s*(?!\d{1,2}\s*号线)\d{1,3}\s*/, '')
    .replace(/^(?:深圳)?[A-Za-z]{0,3}\d{6,}[A-Za-z]?\s*/i, '')
    .replace(/^[（(【[]?\s*[A-Za-z]\s*/i, '')
    .replace(/[¢¤¥]+/g, ' ')
    .replace(/^\d{1,2}(?=深圳市|[\u4e00-\u9fff]{2,4}区)/, '')
    .replace(/深圳市/g, '')
    .replace(/^\d{1,2}(?=[\u4e00-\u9fff]{2,4}区)/, '')
    .replace(/^[^\u4e00-\u9fff0-9]+/, '')
    .replace(new RegExp(`^${district}区?(?!墟)`), '')
    .replace(/^(?:次|地址|地点)\s*[:：]\s*/, '')
    .replace(new RegExp(`^${district}区?(?!墟)`), '')
    .replace(/\s+(?:时间|次数|科目|学生|学员|老师|要求)\s*[:：].*$/, '')
    .replace(/\s*[:：]\s*(?:局蒙|男生|女生|男孩|女孩).*$/, '')
    .replace(/[|｜].*$/, '')
    .replace(/[佳新]?局[一二三].*$/, '')
    .replace(/(?:幼儿园|小[一二三四五六]|[一二三四五六]年级|初[一二三]|高[一二三]|准?初中|准?高中|大[一二三四]|大学|成人).*$/, '')
    .replace(/[（(【[<《]+$/g, '')
    .replace(/['"“”‘’]/g, '')
    .replace(/^[>》】)）<\s]+|[>》】<\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/深圳家教|家教群|可拉人|群聊|群主|新消息|接单|换群|招小助手|言】/.test(place)) place = '';
  if (/^(?:[A-Za-z]{0,3}\d{5,}[A-Za-z]?|\d{5,})$/i.test(place)) place = '';
  if ((place.match(/[A-Za-z]/g) || []).length > 3) place = '';
  const districtHits = ['罗湖', '福田', '南山', '盐田', '宝安', '龙岗', '龙华', '坪山', '光明', '大鹏']
    .filter(name => place.includes(name));
  if (districtHits.length > 1 || (district && districtHits.some(name => name !== district))) place = '';
  if (!place || place.length < 2) place = district ? '具体地点未提供' : '位置待定';
  return place;
}

function firstMatchText(text, patterns, fallback = '') {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return compactText(match[1] || match[0]);
  }
  return fallback;
}

function fieldFromRaw(raw, names) {
  const text = String(raw || '').replace(/\r/g, '');
  for (const name of names) {
    const pattern = new RegExp(`(?:[【\\[]${name}\\s*[:：]?[】\\]]|《${name}》|${name}\\s*[:：])\\s*([\\s\\S]*?)(?=\\n\\s*(?:【|\\[|《|[\\u4e00-\\u9fa5]{2,8}\\s*[:：]|[A-Z]{1,5}\\d|深圳)|$)`, 'i');
    const match = text.match(pattern);
    if (match && compactText(match[1])) return compactText(match[1]);
  }
  return '';
}

function splitSchedule(order) {
  const extracted = fieldFromRaw(order.raw, ['上课时间', '时间安排', '时间次数', '次数', '时间']);
  const text = cleanDisplayText(extracted || order.schedule || '', 150)
    .split(/(?:薪酬|课酬|薪资|时薪|老师薪水|老师要求|教员要求|要求|地点|地址|科目|学生|学员)\s*[:：]/)[0]
    .trim();
  const summarize = globalThis.TutorScheduleFormat?.summarizeScheduleText;
  const summary = typeof summarize === 'function'
    ? summarize(text)
    : { start: '开始时间待定', count: '次数待定', slot: '时间段待定' };
  const safe = (value, fallback) => {
    const cleaned = cleanDisplayText(value, 42);
    return !cleaned || /深圳[A-Za-z]{0,3}\d{5,}|家教群|新消息/.test(cleaned) ? fallback : cleaned;
  };
  return {
    start: safe(summary.start, '开始时间待定'),
    count: safe(summary.count, '次数待定'),
    slot: safe(summary.slot, '时间段待定')
  };
}

function studentSummary(order) {
  const raw = order.raw || '';
  let student = cleanDisplayText(fieldFromRaw(raw, ['学生情况', '学员情况', '学生', '学员', '成绩']) || order.student || '', 76)
    .split(/(?:时间|次数|薪酬|课酬|要求|地址|地点|科目)\s*[:：]/)[0]
    .replace(/[，,、\s]*(?:要|需|需要)(?:男|女)老师.*$/, '')
    .trim();
  if (!usefulChineseText(student) || structuredFieldCount(student) > 1 || /家教群|新消息|接单/.test(student)) student = '';
  const grade = cleanDisplayText(order.gradeDescription || '', 40) || categoryLabel(order.grade, state.lists.grades, '年级待定');
  const subject = categoryLabel(order.subject, state.lists.subjects, '科目待定');
  if (student.replace(/^(?:准|新)/, '') === grade) student = '';
  const gender = order.studentGender ? `；学生：${order.studentGender}` : '';
  const gradeSubject = `${grade} / ${subject}${gender}`;
  return student && !/学生信息待定/.test(student) ? `${gradeSubject}；${student}` : gradeSubject;
}

function requirementSource(order) {
  const extracted = fieldFromRaw(order.raw, ['老师要求', '教师要求', '教员要求', '要求', 'BK', 'BR']);
  return extracted || String(order.requirements || '');
}

function teacherAbility(order) {
  const text = cleanDisplayText(requirementSource(order), 180);
  const matches = text.match(/有经验|经验丰富|专职老师|在职老师|外教|大学生|研究生|985|211|深大|港中深|中大|师范生?|专业老师|耐心|责任心|认真负责|有方法|活跃|性格好|发音标准|口语纯正|沟通好|擅长提分|全英授课|口语好|有教资|成绩优秀/g) || [];
  const unique = [...new Set(matches)].slice(0, 4);
  return unique.length ? unique.join('、') : '能力要求待定';
}

function miscNotes(order) {
  const original = requirementSource(order);
  if (!original || structuredFieldCount(original) > 1) return '';
  const cleaned = cleanDisplayText(original, 90)
    .replace(/^(?:男老师|女老师|男教员|女教员|男女不限|性别不限|不限性别|性别\s*[男女])\s*[，、；;\s]*/, '')
    .replace(/(?:接单私聊我|今日新单|上门辅导|大学生家教|大学生上门).*$/g, ' ')
    .replace(/\s*(?:哩|入|外|地|和|合|网|罗|钊|贡|时|时时时|偶合)\s*$/g, '')
    .replace(/[，、]\s*[，、]+/g, '，')
    .replace(/\s*\/\s*的\s*$/g, '')
    .replace(/^[，。；、：\s]+|[，。；、：\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const districts = ['罗湖', '福田', '南山', '盐田', '宝安', '龙岗', '龙华', '坪山', '光明', '大鹏'].filter(item => cleaned.includes(item));
  const meaningful = /经验|耐心|责任|方法|专业|教学|成绩|学校|学历|本科|研究生|大学|师范|教资|口语|普通话|性格|沟通|长期|严厉|心理|趣味|证书|高考|竞赛|开朗|爱心|全英|提分|基础|能力|优先|老师|同学|英语|数学|物理|化学/.test(cleaned);
  const duplicateOnly = cleaned
    .replace(/有经验的?|经验丰富|专职老师|在职老师|大学生|研究生|985|211|深大|港中深|中大|师范生?|专业老师|有耐心|耐心|有责任心|责任心|沟通好|擅长提分|全英授课|口语好|有教资|成绩优秀/g, '')
    .replace(/[，。；、：\s]+/g, '');
  if (!usefulChineseText(cleaned) || !meaningful || !duplicateOnly || structuredFieldCount(cleaned) || districts.length > 1) return '';
  if (/家教群|群主|新消息|信息费|换群|招小助手|号家教|优家教|进入聊天|现金奖励|限时特惠|立减|026年/.test(cleaned)) return '';
  if (/(?:^|\s)\d+\s+[一二三四五六]\s+|征昌|急需\d/.test(cleaned)) return '';
  return cleaned;
}

function detailItem(label, value, wide = false) {
  const text = compactText(value || '');
  if (!text || text === '暂无额外备注') return '';
  return `<span class="info-chip${wide ? ' wide' : ''}" title="${escapeHtml(label)}">${escapeHtml(text)}</span>`;
}

function teacherDisplayName(name) {
  const value = cleanDisplayText(name || '', 24) || '未填写姓名';
  return /老师$/.test(value) ? value : `${value}老师`;
}

function orderDisplayMeta(o) {
  if (Array.isArray(o.locationOptions) && o.locationOptions.length > 1) {
    const labels = o.locationOptions.slice(0, 3).map((option, index) => {
      const place = cleanDisplayText(option.place || '', 40).replace(/^深圳国际会展中心/, '国际会展中心');
      return `${['①', '②', '③'][index] || `${index + 1}.`}${option.district || ''}·${place}`;
    });
    const grade = cleanDisplayText(o.gradeDescription || '', 40) || categoryLabel(o.grade, state.lists.grades, '年级待定');
    const subject = categoryLabel(o.subject, state.lists.subjects, '科目待定');
    const location = `地点二选一：${labels.join(' ')}`;
    return { district: '', place: '', location, grade, subject, title: `${location} | ${grade} ${subject}` };
  }
  const district = state.lists.districts.includes(String(o.district || '').replace(/区$/, ''))
    ? String(o.district).replace(/区$/, '')
    : '';
  const place = displayPlace(o);
  const locationBase = `${district ? `${district}区·` : ''}${place}`.replace(/区·区/g, '区·') || '位置待定';
  const location = o.transitLine ? `${locationBase}（${cleanDisplayText(o.transitLine, 12)}）` : locationBase;
  const grade = cleanDisplayText(o.gradeDescription || '', 40) || categoryLabel(o.grade, state.lists.grades, '年级待定');
  const subject = categoryLabel(o.subject, state.lists.subjects, '科目待定');
  const title = `${location} | ${grade} ${subject}`;
  return { district, place, location, grade, subject, title };
}

function orderDetailMarkup(o, meta = orderDisplayMeta(o)) {
  const schedule = splitSchedule(o);
  return `<div class="detail-grid">
    ${detailItem('价格', priceLabel(o))}
    ${detailItem('位置/距离', `${meta.location}；${routeText(o)}`)}
    ${detailItem('开始时间', schedule.start)}
    ${detailItem('次数/时段', `${schedule.count}；${schedule.slot}`)}
    ${detailItem('学生年级科目', studentSummary(o), true)}
    ${detailItem('教师性别', genderBucket(o))}
    ${detailItem('教师能力', teacherAbility(o))}
    ${detailItem('备注杂项', miscNotes(o), true)}
  </div>`;
}

function orderCard(o) {
  const meta = orderDisplayMeta(o);
  return `<article class="card" id="order-card-${escapeHtml(o.id)}">
    <div class="card-head">
      <div>
        <div class="title">${escapeHtml(meta.title)}</div>
        <div class="source-line">平台订单 · ${new Date(o.createdAt).toLocaleString()}</div>
      </div>
      <div class="score">${o.score || 0}分</div>
    </div>
    ${orderDetailMarkup(o, meta)}
    <div class="actions">
      <button data-order-id="${o.id}" onclick="applyOrder('${o.id}')">申请接单</button>
      <button class="secondary" onclick="focusOrderOnMap('${o.id}')">地图查看</button>
      <button class="secondary" onclick="openRawText('${encodeURIComponent(o.raw || o.requirements || '').replace(/'/g, '%27')}')">查看原文</button>
      <span class="application-hint">由匿名上传者回群协助联系</span>
    </div>
  </article>`;
}

function renderOrders() {
  const list = filteredOrders();
  $('#orders').innerHTML = list.length ? list.map(orderCard).join('') : '<div class="panel">暂时没有符合条件的订单。</div>';
  const count = $('#orderCount');
  if (count) count.textContent = `共 ${list.length} 条`;
  if (teacherViewMode === 'map') renderOrderMap(list).catch(error => showOrderMapStatus(error.message));
}

function showOrderMapStatus(message = '') {
  const status = $('#orderMapStatus');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('hidden', !message);
}

function orderMapPoints(orders, locationsByOrder = orderMapLocations || new Map()) {
  const points = [];
  for (const order of orders) {
    const locations = locationsByOrder.get(order.id) || [];
    locations.forEach((coordinates, optionIndex) => {
      const match = String(coordinates || '').match(/^(\d{2,3}(?:\.\d+)?),(\d{1,2}(?:\.\d+)?)$/);
      if (!match) return;
      points.push({ lnglat: [Number(match[1]), Number(match[2])], order, optionIndex: locations.length > 1 ? optionIndex : -1 });
    });
  }
  return points;
}

async function loadOrderMapLocations() {
  if (orderMapLocations) return orderMapLocations;
  const result = await api('/api/map-orders', {}, teacherToken);
  orderMapLocations = new Map((result.orders || []).map(order => [order.id, order.locations || []]));
  return orderMapLocations;
}

async function loadOrderMapApi() {
  if (orderMapApi) return orderMapApi;
  if (!window.AMapLoader) throw new Error('高德地图加载器不可用，请检查网络后重试');
  const config = await api('/api/map-config');
  if (!config.configured) throw new Error(config.reason || '高德地图 JS API 尚未配置');
  window._AMapSecurityConfig = { serviceHost: config.serviceHost };
  orderMapApi = await window.AMapLoader.load({
    key: config.key,
    version: config.version || '2.0',
    plugins: ['AMap.MarkerCluster', 'AMap.Walking', 'AMap.Riding', 'AMap.Driving', 'AMap.Transfer']
  });
  return orderMapApi;
}

function openMapOrder(point, marker) {
  const AMap = orderMapApi;
  const meta = orderDisplayMeta(point.order);
  const content = document.createElement('div');
  content.className = 'map-order-popup';
  const title = document.createElement('strong');
  title.textContent = meta.title;
  const summary = document.createElement('div');
  summary.textContent = `${priceLabel(point.order)} · ${routeText(point.order)}`;
  const actions = document.createElement('div');
  actions.className = 'map-popup-actions';
  const detailButton = document.createElement('button');
  detailButton.type = 'button';
  detailButton.textContent = '查看订单';
  detailButton.addEventListener('click', () => focusOrderFromMap(point.order.id));
  const routeButton = document.createElement('button');
  routeButton.type = 'button';
  routeButton.className = 'primary';
  routeButton.textContent = '规划路线';
  routeButton.addEventListener('click', () => {
    focusOrderOnMap(point.order.id).catch(error => showOrderMapStatus(error.message));
  });
  actions.append(detailButton, routeButton);
  content.append(title, summary, actions);
  orderMapInfoWindow ||= new AMap.InfoWindow({ offset: new AMap.Pixel(0, -28) });
  orderMapInfoWindow.setContent(content);
  orderMapInfoWindow.open(orderMap, marker.getPosition());
}

function mapPointCoordinates(value) {
  if (Array.isArray(value) && value.length >= 2) return [Number(value[0]), Number(value[1])];
  if (value && typeof value.getLng === 'function' && typeof value.getLat === 'function') {
    return [Number(value.getLng()), Number(value.getLat())];
  }
  if (value && Number.isFinite(Number(value.lng)) && Number.isFinite(Number(value.lat))) {
    return [Number(value.lng), Number(value.lat)];
  }
  return [];
}

function openMapClusterOrders(clusterData, marker) {
  const AMap = orderMapApi;
  const uniqueOrders = [...new Map(clusterData
    .filter(point => point?.order?.id)
    .map(point => [point.order.id, point.order])).values()];
  if (!uniqueOrders.length) return;
  const content = document.createElement('div');
  content.className = 'map-order-popup map-cluster-popup';
  const title = document.createElement('strong');
  title.textContent = `这里有 ${uniqueOrders.length} 条家教单`;
  const list = document.createElement('div');
  list.className = 'map-cluster-order-list';
  uniqueOrders.forEach(order => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = orderDisplayMeta(order).title;
    button.addEventListener('click', () => focusOrderFromMap(order.id));
    list.append(button);
  });
  content.append(title, list);
  orderMapInfoWindow ||= new AMap.InfoWindow({ offset: new AMap.Pixel(0, -20) });
  orderMapInfoWindow.setContent(content);
  const firstCoordinates = mapPointCoordinates(clusterData[0]?.lnglat);
  const position = marker?.getPosition?.()
    || (firstCoordinates.length === 2 ? new AMap.LngLat(firstCoordinates[0], firstCoordinates[1]) : null);
  if (position) orderMapInfoWindow.open(orderMap, position);
}

function handleMapClusterClick(event) {
  const clusterData = Array.isArray(event?.clusterData)
    ? event.clusterData
    : Array.isArray(event?.marker)
      ? event.marker
      : Array.isArray(event?.markers)
        ? event.markers
        : [];
  if (clusterData.length === 1 && clusterData[0]?.order?.id) {
    focusOrderFromMap(clusterData[0].order.id);
    return;
  }
  if (!clusterData.length) return;

  const marker = event.cluster || (!Array.isArray(event.marker) ? event.marker : null);
  const currentZoom = Number(orderMap.getZoom?.() || 11);
  const coordinates = new Set(clusterData
    .map(point => mapPointCoordinates(point.lnglat).join(','))
    .filter(Boolean));
  if (currentZoom < 18 && coordinates.size > 1) {
    const center = marker?.getPosition?.() || event.lnglat || mapPointCoordinates(clusterData[0]?.lnglat);
    orderMapInfoWindow?.close();
    orderMap.setZoomAndCenter(Math.min(18, currentZoom + 2), center, false, 260);
    return;
  }
  openMapClusterOrders(clusterData, marker);
}

function fitOrderMapPoints(points = []) {
  if (!orderMap || !orderMapApi || !points.length) return;
  if (points.length === 1) {
    orderMap.setZoomAndCenter(15, points[0].lnglat);
    return;
  }
  const longitudes = points.map(point => Number(point.lnglat[0])).filter(Number.isFinite);
  const latitudes = points.map(point => Number(point.lnglat[1])).filter(Number.isFinite);
  if (!longitudes.length || !latitudes.length) return;
  const bounds = new orderMapApi.Bounds(
    new orderMapApi.LngLat(Math.min(...longitudes), Math.min(...latitudes)),
    new orderMapApi.LngLat(Math.max(...longitudes), Math.max(...latitudes))
  );
  orderMap.setBounds(bounds, true, [56, 56, 56, 56]);
}

async function renderOrderMap(orders = filteredOrders()) {
  showOrderMapStatus('正在加载订单地图…');
  const AMap = await loadOrderMapApi();
  await loadOrderMapLocations();
  orderMap ||= new AMap.Map('orderMap', { zoom: 11, center: [114.0579, 22.5431], viewMode: '2D', mapStyle: 'amap://styles/whitesmoke' });
  if (orderMapCluster) {
    orderMapCluster.setMap(null);
    orderMapCluster = null;
  }
  const points = orderMapPoints(orders);
  if (!points.length) {
    showOrderMapStatus('当前筛选结果中没有已确认坐标的订单');
    return;
  }
  orderMapCluster = new AMap.MarkerCluster(orderMap, points, {
    gridSize: 60,
    renderMarker(context) {
      const position = context.marker.getPosition();
      const point = context.data?.order ? context.data : points.find(item => (
        Math.abs(item.lnglat[0] - Number(position?.lng)) < 0.000001
        && Math.abs(item.lnglat[1] - Number(position?.lat)) < 0.000001
      ));
      if (!point?.order) return;
      const pin = document.createElement('div');
      pin.className = 'order-map-marker';
      const glyph = document.createElement('span');
      glyph.textContent = '教';
      pin.append(glyph);
      context.marker.setContent(pin);
      context.marker.setOffset(new AMap.Pixel(-18, -36));
      context.marker.setTitle(orderDisplayMeta(point.order).title);
      context.marker.on('click', () => openMapOrder(point, context.marker));
    }
  });
  orderMapCluster.on('click', handleMapClusterClick);
  await new Promise(resolve => window.setTimeout(resolve, 120));
  fitOrderMapPoints(points);
  showOrderMapStatus('');
}

function setTeacherViewMode(mode) {
  teacherViewMode = mode === 'map' ? 'map' : 'list';
  localStorage.setItem('teacherViewMode', teacherViewMode);
  $('#orders').classList.toggle('hidden', teacherViewMode === 'map');
  $('#orderMapPanel').classList.toggle('hidden', teacherViewMode !== 'map');
  if (activeView === 'teacher') setView('teacher');
  if (teacherViewMode === 'map') return renderOrderMap().catch(error => showOrderMapStatus(error.message));
  return Promise.resolve();
}

function focusOrderFromMap(orderId) {
  orderMapInfoWindow?.close();
  setTeacherViewMode('list');
  requestAnimationFrame(() => {
    const card = document.getElementById(`order-card-${orderId}`);
    if (!card) {
      toast('未找到对应订单，请刷新后重试');
      return;
    }
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('highlight');
    requestAnimationFrame(() => card.classList.add('highlight'));
    setTimeout(() => card.classList.remove('highlight'), 2400);
  });
}

function commuteDistance(value) {
  const meters = Number(value || 0);
  if (!meters) return '';
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)}公里` : `${Math.round(meters)}米`;
}

function commuteMinutes(value) {
  const seconds = Number(value || 0);
  return seconds ? Math.max(1, Math.round(seconds / 60)) : 0;
}

function transitStepDetail(segment = {}) {
  const mode = String(segment.transit_mode || segment.transitMode || '').toUpperCase();
  const walking = segment.walking || segment.transit;
  if (mode === 'WALK' || segment.walking) {
    const distance = commuteDistance(walking?.distance || segment.distance);
    return {
      kind: 'walk',
      label: '步',
      text: distance ? `步行 ${distance}` : cleanDisplayText(segment.instruction || '步行', 80)
    };
  }
  const transit = segment.transit || {};
  const line = transit.lines?.[0] || transit.line || transit;
  const lineName = cleanDisplayText(line.name || line.bus_name || segment.instruction || '公共交通', 60);
  const start = cleanDisplayText(line.on_station?.name || transit.on_station?.name || line.departure_stop?.name || '', 40);
  const end = cleanDisplayText(line.off_station?.name || transit.off_station?.name || line.arrival_stop?.name || '', 40);
  const stations = Number(line.via_num || line.viaNum || transit.via_num || transit.viaNum || 0);
  const isMetro = /地铁|轨道|SUBWAY|METRO/i.test(`${lineName} ${line.type || ''} ${mode}`);
  return {
    kind: isMetro ? 'metro' : 'bus',
    label: isMetro ? '地' : '公',
    text: [
      `乘坐 ${lineName}`,
      start && end ? `${start} → ${end}` : '',
      stations ? `途经${stations}站` : ''
    ].filter(Boolean).join(' · ')
  };
}

function routeStepDetails(route = {}) {
  if (routeMode === 'transit') {
    return (route.segments || []).map(transitStepDetail).filter(item => item.text).slice(0, 8);
  }
  const labels = { walking: ['walk', '步'], cycling: ['ride', '骑'], driving: ['drive', '驾'] };
  const [kind, label] = labels[routeMode] || ['route', '行'];
  return (route.steps || route.rides || []).map(step => {
    const instruction = cleanDisplayText(step.instruction || step.action || '', 90);
    const distance = commuteDistance(step.distance);
    return { kind, label, text: [instruction, distance].filter(Boolean).join(' · ') };
  }).filter(item => item.text).slice(0, 6);
}

function renderOrderCommuteSummary(routeResult = {}, orderId = '') {
  const routes = routeResult.routes || routeResult.plans || [];
  const route = routes[0] || {};
  const km = commuteDistance(route.distance) || '距离待定';
  const minutes = commuteMinutes(route.time || route.duration);
  const walking = commuteDistance(route.walking_distance || route.walkingDistance);
  const transitSegments = (route.segments || []).filter(segment => {
    const mode = String(segment.transit_mode || segment.transitMode || '').toUpperCase();
    return mode && mode !== 'WALK';
  });
  const transfers = Math.max(0, transitSegments.length - 1);
  const isTransit = routeMode === 'transit';
  const metrics = isTransit ? [
    walking ? { value: walking, label: '步行' } : null,
    { value: `${transfers}次`, label: '换乘' },
    Number(route.cost) ? { value: `¥${Number(route.cost).toFixed(1)}`, label: '费用' } : null,
    routes.length > 1 ? { value: routes.length, label: '可选方案' } : null
  ].filter(Boolean) : [];
  const steps = isTransit ? routeStepDetails(route) : [];
  const order = state.orders.find(item => item.id === orderId);
  const destination = order ? orderDisplayMeta(order).location : '订单地点';
  const summary = $('#orderMapRouteSummary');
  summary.classList.toggle('transit', isTransit);
  summary.classList.toggle('compact', !isTransit);
  summary.innerHTML = `
    <div class="commute-card-head">
      <div>
        <span class="commute-mode">${escapeHtml(routeLabels[routeMode])}通勤</span>
        <p>前往 ${escapeHtml(destination)}</p>
      </div>
      <button class="commute-close" type="button" aria-label="关闭通勤详情">×</button>
    </div>
    <div class="commute-primary">
      <strong>${minutes ? `${minutes}<small>分钟</small>` : '时间待定'}</strong>
      <span>${escapeHtml(km)}</span>
    </div>
    ${metrics.length ? `<div class="commute-metrics">${metrics.map(item => `
      <div><strong>${escapeHtml(item.value)}</strong><span>${escapeHtml(item.label)}</span></div>
    `).join('')}</div>` : ''}
    ${steps.length ? `<div class="commute-route-chain">${steps.map(step => `
      <div class="commute-step ${escapeHtml(step.kind)}">
        <i>${escapeHtml(step.label)}</i><span>${escapeHtml(step.text)}</span>
      </div>
    `).join('')}</div>` : ''}
  `;
  $('.commute-close', summary)?.addEventListener('click', () => summary.classList.add('hidden'));
  summary.classList.remove('hidden');
}

async function focusOrderOnMap(orderId) {
  const origin = String($('#teacherOrigin')?.value || teacherOrigin || '').trim();
  if (!origin) {
    toast('请先填写“我的位置”，再查看导航路线');
    $('#teacherOrigin')?.focus();
    $('#teacherLocationForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  activeMapRouteOrderId = orderId;
  const activeOrder = state.orders.find(order => order.id === orderId);
  $('#activeMapRouteHint').textContent = activeOrder
    ? `正在查看：${orderDisplayMeta(activeOrder).title}`
    : '正在查看所选订单';
  await setTeacherViewMode('map');
  const locations = orderMapLocations?.get(orderId) || [];
  const coordinates = String(locations[0] || '').match(/^(\d{2,3}(?:\.\d+)?),(\d{1,2}(?:\.\d+)?)$/);
  if (!coordinates || !orderMap) {
    showOrderMapStatus('该订单还没有可用的地图坐标');
    return;
  }
  const destination = new orderMapApi.LngLat(Number(coordinates[1]), Number(coordinates[2]));
  let originCoordinates = selectedOriginCoordinates;
  if (!originCoordinates) {
    const result = await api(`/api/location-suggestions?q=${encodeURIComponent(origin)}`);
    originCoordinates = result.suggestions?.[0]?.location || '';
  }
  const originMatch = String(originCoordinates).match(/^(\d{2,3}(?:\.\d+)?),(\d{1,2}(?:\.\d+)?)$/);
  if (!originMatch) {
    showOrderMapStatus('无法识别“我的位置”，请从地点候选中重新选择');
    return;
  }
  selectedOriginCoordinates = originCoordinates;
  localStorage.setItem('teacherOriginCoordinates', selectedOriginCoordinates);
  const start = new orderMapApi.LngLat(Number(originMatch[1]), Number(originMatch[2]));
  orderMapRouteService?.clear?.();
  const options = { map: orderMap, autoFitView: true, hideMarkers: false };
  orderMapRouteService = routeMode === 'walking'
    ? new orderMapApi.Walking(options)
    : routeMode === 'driving'
      ? new orderMapApi.Driving(options)
      : routeMode === 'transit'
        ? new orderMapApi.Transfer({ ...options, city: '深圳市', cityd: '深圳市', policy: orderMapApi.TransferPolicy.LEAST_TIME })
        : new orderMapApi.Riding(options);
  showOrderMapStatus('正在规划导航路线…');
  const routeResult = await new Promise((resolve, reject) => {
    orderMapRouteService.search(start, destination, (status, result) => {
      if (status === 'complete') resolve(result);
      else reject(new Error(result?.info || '导航路线规划失败'));
    });
  }).catch(error => {
    showOrderMapStatus(error.message);
    return null;
  });
  if (!routeResult) return;
  renderOrderCommuteSummary(routeResult, orderId);
  showOrderMapStatus('');
}

async function showAllOrdersOnMap() {
  const visibleOrders = filteredOrders();
  orderMapInfoWindow?.close();
  orderMapRouteService?.clear?.();
  orderMapRouteService = null;
  activeMapRouteOrderId = '';
  $('#orderMapRouteSummary').classList.add('hidden');
  $('#activeMapRouteHint').textContent = '正在总览当前筛选中的全部订单';
  await renderOrderMap(visibleOrders);
  await new Promise(resolve => window.setTimeout(resolve, 420));
  fitOrderMapPoints(orderMapPoints(visibleOrders));
  toast('已显示全部订单位置');
}

function renderAdmin() {
  const root = $('#adminOrders');
  if (!adminToken) {
    root.innerHTML = '';
    updateAdminBulkControls('orders');
    return;
  }
  root.innerHTML = state.orders.length ? state.orders.map(o => {
    const meta = orderDisplayMeta(o);
    const status = ['open', 'matched', 'closed'].includes(o.status) ? o.status : 'open';
    return `<article class="card admin-order-card">
      <div class="card-head">
        <div class="card-title-group">
          <label class="selection-check admin-card-select">
            <input class="admin-order-select" type="checkbox" value="${escapeHtml(o.id)}" aria-label="选择订单 ${escapeHtml(meta.title)}">
            <span>选择</span>
          </label>
          <div>
            <div class="title">${escapeHtml(meta.title)}</div>
            <div class="source-line">${escapeHtml(cleanDisplayText(o.source || '', 28) || '平台订单')} · ${new Date(o.createdAt).toLocaleString()}</div>
          </div>
        </div>
        <div class="card-head-side">
          <span class="status-badge ${status}">${escapeHtml(statusLabel(status))}</span>
          <div class="score">${o.score || 0}分</div>
        </div>
      </div>
      ${orderDetailMarkup(o, meta)}
      <div class="admin-order-summary">申请 ${o.applicantCount || 0} 人</div>
      <div class="applicant-list">
        ${(o.applicants || []).length
          ? o.applicants.map(a => `<div class="applicant-item"><strong>${escapeHtml(teacherDisplayName(a.name))}</strong>，联系方式 <a href="tel:${escapeHtml(a.phone || '')}">${escapeHtml(a.phone || '未填写')}</a>，已接单</div>`).join('')
          : '<div class="raw">暂无接单老师</div>'}
      </div>
      <div class="actions">
        <button class="secondary" onclick="setStatus('${o.id}','open')">开放</button>
        <button class="secondary" onclick="setStatus('${o.id}','matched')">已成交</button>
        <button class="danger" onclick="setStatus('${o.id}','closed')">关闭</button>
        <button class="danger" onclick="deleteOrder('${o.id}','admin')">删除</button>
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">目前没有订单。</div>';
  updateAdminBulkControls('orders');
}

function renderAdminUsers() {
  const root = $('#adminUsers');
  if (!root) return;
  if (!adminToken) {
    root.innerHTML = '';
    updateAdminBulkControls('users');
    return;
  }
  const users = (state.users || []).filter(u => u.role === 'teacher' || u.role === 'agency');
  const grouped = new Map();
  for (const user of users) {
    const key = user.phone ? `${user.name}\u0000${user.phone}` : user.id;
    if (!grouped.has(key)) grouped.set(key, { ...user, ids: [], roles: [], passwordStates: [] });
    const account = grouped.get(key);
    account.ids.push(user.id);
    account.roles.push(user.role);
    account.passwordStates.push(user.passwordSet);
  }
  const accounts = [...grouped.values()];
  root.innerHTML = accounts.length ? accounts.map(account => {
    const roles = [...new Set(account.roles)].map(role => role === 'teacher' ? '老师' : '中介').join(' / ');
    const passwordSet = account.passwordStates.every(Boolean);
    return `<div class="admin-user-row">
      <label class="selection-check admin-user-select-wrap">
        <input class="admin-user-select" type="checkbox" value="${escapeHtml(account.ids.join(','))}" aria-label="选择账号 ${escapeHtml(account.name || '')}">
        <span class="sr-only">选择</span>
      </label>
      <div class="admin-user-main">
        <strong>${escapeHtml(account.name || '未填写名称')}</strong>
        <div class="raw">${escapeHtml(account.phone || '未填写联系方式')} · ${escapeHtml(roles)} · ${passwordSet ? '已设置密码' : '未设置密码'}</div>
      </div>
      <button class="secondary" type="button" onclick="resetUserPassword('${account.ids[0]}')">重置密码</button>
    </div>`;
  }).join('') : '<div class="empty-state">还没有老师或中介账号。</div>';
  updateAdminBulkControls('users');
}

function updateAdminBulkControls(type) {
  const isOrders = type === 'orders';
  const root = $(isOrders ? '#adminOrders' : '#adminUsers');
  const selectAll = $(isOrders ? '#selectAllAdminOrders' : '#selectAllAdminUsers');
  const deleteButton = $(isOrders ? '#batchDeleteAdminOrders' : '#batchDeleteAdminUsers');
  const countLabel = $(isOrders ? '#adminOrderSelectionCount' : '#adminUserSelectionCount');
  if (!root || !selectAll || !deleteButton || !countLabel) return;
  const boxes = $$(isOrders ? '.admin-order-select' : '.admin-user-select', root);
  const selected = boxes.filter(box => box.checked);
  selectAll.disabled = !boxes.length;
  selectAll.checked = Boolean(boxes.length && selected.length === boxes.length);
  selectAll.indeterminate = selected.length > 0 && selected.length < boxes.length;
  deleteButton.disabled = selected.length === 0;
  countLabel.textContent = isOrders ? `已选 ${selected.length} 条` : `已选 ${selected.length} 个`;
}

function renderFeedbackList() {
  const root = $('#adminFeedback');
  if (!root) return;
  if (!adminToken) {
    root.innerHTML = '';
    return;
  }
  const list = state.feedback || [];
  root.innerHTML = list.length ? list.map(item => `<div class="admin-row">
    <strong>${escapeHtml(item.name || '匿名反馈')}</strong>
    <div class="raw">${escapeHtml(item.contact || '未留联系方式')} · ${new Date(item.createdAt).toLocaleString()}</div>
    <div>${escapeHtml(item.content || '')}</div>
  </div>`).join('') : '<div class="raw">暂时没有反馈。</div>';
}

function renderAgencyOrders() {
  const root = $('#agencyOrders');
  const closeAllButton = $('#closeAllAgencyOrders');
  const deleteAllButton = $('#deleteAllAgencyOrders');
  if (!currentAgency || !agencyToken) {
    root.innerHTML = '<div class="raw">正在恢复这个浏览器的发单记录…</div>';
    closeAllButton.disabled = true;
    deleteAllButton.disabled = true;
    return;
  }
  const orders = state.orders.filter(o => o.agencyId === currentAgency.id);
  closeAllButton.disabled = !orders.some(order => order.status !== 'closed');
  deleteAllButton.disabled = !orders.length;
  root.innerHTML = orders.length ? orders.map(o => {
    const meta = orderDisplayMeta(o);
    return `<div class="admin-row">
      <strong>${escapeHtml(meta.title)}</strong>
      <div class="raw">${escapeHtml(priceLabel(o))} · 状态：${escapeHtml(statusLabel(o.status))} · 申请 ${o.applicantCount || 0} 人</div>
      <div class="applicant-list">
        ${(o.applicants || []).length
          ? o.applicants.map(a => `<div class="applicant-item">
              <div><strong>${escapeHtml(teacherDisplayName(a.name))}</strong>，联系方式 <span>${escapeHtml(a.phone || '未填写')}</span>，已申请</div>
              <div class="raw">${a.at ? new Date(a.at).toLocaleString() : ''}${a.note ? ` · ${escapeHtml(a.note)}` : ''}</div>
            </div>`).join('')
          : '<div class="raw">暂时还没有老师申请。</div>'}
      </div>
      <div class="actions">
        <button class="secondary" onclick="setAgencyStatus('${o.id}','open')">重新开放</button>
        <button class="secondary" onclick="setAgencyStatus('${o.id}','closed')">下架</button>
        <button class="danger" onclick="deleteOrder('${o.id}','agency')">删除</button>
      </div>
    </div>`;
  }).join('') : '<div class="raw">这个浏览器还没有发布订单。</div>';
}

function statusLabel(status) {
  return ({ open: '开放中', matched: '已成交', closed: '已下架' })[status] || status || '开放中';
}

function previewCard(o, index) {
  const meta = orderDisplayMeta(o);
  const schedule = splitSchedule(o);
  const notes = miscNotes(o);
  const candidates = (!o.locationVerified || o.locationStatus === 'defaulted') && Array.isArray(o.locationCandidates)
    ? o.locationCandidates.slice(0, 3).filter(candidate => candidate?.name)
    : [];
  const optionCandidates = Array.isArray(o.locationOptions) ? o.locationOptions.map((option, optionIndex) => ({
    optionIndex,
    label: `${optionIndex + 1}：${option.district || ''}${option.place || ''}`,
    candidates: option.verified && option.status !== 'defaulted' ? [] : (Array.isArray(option.candidates) ? option.candidates.slice(0, 3).filter(candidate => candidate?.name) : [])
  })).filter(item => item.candidates.length) : [];
  const structured = o.structured || {};
  const evidenceRows = [
    ['地点', structured.locations],
    ['年级', structured.gradeCurrent],
    ['科目', structured.subjectsCurrent],
    ['学生性别', structured.studentGender],
    ['教师性别', structured.teacherGender],
    ['价格', structured.priceMin],
    ['计价单位', structured.priceUnit]
  ].filter(([, field]) => field?.rawEvidence);
  const uncertainFields = structured.diagnostics?.uncertainFields || [];
  return `<div class="preview-card">
    <div class="preview-title">#${index + 1} ${escapeHtml(meta.title)}</div>
    <div class="meta">
      <span class="pill">${escapeHtml(priceLabel(o))}</span>
      <span class="pill">${escapeHtml(`${schedule.start} · ${schedule.count} · ${schedule.slot}`)}</span>
      <span class="pill">${escapeHtml(genderBucket(o))}</span>
      <span class="pill">${escapeHtml(studentSummary(o))}</span>
    </div>
    ${candidates.length ? `<div class="raw">${o.locationStatus === 'defaulted' ? '已默认选择第一项，可改：' : '地点待确认：'}${candidates.map((candidate, candidateIndex) => `<button type="button" class="secondary" onclick="selectPreviewLocationCandidate(${index},${candidateIndex})">${escapeHtml([candidate.district, candidate.name].filter(Boolean).join('·'))}</button>`).join(' ')}</div>` : ''}
    ${optionCandidates.map(item => `<div class="raw">${escapeHtml(item.label)}待确认：${item.candidates.map((candidate, candidateIndex) => `<button type="button" class="secondary" onclick="selectPreviewLocationOptionCandidate(${index},${item.optionIndex},${candidateIndex})">${escapeHtml([candidate.district, candidate.name].filter(Boolean).join('·'))}</button>`).join(' ')}</div>`).join('')}
    ${evidenceRows.length ? `<details class="parse-evidence"><summary>解析证据与置信度</summary>${evidenceRows.map(([label, field]) => `<div><strong>${escapeHtml(label)}</strong> ${(Number(field.confidence || 0) * 100).toFixed(0)}%：${escapeHtml(field.rawEvidence)}</div>`).join('')}</details>` : ''}
    ${uncertainFields.length ? `<div class="parse-warning">导入前请确认：${escapeHtml(uncertainFields.join('、'))}</div>` : ''}
    <details class="parse-evidence"><summary>订单原文（导入时保留）</summary><div>${escapeHtml(o.raw || structured.rawText || '')}</div></details>
    ${notes ? `<div class="raw">${escapeHtml(notes)}</div>` : ''}
  </div>`;
}

function selectPreviewLocationCandidate(orderIndex, candidateIndex) {
  const order = parsedImport[orderIndex];
  const candidate = order?.locationCandidates?.[candidateIndex];
  if (!order || !candidate) return;
  order.district = String(candidate.district || order.district || '').replace(/区$/, '');
  order.place = candidate.name;
  order.address = `深圳市${order.district ? `${order.district}区` : ''}${candidate.address || candidate.name}`;
  order.locationCoordinates = candidate.location || '';
  order.locationPoiId = candidate.id || '';
  order.locationAddress = candidate.address || '';
  order.locationConfidence = candidate.confidence || 100;
  order.locationVerified = Boolean(candidate.location);
  order.locationStatus = candidate.location ? 'confirmed' : 'selected_unverified';
  renderPreview();
}

function selectPreviewLocationOptionCandidate(orderIndex, optionIndex, candidateIndex) {
  const order = parsedImport[orderIndex];
  const option = order?.locationOptions?.[optionIndex];
  const candidate = option?.candidates?.[candidateIndex];
  if (!order || !option || !candidate?.location) return;
  option.district = String(candidate.district || option.district || '').replace(/区$/, '');
  option.place = candidate.name;
  option.poiId = candidate.id || '';
  option.coordinates = candidate.location;
  option.address = `深圳市${option.district ? `${option.district}区` : ''}${candidate.address || candidate.name}`;
  option.confidence = candidate.confidence || 100;
  option.verified = true;
  option.status = 'confirmed';
  order.locationVerified = order.locationOptions.some(item => item.verified);
  order.locationStatus = order.locationOptions.every(item => item.verified) ? 'confirmed' : 'options_unverified';
  renderPreview();
}

function renderPreview() {
  const ignoredNotice = ignoredImportBlocks.length
    ? `<div class="parse-warning">已忽略 ${ignoredImportBlocks.length} 段非订单文本。原文仍保留在解析响应中，可修改后重新识别。</div>`
    : '';
  $('#parsePreview').innerHTML = ignoredNotice + (parsedImport.length
    ? parsedImport.map(previewCard).join('')
    : '<div class="raw">没有识别到有效订单。</div>');
}

function readLoginPreference() {
  try {
    const preference = JSON.parse(localStorage.getItem(LOGIN_PREFERENCE_KEY) || 'null');
    if (!preference || typeof preference !== 'object') return null;
    return {
      name: String(preference.name || ''),
      phone: String(preference.phone || ''),
      rememberAccount: Boolean(preference.rememberAccount),
      autoLogin: Boolean(preference.autoLogin),
      hasCredential: Boolean(preference.hasCredential)
    };
  } catch {
    localStorage.removeItem(LOGIN_PREFERENCE_KEY);
    return null;
  }
}

function writeLoginPreference(preference) {
  localStorage.setItem(LOGIN_PREFERENCE_KEY, JSON.stringify({
    name: String(preference.name || '').trim(),
    phone: String(preference.phone || '').trim(),
    rememberAccount: Boolean(preference.rememberAccount),
    autoLogin: Boolean(preference.autoLogin),
    hasCredential: Boolean(preference.hasCredential)
  }));
}

function clearRememberedPassword(form, clearValue = true) {
  if (!rememberedCredentialActive) return;
  rememberedCredentialActive = false;
  const password = form?.elements?.password;
  if (!password) return;
  delete password.dataset.rememberedCredential;
  if (clearValue) password.value = '';
}

function showRememberedPassword(form) {
  const password = form?.elements?.password;
  if (!password) return;
  password.value = REMEMBERED_PASSWORD_MASK;
  password.dataset.rememberedCredential = 'true';
  rememberedCredentialActive = true;
}

function hydrateLoginForm() {
  const form = $('#unifiedLogin');
  if (!form) return;
  const preference = readLoginPreference();
  form.reset();
  rememberedCredentialActive = false;
  if (!preference?.rememberAccount) return;
  form.elements.name.value = preference.name;
  form.elements.phone.value = preference.phone;
  form.elements.rememberAccount.checked = true;
  form.elements.autoLogin.checked = Boolean(preference.autoLogin);
  if (preference.hasCredential) showRememberedPassword(form);
}

function invalidateRememberedCredential(form = $('#unifiedLogin')) {
  const preference = readLoginPreference();
  clearRememberedPassword(form);
  if (preference?.rememberAccount) {
    writeLoginPreference({ ...preference, autoLogin: false, hasCredential: false });
    form.elements.rememberAccount.checked = true;
  }
  form.elements.autoLogin.checked = false;
}

function invalidateCredentialForIdentity(name, phone) {
  const preference = readLoginPreference();
  if (!preference || preference.name !== String(name || '').trim() || preference.phone !== String(phone || '').trim()) return;
  invalidateRememberedCredential();
}

function setLoginBusy(busy, automatic = false) {
  const form = $('#unifiedLogin');
  const button = form?.querySelector('button[type="submit"]');
  loginBusy = busy;
  if (!button) return;
  button.dataset.idleText ||= button.textContent;
  button.disabled = busy;
  button.textContent = busy ? (automatic ? '正在自动登录...' : '正在登录...') : button.dataset.idleText;
}

function storeMemberSession(result) {
  currentTeacher = result.teacher;
  currentAgency = result.agency;
  teacherToken = result.teacherToken;
  agencyToken = result.agencyToken;
  localStorage.setItem('teacherUser', JSON.stringify(currentTeacher));
  localStorage.setItem('agencyUser', JSON.stringify(currentAgency));
  sessionStorage.setItem('teacherToken', teacherToken);
  sessionStorage.setItem('agencyToken', agencyToken);
}

function guestDeviceId() {
  let value = localStorage.getItem(GUEST_DEVICE_KEY) || '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    value = `browser_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
    localStorage.setItem(GUEST_DEVICE_KEY, value);
  }
  return value;
}

async function ensureGuestSession() {
  if (teacherToken && agencyToken && currentTeacher && currentAgency) return;
  const result = await api('/api/account/guest', { method: 'POST', body: { deviceId: guestDeviceId() } });
  storeMemberSession(result);
}

async function login(role, form) {
  const data = Object.fromEntries(new FormData(form).entries());
  data.passwordProof = await passwordProof(data.password, data.name, data.phone);
  const result = await api('/api/login', { method: 'POST', body: { ...data, role } });
  const user = result.user;
  if (role === 'teacher') {
    currentTeacher = user;
    teacherToken = result.token;
    localStorage.setItem('teacherUser', JSON.stringify(user));
    sessionStorage.setItem('teacherToken', teacherToken);
  } else {
    currentAgency = user;
    agencyToken = result.token;
    localStorage.setItem('agencyUser', JSON.stringify(user));
    sessionStorage.setItem('agencyToken', agencyToken);
  }
  await load();
  toast('已进入' + (role === 'teacher' ? '老师端' : '中介端'));
}

async function unifiedLogin(form, { automatic = false } = {}) {
  if (loginBusy) return;
  setLoginBusy(true, automatic);
  const preference = readLoginPreference();
  const name = String(form.elements.name.value || '').trim();
  const phone = String(form.elements.phone.value || '').trim();
  const autoLogin = Boolean(form.elements.autoLogin.checked);
  const rememberAccount = Boolean(form.elements.rememberAccount.checked || autoLogin);
  const canUseRememberedCredential = rememberedCredentialActive
    && preference?.hasCredential
    && preference.name === name
    && preference.phone === phone;

  try {
    let result;
    if (canUseRememberedCredential) {
      try {
        result = await api('/api/account/remember-login', { method: 'POST', body: {} });
      } catch (error) {
        invalidateRememberedCredential(form);
        form.elements.password.focus();
        throw error;
      }
    } else {
      const password = form.elements.password.value;
      result = await api('/api/account/login', {
        method: 'POST',
        body: {
          name,
          phone,
          password,
          passwordProof: await passwordProof(password, name, phone),
          rememberAccount,
          autoLogin
        }
      });
    }

    storeMemberSession(result);
    if (rememberAccount) {
      writeLoginPreference({
        name: result.teacher?.name || name,
        phone: result.teacher?.phone || phone,
        rememberAccount: true,
        autoLogin,
        hasCredential: true
      });
    } else {
      localStorage.removeItem(LOGIN_PREFERENCE_KEY);
    }

    rememberedCredentialActive = false;
    activeView = 'teacher';
    sessionStorage.setItem('activeView', activeView);
    await load();
    await loadTeacherPreferences();
    setView('teacher');
    form.elements.password.value = '';
    toast(automatic ? '已自动登录' : '登录成功');
  } finally {
    setLoginBusy(false);
  }
}

async function changePasswordByIdentity(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  data.oldPasswordProof = await passwordProof(data.oldPassword, data.name, data.phone);
  data.newPasswordProof = await passwordProof(data.newPassword, data.name, data.phone);
  await api('/api/account/password-by-identity', { method: 'POST', body: data });
  invalidateCredentialForIdentity(data.name, data.phone);
  form.reset();
  form.classList.add('hidden');
  toast('密码已修改，请使用新密码登录');
}

function logout() {
  if (adminToken) {
    adminToken = '';
    sessionStorage.removeItem('adminToken');
    ensureGuestSession().then(load).catch(error => toast(error.message));
    return;
  }
  $('#authScreen').classList.remove('hidden');
  $('#appShell').classList.add('hidden');
  $('#unifiedLogin').classList.add('hidden');
  $('#identityPasswordForm').classList.add('hidden');
  $('#adminLogin').classList.remove('hidden');
  return;
}

function legacyLogout() {
  const preference = readLoginPreference();
  if (preference?.rememberAccount) {
    writeLoginPreference({ ...preference, autoLogin: false });
  }
  currentTeacher = null;
  currentAgency = null;
  teacherToken = '';
  agencyToken = '';
  adminToken = '';
  teacherPreferencesLoaded = false;
  clearTimeout(teacherPreferenceSaveTimer);
  state.viewer = null;
  ['teacherUser', 'agencyUser'].forEach(key => localStorage.removeItem(key));
  ['teacherToken', 'agencyToken', 'adminToken', 'activeView'].forEach(key => sessionStorage.removeItem(key));
  $('#appShell').classList.add('hidden');
  $('#authScreen').classList.remove('hidden');
  hydrateLoginForm();
  $('#unifiedLogin').elements.name.focus();
  toast('已退出登录');
}

async function applyOrder(id) {
  const form = $('#applicationForm');
  let profile = {};
  try { profile = JSON.parse(localStorage.getItem(APPLICANT_PROFILE_KEY) || '{}'); } catch {}
  form.elements.orderId.value = id;
  form.elements.name.value = profile.name || '';
  form.elements.contact.value = profile.contact || '';
  form.elements.note.value = '';
  $('#applicationPanel').classList.remove('hidden');
  (form.elements.name.value ? form.elements.note : form.elements.name).focus();
}

async function setStatus(id, status) {
  await api(`/api/orders/${id}`, { method: 'PATCH', body: { status } }, adminToken);
  toast('状态已更新');
  await load();
}

async function setAgencyStatus(id, status) {
  await api(`/api/orders/${id}`, { method: 'PATCH', body: { status } }, agencyToken);
  toast(status === 'closed' ? '订单已下架' : '订单已重新开放');
  await load();
}

async function deleteOrder(id, actor) {
  if (!confirm('确定永久删除这条订单吗？删除后无法恢复。')) return;
  await api(`/api/orders/${id}`, { method: 'DELETE' }, actor === 'admin' ? adminToken : agencyToken);
  toast('订单已删除');
  await load();
}

async function bulkAgencyOrders(action) {
  const orders = state.orders.filter(order => order.agencyId === currentAgency?.id);
  if (!orders.length) return toast('当前没有可处理的订单');
  const deleting = action === 'delete';
  const affected = deleting ? orders.length : orders.filter(order => order.status !== 'closed').length;
  if (!affected) return toast('所有订单都已经下架');
  const message = deleting
    ? `确定永久删除全部 ${affected} 条订单吗？删除后无法恢复。`
    : `确定一键下架 ${affected} 条订单吗？之后仍可逐条重新开放。`;
  if (!confirm(message)) return;
  const result = await api('/api/agency/orders/bulk', { method: 'POST', body: { action } }, agencyToken);
  toast(deleting ? `已删除 ${result.affected} 条订单` : `已下架 ${result.affected} 条订单`);
  await load();
}

function setClipboardAutomationStatus(message, tone = '') {
  const bar = $('.clipboard-automation-bar');
  const status = $('#clipboardAutomationStatus');
  if (!bar || !status) return;
  bar.classList.toggle('processing', tone === 'processing');
  bar.classList.toggle('error', tone === 'error');
  status.textContent = message;
}

async function parseAndImportText(text) {
  const rawText = String(text || '').trim();
  if (!rawText) throw new Error('请先粘贴订单文字');
  const parsed = await api('/api/parse', { method: 'POST', body: { text: rawText } }, agencyToken);
  parsedImport = parsed.parsed || [];
  ignoredImportBlocks = parsed.ignoredBlocks || [];
  renderPreview();
  if (!parsedImport.length) throw new Error('没有识别出可以导入的订单');
  const imported = await api('/api/import', { method: 'POST', body: { orders: parsedImport } }, agencyToken);
  mergeCreatedOrders(imported.created || []);
  scheduleBackgroundStateRefresh();
  return { imported, parsedCount: parsedImport.length };
}

async function pollClipboardInbox() {
  if (clipboardBridgeUnavailable) return;
  const enabled = $('#clipboardAutomationEnabled')?.checked;
  if (!enabled) {
    setClipboardAutomationStatus('自动接收已暂停');
    return;
  }
  if (!currentAgency || !agencyToken) {
    setClipboardAutomationStatus('登录后会自动处理采集器送来的原文');
    return;
  }
  if (clipboardBridgeBusy) return;
  clipboardBridgeBusy = true;
  let activeItem = null;
  try {
    const inbox = await api('/api/clipboard/inbox', {}, agencyToken);
    if (!inbox.items?.length) {
      if (inbox.pending) setClipboardAutomationStatus(`有 ${inbox.pending} 条正在等待重试`);
      return;
    }
    for (const item of inbox.items) {
      if (!$('#clipboardAutomationEnabled').checked) break;
      activeItem = item;
      setClipboardAutomationStatus(`已收到剪贴板，正在识别并导入…`, 'processing');
      const textarea = $('#importForm').elements.text;
      const { imported, parsedCount } = await parseAndImportText(item.text);
      textarea.value = item.text;
      await api(`/api/clipboard/${encodeURIComponent(item.captureId)}/complete`, { method: 'POST', body: {
        created: imported.created?.length || 0,
        duplicatesSkipped: imported.duplicatesSkipped || 0
      } }, agencyToken);
      const created = imported.created?.length || 0;
      const skipped = Number(imported.duplicatesSkipped || 0) + Number(imported.incompleteSkipped || 0);
      setClipboardAutomationStatus(created ? `自动导入完成：新增 ${created} 条订单` : `已处理：${skipped || parsedCount} 条重复或无效内容已跳过`);
      toast(created ? `剪贴板已自动导入 ${created} 条` : '剪贴板内容已处理，没有新增订单');
      activeItem = null;
    }
  } catch (error) {
    if (error.status === 404 && !activeItem) {
      clipboardBridgeUnavailable = true;
      setClipboardAutomationStatus('当前公网版本未连接本机剪贴板桥接器；手动粘贴仍可正常使用');
      return;
    }
    if (activeItem?.captureId && error.message === '没有识别出可以导入的订单') {
      await api(`/api/clipboard/${encodeURIComponent(activeItem.captureId)}/complete`, {
        method: 'POST',
        body: { outcome: 'ignored' }
      }, agencyToken).catch(() => {});
      setClipboardAutomationStatus('已忽略非家教单或残缺内容');
      activeItem = null;
      return;
    }
    if (activeItem?.captureId) {
      await api(`/api/clipboard/${encodeURIComponent(activeItem.captureId)}/fail`, {
        method: 'POST',
        body: { error: error.message }
      }, agencyToken).catch(() => {});
    }
    setClipboardAutomationStatus(`自动导入失败，将重试：${error.message}`, 'error');
  } finally {
    clipboardBridgeBusy = false;
  }
}

async function batchDeleteAdminOrders() {
  const orderIds = $$('.admin-order-select:checked', $('#adminOrders')).map(input => input.value);
  if (!orderIds.length) return toast('请先选择要删除的订单');
  if (!confirm(`确定永久删除已选的 ${orderIds.length} 条订单吗？删除后无法恢复。`)) return;
  const result = await api('/api/admin/batch-delete-orders', {
    method: 'POST',
    body: { orderIds }
  }, adminToken);
  toast(`已删除 ${result.deletedOrders} 条订单`);
  await load();
}

async function batchDeleteAdminUsers() {
  const userIds = $$('.admin-user-select:checked', $('#adminUsers'))
    .flatMap(input => input.value.split(','))
    .filter(Boolean);
  const accountCount = $$('.admin-user-select:checked', $('#adminUsers')).length;
  if (!userIds.length) return toast('请先选择要删除的账号');
  const warning = `确定永久删除已选的 ${accountCount} 个账号吗？这些账号发布的订单也会同时删除，操作无法恢复。`;
  if (!confirm(warning)) return;
  const result = await api('/api/admin/batch-delete-users', {
    method: 'POST',
    body: { userIds }
  }, adminToken);
  const orderText = result.deletedOrders ? `，同时删除 ${result.deletedOrders} 条关联订单` : '';
  toast(`已删除 ${result.deletedAccounts} 个账号${orderText}`);
  await load();
}

async function changePassword(role, form) {
  const token = role === 'teacher' ? teacherToken : agencyToken;
  if (!token) return toast(role === 'teacher' ? '请先登录老师账号' : '请先登录中介账号');
  const data = Object.fromEntries(new FormData(form).entries());
  const user = role === 'teacher' ? currentTeacher : currentAgency;
  data.oldPasswordProof = await passwordProof(data.oldPassword, user?.name, user?.phone);
  data.newPasswordProof = await passwordProof(data.newPassword, user?.name, user?.phone);
  await api('/api/account/password', { method: 'POST', body: data }, token);
  invalidateCredentialForIdentity(user?.name, user?.phone);
  form.reset();
  toast('密码已修改');
}

async function resetUserPassword(userId) {
  const user = (state.users || []).find(u => u.id === userId);
  const newPassword = prompt(`给 ${user?.name || '这个账号'} 设置新密码（至少6位）`);
  if (newPassword === null) return;
  if (newPassword.trim().length < 6) return toast('新密码至少需要6位');
  await api('/api/admin/reset-password', { method: 'POST', body: { userId, newPassword: newPassword.trim() } }, adminToken);
  toast('密码已重置，请把新密码告诉对方');
  await load();
}

function coordinatePair(value) {
  const match = String(value || '').match(/^(\d{2,3}(?:\.\d+)?),(\d{1,2}(?:\.\d+)?)$/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function straightLineKm(origin, destination) {
  if (!origin || !destination) return 0;
  const radians = value => value * Math.PI / 180;
  const latitudeDelta = radians(destination[1] - origin[1]);
  const longitudeDelta = radians(destination[0] - origin[0]);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(origin[1])) * Math.cos(radians(destination[1]))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function updateTeacherDistances(form, { silent = false } = {}) {
  const data = Object.fromEntries(new FormData(form).entries());
  const origin = String(data.origin || '').trim();
  if (!origin) return toast('请先填写你的位置');
  routeMode = $('#routeModeSelect').value || 'cycling';
  localStorage.setItem('routeMode', routeMode);
  $('#teacherLocationStatus').textContent = '正在计算直线距离…';
  if (!selectedOriginCoordinates) {
    const result = await api(`/api/location-suggestions?q=${encodeURIComponent(origin)}`);
    selectedOriginCoordinates = result.suggestions?.[0]?.location || '';
  }
  const originPair = coordinatePair(selectedOriginCoordinates);
  if (!originPair) throw new Error('无法识别“我的位置”，请从地点候选中选择');
  await loadOrderMapLocations();
  distanceOverrides = {};
  for (const order of state.orders) {
    const distances = (orderMapLocations.get(order.id) || [])
      .map(coordinatePair)
      .filter(Boolean)
      .map(destination => straightLineKm(originPair, destination))
      .filter(distance => distance > 0);
    if (!distances.length) continue;
    distanceOverrides[order.id] = {
      distanceKm: Math.min(...distances),
      routeMode: '直线'
    };
  }
  teacherOrigin = origin;
  localStorage.setItem('teacherOrigin', origin);
  localStorage.setItem('teacherOriginCoordinates', selectedOriginCoordinates);
  applyDistanceOverrides();
  fillTeacherLocation();
  renderOrders();
  queueTeacherPreferencesSave();
  if (!silent) toast('已按直线距离完成排序');
}

function clearTeacherDistances() {
  teacherOrigin = '';
  distanceOverrides = {};
  localStorage.removeItem('teacherOrigin');
  selectedOriginCoordinates = '';
  localStorage.removeItem('teacherOriginCoordinates');
  fillTeacherLocation();
  queueTeacherPreferencesSave();
  load().catch(err => toast(err.message));
}

function hideLocationSuggestions() {
  const root = $('#originSuggestions');
  root.classList.add('hidden');
  root.innerHTML = '';
}

async function showLocationSuggestions(query) {
  const root = $('#originSuggestions');
  if (String(query || '').trim().length < 2) return hideLocationSuggestions();
  const requestId = ++locationSuggestionRequest;
  const result = await api(`/api/location-suggestions?q=${encodeURIComponent(query.trim())}`);
  if (requestId !== locationSuggestionRequest || $('#teacherOrigin').value.trim() !== query.trim()) return;
  const suggestions = result.suggestions || [];
  root.innerHTML = '';
  for (const suggestion of suggestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion-item';
    button.setAttribute('role', 'option');
    const name = document.createElement('span');
    name.textContent = suggestion.name || suggestion.label;
    const detail = document.createElement('small');
    detail.textContent = [suggestion.district, suggestion.address].filter(Boolean).join(' · ');
    button.append(name, detail);
    button.addEventListener('click', () => {
      $('#teacherOrigin').value = suggestion.value || suggestion.label;
      teacherOrigin = suggestion.value || suggestion.label;
      selectedOriginCoordinates = suggestion.location || '';
      localStorage.setItem('teacherOrigin', teacherOrigin);
      if (selectedOriginCoordinates) localStorage.setItem('teacherOriginCoordinates', selectedOriginCoordinates);
      hideLocationSuggestions();
      $('#teacherLocationStatus').textContent = '正在计算并按直线距离排序…';
      updateTeacherDistances($('#teacherLocationForm'), { silent: true }).catch(error => {
        $('#teacherLocationStatus').textContent = `直线距离计算失败：${error.message}`;
      });
    });
    root.appendChild(button);
  }
  root.classList.toggle('hidden', !suggestions.length);
}

function showLocationSuggestionError(message) {
  const root = $('#originSuggestions');
  root.innerHTML = '';
  const status = document.createElement('div');
  status.className = 'suggestion-status';
  status.setAttribute('role', 'status');
  status.textContent = message || '地点候选加载失败';
  root.appendChild(status);
  root.classList.remove('hidden');
}

function queueLocationSuggestions() {
  clearTimeout(locationSuggestionTimer);
  const query = $('#teacherOrigin').value;
  locationSuggestionTimer = setTimeout(() => {
    showLocationSuggestions(query).catch(error => showLocationSuggestionError(error.message));
  }, 260);
}

function openRawText(encoded) {
  activeRawText = decodeURIComponent(encoded || '');
  $('#rawTextContent').textContent = activeRawText || '这条订单没有保留原文。';
  $('#copyRawText').disabled = !activeRawText;
  $('#rawTextPanel').classList.remove('hidden');
}

function closeRawText() {
  $('#rawTextPanel').classList.add('hidden');
  activeRawText = '';
  $('#rawTextContent').textContent = '';
}

async function copyRawText() {
  if (!activeRawText) return;
  await navigator.clipboard.writeText(activeRawText);
  toast('原文已复制');
}

function openAgencyContact(contact) {
  const name = String(contact?.name || '发单人').trim();
  const phone = String(contact?.phone || '').trim();
  activeAgencyContact = { name, phone };
  $('#agencyContactName').textContent = name;
  $('#agencyContactPhone').textContent = phone || '未填写';
  $('#copyAgencyContact').disabled = !phone;
  $('#contactPanel').classList.remove('hidden');
}

function closeAgencyContact() {
  $('#contactPanel').classList.add('hidden');
}

async function copyAgencyContact() {
  if (!activeAgencyContact?.phone) return;
  await navigator.clipboard.writeText(`${activeAgencyContact.name} ${activeAgencyContact.phone}`);
  toast('联系方式已复制');
}

function openFeedback() {
  $('#feedbackPanel').classList.remove('hidden');
  $('#feedbackButton').classList.add('panel-open');
}

function closeFeedback() {
  $('#feedbackPanel').classList.add('hidden');
  $('#feedbackButton').classList.remove('panel-open', 'scrolling');
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

$$('.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    setView(btn.dataset.view);
    if (btn.dataset.view === 'teacher' && btn.dataset.teacherMode) {
      setTeacherViewMode(btn.dataset.teacherMode);
    }
  });
});

['filterMinPrice', 'filterBike'].forEach(id => {
  $('#' + id).addEventListener('input', () => { renderOrders(); queueTeacherPreferencesSave(); });
  $('#' + id).addEventListener('change', () => { renderOrders(); queueTeacherPreferencesSave(); });
});

$('#teacherFilters').addEventListener('change', event => {
  const input = event.target.closest('input[data-filter-option]');
  if (!input) return;
  const group = input.dataset.filterOption;
  if (input.checked) teacherFilterSelections[group].add(input.value);
  else teacherFilterSelections[group].delete(input.value);
  updateFilterSummary(group);
  renderOrders();
  queueTeacherPreferencesSave();
});

$('#teacherFilters').addEventListener('click', event => {
  const button = event.target.closest('[data-clear-filter]');
  if (!button) return;
  clearFilterGroup(button.dataset.clearFilter);
  renderOrders();
  queueTeacherPreferencesSave();
});

$$('.multi-filter').forEach(details => {
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    $$('.multi-filter').forEach(other => { if (other !== details) other.open = false; });
  });
});

document.addEventListener('click', event => {
  if (event.target.closest('.multi-filter')) return;
  $$('.multi-filter').forEach(details => { details.open = false; });
});

$('#clearTeacherFilters').addEventListener('click', () => {
  Object.keys(teacherFilterSelections).forEach(clearFilterGroup);
  $('#filterMinPrice').value = '';
  $('#filterBike').checked = false;
  renderOrders();
  queueTeacherPreferencesSave();
});

$('#routeModeSelect').addEventListener('change', () => {
  routeMode = $('#routeModeSelect').value || 'cycling';
  localStorage.setItem('routeMode', routeMode);
  fillTeacherLocation();
  queueTeacherPreferencesSave();
  if (activeMapRouteOrderId && teacherViewMode === 'map') {
    showOrderMapStatus(`正在切换为${routeLabels[routeMode]}路线…`);
    focusOrderOnMap(activeMapRouteOrderId).catch(error => showOrderMapStatus(error.message));
  }
});

$('#showAllMapOrders').addEventListener('click', () => {
  showAllOrdersOnMap().catch(error => showOrderMapStatus(error.message));
});

$('#refreshOrdersButton').addEventListener('click', () => {
  refreshOrderList().catch(err => toast(err.message));
});

$('#unifiedLogin').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  await unifiedLogin(form).catch(err => toast(err.message));
});

$('#autoLogin').addEventListener('change', event => {
  if (event.currentTarget.checked) $('#rememberPassword').checked = true;
});

$('#rememberPassword').addEventListener('change', event => {
  if (event.currentTarget.checked) return;
  $('#autoLogin').checked = false;
  clearRememberedPassword($('#unifiedLogin'));
  localStorage.removeItem(LOGIN_PREFERENCE_KEY);
});

['name', 'phone'].forEach(fieldName => {
  $('#unifiedLogin').elements[fieldName].addEventListener('input', () => {
    clearRememberedPassword($('#unifiedLogin'));
  });
});

$('#unifiedLogin').elements.password.addEventListener('focus', event => {
  if (rememberedCredentialActive) event.currentTarget.select();
});

$('#unifiedLogin').elements.password.addEventListener('input', event => {
  if (rememberedCredentialActive && event.currentTarget.value !== REMEMBERED_PASSWORD_MASK) {
    clearRememberedPassword($('#unifiedLogin'), false);
  }
});

$('#identityPasswordForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  await changePasswordByIdentity(form).catch(err => toast(err.message));
});

$('#togglePasswordPanel').addEventListener('click', () => {
  $('#identityPasswordForm').classList.toggle('hidden');
  $('#adminLogin').classList.add('hidden');
});

$('#toggleAdminPanel').addEventListener('click', () => {
  $('#adminLogin').classList.toggle('hidden');
  $('#identityPasswordForm').classList.add('hidden');
});

$$('.close-auth-panel').forEach(button => button.addEventListener('click', () => {
  button.closest('form').classList.add('hidden');
  if (button.closest('form').id === 'adminLogin' && teacherToken && agencyToken) {
    $('#authScreen').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
  }
}));

$('#logoutButton').addEventListener('click', logout);

$('#adminOrders').addEventListener('change', event => {
  if (event.target.matches('.admin-order-select')) updateAdminBulkControls('orders');
});

$('#adminUsers').addEventListener('change', event => {
  if (event.target.matches('.admin-user-select')) updateAdminBulkControls('users');
});

$('#selectAllAdminOrders').addEventListener('change', event => {
  $$('.admin-order-select', $('#adminOrders')).forEach(input => { input.checked = event.currentTarget.checked; });
  updateAdminBulkControls('orders');
});

$('#selectAllAdminUsers').addEventListener('change', event => {
  $$('.admin-user-select', $('#adminUsers')).forEach(input => { input.checked = event.currentTarget.checked; });
  updateAdminBulkControls('users');
});

$('#batchDeleteAdminOrders').addEventListener('click', () => {
  batchDeleteAdminOrders().catch(err => toast(err.message));
});

$('#batchDeleteAdminUsers').addEventListener('click', () => {
  batchDeleteAdminUsers().catch(err => toast(err.message));
});

$('#teacherLocationForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  await updateTeacherDistances(form).catch(err => {
    $('#teacherLocationStatus').textContent = '直线距离计算失败，请重新选择位置。';
    toast(err.message);
  });
});

$('#clearTeacherLocation').addEventListener('click', clearTeacherDistances);

$('#teacherOrigin').addEventListener('input', () => {
  selectedOriginCoordinates = '';
  localStorage.removeItem('teacherOriginCoordinates');
  queueLocationSuggestions();
});
$('#teacherOrigin').addEventListener('focus', queueLocationSuggestions);
document.addEventListener('click', event => {
  if (!event.target.closest('.autocomplete-wrap')) hideLocationSuggestions();
});

$('#orderForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!currentAgency || !agencyToken) return toast('请先进入中介端');
  const data = Object.fromEntries(new FormData(form).entries());
  data.raw = `${data.district} ${data.place} ${data.grade} ${data.subject} ${data.priceText || data.price || ''} ${data.schedule} ${data.gender} ${data.requirements}`;
  data.price = Number(data.price || 0);
  await api('/api/orders', { method: 'POST', body: data }, agencyToken);
  form.reset();
  toast('订单已发布');
  await load();
});

$('#importForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!currentAgency || !agencyToken) return toast('请先进入中介端');
  const button = $('#parseAndImport');
  button.disabled = true;
  button.textContent = '正在识别并导入…';
  try {
    const { imported, parsedCount } = await parseAndImportText(form.text.value);
    const created = imported.created?.length || 0;
    toast(created ? `已识别并导入 ${created} 条` : `已识别 ${parsedCount} 条，没有新增订单`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '识别并导入';
  }
});

$('#closeAllAgencyOrders').addEventListener('click', () => bulkAgencyOrders('close').catch(err => toast(err.message)));
$('#deleteAllAgencyOrders').addEventListener('click', () => bulkAgencyOrders('delete').catch(err => toast(err.message)));

$('#settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  data.maxBikeKm = Number(data.maxBikeKm || 12);
  await api('/api/settings', { method: 'POST', body: data }, adminToken);
  toast('设置已保存');
  await load();
});

$('#announcementForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  data.active = true;
  await api('/api/admin/announcement', { method: 'POST', body: data }, adminToken);
  toast('公告已发布');
  await load();
});

$('#withdrawAnnouncement').addEventListener('click', async () => {
  const form = $('#announcementForm');
  const data = {
    title: form.elements.title.value,
    content: form.elements.content.value,
    active: false
  };
  await api('/api/admin/announcement', { method: 'POST', body: data }, adminToken);
  toast('公告已撤下');
  await load();
});

$('#adminLogin').addEventListener('submit', async event => {
  event.preventDefault();
  const form = document.getElementById('adminLogin');
  if (!form) return toast('没有找到管理端登录框，请刷新页面');
  try {
    const data = Object.fromEntries(new FormData(form).entries());
    data.passwordProof = await passwordProof(data.password, 'admin', '');
    const path = state.adminConfigured ? '/api/admin/login' : '/api/admin/setup';
    const result = await api(path, { method: 'POST', body: data });
    adminToken = result.token;
    sessionStorage.setItem('adminToken', adminToken);
    const passwordInput = document.querySelector('#adminLogin [name="password"]');
    if (passwordInput) passwordInput.value = '';
    toast(state.adminConfigured ? '管理员登录成功' : '管理员密码设置成功');
    await load();
  } catch (err) {
    toast(err.message);
  }
});

$('#contactClose').addEventListener('click', closeAgencyContact);
$('#copyAgencyContact').addEventListener('click', () => copyAgencyContact().catch(err => toast(err.message)));
$('#contactPanel').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeAgencyContact();
});
$('#applicationClose').addEventListener('click', () => $('#applicationPanel').classList.add('hidden'));
$('#applicationPanel').addEventListener('click', event => {
  if (event.target === event.currentTarget) $('#applicationPanel').classList.add('hidden');
});
$('#applicationForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  const orderId = data.orderId;
  delete data.orderId;
  localStorage.setItem(APPLICANT_PROFILE_KEY, JSON.stringify({ name: data.name, contact: data.contact }));
  const result = await api(`/api/orders/${orderId}/apply`, { method: 'POST', body: data }, teacherToken);
  $('#applicationPanel').classList.add('hidden');
  toast(result.alreadyApplied ? '你已经申请过这张订单' : '申请已发送，等待上传者协助联系');
  await load();
});
$('#rawTextClose').addEventListener('click', closeRawText);
$('#copyRawText').addEventListener('click', () => copyRawText().catch(err => toast(err.message)));
$('#rawTextPanel').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeRawText();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#contactPanel').classList.contains('hidden')) closeAgencyContact();
  if (event.key === 'Escape' && !$('#applicationPanel').classList.contains('hidden')) $('#applicationPanel').classList.add('hidden');
  if (event.key === 'Escape' && !$('#rawTextPanel').classList.contains('hidden')) closeRawText();
});

$('#feedbackButton').addEventListener('click', openFeedback);
$('#feedbackButton').addEventListener('mouseenter', () => clearTimeout(feedbackHideTimer));
$('#feedbackButton').addEventListener('mouseleave', () => {
  if (!$('#feedbackPanel').classList.contains('hidden')) return;
  clearTimeout(feedbackHideTimer);
  feedbackHideTimer = setTimeout(() => $('#feedbackButton').classList.remove('scrolling'), 700);
});
$('#feedbackClose').addEventListener('click', closeFeedback);
$('#feedbackForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  await api('/api/feedback', { method: 'POST', body: data });
  form.reset();
  closeFeedback();
  toast('感谢反馈，开发者会查看');
});
window.addEventListener('scroll', () => {
  const button = $('#feedbackButton');
  if (!button || !$('#feedbackPanel').classList.contains('hidden')) return;
  button.classList.add('scrolling');
  clearTimeout(feedbackHideTimer);
  feedbackHideTimer = setTimeout(() => button.classList.remove('scrolling'), 1600);
}, { passive: true });

const clipboardAutomationToggle = $('#clipboardAutomationEnabled');
clipboardAutomationToggle.checked = localStorage.getItem(CLIPBOARD_AUTOMATION_KEY) !== 'off';
clipboardAutomationToggle.addEventListener('change', () => {
  localStorage.setItem(CLIPBOARD_AUTOMATION_KEY, clipboardAutomationToggle.checked ? 'on' : 'off');
  if (clipboardAutomationToggle.checked) pollClipboardInbox().catch(() => {});
  else setClipboardAutomationStatus('自动接收已暂停');
});

async function initializeApp() {
  hydrateLoginForm();
  try {
    await ensureGuestSession();
  } catch (error) {
    // 兼容仍在运行的旧本地后端：公共订单应始终可读，重启后再恢复匿名写入权限。
    if (error.status !== 404) throw error;
    console.warn('匿名浏览器接口尚未加载，当前以只读模式展示共享订单。');
  }
  await load();
  setTeacherViewMode(teacherViewMode);
  if (!teacherPreferencesLoaded) await loadTeacherPreferences();
  await pollClipboardInbox();
}

initializeApp().catch(err => toast(err.message));
setInterval(() => refreshPlatformStats().catch(() => {}), 30000);
setInterval(() => pollClipboardInbox().catch(() => {}), 1800);
window.addEventListener('focus', () => {
  refreshPlatformStats().catch(() => {});
  pollClipboardInbox().catch(() => {});
});
