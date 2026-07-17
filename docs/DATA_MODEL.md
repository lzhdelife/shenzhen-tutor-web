# 数据模型

当前数据库是 `TutorPlatform/data/db.json`。`readDb()` 在读取时为缺失的根字段补默认值，但没有 schema 版本和迁移系统。

## 根对象

```json
{
  "settings": {},
  "users": [],
  "orders": [],
  "feedback": [],
  "announcement": {},
  "rememberSessions": []
}
```

匿名空库见 `examples/TutorPlatform-db.example.json`。

## `settings`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `homeAddress` | string | 管理端默认出发地 |
| `amapKey` | string | 本地兼容用的高德 Web 服务 Key；生产环境优先使用 `AMAP_WEB_SERVICE_KEY` |
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

### 地点核验和路线

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `placeOriginal` | string? | 高德处理前的原始地点 |
| `locationVerified` | boolean | 是否通过真实地点候选核验 |
| `locationStatus` | string | 例如 `verified`、`ambiguous`、`unresolved` |
| `locationPoiId` | string? | 高德 POI ID |
| `locationCoordinates` | string? | `longitude,latitude` |
| `locationAddress` | string? | 高德候选地址 |
| `locationConfidence` | number? | 本地匹配评分 |
| `locationQuery` / `locationQueries` | string/string[] | 按区、街道/片区、社区/小区组合的高德查询 |
| `locationCandidates` | array | 低置信度时保留给预览人工选择的 2–3 个候选 |
| `locationOptions` | array | “A 或 B/二选一/均可”订单的多个地点；每项独立保存 POI、坐标、置信度和路线 |
| `locationRelation` | string | 多地点关系，当前为 `OR` |
| `distanceKm` | number/string | 默认路线或估算距离 |
| `routeMode` | string | 实际路线标签或“估算/地点待核实” |
| `score` | number | 当前设置下的匹配分数，可重新计算 |

老师按自己起点计算的四种路线不会持久写入订单，前端保存在当前页面状态中。

### 去重和申请

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `importFingerprint` | string | 近期语义去重指纹，公开状态接口会移除 |
| `applicants` | array | 申请老师列表 |

申请项：

```json
{
  "teacherId": "u-...",
  "name": "示例老师",
  "phone": "<手机号>",
  "note": "",
  "at": "<ISO time>",
  "status": "pending"
}
```

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

迁移 PostgreSQL 时至少需要 `identities/users`、`orders`、`applications`、`teacher_preferences`、`announcements`、`feedback` 和 `sessions` 表。应增加：

- 用户角色 + 名称 + 手机号唯一约束。
- 中介订单编号/指纹的适当唯一约束。
- 外键和级联规则。
- 状态枚举或检查约束。
- 创建/更新时间和软删除字段。
- 数据库迁移版本表。
