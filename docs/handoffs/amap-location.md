# 高德地图与地点闭环交接

## 分支与基线

- 分支：`codex/amap-location-integration`
- 基线：`005502fe848530ba5e849c1b93ba891db8bba251`
- 功能提交：`52091f915a985605cd3c3c8203611d1c46d1b3f9`

## 负责路径

- Cloudflare：`cloudflare/amap-service.js`、`cloudflare/worker.js`、`cloudflare/parser-adapter.js`
- Node 兼容层：`TutorPlatform/server.js`
- 地点确认 UI：`TutorPlatform/public/app.js`、`TutorPlatform/public/index.html`
- 测试：`tests/cloudflare-amap.test.js`、`tests/smoke.js`
- 地图相关 API、部署、开发和数据模型文档；完整基线审计见 `docs/AMAP_AUDIT.md`

## 接口与字段变化

- Cloudflare 新增/补齐 `GET /api/location-suggestions?q=&district=`，只返回高德候选；支持区名约束。
- 新增 `POST /api/orders/:id/location/confirm`，订单所有者或管理员确认候选后保存 `district`、`place`、`address`、`locationPoiId`、`locationCoordinates`、`locationAddress`、`locationConfidence`、`locationVerified`、`locationStatus`。
- Cloudflare 补齐 `POST /api/distance-preview`，只对已确认坐标计算路线，支持 `walking`、`cycling`、`driving`、`transit`。
- 地图错误增加稳定代码：`AMAP_NOT_CONFIGURED`、`AMAP_TIMEOUT`、`AMAP_RATE_LIMITED`、`AMAP_API_ERROR` 等。真实路线返回 `status: "verified"` 和 `source: "amap"`。
- 地点二选一的 `locationOptions[]` 可逐项确认并保存 `poiId`、`coordinates`、`address`、`confidence`、`verified`。
- 删除浏览器/Node 设置中的 `amapKey` 输入和持久化；唯一配置名为服务端 `AMAP_WEB_SERVICE_KEY`。
- 取消路线失败时的本地估算伪装；失败或未配置时距离为空并带明确状态。

## 测试结果

- `npm.cmd test`：通过（smoke、解析回归、recognizer contract、preview API）。
- `npm.cmd run cloudflare:test`：通过，8/8；覆盖地点二选一所需的逐项确认基础、同名候选、区名约束、无 Key、无结果、超时、限流/错误响应和四种路线模式。
- `npm.cmd run check:secrets`：通过，扫描 55 个已跟踪文件。
- `git diff --check`：通过。

## 风险与未验证项

- 所有地图测试均为合成 HTTP 响应；未使用真实高德 Key，因此没有声称公网高德调用已验证。
- Cloudflare 路线预览当前按订单串行处理目的地，订单量很大时可能触发 Worker 执行时长或高德配额限制；后续可在保持错误语义的前提下增加受控并发/缓存。
- Node 旧 `db.json` 若残留 `amapKey`，运行时不会读取；管理员下一次保存设置时会删除。不要为了清理而读取或提交真实运行数据。
- `/api/location-suggestions` 是公共接口，生产环境应在网关或 Worker 增加与业务流量相称的限流。

## 主任务集成顺序

1. 确认主分支已经包含基线 `005502f`，且地点字段没有发生冲突性契约变更。
2. 合并本分支 tip（包含功能提交及本交接文档），或先 cherry-pick `52091f9` 再 cherry-pick 后续交接提交。
3. 若主任务同时修改 `cloudflare/worker.js` 或 `TutorPlatform/public/app.js`，保留本分支地点接口、错误代码、Secret 边界和候选确认字段；登录、解析规则与整体视觉以主任务版本为准。
4. 重新运行三条测试命令和 D1 本地迁移测试。
5. 部署前由运维执行 `npx.cmd wrangler secret put AMAP_WEB_SERVICE_KEY`；不要把值写入代码或配置文件。
6. 使用非生产测试地点验收“解析 → 候选 → 人工确认 → D1 保存 → 四种路线”，确认响应为真实 `amap/verified` 后再发布。
