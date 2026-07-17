'use strict';

const assert = require('node:assert/strict');
const platform = require('../TutorPlatform/server.js');
const { summarizeScheduleText } = require('../TutorPlatform/public/schedule-format.js');

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
      return {
        json: async () => ({
          status: '1',
          pois: [poi]
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
