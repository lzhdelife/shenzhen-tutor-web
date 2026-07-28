'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const adapter = require('../cloudflare/parser-adapter');

test('Cloudflare adapter exposes the shared lossless parser contract', async () => {
  const first = '南山区科技园高一数学，女生，200元/小时，每周六下午2小时';
  const second = '宝安区会展附近或南山区后海均可，准小四语数英，400元/次，女老师';
  const result = await adapter.parseOrders({ text: `${first}\n\n${second}` }, {
    agency: { id: 'synthetic-agency', name: '匿名合成机构' },
    env: {}
  });

  assert.equal(result.parserVersion, '2.2.3');
  assert.deepEqual(result.parsed.map(order => order.raw), [first, second]);
  assert.deepEqual(result.parsed.map(order => order.structured.rawText), [first, second]);
  assert.equal(result.splitDiagnostics.length, 2);
  assert.ok(result.parsed.every(order => Array.isArray(order.structured.diagnostics.uncertainFields)));
  assert.ok(result.parsed.every(order => order.structured.locations.value.every(location => Array.isArray(location.locationQueries))));
  assert.ok(result.parsed.every(order => !order.locationCoordinates), 'fast parsing must not wait for Amap enrichment');
});

test('Cloudflare adapter reports non-order preamble without importing it', async () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'mixed-preamble-order.txt'), 'utf8').trim().replace(/\r/g, '');
  const result = await adapter.parseOrders({ text }, {
    agency: { id: 'synthetic-agency', name: '匿名合成机构' }, env: {}
  });
  assert.equal(result.parsed.length, 1);
  assert.equal(result.ignoredBlocks.length, 1);
  assert.equal(result.ignoredBlocks[0].rawText, text.split('\n\n')[0]);
});

test('Cloudflare adapter recognizes online lessons without creating a map query', async () => {
  const raw = '网课，新高一数学，200元/小时，每周两次，需要有经验老师';
  const result = await adapter.parseOrders({ text: raw }, {
    agency: { id: 'synthetic-agency', name: '匿名合成机构' }, env: {}
  });
  assert.equal(result.parsed.length, 1);
  assert.equal(result.parsed[0].district, '线上');
  assert.equal(result.parsed[0].place, '线上授课');
  assert.equal(result.parsed[0].locationStatus, 'online');
  assert.equal(result.parsed[0].locationQuery, '');
  assert.equal(result.parsed[0].structured.locations.source, 'rule');
});

test('Cloudflare adapter keeps keycap-numbered compact orders separate', async () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'numbered-compact-orders.txt'), 'utf8').trim().replace(/\r/g, '');
  const result = await adapter.parseOrders({ text }, {
    agency: { id: 'synthetic-agency', name: '匿名合成机构' },
    env: {}
  });
  assert.equal(result.parsed.length, 2);
  assert.deepEqual(result.parsed.map(order => order.raw), text.split('\n'));
  assert.deepEqual(result.splitDiagnostics.map(item => item.boundaryReason), ['numbered-order', 'numbered-order']);
});

test('Cloudflare adapter recognizes the complete bracketed eleven-order batch', async () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'batch-eleven-bracketed-orders.txt'), 'utf8').trim().replace(/\r/g, '');
  const result = await adapter.parseOrders({ text }, {
    agency: { id: 'synthetic-agency', name: '匿名合成机构' },
    env: {}
  });
  assert.equal(result.parsed.length, 11);
  assert.equal(result.ignoredBlocks.length, 0);
  assert.deepEqual(result.parsed.map(order => order.raw.match(/SZ\d+/)?.[0]), [
    'SZ06072601', 'SZ06072401', 'SZ06072101', 'SZ06071707', 'SZ06071706', 'SZ06071601',
    'SZ06071401', 'SZ06070404', 'SZ06062901', 'SZ06062501', 'SZ06060406'
  ]);
  const calculus = result.parsed.find(order => order.raw.includes('SZ06070404'));
  assert.equal(calculus.subject, '微积分');
  assert.equal(calculus.place, '宣嘉华庭');
});
