'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const platform = require('../TutorPlatform/server.js');
const { buildRuleStructuredOrder } = require('../TutorPlatform/parser/pipeline');
const { splitOrdersDetailed } = require('../TutorPlatform/parser/splitter');

const fixturePath = path.join(__dirname, 'fixtures', 'parser-regressions.jsonl');
const reportedFixturePath = path.join(__dirname, 'fixtures', 'parser-reported-regressions.jsonl');
const fixtures = [fixturePath, reportedFixturePath]
  .flatMap(file => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse));
const batchFixturePath = path.join(__dirname, 'fixtures', 'batch-nine-orders.txt');
const batchFixture = fs.readFileSync(batchFixturePath, 'utf8').trim().replace(/\r/g, '');
const numberedFixturePath = path.join(__dirname, 'fixtures', 'numbered-compact-orders.txt');
const numberedFixture = fs.readFileSync(numberedFixturePath, 'utf8').trim().replace(/\r/g, '');
const bracketedFixturePath = path.join(__dirname, 'fixtures', 'batch-eleven-bracketed-orders.txt');
const bracketedFixture = fs.readFileSync(bracketedFixturePath, 'utf8').trim().replace(/\r/g, '');
const counters = { district: [0, 0], place: [0, 0], grade: [0, 0], subject: [0, 0], studentGender: [0, 0], teacherGender: [0, 0], price: [0, 0], priceUnit: [0, 0], phases: [0, 0], evidence: [0, 0], genderConfusions: 0 };

for (const fixture of fixtures) {
  const order = platform.parseOrder(fixture.raw, '匿名回归机构', 'fixture');
  const expected = fixture.expected;
  const structured = buildRuleStructuredOrder(order, fixture.raw);
  if (expected.district) { counters.district[1]++; if (order.district === expected.district) counters.district[0]++; assert.equal(order.district, expected.district, fixture.id); }
  if (expected.placeIncludes) { counters.place[1]++; const ok = expected.placeIncludes.every(value => order.place.includes(value)); if (ok) counters.place[0]++; assert.equal(ok, true, `${fixture.id}: ${order.place}`); }
  if (expected.placeExcludes) assert.ok(expected.placeExcludes.every(value => !order.place.includes(value)), `${fixture.id}: polluted place ${order.place}`);
  if (expected.placeOriginal) assert.equal(order.placeOriginal, expected.placeOriginal, `${fixture.id}:placeOriginal`);
  for (const field of ['grade', 'subject', 'studentGender', 'gender', 'price', 'priceMin', 'priceMax', 'priceUnit', 'optionalSubjects', 'studentLevel', 'studentType', 'transitLine', 'locationRelation']) {
    const expectedKey = field === 'gender' ? 'teacherGender' : field;
    if (Object.prototype.hasOwnProperty.call(expected, expectedKey)) assert.equal(order[field], expected[expectedKey], `${fixture.id}:${field}`);
  }
  if (expected.priceUnit) { counters.priceUnit[1]++; if (order.priceUnit === expected.priceUnit) counters.priceUnit[0]++; }
  if (expected.locationOptionCount) assert.equal(order.locationOptions.length, expected.locationOptionCount, fixture.id);
  if (expected.locationQueryIncludes) assert.ok(expected.locationQueryIncludes.every(value => order.locationQueries.includes(value)), `${fixture.id}: ${order.locationQueries.join(' | ')}`);
  if (expected.scheduleIncludes) { counters.phases[1]++; const ok = expected.scheduleIncludes.every(value => order.schedule.includes(value)); if (ok) counters.phases[0]++; assert.equal(ok, true, `${fixture.id}: ${order.schedule}`); }
  if (!expected.teacherGender && order.gender) counters.genderConfusions++;
  assert.equal(structured.parserVersion, '2.2.3');
  assert.equal(structured.rawText, fixture.raw);
  assert.ok(structured.normalizedText, `${fixture.id}: normalized text available alongside lossless rawText`);
  assert.equal(structured.locations.rawEvidence.length > 0, true, `${fixture.id}: location evidence`);
  assert.ok(structured.locations.value.every(location => Array.isArray(location.locationQueries)), `${fixture.id}: candidate query contract`);
  for (const [counter, field, expectedKey] of [
    ['grade', 'gradeCurrent', 'grade'], ['subject', 'subjectsCurrent', 'subject'],
    ['studentGender', 'studentGender', 'studentGender'], ['teacherGender', 'teacherGender', 'teacherGender'],
    ['price', 'priceMin', 'price']
  ]) {
    if (!Object.prototype.hasOwnProperty.call(expected, expectedKey)) continue;
    counters[counter][1]++;
    const value = structured[field].value;
    const wanted = expected[expectedKey];
    const correct = Array.isArray(value) ? value.join('/') === wanted : (counter === 'price' && expected.priceMin ? value === expected.priceMin : value === wanted);
    if (correct) counters[counter][0]++;
  }
  for (const field of ['locations', 'gradeCurrent', 'subjectsCurrent', 'studentGender', 'teacherGender', 'priceMin', 'priceUnit']) {
    const item = structured[field];
    if (item?.value == null || item.value === '' || (Array.isArray(item.value) && !item.value.length)) continue;
    counters.evidence[1]++;
    if (item.rawEvidence && item.confidence > 0) counters.evidence[0]++;
  }
  assert.ok(Array.isArray(structured.diagnostics.uncertainFields), `${fixture.id}: uncertainty contract`);
  if (fixture.id === 'nanshan-baoan-location-or') {
    assert.equal(structured.locations.relation, 'OR');
    assert.equal(structured.locations.value.length, 2);
    assert.equal(structured.locations.value[1].nearby, true);
    assert.ok(structured.locations.value.every(location => location.locationQueries.length >= 1));
    assert.equal(structured.schedulePhases[0].lessonCountMin, 15);
    assert.equal(structured.schedulePhases[0].lessonCountMax, 20);
    assert.equal(structured.schedulePhases[0].durationPerLesson, 2);
  }
  if (fixture.id === 'yantianxu-graduate-phases') {
    assert.deepEqual(structured.schedulePhases[0].weekdays, ['一', '三', '五']);
    assert.equal(structured.schedulePhases[0].timeOfDay, '早8点');
    assert.equal(structured.schedulePhases[1].frequency, '每周末1次');
  }
  if (fixture.id === 'baoan-huaide-metro-phases') {
    assert.equal(structured.locations.value[0].transitLine, '12号线');
    assert.equal(structured.schedulePhases[0].durationPerLesson, 2);
    assert.equal(structured.schedulePhases[1].durationPerLesson, 3);
  }
  if (fixture.id === 'guangming-inline-address-teacher-degree') {
    assert.equal(structured.schedulePhases[0].frequency, '一周二次');
    assert.deepEqual(structured.schedulePhases[0].weekdays, []);
    assert.equal(structured.schedulePhases[0].durationPerLesson, 1.5);
  }
  if (fixture.id === 'guangming-labeled-grade-poi') {
    assert.equal(structured.schedulePhases[0].frequency, '一周2-3次');
    assert.equal(structured.schedulePhases[0].timeOfDay, '');
    assert.equal(structured.schedulePhases[0].durationPerLesson, 2);
  }
}

const ratio = ([correct, total]) => total ? correct / total : 1;
const metrics = {
  districtExact: ratio(counters.district),
  explicitPlaceExact: ratio(counters.place),
  gradeExact: ratio(counters.grade),
  subjectExact: ratio(counters.subject),
  studentGenderExact: ratio(counters.studentGender),
  teacherGenderExact: ratio(counters.teacherGender),
  priceExact: ratio(counters.price),
  priceUnitExact: ratio(counters.priceUnit),
  phasedScheduleRecall: ratio(counters.phases),
  populatedFieldEvidenceCoverage: ratio(counters.evidence),
  genderConfusions: counters.genderConfusions
};
assert.equal(metrics.districtExact, 1, 'district exact-match threshold 100%');
assert.ok(metrics.explicitPlaceExact >= 0.98, 'explicit POI/metro threshold >=98%');
assert.equal(metrics.gradeExact, 1, 'grade exact-match threshold 100%');
assert.equal(metrics.subjectExact, 1, 'subject exact-match threshold 100%');
assert.equal(metrics.studentGenderExact, 1, 'student gender threshold 100%');
assert.equal(metrics.teacherGenderExact, 1, 'teacher gender threshold 100%');
assert.equal(metrics.priceExact, 1, 'price exact-match threshold 100%');
assert.equal(metrics.priceUnitExact, 1, 'price unit threshold 100%');
assert.ok(metrics.phasedScheduleRecall >= 0.95, 'phased schedule threshold >=95%');
assert.equal(metrics.populatedFieldEvidenceCoverage, 1, 'populated fields must retain evidence');
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

const expectedBracketedBlocks = bracketedFixture.split(/\n[ \t]*\n+/).map(block => block.trim());
const bracketedSplit = platform.splitImportBlocksDetailed(bracketedFixture);
assert.equal(bracketedSplit.blocks.length, 11, 'bracketed batch expectedCount=11');
assert.deepEqual(bracketedSplit.blocks, expectedBracketedBlocks, 'bracketed batch must preserve every raw order');
assert.equal(bracketedSplit.blocks.join('\n\n'), expectedBracketedBlocks.join('\n\n'), 'bracketed batch normalized coverage must be 100%');
console.log('PASS bracketed batch split expectedCount=11 coverage=100%');

const numberedExpected = numberedFixture.split('\n');
const numberedSplit = platform.splitImportBlocksDetailed(numberedFixture);
assert.equal(numberedSplit.blocks.length, 2, 'keycap-numbered compact orders must not merge');
assert.deepEqual(numberedSplit.blocks, numberedExpected, 'keycap-numbered raw orders and order must be preserved');
assert.deepEqual(numberedSplit.diagnostics.map(item => item.boundaryReason), ['numbered-order', 'numbered-order']);
assert.ok(numberedSplit.diagnostics.every(item => item.confidence === 0.95));
assert.equal(numberedSplit.blocks.join('\n'), numberedFixture, 'keycap-numbered normalized coverage must be 100%');
console.log('PASS numbered compact split regression expectedCount=2 coverage=100%');
