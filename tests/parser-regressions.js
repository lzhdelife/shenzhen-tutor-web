'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const platform = require('../TutorPlatform/server.js');
const { buildRuleStructuredOrder } = require('../TutorPlatform/parser/pipeline');
const { splitOrdersDetailed } = require('../TutorPlatform/parser/splitter');

const fixturePath = path.join(__dirname, 'fixtures', 'parser-regressions.jsonl');
const fixtures = fs.readFileSync(fixturePath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const batchFixturePath = path.join(__dirname, 'fixtures', 'batch-nine-orders.txt');
const batchFixture = fs.readFileSync(batchFixturePath, 'utf8').trim().replace(/\r/g, '');
const counters = { district: [0, 0], place: [0, 0], priceUnit: [0, 0], phases: [0, 0], genderConfusions: 0 };

for (const fixture of fixtures) {
  const order = platform.parseOrder(fixture.raw, '匿名回归机构', 'fixture');
  const expected = fixture.expected;
  const structured = buildRuleStructuredOrder(order, fixture.raw);
  if (expected.district) { counters.district[1]++; if (order.district === expected.district) counters.district[0]++; assert.equal(order.district, expected.district, fixture.id); }
  if (expected.placeIncludes) { counters.place[1]++; const ok = expected.placeIncludes.every(value => order.place.includes(value)); if (ok) counters.place[0]++; assert.equal(ok, true, `${fixture.id}: ${order.place}`); }
  for (const field of ['grade', 'subject', 'studentGender', 'gender', 'price', 'priceMin', 'priceMax', 'priceUnit', 'optionalSubjects', 'studentLevel', 'studentType', 'transitLine', 'locationRelation']) {
    const expectedKey = field === 'gender' ? 'teacherGender' : field;
    if (Object.prototype.hasOwnProperty.call(expected, expectedKey)) assert.equal(order[field], expected[expectedKey], `${fixture.id}:${field}`);
  }
  if (expected.priceUnit) { counters.priceUnit[1]++; if (order.priceUnit === expected.priceUnit) counters.priceUnit[0]++; }
  if (expected.locationOptionCount) assert.equal(order.locationOptions.length, expected.locationOptionCount, fixture.id);
  if (expected.scheduleIncludes) { counters.phases[1]++; const ok = expected.scheduleIncludes.every(value => order.schedule.includes(value)); if (ok) counters.phases[0]++; assert.equal(ok, true, `${fixture.id}: ${order.schedule}`); }
  if (!expected.teacherGender && order.gender) counters.genderConfusions++;
  assert.equal(structured.parserVersion, '2.0.0');
  assert.equal(structured.rawText, fixture.raw);
}

const ratio = ([correct, total]) => total ? correct / total : 1;
const metrics = {
  districtExact: ratio(counters.district),
  explicitPlaceExact: ratio(counters.place),
  priceUnitExact: ratio(counters.priceUnit),
  phasedScheduleRecall: ratio(counters.phases),
  genderConfusions: counters.genderConfusions
};
assert.equal(metrics.districtExact, 1, 'district exact-match threshold 100%');
assert.ok(metrics.explicitPlaceExact >= 0.98, 'explicit POI/metro threshold >=98%');
assert.equal(metrics.priceUnitExact, 1, 'price unit threshold 100%');
assert.ok(metrics.phasedScheduleRecall >= 0.95, 'phased schedule threshold >=95%');
assert.equal(metrics.genderConfusions, 0, 'student/teacher gender confusion must be zero');
console.log('PASS parser regression metrics', metrics);

const expectedBatchBlocks = batchFixture.split(/\n[ \t]*\n+/).map(block => block.trim());
const split = platform.splitImportBlocksDetailed(batchFixture);
const moduleSplit = splitOrdersDetailed(batchFixture);
assert.equal(split.blocks.length, 9, 'batch-nine-orders expectedCount=9');
assert.deepEqual(moduleSplit, split, 'server compatibility wrapper must use parser splitter contract');
assert.deepEqual(split.blocks, expectedBatchBlocks, 'batch split must preserve all raw text');
assert.equal(split.diagnostics.length, 9);
assert.ok(split.diagnostics.every(item => item.boundaryReason === 'blank-line' && item.confidence === 1));
assert.equal(split.blocks.join('\n\n'), expectedBatchBlocks.join('\n\n'), 'batch normalized coverage must be 100%');
console.log('PASS batch split regression expectedCount=9 coverage=100%');
