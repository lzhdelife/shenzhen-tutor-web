let state = { viewer: null, settings: {}, orders: [], orderIssueReports: [], stats: { totalVisits: 0 }, adminStats: { totalVisitors: 0, onlineVisitors: 0, amapUsage: { date: '', total: 0, limited: 0, byEndpoint: {} } }, lists: { districts: [], subjects: [], grades: [] } };
let issueExportDirectoryHandle = null;
const WU_TEACHER_PHONE = ['187', '1937', '1936'].join('');
let currentTeacher = JSON.parse(localStorage.getItem('teacherUser') || 'null');
let currentAgency = JSON.parse(localStorage.getItem('agencyUser') || 'null');
let teacherToken = sessionStorage.getItem('teacherToken') || '';
let agencyToken = sessionStorage.getItem('agencyToken') || '';
let adminToken = sessionStorage.getItem('adminToken') || '';
let parsedImport = [];
let ignoredImportBlocks = [];
let importPreviewHistory = [];
let teacherOrigin = localStorage.getItem('teacherOrigin') || '';
let routeMode = localStorage.getItem('routeMode') || 'cycling';
let distanceOverrides = {};
let activeView = 'teacher';
let locationSuggestionTimer = 0;
let locationSuggestionRequest = 0;
let selectedOriginCoordinates = localStorage.getItem('teacherOriginCoordinates') || '';
let teacherViewMode = 'list';
let orderMap = null;
let orderMapCluster = null;
let orderMapInfoWindow = null;
let orderMapOriginMarker = null;
let orderMapRenderRequest = 0;
let orderMapApi = null;
let orderMapLocations = null;
let orderMapDataRevision = 0;
let orderMapRenderedSignature = '';
let orderMapRouteService = null;
let activeMapRouteOrderId = '';
let orderMapRouteRequest = 0;
let orderMapViewportMode = 'all';
let activeAgencyContact = null;
let activeRawText = '';
let activeApplicationContact = null;
let applicationContactRequest = 0;
let rememberedCredentialActive = false;
let loginBusy = false;
let teacherPreferenceSaveTimer = 0;
let teacherPreferencesLoaded = false;
let ordersRefreshBusy = false;
let privateStateRefreshBusy = false;
let lastStateLoadedAt = 0;
let orderLoadStatusTimer = 0;
let backgroundStateRefreshTimer = 0;
let teacherDistanceRequest = 0;
let visibleOrderLimit = 20;
let focusedListOrderId = '';

const LOGIN_PREFERENCE_KEY = 'tutorPlatformLoginPreference';
const REMEMBERED_PASSWORD_MASK = 'remembered-login';
const GUEST_DEVICE_KEY = 'tutorPlatformGuestDeviceId';
const PUBLISHER_BROWSER_ACCESS_KEY = 'tutorPlatformPublisherBrowserAccess';
const ADMIN_BROWSER_ACCESS_KEY = 'tutorPlatformAdminBrowserAccess';
const BROWSER_PREFERENCES_KEY = 'tutorPlatformBrowserPreferences';
const IMPORT_PREVIEW_HISTORY_KEY = 'importPreviewHistoryV1';
const SUBPAGE_HISTORY_KEY = 'tutorPlatformSubpages';
const SUBPAGE_PANEL_IDS = ['contactPanel', 'applicationPanel', 'rawTextPanel'];
const PRIVATE_STATE_REFRESH_MS = 60 * 1000;
const MAX_IMPORT_PREVIEW_ORDERS = 50;
const NEARBY_DISTANCE_KM = 10;
try {
  const savedPreviewHistory = JSON.parse(sessionStorage.getItem(IMPORT_PREVIEW_HISTORY_KEY) || '[]');
  if (Array.isArray(savedPreviewHistory)) {
    importPreviewHistory = savedPreviewHistory
      .filter(batch => /^[a-zA-Z0-9-]{1,80}$/.test(String(batch?.id || '')) && Array.isArray(batch.orders) && batch.orders.length)
      .map(batch => batch.stage === 'publishing' ? { ...batch, stage: 'interrupted' } : batch);
    parsedImport = importPreviewHistory[0]?.orders || [];
    ignoredImportBlocks = importPreviewHistory[0]?.ignoredBlocks || [];
  }
} catch {
  sessionStorage.removeItem(IMPORT_PREVIEW_HISTORY_KEY);
}
function clientRandomId(prefix = '') {
  const value = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}${value}`;
}

function visibleSubpageIds() {
  return SUBPAGE_PANEL_IDS.filter(id => !document.getElementById(id)?.classList.contains('hidden'));
}

function showSubpage(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel || !panel.classList.contains('hidden')) return;
  history.pushState({ ...history.state, [SUBPAGE_HISTORY_KEY]: [...visibleSubpageIds(), panelId] }, '', location.href);
  panel.classList.remove('hidden');
}

function closeSubpage(panelId, finalize) {
  const stack = Array.isArray(history.state?.[SUBPAGE_HISTORY_KEY]) ? history.state[SUBPAGE_HISTORY_KEY] : [];
  if (stack.at(-1) === panelId) {
    history.back();
    return;
  }
  finalize();
}

function syncSubpagesFromHistory(nextState) {
  const target = new Set(Array.isArray(nextState?.[SUBPAGE_HISTORY_KEY]) ? nextState[SUBPAGE_HISTORY_KEY] : []);
  if (!target.has('rawTextPanel') && !$('#rawTextPanel').classList.contains('hidden')) closeRawText(true);
  if (!target.has('applicationPanel') && !$('#applicationPanel').classList.contains('hidden')) closeApplicationContact(true);
  if (!target.has('contactPanel') && !$('#contactPanel').classList.contains('hidden')) closeAgencyContact(true);
}

const visitorId = localStorage.getItem('tutorPlatformVisitorId') || clientRandomId('visitor-');
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

async function api(path, options = {}, token = '', retryGuestSession = true) {
  const tokenRole = token && token === teacherToken
    ? 'teacher'
    : token && token === agencyToken
      ? 'agency'
      : '';
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
    if (res.status === 401 && tokenRole && retryGuestSession) {
      await ensureGuestSession(true);
      return api(path, options, tokenRole === 'teacher' ? teacherToken : agencyToken, false);
    }
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

function showOrderLoadStatus(title, detail = '', { complete = false } = {}) {
  clearTimeout(orderLoadStatusTimer);
  const root = $('#orderLoadStatus');
  if (!root) return;
  $('#orderLoadTitle').textContent = title;
  $('#orderLoadDetail').textContent = detail;
  root.classList.toggle('complete', complete);
  root.classList.remove('hidden');
}

function finishOrderLoadStatus(detail = '列表已准备好') {
  showOrderLoadStatus(`已加载 ${state.orders.length} 条家教信息`, detail, { complete: true });
  orderLoadStatusTimer = setTimeout(() => $('#orderLoadStatus')?.classList.add('hidden'), 900);
}

function waitForNextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

async function load({ showProgress = false } = {}) {
  if (showProgress) showOrderLoadStatus('正在加载家教信息', '正在从平台获取最新订单…');
  orderMapLocations = null;
  orderMapDataRevision += 1;
  state = await api('/api/state', {}, adminToken || agencyToken || teacherToken);
  if (showProgress) {
    showOrderLoadStatus(`正在加载 ${state.orders.length} 条家教信息`, '数据已获取，正在整理列表…');
  }
  if (adminToken && state.viewer?.role === 'admin') {
    state.adminStats = await api('/api/admin/stats', {}, adminToken);
  }
  applyDistanceOverrides();
  fillSelects();
  fillTeacherLocation();
  renderBadges();
  renderOrders();
  renderPublisherAccess();
  renderAgencyOrders();
  renderAdmin();
  renderPlatformStats();
  renderAdminStats();
  syncShell();
  lastStateLoadedAt = Date.now();
  if (showProgress) await waitForNextPaint();
}

async function refreshPrivateState({ force = false } = {}) {
  const canRefresh = (activeView === 'agency' && agencyToken)
    || (activeView === 'admin' && adminToken);
  if (!canRefresh || privateStateRefreshBusy) return;
  if (!force && Date.now() - lastStateLoadedAt < PRIVATE_STATE_REFRESH_MS) return;
  privateStateRefreshBusy = true;
  try {
    await load();
  } catch (error) {
    console.warn('私有订单刷新失败', error);
  } finally {
    privateStateRefreshBusy = false;
  }
}

function mergeCreatedOrders(created = []) {
  if (!created.length) return;
  const ids = new Set(created.map(order => order.id));
  state.orders = [...created, ...state.orders.filter(order => !ids.has(order.id))];
  orderMapLocations = null;
  orderMapDataRevision += 1;
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
  $('#accountBadge').textContent = isAdmin ? '管理员' : '';
  $('#accountBadge').classList.toggle('hidden', !isAdmin);
  const adminEntry = $('#logoutButton');
  adminEntry.textContent = isAdmin ? '退出管理端' : '⋯';
  adminEntry.classList.toggle('admin-session', isAdmin);
  adminEntry.setAttribute('aria-label', isAdmin ? '退出管理端' : '管理员入口');
  adminEntry.title = isAdmin ? '退出管理端' : '系统管理';
  if (isAdmin) setView('admin');
  else setView(hasMemberSession && ['teacher', 'agency'].includes(activeView) ? activeView : 'teacher');
}

function renderPlatformStats() {
  $$('[data-stat="visits"]').forEach(node => { node.textContent = Number(state.stats?.totalVisits || 0).toLocaleString(); });
}

function renderAdminStats() {
  const total = $('#adminTotalVisitors');
  const online = $('#adminOnlineVisitors');
  if (total) total.textContent = Number(state.adminStats?.totalVisitors || 0).toLocaleString();
  if (online) online.textContent = Number(state.adminStats?.onlineVisitors || 0).toLocaleString();
  const usage = state.adminStats?.amapUsage || {};
  const date = $('#adminAmapDate');
  const usageTotal = $('#adminAmapTotal');
  const poiMonth = $('#adminAmapPoiMonth');
  const baseMonth = $('#adminAmapBaseMonth');
  const limited = $('#adminAmapLimited');
  const list = $('#adminAmapUsage');
  if (date) date.textContent = usage.date ? `统计日期 ${usage.date}` : '';
  if (usageTotal) usageTotal.textContent = Number(usage.total || 0).toLocaleString();
  if (poiMonth) poiMonth.textContent = Number(usage.poiMonth || 0).toLocaleString();
  if (baseMonth) baseMonth.textContent = Number(usage.baseMonth || 0).toLocaleString();
  if (limited) limited.textContent = Number(usage.limited || 0).toLocaleString();
  if (list) {
    const labels = { '/v3/place/text': '地点搜索', '/v3/geocode/geo': '地理编码', '/v5/direction/walking': '步行路线', '/v5/direction/bicycling': '骑行路线', '/v5/direction/driving': '驾车路线', '/v3/direction/transit/integrated': '公交路线' };
    const entries = Object.entries(usage.byEndpoint || {});
    list.innerHTML = entries.length ? entries.map(([endpoint, item]) => {
      const outcomeText = Object.entries(item.outcomes || {}).map(([outcome, count]) => `${outcome === 'success' ? '成功' : outcome === 'rate_limited' ? '限流' : outcome} ${Number(count).toLocaleString()}`).join(' · ');
      return `<div class="amap-usage-row"><strong>${escapeHtml(labels[endpoint] || endpoint)}</strong><span>${Number(item.total || 0).toLocaleString()} 次</span><small>${escapeHtml(outcomeText)}</small></div>`;
    }).join('') : '<div class="form-note">今日暂无高德调用</div>';
  }
}

async function refreshAdminStats() {
  if (!adminToken || state.viewer?.role !== 'admin') return;
  state.adminStats = await api('/api/admin/stats', {}, adminToken);
  renderAdminStats();
}

async function sendPresence() {
  if (document.visibilityState !== 'visible') return;
  await api('/api/presence', { method: 'POST' });
}

async function refreshOrderList() {
  if (ordersRefreshBusy) return;
  const button = $('#refreshOrdersButton');
  ordersRefreshBusy = true;
  button.disabled = true;
  button.classList.add('loading');
  try {
    await load({ showProgress: true });
    if (teacherOrigin) {
      showOrderLoadStatus(`已加载 ${state.orders.length} 条家教信息`, `正在计算 ${state.orders.length} 条订单的直线距离…`);
      await waitForNextPaint();
      await updateTeacherDistances($('#teacherLocationForm'), { silent: true });
    }
    finishOrderLoadStatus(teacherOrigin ? '订单和距离均已更新' : '列表已更新');
    toast('家教单已刷新');
  } catch (error) {
    showOrderLoadStatus('加载失败', '请稍后点击刷新重试');
    throw error;
  } finally {
    ordersRefreshBusy = false;
    button.disabled = false;
    button.classList.remove('loading');
  }
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
  return teacherOrigin ? '直线距离待计算' : '';
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

async function loadTeacherPreferences({ showProgress = false } = {}) {
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_KEY) || '{}'); } catch {}
  if (!Object.keys(preferences).length) {
    preferences = { origin: teacherOrigin, originCoordinates: selectedOriginCoordinates, routeMode };
  }
  applyTeacherPreferences(preferences);
  teacherPreferencesLoaded = true;
  if (teacherOrigin) {
    $('#teacherLocationStatus').textContent = '正在计算直线距离…';
    if (showProgress) {
      showOrderLoadStatus(`已加载 ${state.orders.length} 条家教信息`, `正在计算 ${state.orders.length} 条订单的直线距离…`);
      await waitForNextPaint();
    }
    await updateTeacherDistances($('#teacherLocationForm'), { silent: true }).catch(error => {
      $('#teacherLocationStatus').textContent = `直线距离计算失败：${error.message}`;
    });
  }
  if (showProgress) finishOrderLoadStatus(teacherOrigin ? '订单和距离均已准备好' : '列表已准备好');
}

function fillTeacherLocation() {
  const form = $('#teacherLocationForm');
  if (!form) return;
  form.origin.value = teacherOrigin;
  $('#routeModeSelect').value = routeMode;
  $('#teacherLocationStatus').textContent = '';
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
  return state.orders
    .filter(o => o.status !== 'closed')
    .filter(o => o.teacherVisible !== false)
    .filter(o => !teacherFilterSelections.district.size || teacherFilterSelections.district.has(String(o.district || '').replace(/区$/, '')))
    .filter(o => matchesSelection(subjectBuckets(o), teacherFilterSelections.subject))
    .filter(o => matchesSelection(gradeBuckets(o), teacherFilterSelections.grade))
    .filter(o => !teacherFilterSelections.gender.size || teacherFilterSelections.gender.has(genderBucket(o)))
    .filter(o => !minPrice || (window.TutorOrderScore?.lessonPriceAmount(o) || Number(o.price)) >= minPrice || Number(o.monthly) >= minPrice)
    .filter(o => !onlyRange || (Number(o.distanceKm) > 0 && Number(o.distanceKm) <= NEARBY_DISTANCE_KM))
    .sort((a, b) => {
      const scoreDifference = orderScore(b) - orderScore(a);
      if (scoreDifference) return scoreDifference;
      return Number(a.distanceKm || Number.MAX_SAFE_INTEGER)
        - Number(b.distanceKm || Number.MAX_SAFE_INTEGER);
    });
}

function orderScore(order) {
  return window.TutorOrderScore?.scoreOrder(order) ?? Number(order.score || 0);
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
  let text = compactText(repairCommonOcr(displayFieldValue(value)))
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

function displayFieldValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) value = value.value;
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim()).join('、');
  return ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : '';
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
  const priceUnit = displayFieldValue(o.priceUnit);
  const lessonLabel = window.TutorOrderScore?.lessonPriceLabel(o);
  if (lessonLabel) return lessonLabel;
  const fieldPrice = fieldFromRaw(o.raw, ['老师薪水', '老师课费', '课时价格', '课费报酬', '课费薪酬', '薪酬', '课酬', '薪资', '时薪']);
  let text = cleanDisplayText(fieldPrice || o.priceText || '', 80)
    .replace(/^(?:老师薪水|老师课费|课时价格|课费报酬|课费薪酬|薪酬|课酬|薪资|时薪)\s*[:：]?\s*/, '')
    .split(/(?:学生|学员|老师要求|教员要求|要求|地址|地点|科目|时间)\s*[:：]/)[0]
    .trim();
  if (Number(o.priceMin) && Number(o.priceMax) && Number(o.priceMin) !== Number(o.priceMax) && priceUnit) {
    return `${o.priceMin}-${o.priceMax}元/${priceUnit}`;
  }
  if (Number(o.price) >= 50 && priceUnit) return `${o.price}元/${priceUnit}`;
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
  const studentGender = displayFieldValue(order.studentGender);
  const gender = studentGender ? `；学生：${studentGender}` : '';
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
  const distance = routeText(o);
  return `<div class="detail-grid">
    ${detailItem('价格', priceLabel(o))}
    ${detailItem('位置/距离', `${meta.location}${distance ? `；${distance}` : ''}`)}
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
      <div class="score">${orderScore(o)}分</div>
    </div>
    ${orderDetailMarkup(o, meta)}
    <div class="actions">
      <button data-order-id="${o.id}" onclick="applyOrder('${o.id}')">申请接单</button>
      <button class="secondary" onclick="focusOrderOnMap('${o.id}')">地图导航</button>
      <button class="secondary" onclick="openRawText('${encodedOrderRawText(o)}')">查看原文</button>
      <button class="text-button issue-report-button" onclick="reportPublishedOrderIssue('${o.id}', this)">识别有误</button>
    </div>
  </article>`;
}

function renderOrders({ resetLimit = false } = {}) {
  const list = filteredOrders();
  if (resetLimit) visibleOrderLimit = 20;
  const count = $('#orderCount');
  if (count) count.textContent = `共 ${list.length} 条`;
  const more = $('#orderListMore');
  if (teacherViewMode === 'map') {
    $('#orders').replaceChildren();
    more.classList.add('hidden');
    ensureOrderMapCurrent(list).catch(error => showOrderMapStatus(error.message));
    return;
  }
  let visible = list.slice(0, visibleOrderLimit);
  if (focusedListOrderId && !visible.some(order => order.id === focusedListOrderId)) {
    const focused = list.find(order => order.id === focusedListOrderId);
    if (focused) visible = [focused, ...visible.slice(0, Math.max(0, visibleOrderLimit - 1))];
  }
  $('#orders').innerHTML = visible.length ? visible.map(orderCard).join('') : '<div class="panel">暂时没有符合条件的订单。</div>';
  more.classList.toggle('hidden', visibleOrderLimit >= list.length);
  $('#loadMoreOrders').textContent = `加载更多（${Math.min(visibleOrderLimit, list.length)}/${list.length}）`;
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

function mapOriginPoint() {
  const lnglat = coordinatePair(selectedOriginCoordinates);
  return lnglat ? { lnglat } : null;
}

function syncOrderMapOriginMarker() {
  if (!orderMap || !orderMapApi) return null;
  const origin = mapOriginPoint();
  if (!origin) {
    orderMapOriginMarker?.setMap(null);
    orderMapOriginMarker = null;
    return null;
  }
  const position = new orderMapApi.LngLat(origin.lnglat[0], origin.lnglat[1]);
  if (!orderMapOriginMarker) {
    const marker = document.createElement('div');
    marker.className = 'order-map-origin-marker';
    const dot = document.createElement('span');
    const label = document.createElement('b');
    label.textContent = '我的位置';
    marker.append(dot, label);
    orderMapOriginMarker = new orderMapApi.Marker({
      map: orderMap,
      position,
      content: marker,
      offset: new orderMapApi.Pixel(-14, -14),
      title: '我的位置',
      zIndex: 300
    });
  } else {
    orderMapOriginMarker.setPosition(position);
    orderMapOriginMarker.setMap(orderMap);
  }
  return orderMapOriginMarker;
}

function fitOrderMapPoints(points = []) {
  if (!orderMap || !orderMapApi) return;
  const origin = mapOriginPoint();
  const visiblePoints = origin ? [...points, origin] : [...points];
  if (!visiblePoints.length) return;
  if (visiblePoints.length === 1) {
    orderMap.setZoomAndCenter(15, visiblePoints[0].lnglat);
    return;
  }
  const longitudes = visiblePoints.map(point => Number(point.lnglat[0])).filter(Number.isFinite);
  const latitudes = visiblePoints.map(point => Number(point.lnglat[1])).filter(Number.isFinite);
  if (!longitudes.length || !latitudes.length) return;
  const bounds = new orderMapApi.Bounds(
    new orderMapApi.LngLat(Math.min(...longitudes), Math.min(...latitudes)),
    new orderMapApi.LngLat(Math.max(...longitudes), Math.max(...latitudes))
  );
  orderMap.setBounds(bounds, true, [56, 56, 56, 56]);
}

function applyOrderMapViewport(points = []) {
  if (orderMapViewportMode === 'nearby' && centerOrderMapNearOrigin(0)) return;
  fitOrderMapPoints(points);
}

function scheduleOrderMapFit() {
  window.setTimeout(() => {
    if (teacherViewMode !== 'map' || activeMapRouteOrderId || orderMapRouteService) return;
    applyOrderMapViewport(orderMapPoints(filteredOrders()));
  }, 1400);
}

function orderMapSignature(orders = filteredOrders()) {
  return [
    orderMapDataRevision,
    selectedOriginCoordinates,
    orders.map(order => order.id).join(',')
  ].join('|');
}

function resumeOrderMap() {
  showOrderMapStatus('');
  requestAnimationFrame(() => orderMap?.resize?.());
}

function ensureOrderMapCurrent(orders = filteredOrders()) {
  if (orderMap && orderMapRenderedSignature === orderMapSignature(orders)) {
    resumeOrderMap();
    return Promise.resolve();
  }
  return renderOrderMap(orders);
}

async function renderOrderMap(orders = filteredOrders()) {
  const renderRequest = ++orderMapRenderRequest;
  showOrderMapStatus('正在加载订单地图…');
  const AMap = await loadOrderMapApi();
  if (renderRequest !== orderMapRenderRequest) return;
  await loadOrderMapLocations();
  if (renderRequest !== orderMapRenderRequest) return;
  orderMap ||= new AMap.Map('orderMap', { zoom: 11, center: [114.0579, 22.5431], viewMode: '2D', mapStyle: 'amap://styles/whitesmoke' });
  syncOrderMapOriginMarker();
  if (orderMapCluster) {
    orderMapCluster.setMap(null);
    orderMapCluster = null;
  }
  const points = orderMapPoints(orders);
  if (!points.length) {
    if (renderRequest !== orderMapRenderRequest) return;
    orderMapRenderedSignature = orderMapSignature(orders);
    applyOrderMapViewport(points);
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
  if (renderRequest !== orderMapRenderRequest) return;
  applyOrderMapViewport(points);
  await new Promise(resolve => window.setTimeout(resolve, 420));
  if (renderRequest !== orderMapRenderRequest) return;
  applyOrderMapViewport(points);
  scheduleOrderMapFit();
  orderMapRenderedSignature = orderMapSignature(orders);
  showOrderMapStatus('');
}

function setTeacherViewMode(mode) {
  teacherViewMode = mode === 'map' ? 'map' : 'list';
  $('#teacherFilters').classList.toggle('hidden', teacherViewMode === 'map');
  $('#orders').classList.toggle('hidden', teacherViewMode === 'map');
  $('#orderListMore').classList.toggle('hidden', teacherViewMode === 'map');
  $('#orderMapPanel').classList.toggle('hidden', teacherViewMode !== 'map');
  if (activeView === 'teacher') setView('teacher');
  if (teacherViewMode === 'map') return ensureOrderMapCurrent().catch(error => showOrderMapStatus(error.message));
  renderOrders();
  return Promise.resolve();
}

function focusOrderFromMap(orderId) {
  orderMapInfoWindow?.close();
  focusedListOrderId = orderId;
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
    setTimeout(() => {
      card.classList.remove('highlight');
      focusedListOrderId = '';
    }, 2400);
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
    Number(route.cost) ? { value: `¥${Number(route.cost).toFixed(1)}`, label: '费用' } : null
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

function collectRouteCoordinates(value, result = [], seen = new WeakSet()) {
  if (result.length >= 5000 || value == null) return result;
  if (typeof value === 'string') {
    for (const match of value.matchAll(/(\d{2,3}(?:\.\d+)?),(\d{1,2}(?:\.\d+)?)/g)) {
      const point = [Number(match[1]), Number(match[2])];
      if (point[0] >= 70 && point[0] <= 140 && point[1] >= 0 && point[1] <= 60) result.push(point);
    }
    return result;
  }
  if (typeof value !== 'object') return result;
  const directPoint = mapPointCoordinates(value);
  if (directPoint.length === 2 && directPoint.every(Number.isFinite)) {
    if (directPoint[0] >= 70 && directPoint[0] <= 140 && directPoint[1] >= 0 && directPoint[1] <= 60) result.push(directPoint);
    return result;
  }
  if (seen.has(value)) return result;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => collectRouteCoordinates(item, result, seen));
    return result;
  }
  Object.values(value).forEach(item => collectRouteCoordinates(item, result, seen));
  return result;
}

function routeViewportCoordinates(routeResult, start, destination) {
  const primaryRoute = routeResult?.routes?.[0] || routeResult?.plans?.[0] || routeResult || {};
  const points = [mapPointCoordinates(start), ...collectRouteCoordinates(primaryRoute), mapPointCoordinates(destination)]
    .filter(point => point.length === 2 && point.every(Number.isFinite));
  return [...new Map(points.map(point => [point.map(value => value.toFixed(6)).join(','), point])).values()];
}

function fitOrderMapRoute(points, requestId) {
  if (!orderMap || !orderMapApi || requestId !== orderMapRouteRequest || points.length < 2) return;
  const longitudes = points.map(point => point[0]);
  const latitudes = points.map(point => point[1]);
  const bounds = new orderMapApi.Bounds(
    new orderMapApi.LngLat(Math.min(...longitudes), Math.min(...latitudes)),
    new orderMapApi.LngLat(Math.max(...longitudes), Math.max(...latitudes))
  );
  orderMap.resize?.();
  orderMap.setBounds(bounds, false, [64, 64, 64, 64], 18);
}

async function focusOrderOnMap(orderId) {
  const routeRequest = ++orderMapRouteRequest;
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
  setView('teacher');
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
  const options = { map: orderMap, autoFitView: false, hideMarkers: false };
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
  if (!routeResult || routeRequest !== orderMapRouteRequest) return;
  renderOrderCommuteSummary(routeResult, orderId);
  const routePoints = routeViewportCoordinates(routeResult, start, destination);
  fitOrderMapRoute(routePoints, routeRequest);
  window.setTimeout(() => fitOrderMapRoute(routePoints, routeRequest), 260);
  showOrderMapStatus('');
}

async function showAllOrdersOnMap() {
  orderMapRouteRequest++;
  const visibleOrders = filteredOrders();
  orderMapViewportMode = 'all';
  orderMapInfoWindow?.close();
  orderMapRouteService?.clear?.();
  orderMapRouteService = null;
  activeMapRouteOrderId = '';
  $('#orderMapRouteSummary').classList.add('hidden');
  $('#activeMapRouteHint').textContent = '正在总览当前筛选中的全部订单';
  await ensureOrderMapCurrent(visibleOrders);
  await new Promise(resolve => window.setTimeout(resolve, 420));
  fitOrderMapPoints(orderMapPoints(visibleOrders));
  toast('已显示全部订单位置');
}

function nearbyOrderMapZoom(origin, targetWidthKm = 14) {
  const mapWidth = Math.max(320, Number($('#orderMap')?.clientWidth || 0));
  const latitude = Number(origin.lnglat[1]);
  const metersPerPixelAtZoomZero = 156543.03392 * Math.cos(latitude * Math.PI / 180);
  const zoom = Math.log2((metersPerPixelAtZoomZero * mapWidth) / (targetWidthKm * 1000));
  return Math.max(10, Math.min(18, Math.round(zoom * 10) / 10));
}

function centerOrderMapNearOrigin(animationDuration = 260) {
  const origin = mapOriginPoint();
  if (!origin || !orderMap || !orderMapApi) return false;
  syncOrderMapOriginMarker();
  const center = new orderMapApi.LngLat(origin.lnglat[0], origin.lnglat[1]);
  orderMap.setZoomAndCenter(nearbyOrderMapZoom(origin), center, false, animationDuration);
  return true;
}

async function showNearbyOrdersOnMap() {
  if (!mapOriginPoint()) {
    showOrderMapStatus('请先在“我的位置”中选择地点');
    toast('请先选择“我的位置”');
    $('#teacherOrigin')?.focus();
    $('#teacherLocationForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (!orderMap || !orderMapApi) await renderOrderMap();
  orderMapRouteRequest++;
  orderMapInfoWindow?.close();
  orderMapRouteService?.clear?.();
  orderMapRouteService = null;
  activeMapRouteOrderId = '';
  orderMapViewportMode = 'nearby';
  $('#orderMapRouteSummary').classList.add('hidden');
  $('#activeMapRouteHint').textContent = '正在查看我的位置附近';
  centerOrderMapNearOrigin();
  showOrderMapStatus('');
  toast('已显示我附近的订单');
}

function rawTextForOrder(order = {}) {
  const candidates = [order.raw, order.rawText, order.structured?.rawText, order.requirements?.rawEvidence, order.structured?.requirements?.rawEvidence];
  return candidates.find(value => typeof value === 'string' && value.trim() && value.trim() !== '[object Object]')?.trim() || '';
}

function encodedOrderRawText(order) {
  return encodeURIComponent(rawTextForOrder(order)).replace(/'/g, '%27');
}

function renderAdminAnomalies() {
  const panel = $('#adminAnomalyPanel');
  const root = $('#adminAnomalyOrders');
  const count = $('#adminAnomalyCount');
  if (!panel || !root || !count) return;
  const anomalies = adminToken ? state.orders.filter(order => Array.isArray(order.qualityIssues) && order.qualityIssues.length) : [];
  const groupedReports = new Map();
  for (const report of adminToken && Array.isArray(state.orderIssueReports) ? state.orderIssueReports : []) {
    const current = groupedReports.get(report.targetKey);
    if (current) {
      current.reportCount += 1;
      if (String(report.updatedAt || '') > String(current.updatedAt || '')) Object.assign(current, report, { reportCount: current.reportCount });
    } else groupedReports.set(report.targetKey, { ...report, reportCount: 1 });
  }
  const reports = [...groupedReports.values()];
  panel.classList.toggle('hidden', !anomalies.length && !reports.length);
  count.textContent = anomalies.length || reports.length ? `${anomalies.length + reports.length} 项需要检查` : '';
  const reportMarkup = reports.map(report => {
    const snapshot = report.parsedSnapshot || {};
    const linkedOrder = report.orderId ? state.orders.find(order => order.id === report.orderId) : null;
    const meta = orderDisplayMeta(linkedOrder || snapshot);
    return `<article class="admin-anomaly-row user-reported-issue">
      <div><strong>${escapeHtml(meta.title || '识别预览')}</strong><div class="anomaly-tags"><span>用户反馈</span>${report.reportCount > 1 ? `<span>${report.reportCount} 人反馈</span>` : ''}${report.parserVersion ? `<span>解析器 ${escapeHtml(report.parserVersion)}</span>` : ''}</div></div>
      <div class="actions">
        <button class="secondary" onclick="openRawText('${encodeURIComponent(report.rawText || '').replace(/'/g, '%27')}')">查看原文</button>
        <button class="secondary" onclick="openIssueSnapshot('${encodeURIComponent(JSON.stringify(snapshot, null, 2)).replace(/'/g, '%27')}')">查看识别结果</button>
      </div>
    </article>`;
  }).join('');
  const anomalyMarkup = anomalies.map(order => {
    const meta = orderDisplayMeta(order);
    const canRetryLocation = order.qualityIssues.some(issue => issue.code === 'location_unverified');
    return `<article class="admin-anomaly-row">
      <div><strong>${escapeHtml(meta.title)}</strong><div class="anomaly-tags">${order.qualityIssues.map(issue => `<span>${escapeHtml(issue.label)}</span>`).join('')}</div></div>
      <div class="actions">
        ${canRetryLocation ? `<button class="secondary" onclick="retryAdminOrderLocation('${order.id}', this)">重新识别地点</button>` : ''}
        <button class="secondary" onclick="openRawText('${encodedOrderRawText(order)}')">查看原文</button>
        <button class="danger" onclick="deleteOrder('${order.id}','admin')">删除</button>
      </div>
    </article>`;
  }).join('');
  root.innerHTML = reportMarkup + anomalyMarkup;
}

function exportedIssueReports() {
  const grouped = new Map();
  for (const report of Array.isArray(state.orderIssueReports) ? state.orderIssueReports : []) {
    const current = grouped.get(report.targetKey);
    if (current) {
      current.reportCount += 1;
      current.firstReportedAt = [current.firstReportedAt, report.createdAt].filter(Boolean).sort()[0] || '';
      current.lastReportedAt = [current.lastReportedAt, report.updatedAt].filter(Boolean).sort().at(-1) || '';
    } else grouped.set(report.targetKey, {
      raw: report.rawText || '',
      parsed: report.parsedSnapshot || {},
      parserVersion: report.parserVersion || '',
      source: report.source || '',
      reportCount: 1,
      firstReportedAt: report.createdAt || '',
      lastReportedAt: report.updatedAt || ''
    });
  }
  return [...grouped.values()];
}

function issueReportContent(reports, format) {
  return format === 'txt'
    ? reports.map((report, index) => [
        `# ${index + 1} · 反馈 ${report.reportCount} 次 · 解析器 ${report.parserVersion || '未知'}`,
        '【原文】', report.raw, '', '【识别结果】', JSON.stringify(report.parsed, null, 2)
      ].join('\n')).join('\n\n========================================\n\n')
    : reports.map(report => JSON.stringify(report)).join('\n');
}

function downloadIssueReportFile(content, format) {
  const blob = new Blob([content], { type: format === 'txt' ? 'text/plain;charset=utf-8' : 'application/x-ndjson;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `order-parser-issues.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function saveIssueReportFiles(files) {
  if (typeof window.showDirectoryPicker !== 'function') {
    for (const file of files) downloadIssueReportFile(file.content, file.format);
    return false;
  }
  let directory = issueExportDirectoryHandle;
  if (directory && typeof directory.queryPermission === 'function') {
    let permission = await directory.queryPermission({ mode: 'readwrite' });
    if (permission === 'prompt') permission = await directory.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') directory = null;
  }
  if (!directory) {
    directory = await window.showDirectoryPicker({ id: 'order-parser-issues', mode: 'readwrite' });
    issueExportDirectoryHandle = directory;
  }
  for (const file of files) {
    const handle = await directory.getFileHandle(file.name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(file.content);
    } finally {
      await writable.close();
    }
  }
  return true;
}

async function exportAndClearIssueReports(button) {
  const reports = exportedIssueReports();
  if (!reports.length) return toast('还没有用户反馈');
  const sourceReports = Array.isArray(state.orderIssueReports) ? [...state.orderIssueReports] : [];
  const exportedRefs = sourceReports.map(report => ({ id: report.id, updatedAt: report.updatedAt })).filter(report => report.id && report.updatedAt);
  if (!exportedRefs.length) return toast('反馈记录缺少导出标识，请刷新后重试');
  if (button) button.disabled = true;
  try {
    const files = [
      { name: 'order-parser-issues.txt', format: 'txt', content: issueReportContent(reports, 'txt') },
      { name: 'order-parser-issues.jsonl', format: 'jsonl', content: issueReportContent(reports, 'jsonl') }
    ];
    const overwritten = await saveIssueReportFiles(files);
    const result = await api('/api/admin/order-issues/clear-exported', {
      method: 'POST', body: { reports: exportedRefs }
    }, adminToken);
    await load();
    toast(`${overwritten ? 'TXT 和 JSONL 已保存并覆盖同名文件' : 'TXT 和 JSONL 已下载'}，已清理 ${Number(result.deletedReports || 0)} 条反馈`);
  } catch (error) {
    if (error?.name === 'AbortError') toast('已取消导出，反馈没有清理');
    else toast(`导出未完成，反馈没有清理：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function openIssueSnapshot(encoded) {
  showRawText(decodeURIComponent(encoded || ''));
}

function renderPublisherAccess() {
  const gate = $('#publisherGate');
  const workspace = $('#publisherWorkspace');
  const form = $('#publisherAccessForm');
  const title = $('#publisherGateTitle');
  const message = $('#publisherGateMessage');
  if (!gate || !workspace || !form || !title || !message) return;
  const phoneButton = $('#wuTeacherPhone');
  if (phoneButton) phoneButton.textContent = WU_TEACHER_PHONE;

  const access = state.publisherAccess || null;
  const approved = access?.status === 'approved';
  if (approved) localStorage.setItem(PUBLISHER_BROWSER_ACCESS_KEY, 'approved');
  gate.classList.toggle('hidden', approved);
  workspace.classList.toggle('hidden', !approved);
  if (approved) {
    window.setTimeout(scheduleManualImportQueue, 0);
    return;
  }

  const pending = access?.status === 'pending';
  form.classList.toggle('hidden', pending);
  if (pending) {
    title.textContent = '申请审核中';
    message.textContent = '请添加吴老师沟通，审核通过后即可发单。';
    return;
  }

  title.textContent = access?.status === 'rejected' ? '重新申请发单权限' : '申请发单权限';
  message.textContent = access?.status === 'rejected'
    ? '本次申请暂未通过。请联系吴老师沟通后重新提交。'
    : '首次使用需审核；已通过的联系方式可直接进入。';
  form.elements.displayName.value = access?.displayName || '';
  form.elements.contact.value = access?.contact || '';
}

function renderAdminPublisherRequests() {
  const root = $('#adminPublisherRequests');
  const count = $('#adminPublisherCount');
  if (!root || !count) return;
  const requests = adminToken && Array.isArray(state.publisherRequests) ? state.publisherRequests : [];
  const pendingCount = requests.filter(item => item.status === 'pending').length;
  count.textContent = pendingCount ? `${pendingCount} 条待审核` : '';
  root.innerHTML = requests.length ? requests.map(item => {
    const statusText = item.status === 'approved' ? '已批准' : item.status === 'rejected' ? '已拒绝' : '待审核';
    return `<article class="publisher-request-row">
      <div class="publisher-request-info">
        <strong>${escapeHtml(item.displayName || '未填写称呼')}</strong>
        <button class="publisher-contact-copy" type="button" data-copy-contact="${escapeHtml(item.contact || '')}" title="点击复制联系方式">${escapeHtml(item.contact || '未填写联系方式')}</button>
        <small>${item.requestedAt ? new Date(item.requestedAt).toLocaleString() : ''}</small>
      </div>
      <span class="publisher-status ${escapeHtml(item.status || 'pending')}">${statusText}</span>
      <div class="actions">
        ${item.status !== 'approved' ? `<button class="primary" type="button" data-publisher-review="approved" data-user-id="${escapeHtml(item.userId)}">批准</button>` : ''}
        ${item.status !== 'rejected' ? `<button class="secondary" type="button" data-publisher-review="rejected" data-user-id="${escapeHtml(item.userId)}">拒绝</button>` : ''}
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">目前没有发单申请。</div>';
}

function renderAdmin() {
  const root = $('#adminOrders');
  if (!adminToken) {
    root.innerHTML = '';
    renderAdminPublisherRequests();
    renderAdminAnomalies();
    updateAdminBulkControls();
    return;
  }
  root.innerHTML = state.orders.length ? state.orders.map(o => {
    const meta = orderDisplayMeta(o);
    return `<article class="card admin-order-card">
      <div class="card-head">
        <div>
          <div class="title">${escapeHtml(meta.title)}</div>
          <div class="source-line">${escapeHtml(cleanDisplayText(o.source || '', 28) || '平台订单')} · ${new Date(o.createdAt).toLocaleString()}</div>
        </div>
        <div class="score">${orderScore(o)}分</div>
      </div>
      ${orderDetailMarkup(o, meta)}
      <div class="actions admin-card-actions">
        <label class="selection-check admin-card-select">
          <input class="admin-order-select" type="checkbox" value="${escapeHtml(o.id)}" aria-label="选择订单 ${escapeHtml(meta.title)}">
          <span>选择</span>
        </label>
        <button class="danger" onclick="deleteOrder('${o.id}','admin')">删除</button>
      </div>
    </article>`;
  }).join('') : '<div class="empty-state">目前没有订单。</div>';
  renderAdminPublisherRequests();
  renderAdminAnomalies();
  updateAdminBulkControls();
}

function updateAdminBulkControls() {
  const root = $('#adminOrders');
  const selectAll = $('#selectAllAdminOrders');
  const deleteButton = $('#batchDeleteAdminOrders');
  const countLabel = $('#adminOrderSelectionCount');
  if (!root || !selectAll || !deleteButton || !countLabel) return;
  const boxes = $$('.admin-order-select', root);
  const selected = boxes.filter(box => box.checked);
  selectAll.disabled = !boxes.length;
  selectAll.checked = Boolean(boxes.length && selected.length === boxes.length);
  selectAll.indeterminate = selected.length > 0 && selected.length < boxes.length;
  deleteButton.disabled = selected.length === 0;
  countLabel.textContent = `已选 ${selected.length} 条`;
}

function renderAgencyOrders() {
  const root = $('#agencyOrders');
  const deleteAllButton = $('#deleteAllAgencyOrders');
  if (!currentAgency || !agencyToken) {
    root.innerHTML = '<div class="raw">正在恢复这个浏览器的发单记录…</div>';
    deleteAllButton.disabled = true;
    return;
  }
  const orders = state.orders.filter(o => o.agencyId === currentAgency.id);
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
        <button class="danger" onclick="deleteOrder('${o.id}','agency')">删除</button>
      </div>
    </div>`;
  }).join('') : '<div class="raw">这个浏览器还没有发布订单。</div>';
}

function statusLabel(status) {
  return ({ open: '开放中', matched: '已成交', closed: '已下架' })[status] || status || '开放中';
}

function previewCard(o, index, batchId = '') {
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
    ${candidates.length ? `<div class="raw">${o.locationStatus === 'defaulted' ? '已默认选择第一项，可改：' : '地点待确认：'}${candidates.map((candidate, candidateIndex) => `<button type="button" class="secondary" onclick="selectPreviewLocationCandidate('${batchId}',${index},${candidateIndex})">${escapeHtml([candidate.district, candidate.name].filter(Boolean).join('·'))}</button>`).join(' ')}</div>` : ''}
    ${optionCandidates.map(item => `<div class="raw">${escapeHtml(item.label)}待确认：${item.candidates.map((candidate, candidateIndex) => `<button type="button" class="secondary" onclick="selectPreviewLocationOptionCandidate('${batchId}',${index},${item.optionIndex},${candidateIndex})">${escapeHtml([candidate.district, candidate.name].filter(Boolean).join('·'))}</button>`).join(' ')}</div>`).join('')}
    ${evidenceRows.length ? `<details class="parse-evidence"><summary>解析证据与置信度</summary>${evidenceRows.map(([label, field]) => `<div><strong>${escapeHtml(label)}</strong> ${(Number(field.confidence || 0) * 100).toFixed(0)}%：${escapeHtml(field.rawEvidence)}</div>`).join('')}</details>` : ''}
    ${uncertainFields.length ? `<div class="parse-warning">导入前请确认：${escapeHtml(uncertainFields.join('、'))}</div>` : ''}
    <details class="parse-evidence"><summary>订单原文（导入时保留）</summary><div>${escapeHtml(o.raw || structured.rawText || '')}</div></details>
    ${notes ? `<div class="raw">${escapeHtml(notes)}</div>` : ''}
    <div class="actions"><button class="text-button issue-report-button" onclick="reportPreviewIssue('${batchId}',${index},this)">识别有误</button></div>
  </div>`;
}

async function submitIssueReport(body, button) {
  if (button?.disabled) return;
  if (button) { button.disabled = true; button.textContent = '提交中…'; }
  try {
    const token = body.orderId ? teacherToken : agencyToken;
    await api('/api/order-issues', { method: 'POST', body }, token);
    if (button) button.textContent = '已反馈';
    toast('已反馈，订单继续保留');
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = '识别有误'; }
    toast(error.message);
  }
}

function reportPublishedOrderIssue(orderId, button) {
  return submitIssueReport({ orderId }, button);
}

function reportPreviewIssue(batchId, orderIndex, button) {
  const order = previewBatchById(batchId)?.orders?.[orderIndex];
  if (!order) return toast('这条识别结果已不存在');
  return submitIssueReport({ raw: order.raw || order.structured?.rawText || '', parsedSnapshot: order,
    parserVersion: order.structured?.parserVersion || order.parserVersion || '' }, button);
}

function previewBatchById(batchId) {
  return importPreviewHistory.find(batch => batch.id === batchId);
}

function selectPreviewLocationCandidate(batchId, orderIndex, candidateIndex) {
  const order = previewBatchById(batchId)?.orders?.[orderIndex];
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
  saveImportPreviewHistory();
  renderPreview();
}

function selectPreviewLocationOptionCandidate(batchId, orderIndex, optionIndex, candidateIndex) {
  const order = previewBatchById(batchId)?.orders?.[orderIndex];
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
  saveImportPreviewHistory();
  renderPreview();
}

function trimImportPreviewHistory() {
  let remaining = MAX_IMPORT_PREVIEW_ORDERS;
  importPreviewHistory = importPreviewHistory.flatMap(batch => {
    if (remaining <= 0) return [];
    batch.orders = batch.orders.slice(0, remaining);
    remaining -= batch.orders.length;
    return batch.orders.length ? [batch] : [];
  });
}

function saveImportPreviewHistory() {
  trimImportPreviewHistory();
  try {
    sessionStorage.setItem(IMPORT_PREVIEW_HISTORY_KEY, JSON.stringify(importPreviewHistory));
  } catch {
    // Very large source text can exceed browser storage; keep the current in-memory history.
  }
}

function previewBatchSummary(batch) {
  const total = batch.orders.length;
  if (batch.stage === 'publishing') return `识别 ${total} 条 · 正在发布`;
  if (batch.stage === 'interrupted') return `识别 ${total} 条 · 结果已保留`;
  if (batch.stage === 'failed') return `识别 ${total} 条 · 发布暂时失败`;
  const created = Number(batch.outcome?.created || 0);
  const duplicates = Number(batch.outcome?.duplicates || 0);
  return [`识别 ${total} 条`, created ? `发布 ${created} 条` : '', duplicates ? `重复 ${duplicates} 条` : ''].filter(Boolean).join(' · ');
}

function renderPreview() {
  const clearButton = $('#clearImportHistory');
  if (clearButton) clearButton.classList.toggle('hidden', !importPreviewHistory.length);
  $('#parsePreview').innerHTML = importPreviewHistory.length
    ? importPreviewHistory.map(batch => {
        const ignoredCount = batch.ignoredBlocks?.length || 0;
        const time = new Date(batch.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<section class="preview-batch">
          <div class="preview-batch-heading"><strong>${escapeHtml(previewBatchSummary(batch))}</strong><span>${escapeHtml(time)}</span></div>
          ${ignoredCount ? `<div class="parse-warning">过滤 ${ignoredCount} 段无效内容</div>` : ''}
          ${batch.orders.map((order, index) => previewCard(order, index, batch.id)).join('')}
        </section>`;
      }).join('')
    : '<div class="import-preview-empty"></div>';
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

async function restorePublisherBrowserSession() {
  if (localStorage.getItem(PUBLISHER_BROWSER_ACCESS_KEY) !== 'approved') return false;
  if (teacherToken && agencyToken && currentTeacher && currentAgency) return true;
  try {
    const result = await api('/api/account/remember-login', { method: 'POST', body: {} });
    storeMemberSession(result);
    return true;
  } catch {
    return false;
  }
}

async function restoreAdminBrowserSession() {
  if (localStorage.getItem(ADMIN_BROWSER_ACCESS_KEY) !== 'remembered') return false;
  if (adminToken) return true;
  try {
    const result = await api('/api/admin/remember-login', { method: 'POST', body: {} });
    adminToken = result.token;
    sessionStorage.setItem('adminToken', adminToken);
    return true;
  } catch {
    return false;
  }
}

function guestDeviceId() {
  let value = localStorage.getItem(GUEST_DEVICE_KEY) || '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    value = clientRandomId('browser_');
    localStorage.setItem(GUEST_DEVICE_KEY, value);
  }
  return value;
}

async function ensureGuestSession(force = false) {
  if (!force && teacherToken && agencyToken && currentTeacher && currentAgency) return;
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

function openApplicationContact(result) {
  activeApplicationContact = result;
  const publisherName = String(result.publisher?.name || '发单人').trim();
  const publisherContact = String(result.publisher?.contact || '').trim();
  const adminContact = String(result.admin?.contact || WU_TEACHER_PHONE).trim();
  $('#applicationPublisherName').textContent = publisherName;
  $('#applicationPublisherContact').textContent = publisherContact || '暂无联系方式';
  $('#applicationPublisherContact').disabled = !publisherContact;
  $('#applicationAdminContact').textContent = adminContact;
  $('#applicationAdminContact').disabled = !adminContact;
  $('#applicationViewRaw').disabled = !result.raw;
  $('#applicationCopyRaw').disabled = !result.raw;
  showSubpage('applicationPanel');
  $('#applicationViewRaw').focus();
}

function openApplicationContactLoading() {
  activeApplicationContact = null;
  $('#applicationPublisherName').textContent = '正在获取';
  $('#applicationPublisherContact').textContent = '请稍候';
  $('#applicationPublisherContact').disabled = true;
  $('#applicationAdminContact').textContent = WU_TEACHER_PHONE;
  $('#applicationAdminContact').disabled = false;
  $('#applicationViewRaw').disabled = true;
  $('#applicationCopyRaw').disabled = true;
  showSubpage('applicationPanel');
  $('#applicationClose').focus();
}

function closeApplicationContact(fromHistory = false) {
  const finalize = () => {
    applicationContactRequest += 1;
    $('#applicationPanel').classList.add('hidden');
  };
  if (fromHistory) finalize();
  else closeSubpage('applicationPanel', finalize);
}

async function applyOrder(id) {
  const request = ++applicationContactRequest;
  openApplicationContactLoading();
  try {
    const result = await api(`/api/orders/${id}/contact`, {}, teacherToken);
    if (request !== applicationContactRequest) return;
    openApplicationContact(result);
  } catch (error) {
    if (request !== applicationContactRequest) return;
    $('#applicationPublisherName').textContent = '获取失败';
    $('#applicationPublisherContact').textContent = '请稍后重试';
    toast(error.message);
  }
}

async function deleteOrder(id, actor) {
  if (!confirm('确定永久删除这条订单吗？删除后无法恢复。')) return;
  await api(`/api/orders/${id}`, { method: 'DELETE' }, actor === 'admin' ? adminToken : agencyToken);
  toast('订单已删除');
  await load();
}

async function retryAdminOrderLocation(id, button) {
  const originalText = button?.textContent || '重新识别地点';
  if (button) {
    button.disabled = true;
    button.textContent = '正在识别…';
  }
  try {
    const order = await api(`/api/admin/orders/${id}/location/retry`, { method: 'POST' }, adminToken);
    toast(`已识别：${[order.district ? `${order.district}区` : '', order.place].filter(Boolean).join('·')}`);
    await load();
  } catch (error) {
    toast(error.message);
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function deleteAllAgencyOrders() {
  const orders = state.orders.filter(order => order.agencyId === currentAgency?.id);
  if (!orders.length) return toast('当前没有可处理的订单');
  if (!confirm(`确定永久删除全部 ${orders.length} 条订单吗？删除后无法恢复。`)) return;
  const result = await api('/api/agency/orders/bulk', { method: 'POST', body: { action: 'delete' } }, agencyToken);
  toast(`已删除 ${result.affected} 条订单`);
  await load();
}

async function submitPublisherAccess(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api('/api/publisher-access', { method: 'POST', body: data }, agencyToken);
    if (result.recognized && result.agencyToken && result.agency) {
      agencyToken = result.agencyToken;
      currentAgency = result.agency;
      localStorage.setItem('agencyUser', JSON.stringify(currentAgency));
      sessionStorage.setItem('agencyToken', agencyToken);
      localStorage.setItem(PUBLISHER_BROWSER_ACCESS_KEY, 'approved');
      toast('发单身份已恢复');
      await load();
      return;
    }
    state.publisherAccess = result.access;
    renderPublisherAccess();
    toast('申请已提交');
  } finally {
    button.disabled = false;
  }
}

async function reviewPublisherAccess(userId, status) {
  const result = await api(`/api/admin/publisher-access/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: { status }
  }, adminToken);
  state.publisherRequests = (state.publisherRequests || []).map(item => item.userId === userId ? result.access : item);
  renderAdminPublisherRequests();
  toast(status === 'approved' ? '已批准发单权限' : '已拒绝发单权限');
}

async function parseAndImportText(text, onStage = () => {}) {
  const rawText = String(text || '').trim();
  if (!rawText) throw new Error('请先粘贴订单文字');
  onStage({ stage: 'parsing' });
  const parsed = await api('/api/parse', { method: 'POST', body: { text: rawText } }, agencyToken);
  parsedImport = parsed.parsed || [];
  ignoredImportBlocks = parsed.ignoredBlocks || [];
  if (!parsedImport.length) throw new Error('没有识别出可以导入的订单');
  const previewBatch = {
    id: clientRandomId('preview-'),
    createdAt: Date.now(),
    stage: 'publishing',
    orders: parsedImport,
    ignoredBlocks: ignoredImportBlocks,
    outcome: null
  };
  importPreviewHistory.unshift(previewBatch);
  saveImportPreviewHistory();
  renderPreview();
  onStage({ stage: 'publishing', total: parsedImport.length, ignored: ignoredImportBlocks.length });
  try {
    const imported = await api('/api/import', { method: 'POST', body: { orders: parsedImport } }, agencyToken);
    previewBatch.stage = 'complete';
    previewBatch.outcome = {
      created: imported.created?.length || 0,
      duplicates: Number(imported.duplicatesSkipped || 0),
      incomplete: Number(imported.incompleteSkipped || 0)
    };
    saveImportPreviewHistory();
    renderPreview();
    mergeCreatedOrders(imported.created || []);
    scheduleBackgroundStateRefresh();
    return { imported, parsedCount: parsedImport.length, ignoredCount: ignoredImportBlocks.length };
  } catch (error) {
    previewBatch.stage = 'failed';
    saveImportPreviewHistory();
    renderPreview();
    throw error;
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
  const requestId = ++teacherDistanceRequest;
  const data = Object.fromEntries(new FormData(form).entries());
  const origin = String(data.origin || '').trim();
  if (!origin) return toast('请先填写你的位置');
  routeMode = $('#routeModeSelect').value || 'cycling';
  localStorage.setItem('routeMode', routeMode);
  $('#teacherLocationStatus').textContent = '正在计算直线距离…';
  let originCoordinates = selectedOriginCoordinates;
  if (!originCoordinates) {
    const result = await api(`/api/location-suggestions?q=${encodeURIComponent(origin)}`);
    originCoordinates = result.suggestions?.[0]?.location || '';
  }
  if (requestId !== teacherDistanceRequest) return;
  const originPair = coordinatePair(originCoordinates);
  if (!originPair) throw new Error('无法识别“我的位置”，请从地点候选中选择');
  await loadOrderMapLocations();
  if (requestId !== teacherDistanceRequest) return;
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
  selectedOriginCoordinates = originCoordinates;
  localStorage.setItem('teacherOrigin', origin);
  localStorage.setItem('teacherOriginCoordinates', selectedOriginCoordinates);
  applyDistanceOverrides();
  fillTeacherLocation();
  renderOrders();
  queueTeacherPreferencesSave();
  if (!silent) toast('已按直线距离完成排序');
}

function clearTeacherDistances() {
  teacherDistanceRequest++;
  teacherOrigin = '';
  distanceOverrides = {};
  localStorage.removeItem('teacherOrigin');
  selectedOriginCoordinates = '';
  localStorage.removeItem('teacherOriginCoordinates');
  $('#filterBike').checked = false;
  $('#teacherLocationStatus').textContent = '';
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
  }, 120);
}

function showRawText(rawText) {
  activeRawText = String(rawText || '');
  $('#rawTextContent').textContent = activeRawText || '这条订单没有保留原文。';
  $('#copyRawText').disabled = !activeRawText;
  showSubpage('rawTextPanel');
}

function openRawText(encoded) {
  showRawText(decodeURIComponent(encoded || ''));
}

function closeRawText(fromHistory = false) {
  const finalize = () => {
    $('#rawTextPanel').classList.add('hidden');
    activeRawText = '';
    $('#rawTextContent').textContent = '';
  };
  if (fromHistory) finalize();
  else closeSubpage('rawTextPanel', finalize);
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
  showSubpage('contactPanel');
}

function closeAgencyContact(fromHistory = false) {
  const finalize = () => $('#contactPanel').classList.add('hidden');
  if (fromHistory) finalize();
  else closeSubpage('contactPanel', finalize);
}

async function copyAgencyContact() {
  if (!activeAgencyContact?.phone) return;
  await navigator.clipboard.writeText(`${activeAgencyContact.name} ${activeAgencyContact.phone}`);
  toast('联系方式已复制');
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

$$('.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view === 'admin') {
      setView('admin');
      refreshPrivateState({ force: true });
      return;
    }
    if (btn.dataset.view === 'agency') {
      setView('agency');
      refreshPrivateState({ force: true });
      return;
    }
    setView('teacher');
    setTeacherViewMode(btn.dataset.teacherMode === 'map' ? 'map' : 'list');
  });
});

['filterMinPrice'].forEach(id => {
  $('#' + id).addEventListener('input', () => { renderOrders({ resetLimit: true }); queueTeacherPreferencesSave(); });
  $('#' + id).addEventListener('change', () => { renderOrders({ resetLimit: true }); queueTeacherPreferencesSave(); });
});

$('#filterBike').addEventListener('change', event => {
  if (event.currentTarget.checked && !selectedOriginCoordinates) {
    event.currentTarget.checked = false;
    toast('请先选择“我的位置”');
    $('#teacherOrigin').focus();
  }
  renderOrders({ resetLimit: true });
  queueTeacherPreferencesSave();
});

$('#teacherFilters').addEventListener('change', event => {
  const input = event.target.closest('input[data-filter-option]');
  if (!input) return;
  const group = input.dataset.filterOption;
  if (input.checked) teacherFilterSelections[group].add(input.value);
  else teacherFilterSelections[group].delete(input.value);
  updateFilterSummary(group);
  renderOrders({ resetLimit: true });
  queueTeacherPreferencesSave();
});

$('#teacherFilters').addEventListener('click', event => {
  const button = event.target.closest('[data-clear-filter]');
  if (!button) return;
  clearFilterGroup(button.dataset.clearFilter);
  renderOrders({ resetLimit: true });
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
  renderOrders({ resetLimit: true });
  queueTeacherPreferencesSave();
});

$('#loadMoreOrders').addEventListener('click', () => {
  visibleOrderLimit += 20;
  renderOrders();
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

$('#showNearbyMapOrders').addEventListener('click', () => {
  showNearbyOrdersOnMap().catch(error => showOrderMapStatus(error.message));
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

$('#publisherAccessForm')?.addEventListener('submit', event => {
  event.preventDefault();
  submitPublisherAccess(event.currentTarget).catch(error => toast(error.message));
});

$('#wuTeacherPhone')?.addEventListener('click', () => {
  navigator.clipboard.writeText(WU_TEACHER_PHONE)
    .then(() => toast('吴老师手机号已复制'))
    .catch(() => toast('复制失败，请手动复制'));
});

$('#adminPublisherRequests')?.addEventListener('click', event => {
  const copyButton = event.target.closest('[data-copy-contact]');
  if (copyButton) {
    const contact = copyButton.dataset.copyContact || '';
    if (!contact) return;
    navigator.clipboard.writeText(contact)
      .then(() => toast('联系方式已复制'))
      .catch(() => toast('复制失败，请手动复制'));
    return;
  }
  const button = event.target.closest('[data-publisher-review]');
  if (!button) return;
  button.disabled = true;
  reviewPublisherAccess(button.dataset.userId, button.dataset.publisherReview)
    .catch(error => toast(error.message))
    .finally(() => { button.disabled = false; });
});

$('#adminOrders').addEventListener('change', event => {
  if (event.target.matches('.admin-order-select')) updateAdminBulkControls();
});

$('#selectAllAdminOrders').addEventListener('change', event => {
  $$('.admin-order-select', $('#adminOrders')).forEach(input => { input.checked = event.currentTarget.checked; });
  updateAdminBulkControls();
});

$('#batchDeleteAdminOrders').addEventListener('click', () => {
  batchDeleteAdminOrders().catch(err => toast(err.message));
});

$('#teacherLocationForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  await updateTeacherDistances(form).catch(err => {
    $('#teacherLocationStatus').textContent = '直线距离计算失败，请重新选择位置。';
    toast(err.message);
  });
});

$('#teacherOrigin').addEventListener('input', () => {
  if (!$('#teacherOrigin').value.trim()) {
    hideLocationSuggestions();
    clearTeacherDistances();
    return;
  }
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

const MANUAL_IMPORT_QUEUE_KEY = 'manualImportQueueV1';
const MAX_MANUAL_IMPORT_BYTES = 2 * 1024 * 1024;
const MANUAL_IMPORT_EVENT_DEDUPE_MS = 30000;

function manualImportFingerprint(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

let manualImportQueue = [];
try {
  const savedQueue = JSON.parse(sessionStorage.getItem(MANUAL_IMPORT_QUEUE_KEY) || '[]');
  if (Array.isArray(savedQueue)) {
    const seen = new Set();
    manualImportQueue = savedQueue.filter(item => {
      const fingerprint = manualImportFingerprint(item?.text);
      if (!fingerprint || seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
  }
} catch {}
let manualImportBusy = false;
let manualImportRetryTimer = 0;
let manualImportClearTimer = 0;
let manualImportTypingTimer = 0;
let manualImportClearGeneration = 0;
let manualImportActiveFingerprint = '';
let lastManualPasteEvent = { text: '', at: 0 };
const recentManualImportFingerprints = new Map(manualImportQueue.map(item => [manualImportFingerprint(item.text), Date.now()]));

function clearManualImportTextarea() {
  manualImportClearGeneration++;
  window.clearTimeout(manualImportClearTimer);
  window.clearTimeout(manualImportTypingTimer);
  manualImportClearTimer = 0;
  manualImportTypingTimer = 0;
  const textarea = $('#importForm')?.elements.text;
  if (textarea) textarea.value = '';
}

function showPastedTextBriefly(textarea, rawText) {
  const clearGeneration = ++manualImportClearGeneration;
  window.clearTimeout(manualImportClearTimer);
  textarea.value = rawText;
  manualImportClearTimer = window.setTimeout(() => {
    if (clearGeneration === manualImportClearGeneration) textarea.value = '';
    manualImportClearTimer = 0;
  }, 320);
}

function saveManualImportQueue() {
  try {
    if (manualImportQueue.length) sessionStorage.setItem(MANUAL_IMPORT_QUEUE_KEY, JSON.stringify(manualImportQueue));
    else sessionStorage.removeItem(MANUAL_IMPORT_QUEUE_KEY);
  } catch {
    sessionStorage.removeItem(MANUAL_IMPORT_QUEUE_KEY);
  }
}

function setManualImportStatus(message, tone = '') {
  const status = $('#importInputStatus');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function scheduleManualImportQueue() {
  if (manualImportBusy || !manualImportQueue.length) return;
  window.clearTimeout(manualImportRetryTimer);
  const now = Date.now();
  const nextAttemptAt = Math.min(...manualImportQueue.map(item => Number(item.nextAttemptAt || 0)));
  if (nextAttemptAt > now) {
    manualImportRetryTimer = window.setTimeout(processManualImportQueue, Math.min(nextAttemptAt - now, 30000));
    return;
  }
  processManualImportQueue().catch(error => {
    manualImportBusy = false;
    setManualImportStatus(`队列处理异常：${error.message}`, 'error');
  });
}

async function processManualImportQueue() {
  if (manualImportBusy || !manualImportQueue.length) return;
  if (state.publisherAccess?.status !== 'approved') return;
  if (!currentAgency || !agencyToken) {
    setManualImportStatus(`已保留 ${manualImportQueue.length} 批，等待网站连接`, 'error');
    manualImportRetryTimer = window.setTimeout(scheduleManualImportQueue, 3000);
    return;
  }
  const now = Date.now();
  const readyIndex = manualImportQueue.findIndex(item => Number(item.nextAttemptAt || 0) <= now);
  if (readyIndex < 0) return scheduleManualImportQueue();
  const [item] = manualImportQueue.splice(readyIndex, 1);
  saveManualImportQueue();
  manualImportBusy = true;
  manualImportActiveFingerprint = manualImportFingerprint(item.text);
  clearManualImportTextarea();
  const remainingBatches = () => manualImportQueue.length ? `，队列中还有 ${manualImportQueue.length} 批` : '';
  try {
    const { imported, parsedCount, ignoredCount } = await parseAndImportText(item.text, progress => {
      if (progress.stage === 'parsing') {
        setManualImportStatus(`正在切割并识别本批内容${remainingBatches()}`, 'processing');
      }
      if (progress.stage === 'publishing') {
        const ignored = progress.ignored ? `，已过滤 ${progress.ignored} 段无效内容` : '';
        setManualImportStatus(`已识别 ${progress.total} 条订单${ignored}；正在处理地点并发布${remainingBatches()}`, 'processing');
      }
    });
    const created = imported.created?.length || 0;
    const duplicates = Number(imported.duplicatesSkipped || 0);
    const outcome = [
      created ? `成功发布 ${created} 条` : '',
      duplicates ? `跳过重复 ${duplicates} 条` : '',
      ignoredCount ? `过滤无效内容 ${ignoredCount} 段` : ''
    ].filter(Boolean).join('，') || `已识别 ${parsedCount} 条，没有新增订单`;
    setManualImportStatus(`${outcome}${remainingBatches()}`, 'success');
    toast(created ? `成功发布 ${created} 条订单` : '内容已处理，没有新增订单');
  } catch (error) {
    if (error.message === '没有识别出可以导入的订单') {
      const incompleteMessage = item.source === '输入内容'
        ? '输入的信息不完整，请直接粘贴'
        : '没有识别出完整家教单，请检查后重新输入';
      setManualImportStatus(`${incompleteMessage}${manualImportQueue.length ? `；还有 ${manualImportQueue.length} 批` : ''}`, 'muted');
      toast(incompleteMessage);
    } else {
      item.attempts = Number(item.attempts || 0) + 1;
      item.nextAttemptAt = Date.now() + Math.min(30000, 1500 * (2 ** Math.min(item.attempts, 4)));
      manualImportQueue.push(item);
      saveManualImportQueue();
      setManualImportStatus(`识别暂时失败，已保留 ${manualImportQueue.length} 批等待重试`, 'error');
    }
  } finally {
    manualImportBusy = false;
    manualImportActiveFingerprint = '';
    scheduleManualImportQueue();
  }
}

function enqueueManualImport(text, source = '粘贴内容', showPastedText = false) {
  const rawText = String(text || '').trim();
  if (!rawText) {
    setManualImportStatus('没有可识别的文字', 'error');
    toast('没有可识别的文字');
    return false;
  }
  if (new TextEncoder().encode(rawText).byteLength > MAX_MANUAL_IMPORT_BYTES) {
    setManualImportStatus('内容超过 2 MB，请拆分后再导入', 'error');
    toast('内容超过 2 MB，请拆分后再导入');
    return false;
  }
  const fingerprint = manualImportFingerprint(rawText);
  const now = Date.now();
  for (const [key, acceptedAt] of recentManualImportFingerprints) {
    if (now - acceptedAt > MANUAL_IMPORT_EVENT_DEDUPE_MS) recentManualImportFingerprints.delete(key);
  }
  const alreadyQueued = manualImportQueue.some(item => manualImportFingerprint(item.text) === fingerprint);
  const activeDuplicate = manualImportActiveFingerprint === fingerprint;
  const duplicateEvent = alreadyQueued || activeDuplicate
    || now - Number(recentManualImportFingerprints.get(fingerprint) || 0) <= MANUAL_IMPORT_EVENT_DEDUPE_MS;
  if (duplicateEvent) {
    const textarea = $('#importForm')?.elements.text;
    if (showPastedText && textarea && !activeDuplicate) {
      textarea.value = rawText;
      if (!manualImportClearTimer) showPastedTextBriefly(textarea, rawText);
      setManualImportStatus('已粘贴成功，内容已在识别队列中', 'queued');
    } else {
      clearManualImportTextarea();
    }
    return false;
  }
  recentManualImportFingerprints.set(fingerprint, now);
  manualImportQueue.push({ id: clientRandomId('import-'), text: rawText, source, attempts: 0, nextAttemptAt: Date.now() + 180 });
  saveManualImportQueue();
  const textarea = $('#importForm')?.elements.text;
  if (textarea) {
    if (showPastedText) showPastedTextBriefly(textarea, rawText);
    else clearManualImportTextarea();
    textarea.classList.remove('queue-flash');
    void textarea.offsetWidth;
    textarea.classList.add('queue-flash');
    window.setTimeout(() => textarea.classList.remove('queue-flash'), 520);
  }
  const queuedCount = manualImportQueue.length + (manualImportBusy ? 1 : 0);
  setManualImportStatus(source === '粘贴内容'
    ? `已粘贴成功，已加入识别队列，等待切割（共 ${queuedCount} 批）`
    : `${source}已加入识别队列，等待切割（共 ${queuedCount} 批）`, 'queued');
  toast(source === '粘贴内容' ? '已粘贴成功' : `${source}已加入识别队列`);
  scheduleManualImportQueue();
  return true;
}

const importTextarea = $('#importForm')?.elements.text;
function scheduleTextareaImport(delay, source, showPastedText = false) {
  window.clearTimeout(manualImportTypingTimer);
  manualImportTypingTimer = window.setTimeout(() => {
    manualImportTypingTimer = 0;
    const text = importTextarea?.value || '';
    if (text.trim()) enqueueManualImport(text, source, showPastedText);
  }, delay);
}
$('#importForm')?.addEventListener('submit', event => {
  event.preventDefault();
  enqueueManualImport(importTextarea?.value);
});
importTextarea?.addEventListener('paste', event => {
  const text = event.clipboardData?.getData('text/plain') || '';
  if (!text.trim()) return;
  window.clearTimeout(manualImportTypingTimer);
  lastManualPasteEvent = { text, at: Date.now() };
  enqueueManualImport(text, '粘贴内容', true);
  event.preventDefault();
});
importTextarea?.addEventListener('input', event => {
  const text = importTextarea.value;
  const recentPaste = Date.now() - lastManualPasteEvent.at < 1000;
  const insertedAtOnce = ['insertFromPaste', 'insertFromYank', 'insertReplacementText'].includes(event.inputType)
    || recentPaste
    || String(event.data || '').trim().length > 4
    || (event.data == null && text.trim().length > 4);
  if (insertedAtOnce && text.trim()) scheduleTextareaImport(120, '粘贴内容', true);
  else if (text) scheduleTextareaImport(800, '输入内容');
});
importTextarea?.addEventListener('change', () => {
  if (importTextarea.value.trim()) scheduleTextareaImport(120, '粘贴内容', true);
});
async function importTxtFile(file) {
  if (!file) return;
  if (!/\.txt$/i.test(file.name)) {
    setManualImportStatus('请选择 TXT 文档', 'error');
    return toast('请选择 TXT 文档');
  }
  if (file.size > MAX_MANUAL_IMPORT_BYTES) {
    setManualImportStatus('TXT 超过 2 MB，请拆分后再导入', 'error');
    return toast('TXT 超过 2 MB，请拆分后再导入');
  }
  try {
    enqueueManualImport(await file.text(), file.name);
  } catch {
    setManualImportStatus('TXT 读取失败，请重新选择', 'error');
    toast('TXT 读取失败，请重新选择');
  }
}

$('#txtImportInput')?.addEventListener('change', event => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = '';
  importTxtFile(file).catch(error => toast(error.message));
});
const txtDropZone = $('#txtDropZone');
for (const eventName of ['dragenter', 'dragover']) {
  txtDropZone?.addEventListener(eventName, event => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    txtDropZone.classList.add('is-dragging');
  });
}
for (const eventName of ['dragleave', 'dragend']) {
  txtDropZone?.addEventListener(eventName, () => txtDropZone.classList.remove('is-dragging'));
}
txtDropZone?.addEventListener('drop', event => {
  event.preventDefault();
  txtDropZone.classList.remove('is-dragging');
  importTxtFile(event.dataTransfer?.files?.[0]).catch(error => toast(error.message));
});
$('#clearImportHistory')?.addEventListener('click', () => {
  importPreviewHistory = [];
  parsedImport = [];
  ignoredImportBlocks = [];
  sessionStorage.removeItem(IMPORT_PREVIEW_HISTORY_KEY);
  renderPreview();
});
scheduleManualImportQueue();

$('#deleteAllAgencyOrders').addEventListener('click', () => deleteAllAgencyOrders().catch(err => toast(err.message)));

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
    localStorage.setItem(ADMIN_BROWSER_ACCESS_KEY, 'remembered');
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
$('#applicationClose').addEventListener('click', closeApplicationContact);
$('#applicationPanel').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeApplicationContact();
});
$('#applicationViewRaw').addEventListener('click', () => {
  if (activeApplicationContact?.raw) showRawText(activeApplicationContact.raw);
});
$('#applicationCopyRaw').addEventListener('click', () => {
  const raw = activeApplicationContact?.raw || '';
  if (!raw) return;
  navigator.clipboard.writeText(raw)
    .then(() => toast('原文已复制'))
    .catch(() => toast('复制失败，请手动复制'));
});
$('#applicationPublisherContact').addEventListener('click', () => {
  const contact = activeApplicationContact?.publisher?.contact || '';
  if (!contact) return;
  navigator.clipboard.writeText(contact)
    .then(() => toast('发单人联系方式已复制'))
    .catch(() => toast('复制失败，请手动复制'));
});
$('#applicationAdminContact').addEventListener('click', () => {
  const contact = activeApplicationContact?.admin?.contact || WU_TEACHER_PHONE;
  navigator.clipboard.writeText(contact)
    .then(() => toast('吴老师手机号已复制'))
    .catch(() => toast('复制失败，请手动复制'));
});
$('#rawTextClose').addEventListener('click', closeRawText);
$('#copyRawText').addEventListener('click', () => copyRawText().catch(err => toast(err.message)));
$('#rawTextPanel').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeRawText();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!$('#rawTextPanel').classList.contains('hidden')) closeRawText();
  else if (!$('#applicationPanel').classList.contains('hidden')) closeApplicationContact();
  else if (!$('#contactPanel').classList.contains('hidden')) closeAgencyContact();
});
window.addEventListener('popstate', event => syncSubpagesFromHistory(event.state));

async function initializeApp() {
  hydrateLoginForm();
  await api('/api/visit', { method: 'POST' }).catch(() => {});
  await sendPresence().catch(() => {});
  try {
    const adminRestored = await restoreAdminBrowserSession();
    if (!adminRestored) {
      await restorePublisherBrowserSession();
      await ensureGuestSession();
    }
  } catch (error) {
    // 兼容仍在运行的旧本地后端：公共订单应始终可读，重启后再恢复匿名写入权限。
    if (error.status !== 404) throw error;
    console.warn('匿名浏览器接口尚未加载，当前以只读模式展示共享订单。');
  }
  await load({ showProgress: true });
  renderPreview();
  setTeacherViewMode('list');
  if (!adminToken && !teacherPreferencesLoaded) await loadTeacherPreferences({ showProgress: true });
}

initializeApp().catch(err => {
  showOrderLoadStatus('加载失败', '请检查网络后点击刷新重试');
  toast(err.message);
});
setInterval(() => {
  sendPresence().catch(() => {});
  refreshAdminStats().catch(() => {});
}, 30000);
window.addEventListener('focus', () => {
  sendPresence().catch(() => {});
  refreshAdminStats().catch(() => {});
  refreshPrivateState();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshPrivateState();
});
