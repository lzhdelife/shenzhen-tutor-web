# 数据模型

正式站使用 Cloudflare D1 `shenzhen-tutor-prod`，通过 `cloudflare/migrations/` 进行版本化迁移。本地开发使用 `TutorPlatform/data/db.json`；`readDb()` 会为缺失根字段补默认值，但本地 JSON 不是正式生产数据源。

## 正式订单存储

正式订单拆为一张订单主表和一张一对一地点表。列表常用字段独立成列，完整解析结果保留在 JSON 中：

### `orders`

| 列 | 说明 |
| --- | --- |
| `id` | 订单主键 |
| `agency_id` | 关联 `users.id` 的发单身份；删除该身份会级联删除其订单 |
| `source` / `status` | 发单来源和兼容状态；当前新订单使用 `open` |
| `district` / `subject` / `grade` / `price` | 列表筛选、排序常用字段 |
| `import_fingerprint` | 规范化原文的 SHA-256 指纹；唯一索引负责最终防重 |
| `structured_json` | 完整订单快照：原文、解析字段、证据、置信度和扩展字段 |
| `created_at` / `updated_at` | 创建和更新时间 |

### `order_locations`

`order_id` 同时是主键和指向 `orders.id` 的外键，因此每个订单最多有一条地点记录，删除订单时地点会自动级联删除。

| 列 | 说明 |
| --- | --- |
| `place` / `address` / `original_place` | 展示地点、查询地址和高德处理前的地点文本 |
| `verified` / `status` / `confidence` | 地点是否确认、核验状态和匹配置信度 |
| `poi_id` / `coordinates` / `resolved_address` | 高德 POI、经纬度和标准地址 |
| `query_text` / `queries_json` | 地点查询主文本及备选查询组合 |
| `candidates_json` | 高德候选列表，供人工复核 |
| `options_json` / `relation` | 多地点选项及其关系；`OR` 为二选一，`PHASED` 为暑假/开学后等分阶段地点 |
| `updated_at` | 地点最后更新时间 |

发单人的称呼和联系方式不复制进订单正文。订单只保存 `agency_id`，用户主动点击“申请接单”时再通过 `publisher_access` 读取对应资料。老师自己的出发位置、直线距离和路线结果不写入订单数据库。

### `order_issue_reports`

一键“识别有误”反馈与订单展示状态相互独立。每条记录保存反馈发生时的原文、识别结果快照和解析器版本；不保存错误分类或用户说明。

| 列 | 说明 |
| --- | --- |
| `id` | 反馈记录主键 |
| `target_key` | 已发布订单为 `order:<id>`；预览为规范原文 SHA-256 |
| `order_id` | 可空订单外键；订单删除后置空，反馈快照继续保留 |
| `source` | `published` 或 `preview` |
| `reporter_key` | 匿名浏览器身份对应的用户 ID，仅用于同人去重和多人计数 |
| `raw_text` | 反馈时的订单原文 |
| `parsed_snapshot_json` | 反馈时的完整识别结果快照 |
| `parser_version` | 产生该结果的解析器版本 |
| `created_at` / `updated_at` | 首次和最近反馈时间 |

`target_key + reporter_key` 唯一：同一人重复点击不会增加人数，不同人可共同标记同一目标。该表只通过管理员状态返回；导出文件不包含 `reporter_key`、发单人联系方式或其他身份资料。

管理端导出 TXT 和 JSONL 后，按每条记录的 `id + updated_at` 删除本次导出快照。导出期间新增的记录，或在导出后被再次更新而改变 `updated_at` 的记录不会被清理。

## 本地 JSON 兼容模型

## 根对象

```json
{
  "settings": {},
  "users": [],
  "orders": [],
  "orderIssueReports": [],
  "feedback": [],
  "announcement": {},
  "rememberSessions": []
}
```

本地 `orderIssueReports[]` 与正式表使用同名驼峰字段，用于保持本地和 Worker API 契约一致；它不是正式生产数据源。

匿名空库见 `examples/TutorPlatform-db.example.json`。

## `settings`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `homeAddress` | string | 管理端默认出发地 |
| `maxBikeKm` | number | 历史默认骑行范围，当前路线 UI 仍沿用该配置 |
| `adminPasswordHash` | string | `salt:scryptHex`，敏感数据 |

## `users[]`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `u-...` |
| `role` | string | `teacher` 或 `agency` |
| `name` | string | 老师名或机构名 |
| `phone` | string | 11 位中国大陆手机号 |
| `passwordHash` | string? | `salt:scryptHex`；旧账号可能没有 |
| `preferences` | object? | 仅老师账号使用的筛选偏好 |
| `createdAt` | ISO string | 创建时间 |

统一登录会为相同 `name + phone` 创建老师和中介两条记录。管理删除和密码重置把它们视为同一身份。

### 老师 `preferences`

```json
{
  "filters": {
    "district": [],
    "subject": [],
    "grade": [],
    "gender": []
  },
  "minPrice": 0,
  "onlyRange": false,
  "origin": "",
  "routeMode": "cycling",
  "updatedAt": "<ISO time>"
}
```

服务端会用允许列表清洗多选值，并限制起点长度和最低课酬范围。

## `orders[]`

### 身份和状态

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `o-...` |
| `agencyId` | string | 发布中介用户 ID |
| `source` | string | 发布中介显示名 |
| `status` | string | `open`、`matched`、`closed` |
| `createdAt` | ISO string | 创建时间 |

### 解析字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `district` | string | 深圳区名，不带“区” |
| `place` | string | 展示地点 |
| `address` | string | 用于地理编码的完整地址 |
| `subject` | string | 一个或多个科目文本 |
| `grade` | string | 规范化年级 |
| `gradeDescription` | string | 保留“复习初三并预习高一”等跨阶段教学语义 |
| `price` | number | 原始计价单位下的代表价格（区间取中值） |
| `priceMin` / `priceMax` | number | 原始价格区间；单价时两者相同 |
| `priceUnit` | string | `小时`、`次`、`2小时`、`天`或`月`等原始计价单位 |
| `hourlyPrice` | number | 仅在能可靠换算时提供的参考时薪 |
| `priceApproximate` | boolean | 原文是否包含“左右/约/大概” |
| `priceText` | string | 原始课酬文本 |
| `monthly` | number | 包月订单的月薪，普通订单通常为 0 |
| `schedule` | string | 开始日期、频率、时段和时长原文摘要 |
| `gender` | string | `男老师`、`女老师`、`不限` 或空 |
| `student` | string | 学生性别、成绩和情况 |
| `studentGender` | string | 学生性别，与教师性别严格分离 |
| `requirements` | string | 教师能力、院校、经验和其他要求 |
| `raw` | string | 清洗后的订单原文 |
| `structured` | object? | 解析预览契约；包含原文证据、0–1 置信度、来源和 `uncertainFields`，导入前用于人工确认 |

### 地点核验和路线

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `placeOriginal` | string? | 高德处理前的原始地点 |
| `locationVerified` | boolean | 是否通过真实地点候选核验 |
| `locationStatus` | string | `confirmed` 表示用户确认；另有 `verified`、`ambiguous`、`not_found` 等解析状态 |
| `locationPoiId` | string? | 高德 POI ID |
| `locationCoordinates` | string? | `longitude,latitude` |
| `locationAddress` | string? | 高德候选地址 |
| `locationConfidence` | number? | 本地匹配评分 |
| `locationQuery` / `locationQueries` | string/string[] | 按区、街道/片区、社区/小区组合的高德查询 |
| `locationCandidates` | array | 低置信度时保留给预览人工选择的 2–3 个候选 |
| `locationOptions` | array | 二选一或分阶段订单的多个地点；每项独立保存阶段、POI、坐标、置信度和路线 |
| `locationRelation` | string | 多地点关系：`OR` 或 `PHASED` |
| `distanceKm` | number/string | 高德返回的路线距离；失败时为空 |
| `routeMode` | string | 实际路线标签或明确的不可用状态，不再伪装成本地估算 |
| `score` | number | 当前设置下的匹配分数，可重新计算 |

老师按自己起点计算的四种路线不会持久写入订单，前端保存在当前页面状态中。

解析预览中的每个地点选项还包含 `raw`、`query`、`locationQueries[]` 和 `nearby`。这些字段只表达文本证据与候选查询意图；POI、坐标和最终地址只能由独立地图核验或用户确认补充。

### 去重

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `importFingerprint` | string | 近期语义去重指纹，公开状态接口会移除 |

## `feedback[]`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `f-...` |
| `name` | string | 可选反馈人 |
| `contact` | string | 可选联系方式 |
| `content` | string | 反馈正文 |
| `createdAt` | ISO string | 创建时间 |

只保留最近 200 条。

## `announcement`

```json
{
  "title": "",
  "content": "",
  "active": false,
  "updatedAt": ""
}
```

普通访问者只收到启用的公告，管理员可看到已撤下内容。

## `rememberSessions[]`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tokenHash` | string | Cookie 随机令牌的 SHA-256 |
| `name` | string | 身份名称 |
| `phone` | string | 身份手机号 |
| `createdAt` | ISO string | 创建时间 |
| `expiresAt` | number | Unix 毫秒时间戳，默认 30 天 |

服务会在使用时清理过期记录并轮换令牌，最多保留最近 500 条。

## 迁移注意事项

迁移 PostgreSQL 时至少需要 `identities/users`、`orders`、`order_locations`、`publisher_access`、`teacher_preferences`、`announcements`、`feedback` 和 `sessions` 表。应增加：

- 用户角色 + 名称 + 手机号唯一约束。
- 中介订单编号/指纹的适当唯一约束。
- 外键和级联规则。
- 状态枚举或检查约束。
- 创建/更新时间和软删除字段。
- 数据库迁移版本表。
