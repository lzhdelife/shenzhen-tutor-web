'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAmapService } = require('../cloudflare/amap-service.js');

function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('地点候选保留同名结果并按区名约束', async () => {
  const service = createAmapService({ key: 'synthetic-key', fetchImpl: async () => response({ status: '1', pois: [
    { id: 'n1', name: '中心花园', adname: '南山区', address: '科技园路', location: '113.900,22.500', type: '住宅' },
    { id: 'b1', name: '中心花园', adname: '宝安区', address: '新安路', location: '113.880,22.560', type: '住宅' }
  ] }) });
  const unrestricted = await service.candidates('中心花园');
  assert.deepEqual(unrestricted.candidates.map(item => item.id), ['n1', 'b1']);
  const constrained = await service.candidates('中心花园', '南山区');
  assert.deepEqual(constrained.candidates.map(item => item.id), ['n1']);
});

test('地点候选明确区分无 Key、无结果、超时、限流和错误响应', async () => {
  await assert.rejects(() => createAmapService().candidates('科技园'), { code: 'AMAP_NOT_CONFIGURED', status: 503 });
  assert.equal((await createAmapService({ key: 'synthetic', fetchImpl: async () => response({ status: '1', pois: [] }) }).candidates('不存在地点')).status, 'not_found');
  await assert.rejects(() => createAmapService({ key: 'synthetic', fetchImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); } }).candidates('科技园'), { code: 'AMAP_TIMEOUT' });
  await assert.rejects(() => createAmapService({ key: 'synthetic', fetchImpl: async () => response({}, 429) }).candidates('科技园'), { code: 'AMAP_RATE_LIMITED' });
  await assert.rejects(() => createAmapService({ key: 'synthetic', fetchImpl: async () => response({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }) }).candidates('科技园'), { code: 'AMAP_API_ERROR' });
});

test('候选确认保存标准地址经纬度且拒绝跨区候选', () => {
  const service = createAmapService({ key: 'synthetic' });
  const selected = service.confirm({ id: 'a', name: '甲地', district: '南山区', address: '学府路1号', location: '113.9,22.5' }, '南山');
  const alternative = service.confirm({ id: 'b', name: '乙地', district: '南山区', address: '科苑路2号', location: '113.91,22.51' }, '南山');
  assert.equal(selected.address, '深圳市南山区学府路1号');
  assert.equal(selected.locationCoordinates, '113.9,22.5');
  assert.equal(alternative.place, '乙地');
  assert.throws(() => service.confirm({ name: '同名地点', district: '宝安区', location: '113.8,22.6' }, '南山'), { code: 'LOCATION_DISTRICT_CONFLICT' });
});

test('四种路线模式调用对应端点并返回真实来源标记', async () => {
  const paths = [];
  const service = createAmapService({ key: 'synthetic', fetchImpl: async url => {
    paths.push(new URL(url).pathname);
    return response({ status: '1', route: { paths: [{ distance: '1250', cost: { duration: '600' } }], transits: [{ distance: '2400', duration: '1200' }] } });
  } });
  for (const mode of ['walking', 'cycling', 'driving', 'transit']) {
    const route = await service.route('113.9,22.5', '113.91,22.51', mode);
    assert.equal(route.status, 'verified');
    assert.equal(route.source, 'amap');
    assert.equal(route.mode, mode);
  }
  assert.deepEqual(paths, ['/v5/direction/walking', '/v5/direction/bicycling', '/v5/direction/driving', '/v3/direction/transit/integrated']);
});

test('map requests are coalesced and concurrency is bounded', async () => {
  let calls = 0;
  let active = 0;
  let peak = 0;
  const service = createAmapService({ key: 'synthetic-cache-key', fetchImpl: async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return response({ status: '1', pois: [{ id: 'same', name: 'same place', adname: 'NanShan', address: 'science road', location: '113.9,22.5' }] });
  } });
  const results = await Promise.all(Array.from({ length: 8 }, () => service.candidates('same place')));
  assert.equal(calls, 1);
  assert.equal(peak, 1);
  assert.equal(results.every(item => item.status === 'candidates'), true);
});

test('map requests retry briefly after rate limiting', async () => {
  let calls = 0;
  const service = createAmapService({ key: 'synthetic-retry-key', fetchImpl: async () => {
    calls++;
    return calls < 3 ? response({}, 429) : response({ status: '1', pois: [] });
  } });
  assert.equal((await service.candidates('retry place')).status, 'not_found');
  assert.equal(calls, 3);
});
