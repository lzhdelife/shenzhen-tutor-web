# 文本解析准确率交接

## 分支与基线

- 工作分支：`codex/parser-accuracy`
- 基线提交：`005502f`
- 功能提交：`bb7bd6b feat: strengthen tutor order parsing evidence`
- 编号订单切割修复：`cbdbe15 fix: split compact numbered tutor orders`
- 道路与楼盘地点修复：`095fe4e fix: preserve road and property location evidence`
- 括号标题地点隔离修复：`3d0296c fix: isolate bracketed location evidence`
- 状态：仅本地提交；未推送、未部署、未合并。

## 负责范围与修改路径

领域负责范围是无损多单切割、订单字段提取、证据与置信度、解析契约和匿名回归测试。

- `TutorPlatform/parser/pipeline.js`：结构化证据、地点查询意图、分阶段时间和不确定字段。
- `TutorPlatform/parser/splitter.js`：无损边界与 keycap/circled-digit 编号订单起始判定。
- `TutorPlatform/parser/schema.js`：解析输出 schema。
- `tests/parser-regressions.js`、`tests/recognizer-contract.js`、`tests/api-preview.js`：公共解析和 9 条永久样例回归。
- `tests/cloudflare-parser-contract.test.js`：Cloudflare adapter 使用同一公共解析契约的测试。
- `docs/API.md`、`docs/DATA_MODEL.md`、`docs/PARSER_ACCURACY.md`：共享契约与指标。
- `TutorPlatform/public/app.js`、`TutorPlatform/public/styles.css`：只消费公共 `structured` 契约，展示证据、置信度、原文和不确定字段；未加入解析正则或地图逻辑。

未修改登录、高德网络调用、数据库实现、图片处理或页面整体视觉。

## 接口与字段变化

- `parserVersion`：`2.0.0` → `2.1.0`。
- `/api/parse` 响应形状仍为 `{ parserVersion, parsed, splitDiagnostics }`。
- 每个 `parsed[]` 项的 `structured` 字段强化如下：
  - 可抽取字段统一为 `{ value, rawEvidence, confidence, source }`。
  - `locations` 增加/规范 `relation`、地点原文、行政区、片区、展示地点、`query`、`locationQueries[]`、`nearby`、核验状态和候选证据。
  - `schedulePhases[]` 保留 `phase`、`rawEvidence`、`start`、`frequency`、`weekdays`、`timeOfDay`、`durationPerLesson`、`lessonCountMin/Max`、`confidence`、`source`。
  - `diagnostics.uncertainFields[]` 列出缺失或低置信字段，供导入前确认。
- `raw` 与 `structured.rawText` 保留逐条原文；`normalizedText` 允许做解析用标点规范化。
- 地点解析只输出证据和候选查询文本，不调用高德。地点与路线工作流应把 `district + locationQueries[] + nearby` 作为输入，返回 POI 候选；用户确认后再写标准地址和坐标。

## 测试结果

在提交 `bb7bd6b` 后执行：

- `npm test`：通过。
  - 9 条批量样例数量、顺序、逐条原文和覆盖率均为 100%。
  - 行政区、明示地点、年级、学科、学生/教师性别、价格和单位均为 100%。
  - 分阶段时间召回率和已填字段证据覆盖率均为 100%；性别混淆为 0。
- `npm run cloudflare:test`：6/6 通过，包含真实 parser adapter 及编号紧凑订单契约测试。
- `npm run check:secrets`：通过；编号订单修复提交前共扫描 56 个跟踪文件。
- `git diff --check`：通过。

所有回归数据均为匿名合成数据。详细口径见 `docs/PARSER_ACCURACY.md`；样本量较小，不代表线上总体准确率。

### 后续缺陷修复

- 修复无空行的 `1️⃣…` / `2️⃣…` 长单行订单被合并的问题。
- 公共 splitter 仅在编号后的同一行同时存在年级与学科证据时建立边界，避免把普通编号要求列表误切成订单。
- 匿名合成回归固定为 2 条，断言数量、顺序、逐条原文、边界原因和 100% 覆盖率。
- 修复独立地点行“行政区 + 道路 + `·` 分隔楼盘（如某某华府）”落成“具体地点未提供”的问题；保留展示原文，并额外生成去间隔点的“区+道路+楼盘”和“区+楼盘”查询文本供地点工作流使用。
- 修复括号标题中的真实地点被 `【薪酬】` 等后续字段标签及“暑假单”前缀污染的问题；地点层现在只接受含行政区、道路、片区或楼盘特征的候选证据。

## 已知风险与跨领域依赖

- “会展附近”等范围地点不能由解析层确定唯一 POI；地点工作流必须保留 `nearby`，展示候选并要求用户确认。
- “连续上课”“周内上课”缺少明确每周次数时只保留原文证据，不应由订单或 UI 层猜测。
- 缺少明确“老师”上下文的性别描述不会推断教师性别，UI 应继续展示 `uncertainFields`。
- `parserVersion` 已升级，主任务若有硬编码版本断言或桌面客户端契约，需要同步调整为 `2.1.0`。
- 当前旧规则解析仍由 `server.js` 注入公共 recognizer；后续若迁移实现，应保持 `TutorPlatform/parser` 为唯一编排/契约边界，禁止在 Worker、UI 或地点服务复制正则。
- 道路+楼盘修复保证新解析/重新解析结果；已经持久化为“具体地点未提供”的旧订单不会由 parser 主动写库。主任务的订单领域需要决定按原文重新解析、重新导入或提供安全的一次性修复入口。

## 主任务集成顺序

1. 先集成主任务最新的协同文档提交，保留 `AGENTS.md` 和 `docs/WORKSTREAMS.md`。
2. 在集成分支 cherry-pick 功能提交 `bb7bd6b`。
3. cherry-pick 首次交接提交 `ba7e2df`，再 cherry-pick 编号订单切割修复 `cbdbe15` 和最新交接更新提交。
   已集成上述历史提交的主任务只需继续 cherry-pick `095fe4e` 和其后的最新交接更新提交。
4. 检查地点工作流是否消费 `structured.locations.value[].locationQueries`、`district` 和 `nearby`，不要把高德调用移入 parser。
5. 运行 `npm test`、`npm run cloudflare:test`、`npm run check:secrets`，并人工确认解析预览能展开证据、置信度、原文和不确定字段。
