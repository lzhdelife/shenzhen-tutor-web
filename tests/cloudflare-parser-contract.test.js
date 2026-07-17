'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const adapter = require('../cloudflare/parser-adapter');

test('Cloudflare adapter exposes the shared lossless parser contract', async () => {
  const first = '南山区科技园高一数学，女生，200元/小时，每周六下午2小时';
  const second = '宝安区会展附近或南山区后海均可，准小四语数英，400元/次，女老师';
  const result = await adapter.parseOrders({ text: `${first}\n\n${second}` }, {
    agency: { id: 'synthetic-agency', name: '匿名合成机构' },
    env: {}
  });

  assert.equal(result.parserVersion, '2.1.0');
  assert.deepEqual(result.parsed.map(order => order.raw), [first, second]);
  assert.deepEqual(result.parsed.map(order => order.structured.rawText), [first, second]);
  assert.equal(result.splitDiagnostics.length, 2);
  assert.ok(result.parsed.every(order => Array.isArray(order.structured.diagnostics.uncertainFields)));
  assert.ok(result.parsed.every(order => order.structured.locations.value.every(location => Array.isArray(location.locationQueries))));
});
