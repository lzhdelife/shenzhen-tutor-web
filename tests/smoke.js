'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const platform = require('../TutorPlatform/server.js');
const { summarizeScheduleText } = require('../TutorPlatform/public/schedule-format.js');
const { lessonPriceLabel, lessonPriceAmount } = require('../TutorPlatform/public/order-score.js');

const browserAppSource = fs.readFileSync(path.join(__dirname, '..', 'TutorPlatform', 'public', 'app.js'), 'utf8');
const browserStylesSource = fs.readFileSync(path.join(__dirname, '..', 'TutorPlatform', 'public', 'styles.css'), 'utf8');
const browserHtmlSource = fs.readFileSync(path.join(__dirname, '..', 'TutorPlatform', 'public', 'index.html'), 'utf8');
const passwordFallbackSource = fs.readFileSync(path.join(__dirname, '..', 'TutorPlatform', 'public', 'password-proof-fallback.js'), 'utf8');
assert.match(browserHtmlSource, /id="toggleOrderSearch"/,
  'order list should expose the secondary keyword-search control');
assert.match(browserAppSource, /searchTokens\.every\(token => searchable\.includes\(token\)\)/,
  'keyword search should require every entered token to match');
assert.match(browserAppSource, /function clientRandomId\(/, 'mobile browsers need a randomUUID fallback');
assert.doesNotMatch(browserAppSource, /\bid:\s*crypto\.randomUUID\(\)/, 'mobile import IDs must not require crypto.randomUUID');
assert.match(browserAppSource, /typeof crypto !== 'undefined' && crypto\.subtle/,
  'admin login should tolerate browsers without Web Crypto');
assert.match(browserAppSource, /password-proof-fallback\.js/,
  'limited webviews should load the password-proof fallback on demand');
assert.doesNotMatch(browserHtmlSource, /password-proof-fallback\.js/,
  'normal page loads should not download the password-proof fallback');
const fallbackContext = { TextEncoder };
vm.runInNewContext(passwordFallbackSource, fallbackContext);
const fallbackPassword = 'fallback-test-password';
const fallbackSalt = 'shenzhen-tutor-v1|admin|';
assert.deepEqual(
  Buffer.from(fallbackContext.TutorPasswordProof.derive(fallbackPassword, fallbackSalt, 210000)),
  crypto.pbkdf2Sync(fallbackPassword, fallbackSalt, 210000, 32, 'sha256'),
  'fallback password proof should exactly match native PBKDF2'
);
assert.match(browserAppSource, /teacherFilters'\)\.classList\.toggle\('hidden', teacherViewMode === 'map'\)/,
  'map view should hide the list-only filter toolbar');
assert.match(browserAppSource, /restorePublisherBrowserSession\(\)/,
  'approved publisher access should be restored when the browser is reopened');
assert.match(browserAppSource, /restoreAdminBrowserSession\(\)/,
  'admin access should be restored when the browser is reopened');
assert.doesNotMatch(browserAppSource, /removeItem\(ADMIN_BROWSER_ACCESS_KEY\)/,
  'leaving the admin view should preserve browser-level admin access');
assert.match(browserAppSource, /const PRIVATE_STATE_REFRESH_MS = 60 \* 1000;/,
  'private order refreshes should be throttled to protect the server');
assert.match(browserAppSource, /activeView === 'agency' && agencyToken[\s\S]*activeView === 'admin' && adminToken/,
  'automatic order refreshes should be limited to publisher and admin views');
assert.match(browserAppSource, /history\.pushState\(\{ \.\.\.history\.state, \[SUBPAGE_HISTORY_KEY\]/,
  'mobile subpages should create a browser history entry');
assert.match(browserAppSource, /window\.addEventListener\('popstate', event => syncSubpagesFromHistory\(event\.state\)\)/,
  'browser back should close the active subpage before leaving the site');
assert.doesNotMatch(browserAppSource, /label: '可选方案'/,
  'transit route cards should omit the redundant alternative count');
assert.match(browserStylesSource, /@media \(max-width: 980px\)[\s\S]*grid-template-areas: "controls" "map" "summary";/,
  'phone and tablet map controls should appear between the location form and map');
assert.match(browserStylesSource, /@media \(max-width: 980px\)[\s\S]*\.order-map-panel \{ overflow: visible; border: 0; border-radius: 0; background: transparent; \}/,
  'phone and tablet map controls and map should use separate visual layers');
assert.match(browserStylesSource, /@media \(prefers-color-scheme: dark\)[\s\S]*--card: #232a29;/,
  'dark mode should use a distinct card color instead of relying on borders');
assert.match(browserStylesSource, /\.card,[\s\S]*background: var\(--card\); color: var\(--ink\);/,
  'dark repeated cards should use the raised card layer');
assert.doesNotMatch(browserStylesSource, /\.order-list \.card\.order-seen\s*\{[^}]*\bfilter\s*:/,
  'seen-order styling must not dim interactive buttons through a card-wide filter');
assert.doesNotMatch(browserStylesSource, /\.order-list \.card\.order-seen \.score\s*\{[^}]*color\s*:/,
  'seen-order styling must keep the score badge contrast intact');
assert.doesNotMatch(browserAppSource, /IntersectionObserver|SEEN_ORDER_DELAY_MS/,
  'orders must not be marked as seen merely because they were scrolled into view');
assert.match(browserAppSource, /function openRawText\(encoded, orderId = ''\)\s*\{\s*markOrderSeen\(orderId\)/,
  'opening raw order text should mark that order as seen');
assert.match(browserAppSource, /async function applyOrder\(id\)\s*\{\s*markOrderSeen\(id\)/,
  'requesting order contact details should mark that order as seen');
assert.match(browserAppSource, /const canDelete = Boolean\(currentAgency && agencyToken && o\.agencyId === currentAgency\.id\)/,
  'the list issue menu should expose deletion only to the publishing identity');
assert.match(browserAppSource, /canDelete \? `deleteOrder\('\$\{o\.id\}','agency'\)` : ''/,
  'an owned list order should use the owner-protected delete endpoint');
assert.doesNotMatch(browserHtmlSource, /id="orderForm"|manual-entry-panel|手动录入/,
  'the redundant manual order form should not be shown');
assert.doesNotMatch(browserAppSource, /\$\('#orderForm'\)/,
  'removed manual order form should have no event handlers');

const sample = `【L 南山区后海地铁站高二数学】
【学生】女生，基础巩固
【时间】下周开始，一周2次，每次2小时
【薪酬】300/2h
【要求】女老师，有高中教学经验

【L 宝安区西乡地铁站初三物理】
【学生】男生，查漏补缺
【时间】暑假，一周3次，晚上上课，每次2小时
【薪酬】160元/小时
【要求】男女不限，有责任心`;

const blocks = platform.splitImportBlocks(sample);
assert.equal(blocks.length, 2, 'synthetic text should split into two orders');

const orders = blocks.map(raw => platform.parseOrder(raw, '匿名测试机构', 'test-agency'));
assert.equal(orders[0].district, '南山');
assert.match(orders[0].place, /后海/);
assert.equal(orders[0].grade, '高二');
assert.equal(orders[0].subject, '数学');
assert.equal(orders[0].price, 150);
assert.equal(orders[0].gender, '女老师');

assert.equal(orders[1].district, '宝安');
assert.match(orders[1].place, /西乡/);
assert.equal(orders[1].grade, '初三');
assert.equal(orders[1].subject, '物理');
assert.equal(orders[1].price, 160);
assert.equal(orders[1].gender, '不限');

const onlineOrder = platform.parseOrder('网课，新高一数学，200元/小时，每周两次，需要有经验老师', '匿名测试机构', 'test-agency');
assert.equal(onlineOrder.district, '线上');
assert.equal(onlineOrder.place, '线上授课');
assert.equal(onlineOrder.address, '线上授课');
assert.equal(onlineOrder.locationStatus, 'online');
assert.equal(onlineOrder.locationVerified, true);
assert.equal(onlineOrder.locationQuery, '');

const explicitOnlineOrder = platform.parseOrder('深圳南山区学生，线上辅导初二英语，240元/2小时', '匿名测试机构', 'test-agency');
assert.equal(explicitOnlineOrder.district, '线上', 'explicit online teaching should override a physical district mention');

const decorativeSeparatorOrder = platform.parseOrder(`深圳26071759
地址》宝安区共和花园
学员★高二女
科目★物理
情况★基础薄弱，查漏补缺
时间★一周1次，一次2个小时，周日上午
要求★女在职老师，普通话标准，有经验认真负责
报酬:330一个小时`, '匿名测试机构', 'test-agency');
assert.equal(decorativeSeparatorOrder.district, '宝安');
assert.equal(decorativeSeparatorOrder.place, '共和花园');
assert.equal(decorativeSeparatorOrder.grade, '高二');
assert.equal(decorativeSeparatorOrder.subject, '物理');
assert.equal(decorativeSeparatorOrder.price, 330);
assert.equal(decorativeSeparatorOrder.gender, '女老师');

const yantianOrder = platform.parseOrder('盐田墟初三刚毕业女生，需要一位数学老师，带孩子把初三知识点查漏补缺并提前熟悉高一内容，课费500一次，上课时间，暑假开始每周周一周三周五早8点，开学后周末一次', '匿名测试机构', 'test-agency');
assert.equal(yantianOrder.district, '盐田');
assert.equal(yantianOrder.place, '盐田墟');
assert.equal(yantianOrder.studentGender, '女');
assert.equal(yantianOrder.gender, '');
assert.equal(yantianOrder.subject, '数学');
assert.equal(yantianOrder.price, 500);
assert.equal(yantianOrder.priceUnit, '次');
assert.equal(yantianOrder.gradeDescription, '初三毕业，复习初三并预习高一');
assert.match(yantianOrder.schedule, /暑假.*周一周三周五.*开学.*周末/);

const liutangOrder = platform.parseOrder('S215916【高二物理宝安西乡】流塘高二男，基础一般想提高成绩，暑假连续上课，开学周末，800-1000元2小时，要求专业家教老师，想要前10大', '匿名测试机构', 'test-agency');
assert.equal(liutangOrder.district, '宝安');
assert.match(liutangOrder.place, /西乡/);
assert.match(liutangOrder.place, /流塘/);
assert.match(liutangOrder.locationQuery, /深圳市宝安区.*西乡.*流塘/);
assert.equal(liutangOrder.grade, '高二');
assert.equal(liutangOrder.subject, '物理');
assert.equal(liutangOrder.studentGender, '男');
assert.equal(liutangOrder.gender, '');
assert.equal(liutangOrder.priceMin, 800);
assert.equal(liutangOrder.priceMax, 1000);
assert.equal(liutangOrder.priceUnit, '2小时');
assert.match(liutangOrder.schedule, /暑假连续上课.*开学周末/);

const alternativeLocationOrder = platform.parseOrder(`【Z深圳市南山区颐城栖湾里或宝安会展附近准小四语数英】
【学生】女孩，基础薄弱双语学校
【次数】暑假七月中旬开始大概15-20次课，周内上课2h/次
【薪酬】400左右/次
【要求】年轻女老师，有经验`, '匿名测试机构', 'test-agency');
assert.equal(alternativeLocationOrder.locationRelation, 'OR');
assert.equal(alternativeLocationOrder.locationOptions.length, 2);
assert.deepEqual(alternativeLocationOrder.locationOptions.map(option => option.district), ['南山', '宝安']);
assert.match(alternativeLocationOrder.locationOptions[0].place, /颐城栖湾里/);
assert.equal(alternativeLocationOrder.locationOptions[1].place, '深圳国际会展中心附近');
assert.equal(alternativeLocationOrder.locationOptions[1].nearby, true);
assert.equal(alternativeLocationOrder.price, 400);
assert.equal(alternativeLocationOrder.priceUnit, '次');
assert.equal(alternativeLocationOrder.priceApproximate, true);
assert.equal(alternativeLocationOrder.grade, '四年级');
assert.equal(alternativeLocationOrder.subject, '语文/数学/英语');
assert.equal(alternativeLocationOrder.studentGender, '女');
assert.equal(alternativeLocationOrder.gender, '女老师');

const huaideOrder = platform.parseOrder('高二 男 语数英。后续可能考虑再加历政地 中等，艺术生 暑假一次2小时，隔天上一次。开学之后周6上一次，一次3小时 深大或者哈工大，老师要负责的 宝安区12号线福永怀德地铁站 120一小时', '匿名测试机构', 'test-agency');
assert.equal(huaideOrder.district, '宝安');
assert.equal(huaideOrder.area, '福永');
assert.equal(huaideOrder.place, '福永·怀德地铁站');
assert.equal(huaideOrder.transitLine, '12号线');
assert.deepEqual(huaideOrder.locationQueries, ['深圳市宝安区福永怀德地铁站', '深圳地铁12号线怀德站', '怀德地铁站']);
assert.equal(huaideOrder.grade, '高二');
assert.equal(huaideOrder.studentGender, '男');
assert.equal(huaideOrder.subject, '语文/数学/英语');
assert.equal(huaideOrder.optionalSubjects, '历史/政治/地理');
assert.equal(huaideOrder.studentLevel, '中等');
assert.equal(huaideOrder.studentType, '艺术生');
assert.equal(huaideOrder.price, 120);
assert.equal(huaideOrder.priceUnit, '小时');
assert.equal(huaideOrder.gender, '');
assert.match(huaideOrder.teacherRequirement, /深大或哈工大.*负责/);
const huaideSchedule = summarizeScheduleText(huaideOrder.schedule);
assert.match(huaideSchedule.count, /暑假隔天1次，每次2小时；开学后每周六1次，每次3小时/);

const singleLineAlternatives = platform.parseOrder('【Z深圳市南山区颐城栖湾里或宝安会展附近准小四语数英】【学生】女孩，基础薄弱双语学校【次数】暑假七月中旬开始大概15-20次课，周内上课2h/次【薪酬】400左右/次【要求】年轻女老师，有经验', '匿名测试机构', 'test-agency');
assert.equal(singleLineAlternatives.schedule, '暑假七月中旬开始大概15-20次课，周内上课2h/次');
assert.equal(singleLineAlternatives.price, 400);
assert.equal(singleLineAlternatives.gender, '女老师');

const schedule = summarizeScheduleText('下周开始，一周2次，晚上上课，每次2小时');
assert.equal(schedule.start, '下周开始');
assert.match(schedule.count, /一周2次/);
assert.match(schedule.slot, /晚上/);
const phasedSchedule = summarizeScheduleText(yantianOrder.schedule);
assert.match(phasedSchedule.count, /暑假每周一、三、五；开学后每周末1次/);
assert.match(phasedSchedule.slot, /早8点/);

const syntheticPhone = ['138', '0013', '8000'].join('');
assert.equal(platform.validMainlandPhone(syntheticPhone), true);
assert.equal(platform.validMainlandPhone(syntheticPhone + syntheticPhone), false);
assert.equal(platform.sanitizeRouteMode('walking'), 'walking');
assert.equal(platform.sanitizeRouteMode('unsupported'), 'cycling');

const scoreExample = { district: '福田', subject: '物理', grade: '高三', hourlyPrice: 200 };
const distanceWeightedScores = [2, 8, 12, 18, 30].map(distanceKm => platform.score({ ...scoreExample, distanceKm }));
assert.deepEqual(distanceWeightedScores, [90, 75, 65, 55, 45]);
assert.equal(platform.score({ hourlyPrice: 300, distanceKm: 2 }), 100);
assert.equal(platform.score({ hourlyPrice: 100, distanceKm: 2 }), 70);
assert.equal(platform.score({ hourlyPrice: 300, distanceKm: 30 }), 55);
assert.equal(platform.score({ price: 400, priceUnit: '2小时', distanceKm: 2 }), 90);
assert.equal(lessonPriceLabel({ price: 200, hourlyPrice: 200, priceUnit: '小时' }), '400元/次（2小时）');
assert.equal(lessonPriceLabel({ price: 900, priceMin: 800, priceMax: 1000, hourlyPrice: 450, priceUnit: '2小时' }), '800-1000元/次（2小时）');
assert.equal(lessonPriceLabel({ price: 500, hourlyPrice: 250, priceUnit: '次' }), '500元/次');
assert.equal(lessonPriceLabel({ price: 600, hourlyPrice: 200, priceUnit: '3小时' }), '400元/次（2小时）');
assert.equal(lessonPriceAmount({ price: 160, hourlyPrice: 160, priceUnit: '小时' }), 320);

async function runLocationChecks() {
  const originalFetch = global.fetch;
  global.fetch = async url => {
    if (String(url).includes('/v3/place/text')) {
      const keywords = new URL(String(url)).searchParams.get('keywords') || '';
      const poi = keywords.includes('盐田墟')
        ? { id: 'yantian-poi', name: '盐田墟', adname: '盐田区', address: '盐田街道', location: '114.268000,22.584000', type: '地名地址信息;普通地名;村庄级地名' }
        : keywords.includes('流塘')
          ? { id: 'liutang-poi', name: '流塘社区', adname: '宝安区', address: '西乡街道', location: '113.890000,22.580000', type: '商务住宅;住宅区;社区中心' }
          : keywords.includes('颐城栖湾里')
            ? { id: 'qiyuanli-poi', name: '颐城栖湾里', adname: '南山区', address: '港城路', location: '113.895000,22.493000', type: '商务住宅;住宅区;住宅小区' }
            : keywords.includes('会展')
              ? { id: 'convention-poi', name: '深圳国际会展中心', adname: '宝安区', address: '展城路1号', location: '113.776000,22.707000', type: '科教文化服务;会展中心;会展中心' }
              : { id: 'synthetic-poi', name: '共和花园', adname: '宝安区', address: '西乡街道', location: '113.850000,22.580000', type: '商务住宅;住宅区;住宅小区' };
      const pois = keywords === '福田区'
        ? [{ id: 'district-default', name: '福田区人民政府', adname: '福田区', address: '福民路123号', location: '114.055000,22.522000', type: '政府机构及社会团体;政府机关;区县级政府及事业单位' }]
        : /洲石路|润景华府/.test(keywords)
          ? [{ id: 'road-property', name: '润景华府', adname: '宝安区', address: '洲石路', location: '113.880000,22.650000', type: '商务住宅;住宅区;住宅小区' }]
        : keywords.includes('默认地点社区')
        ? [
            { id: 'default-first', name: '默认地点社区一期', adname: '福田区', address: '测试路1号', location: '114.050000,22.530000', type: '商务住宅;住宅区;住宅小区' },
            { id: 'default-second', name: '默认地点社区二期', adname: '福田区', address: '测试路2号', location: '114.051000,22.531000', type: '商务住宅;住宅区;住宅小区' }
          ]
        : [poi];
      return {
        json: async () => ({
          status: '1',
          pois
        })
      };
    }
    throw new Error(`Unexpected synthetic request: ${url}`);
  };
  try {
    const resolved = await platform.resolveOrderLocation({ ...decorativeSeparatorOrder }, { amapWebServiceKey: 'synthetic-test-value' });
    assert.equal(resolved.locationVerified, true);
    assert.equal(resolved.locationStatus, 'verified');
    assert.equal(resolved.locationCoordinates, '113.850000,22.580000');
    assert.equal(resolved.district, '宝安');
    assert.equal(resolved.place, '共和花园');

    let verifiedImportLocationCalls = 0;
    const preparedVerified = await platform.prepareImportedOrder(resolved, { id: 'fixture', name: '匿名测试机构' }, { amapWebServiceKey: 'synthetic-test-value' }, {
      resolveLocation: async order => { verifiedImportLocationCalls++; return order; },
      buildStructured: async ({ rawText }) => ({ rawText })
    });
    assert.equal(verifiedImportLocationCalls, 0, 'verified preview import must reuse the confirmed POI');
    assert.equal(preparedVerified.routeMode, '待计算');
    assert.equal(preparedVerified.routeStatus, 'pending');
    assert.equal(preparedVerified.distanceKm, '');

    let unverifiedImportLocationCalls = 0;
    const preparedUnverified = await platform.prepareImportedOrder({ ...decorativeSeparatorOrder, locationVerified: false }, { id: 'fixture', name: '匿名测试机构' }, { amapWebServiceKey: 'synthetic-test-value' }, {
      resolveLocation: async order => {
        unverifiedImportLocationCalls++;
        order.locationVerified = true;
        order.locationPoiId = 'resolved-by-location-service';
        order.locationCoordinates = '113.850000,22.580000';
        return order;
      },
      buildStructured: async ({ rawText }) => ({ rawText })
    });
    assert.equal(unverifiedImportLocationCalls, 1, 'unverified import must still use the shared location service');
    assert.equal(preparedUnverified.locationPoiId, 'resolved-by-location-service');
    assert.equal(preparedUnverified.routeStatus, 'pending');

    const resolvedYantian = await platform.resolveOrderLocation({ ...yantianOrder }, { amapWebServiceKey: 'synthetic-test-value' });
    assert.equal(resolvedYantian.locationVerified, true);
    assert.equal(resolvedYantian.district, '盐田');
    assert.equal(resolvedYantian.place, '盐田墟');
    assert.equal(resolvedYantian.locationCoordinates, '114.268000,22.584000');

    const resolvedLiutang = await platform.resolveOrderLocation({ ...liutangOrder }, { amapWebServiceKey: 'synthetic-test-value' });
    assert.equal(resolvedLiutang.locationVerified, true);
    assert.equal(resolvedLiutang.district, '宝安');
    assert.match(resolvedLiutang.place, /流塘/);
    assert.equal(resolvedLiutang.locationCoordinates, '113.890000,22.580000');

    const resolvedAlternatives = await platform.resolveOrderLocation({ ...alternativeLocationOrder }, { amapWebServiceKey: 'synthetic-test-value' });
    assert.equal(resolvedAlternatives.locationOptions.length, 2);
    assert.equal(resolvedAlternatives.locationOptions[0].coordinates, '113.895000,22.493000');
    assert.equal(resolvedAlternatives.locationOptions[1].coordinates, '113.776000,22.707000');

    const defaulted = await platform.resolveOrderLocation({
      district: '福田',
      place: '默认地点社区',
      placeOriginal: '默认地点社区',
      locationQuery: '默认地点社区',
      locationQueries: ['默认地点社区'],
      raw: '福田区默认地点社区，高三物理'
    }, { amapWebServiceKey: 'synthetic-test-value' });
    assert.equal(defaulted.locationVerified, true);
    assert.equal(defaulted.locationStatus, 'defaulted');
    assert.equal(defaulted.locationPoiId, 'default-first');
    assert.equal(defaulted.locationCoordinates, '114.050000,22.530000');
    assert.equal(defaulted.locationCandidates.length, 2);

    const genericDefault = await platform.resolveOrderLocation({
      district: '福田',
      place: '具体地点未提供',
      placeOriginal: '具体地点未提供',
      raw: '福田区，高三物理，具体地点未提供'
    }, { amapWebServiceKey: 'synthetic-test-value' });
    assert.equal(genericDefault.locationVerified, true);
    assert.equal(genericDefault.locationStatus, 'defaulted');
    assert.equal(genericDefault.locationPoiId, 'district-default');
    assert.equal(genericDefault.locationCoordinates, '114.055000,22.522000');

    const persistedGeneric = {
      id: 'persisted-location-fixture',
      status: 'open',
      district: '宝安',
      place: '具体地点未提供',
      placeOriginal: '具体地点未提供',
      address: '深圳市宝安区具体地点未提供',
      distanceKm: 5.4,
      routeMode: '骑行',
      locationVerified: true,
      locationPoiId: 'stale-district-poi',
      locationCoordinates: '113.800000,22.600000',
      raw: '2️⃣新高二物理 男孩\n宝安洲石路润景·华府\n成绩只有32，其他科还可以，7月或8月都能上课\n需要补差经验好的老师\n大学生300~350/2h',
      source: '匿名回归机构',
      agencyId: 'fixture'
    };
    const repairedCount = await platform.repairPersistedOpenOrderLocations({
      orders: [persistedGeneric],
      settings: { amapWebServiceKey: 'synthetic-test-value' }
    });
    assert.equal(repairedCount, 1);
    assert.match(persistedGeneric.place, /洲石路/);
    assert.match(persistedGeneric.placeOriginal, /润景·华府/);
    assert.ok(persistedGeneric.locationQueries.includes('深圳市宝安区洲石路润景华府'));
    assert.equal(persistedGeneric.locationPoiId, 'road-property');
    assert.notEqual(persistedGeneric.locationPoiId, 'district-default');
    assert.equal(persistedGeneric.distanceKm, '');
    assert.equal(persistedGeneric.routeMode, '待计算');
    assert.equal(persistedGeneric.routeStatus, 'pending');
    assert.equal(persistedGeneric.structured.rawText, persistedGeneric.raw);
  } finally {
    global.fetch = originalFetch;
  }
}

runLocationChecks()
  .then(() => console.log('PASS public synthetic smoke tests'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
