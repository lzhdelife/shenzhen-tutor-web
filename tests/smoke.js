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

const schedule = summarizeScheduleText('下周开始，一周2次，晚上上课，每次2小时');
assert.equal(schedule.start, '下周开始');
assert.match(schedule.count, /一周2次/);
assert.match(schedule.slot, /晚上/);

const selectedImage = platform.sourceImageForOrder(orders[0].raw, [
  { text: blocks[1], fileName: 'page-b.png' },
  { text: blocks[0], fileName: 'page-a.png' }
]);
assert.deepEqual(selectedImage, ['page-a.png']);

const syntheticPhone = ['138', '0013', '8000'].join('');
assert.equal(platform.validMainlandPhone(syntheticPhone), true);
assert.equal(platform.validMainlandPhone(syntheticPhone + syntheticPhone), false);
assert.equal(platform.sanitizeRouteMode('walking'), 'walking');
assert.equal(platform.sanitizeRouteMode('unsupported'), 'cycling');

console.log('PASS public synthetic smoke tests');
