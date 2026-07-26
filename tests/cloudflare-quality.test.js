'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverOrderRawText, detectOrderIssues } = require('../shared/order-quality.js');

test('recoverable structured raw text is readable and flagged for admin review', () => {
  const order = {
    district: '南山', place: '科技园', subject: '数学', grade: '初二',
    rawText: '南山区科技园，初二数学，每周两次。',
    requirements: { value: ['认真负责'], rawEvidence: '认真负责' }
  };
  assert.equal(recoverOrderRawText(order), order.rawText);
  assert.deepEqual(detectOrderIssues(order).map(issue => issue.code), ['raw_recovered']);
});

test('unreadable raw and missing key fields receive explicit labels', () => {
  const issues = detectOrderIssues({ raw: {}, locationStatus: 'missing' });
  assert.deepEqual(issues.map(issue => issue.code), ['raw_unreadable', 'location_missing', 'subject_missing', 'grade_missing']);
});

test('normal orders do not receive quality labels', () => {
  const order = { raw: '福田区百花，新初三数学，时间可协商。', district: '福田', place: '百花', subject: '数学', grade: '初三' };
  assert.equal(recoverOrderRawText(order), order.raw);
  assert.deepEqual(detectOrderIssues(order), []);
});

test('recognized location text without confirmed coordinates receives a precise label', () => {
  const order = {
    raw: '罗湖区松泉公寓旁，初一英语。',
    district: '罗湖', place: '松泉公寓旁', subject: '英语', grade: '初一',
    locationStatus: 'ambiguous', locationCoordinates: ''
  };
  assert.deepEqual(detectOrderIssues(order), [
    { code: 'location_unverified', label: '地点坐标未确认' }
  ]);
});
