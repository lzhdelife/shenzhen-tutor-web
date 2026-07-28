'use strict';

const assert = require('node:assert/strict');
const { recognizeOrders } = require('../TutorPlatform/parser/recognizer');
const { splitOrdersDetailed } = require('../TutorPlatform/parser/splitter');
const { classifyOrderBlock } = require('../TutorPlatform/parser/classifier');

async function run() {
  const raw = '南山区高一数学，200元/小时\n\n南山区高一数学，200元/小时';
  const calls = [];
  const result = await recognizeOrders({ text: raw, source: 'synthetic', agencyId: 'a-test' }, {
    splitDetailed: splitOrdersDetailed,
    parseRuleOrder(text, source, agencyId) {
      calls.push(['parse', text, source, agencyId]);
      return { raw: text, source, agencyId };
    },
    async resolveLocation(order) {
      calls.push(['location', order.raw]);
      order.locationStatus = 'synthetic';
    },
    async buildStructured({ rawText }) {
      calls.push(['structured', rawText]);
      return { rawText };
    }
  });

  assert.equal(result.parserVersion, '2.3.0');
  assert.equal(result.parsed.length, 2, 'preview contract must preserve duplicate-looking raw blocks');
  assert.equal(result.splitDiagnostics.length, 2);
  assert.deepEqual(result.parsed.map(order => order.raw), raw.split('\n\n'));
  assert.ok(result.parsed.every(order => order.locationStatus === 'synthetic'));
  assert.ok(result.parsed.every(order => order.structured.rawText === order.raw));
  assert.equal(calls.filter(([type]) => type === 'parse').length, 2);

  assert.equal(classifyOrderBlock('学习交流群-家长互助').accepted, false);
  assert.equal(classifyOrderBlock('明天下午记得把资料发到群里，谢谢').accepted, false);
  assert.equal(classifyOrderBlock('福田高一数学，找老师上课').accepted, true);
  assert.equal(classifyOrderBlock('线上初二英语小班课').accepted, true);
  assert.equal(classifyOrderBlock('网课高一数学，200元每小时').accepted, true);

  const mixed = '学习交流群-家长互助\n\n单号：合成1545E\n龙华、福田，找暑假新高三英语小班课，时间不限制，有开班的老师可带简介联系';
  const mixedResult = await recognizeOrders({ text: mixed }, {
    splitDetailed: splitOrdersDetailed,
    parseRuleOrder: text => ({ raw: text }),
    buildStructured: async ({ rawText }) => ({ rawText })
  });
  assert.equal(mixedResult.parsed.length, 1);
  assert.equal(mixedResult.ignoredBlocks.length, 1);
  assert.equal(mixedResult.ignoredBlocks[0].rawText, '学习交流群-家长互助');
  assert.equal(mixedResult.ignoredBlocks[0].reason, 'insufficient-order-evidence');
  assert.equal(mixedResult.splitDiagnostics[0].sourceBlockIndex, 1);

  const compactMixedResult = await recognizeOrders({ text: mixed.replace('\n\n', '\n') }, {
    splitDetailed: splitOrdersDetailed,
    parseRuleOrder: text => ({ raw: text }),
    buildStructured: async ({ rawText }) => ({ rawText })
  });
  assert.equal(compactMixedResult.parsed.length, 1, 'explicit order title splits a directly attached preamble');
  assert.equal(compactMixedResult.ignoredBlocks.length, 1);
  assert.equal(compactMixedResult.splitDiagnostics[0].boundaryReason, 'explicit-order-title');
  console.log('PASS recognizer module contract');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
