'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { canonicalOrderText } = require('../shared/order-dedupe');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-preview-test-'));
const port = 18791;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['TutorPlatform/server.js'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, PORT: String(port), TUTOR_DATA_DIR: dataDir, AMAP_WEB_SERVICE_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${base}/api/state`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('preview test server did not start');
}

async function preview(token, text) {
  const response = await fetch(`${base}/api/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ text })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.parsed.length, 1);
  return body.parsed[0];
}

async function previewBatch(token, text) {
  const response = await fetch(`${base}/api/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ text })
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function run() {
  await waitForServer();
  assert.deepEqual(await fetch(`${base}/api/visit`, { method: 'POST' }).then(response => response.json()), { totalVisits: 1 });
  assert.deepEqual(await fetch(`${base}/api/visit`, { method: 'POST' }).then(response => response.json()), { totalVisits: 2 });
  assert.deepEqual(await fetch(`${base}/api/stats`).then(response => response.json()), { totalVisits: 2 });
  const loginResponse = await fetch(`${base}/api/account/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '预览接口测试', phone: ['138', '0013', '8000'].join(''), password: 'preview-test-password' })
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();

  const yantian = await preview(login.agencyToken, '盐田墟初三刚毕业女生，需要一位数学老师，带孩子把初三知识点查漏补缺并提前熟悉高一内容，课费500一次，上课时间，暑假开始每周周一周三周五早8点，开学后周末一次');
  assert.deepEqual({ district: yantian.district, place: yantian.place, price: yantian.price, priceUnit: yantian.priceUnit, studentGender: yantian.studentGender, teacherGender: yantian.gender }, { district: '盐田', place: '盐田墟', price: 500, priceUnit: '次', studentGender: '女', teacherGender: '' });

  const liutang = await preview(login.agencyToken, 'S215916【高二物理宝安西乡】流塘高二男，基础一般想提高成绩，暑假连续上课，开学周末，800-1000元2小时，要求专业家教老师，想要前10大');
  assert.equal(liutang.district, '宝安');
  assert.match(liutang.place, /西乡.*流塘/);
  assert.deepEqual([liutang.priceMin, liutang.priceMax, liutang.priceUnit], [800, 1000, '2小时']);

  const alternatives = await preview(login.agencyToken, `【Z深圳市南山区颐城栖湾里或宝安会展附近准小四语数英】
【学生】女孩，基础薄弱双语学校
【次数】暑假七月中旬开始大概15-20次课，周内上课2h/次
【薪酬】400左右/次
【要求】年轻女老师，有经验`);
  assert.equal(alternatives.locationRelation, 'OR');
  assert.equal(alternatives.locationOptions.length, 2);
  assert.equal(alternatives.locationOptions[1].nearby, true);
  assert.deepEqual([alternatives.price, alternatives.priceUnit, alternatives.priceApproximate], [400, '次', true]);

  const batchText = fs.readFileSync(path.join(__dirname, 'fixtures', 'batch-nine-orders.txt'), 'utf8').trim().replace(/\r/g, '');
  const expectedBlocks = batchText.split(/\n[ \t]*\n+/).map(block => block.trim());
  const batch = await previewBatch(login.agencyToken, batchText);
  assert.equal(batch.parserVersion, '2.2.3');
  assert.equal(batch.parsed.length, 9, 'blank-line batch must produce exactly 9 orders');
  assert.equal(batch.splitDiagnostics.length, 9);
  assert.deepEqual(batch.parsed.map(order => order.raw), expectedBlocks, 'preview raw blocks must preserve every order exactly');
  assert.deepEqual(batch.splitDiagnostics.map(item => item.blockIndex), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(batch.splitDiagnostics.every(item => item.boundaryReason === 'blank-line' && item.confidence === 1));
  for (let index = 0; index < batch.splitDiagnostics.length; index++) {
    const item = batch.splitDiagnostics[index];
    assert.equal(batchText.slice(item.rawStart, item.rawEnd), expectedBlocks[index], `diagnostic span ${index}`);
    if (index > 0) assert.ok(item.rawStart >= batch.splitDiagnostics[index - 1].rawEnd, `no overlap at block ${index}`);
  }

  const numberedText = fs.readFileSync(path.join(__dirname, 'fixtures', 'numbered-compact-orders.txt'), 'utf8').trim().replace(/\r/g, '');
  const numberedExpected = numberedText.split('\n');
  const numbered = await previewBatch(login.agencyToken, numberedText);
  assert.equal(numbered.parsed.length, 2, 'preview must split keycap-numbered compact orders');
  assert.deepEqual(numbered.parsed.map(order => order.raw), numberedExpected);
  assert.deepEqual(numbered.splitDiagnostics.map(item => item.boundaryReason), ['numbered-order', 'numbered-order']);

  const mixedText = fs.readFileSync(path.join(__dirname, 'fixtures', 'mixed-preamble-order.txt'), 'utf8').trim().replace(/\r/g, '');
  const mixed = await previewBatch(login.agencyToken, mixedText);
  assert.equal(mixed.parsed.length, 1, 'non-order preamble must not become an order');
  assert.equal(mixed.ignoredBlocks.length, 1, 'ignored raw text remains reviewable');
  assert.equal(mixed.ignoredBlocks[0].rawText, mixedText.split('\n\n')[0]);
  assert.match(mixed.parsed[0].raw, /^单号：合成1545E/);

  const bridgeHeaders = { 'content-type': 'application/json', 'x-clipboard-bridge': 'shenzhen-tutor-local-v1' };
  const ignoredCaptureId = 'synthetic-ignore-001';
  const ignoredCapture = await fetch(`${base}/api/clipboard/capture`, {
    method: 'POST',
    headers: bridgeHeaders,
    body: JSON.stringify({ captureId: ignoredCaptureId, text: '明天下午记得把资料发到群里，谢谢' })
  }).then(response => response.json());
  assert.equal(ignoredCapture.status, 'ignored', 'non-order clipboard text must terminate without entering the inbox');
  const ignoredStatus = await fetch(`${base}/api/clipboard/status?captureId=${ignoredCaptureId}`, { headers: bridgeHeaders }).then(response => response.json());
  assert.equal(ignoredStatus.status, 'ignored');

  const orderCaptureId = 'synthetic-order-001';
  const orderCapture = await fetch(`${base}/api/clipboard/capture`, {
    method: 'POST',
    headers: bridgeHeaders,
    body: JSON.stringify({ captureId: orderCaptureId, text: '福田香蜜湖高一数学，周末上课，200元每小时，需要有经验老师' })
  }).then(response => response.json());
  assert.equal(orderCapture.status, 'pending', 'order-like clipboard text must enter the authenticated Web inbox');
  const clipboardInbox = await fetch(`${base}/api/clipboard/inbox`, {
    headers: { authorization: `Bearer ${login.agencyToken}` }
  }).then(response => response.json());
  assert.deepEqual(clipboardInbox.items.map(item => item.captureId), [orderCaptureId]);

  const duplicateRaw = '宝安区西乡去重花园，高二物理，每周六下午，300元/小时，需要有经验老师';
  const firstDuplicateImport = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.agencyToken}` },
    body: JSON.stringify({ orders: [{ raw: duplicateRaw }] })
  }).then(response => response.json());
  assert.equal(firstDuplicateImport.created.length, 1);

  const secondLogin = await fetch(`${base}/api/account/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '第二个去重账号', phone: ['138', '0013', '8001'].join(''), password: 'preview-test-password' })
  }).then(response => response.json());
  const repeatedAcrossAccounts = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secondLogin.agencyToken}` },
    body: JSON.stringify({ orders: [{ raw: `📚 ${duplicateRaw}！！！` }] })
  }).then(response => response.json());
  assert.equal(repeatedAcrossAccounts.created.length, 0, 'the same order from another account must be skipped platform-wide');
  assert.equal(repeatedAcrossAccounts.duplicatesSkipped, 1);

  const stateAfterDuplicate = await fetch(`${base}/api/state`, {
    headers: { authorization: `Bearer ${login.teacherToken}` }
  }).then(response => response.json());
  assert.equal(stateAfterDuplicate.orders.filter(order => canonicalOrderText(order.raw) === canonicalOrderText(duplicateRaw)).length, 1);
  console.log('PASS preview API regression tests');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
