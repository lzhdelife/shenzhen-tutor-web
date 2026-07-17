'use strict';

const assert = require('node:assert/strict');
const { recognizeOrders } = require('../TutorPlatform/parser/recognizer');
const { splitOrdersDetailed } = require('../TutorPlatform/parser/splitter');

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

  assert.equal(result.parserVersion, '2.1.0');
  assert.equal(result.parsed.length, 2, 'preview contract must preserve duplicate-looking raw blocks');
  assert.equal(result.splitDiagnostics.length, 2);
  assert.deepEqual(result.parsed.map(order => order.raw), raw.split('\n\n'));
  assert.ok(result.parsed.every(order => order.locationStatus === 'synthetic'));
  assert.ok(result.parsed.every(order => order.structured.rawText === order.raw));
  assert.equal(calls.filter(([type]) => type === 'parse').length, 2);
  console.log('PASS recognizer module contract');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
