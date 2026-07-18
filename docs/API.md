# HTTP API

基础地址默认是 `http://localhost:8787`。请求和响应使用 JSON。

## 认证方式

- 普通 API 使用 `Authorization: Bearer <token>`。
- 老师、中介和管理员 Token 由登录接口返回，只保存在服务进程内存中。
- 自动登录使用名为 `tutor_remember` 的 `HttpOnly` Cookie，浏览器请求需保持同源 Cookie。
- 批量导入使用中介 Token 调用 `/api/import`。

错误通常返回；地图上游错误还会包含稳定的 `code` 和不含密钥的 `details`：

```json
{ "error": "可读的错误消息" }
```

## 公共和登录接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/state` | 可选登录 | 返回页面状态；管理员可看到用户/反馈，中介所有者可看到申请人 |
| GET | `/api/stats` | 公共 | 注册身份数和最近 5 分钟访客数 |
| GET | `/api/location-suggestions?q=&district=` | 公共 | 查询高德地点候选，可用深圳区名约束；不返回本地伪候选 |
| GET | `/api/map-config` | 公共 | 返回 JS API 是否配置、域名受限的浏览器 Key 和同源安全代理地址；不返回安全密钥 |
| GET | `/api/map-orders` | teacher | 仅返回开放订单 ID 与已确认坐标，不返回门牌地址或学生信息 |
| POST | `/api/account/login` | 公共 | 统一密码登录/首次注册，返回老师和中介双 Token |
| POST | `/api/account/remember-login` | 记住登录 Cookie | 轮换长期令牌并恢复双 Token |
| POST | `/api/login` | 公共 | 兼容单角色登录 |
| POST | `/api/feedback` | 公共 | 提交问题反馈，最多保留最近 200 条 |

### 统一密码登录

```http
POST /api/account/login
Content-Type: application/json

{
  "name": "示例老师",
  "phone": "<11位手机号>",
  "password": "<至少6位密码>",
  "rememberAccount": true,
  "autoLogin": false
}
```

成功响应：

```json
{
  "teacher": { "id": "...", "role": "teacher", "name": "示例老师", "phone": "..." },
  "agency": { "id": "...", "role": "agency", "name": "示例老师", "phone": "..." },
  "teacherToken": "...",
  "agencyToken": "..."
}
```

不存在的“名称 + 手机号”会在当前实现中自动注册。生产系统应把注册与登录分开。

地点候选成功响应为 `{ "status": "candidates", "suggestions": [...] }`。每个候选包含 `name`、`district`、`address`、`location`，以及可直接填入“我的位置”的标准地址 `value`。前端必须展示名称、区和地址供用户选择；无 Key 返回 HTTP 503、`AMAP_NOT_CONFIGURED` 和“高德服务未配置”，不生成占位候选。

地图使用独立的高德 Web端（JS API）Key。`/api/map-config` 只在 `AMAP_JS_API_KEY` 和 `AMAP_JS_SECURITY_CODE` 同时存在时返回 `configured: true`；安全密钥仅由 `/_AMapService/*` 同源代理追加到高德请求。普通订单状态会裁剪非订单所有者可见的精确地址和经纬度，老师地图通过鉴权后的 `/api/map-orders` 获取最小坐标集合。

### 单角色兼容登录

```http
POST /api/login
Content-Type: application/json

{
  "role": "agency",
  "name": "示例中介",
  "phone": "<11位手机号>",
  "password": "<至少6位密码>"
}
```

返回 `{ "user": {...}, "token": "..." }`。

## 老师接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/distance-preview` | teacher | 对所有未关闭订单计算指定路线模式 |
| GET | `/api/teacher/preferences` | teacher | 读取账号保存的筛选偏好 |
| PUT | `/api/teacher/preferences` | teacher | 保存多选筛选、起点、路线和最低课酬 |
| POST | `/api/orders/:id/apply` | teacher | 申请订单并返回发单人联系方式 |

路线预览请求：

```json
{
  "origin": "深圳市某地铁站",
  "mode": "cycling"
}
```

`mode` 可为 `walking`、`cycling`、`driving`、`transit`。

Cloudflare 响应顶层 `status` 为 `verified`；每条路线带 `source: "amap"`。未确认地点返回 `location_unconfirmed`，无 Key、超时、限流和高德错误分别返回 `AMAP_NOT_CONFIGURED`、`AMAP_TIMEOUT`、`AMAP_RATE_LIMITED`、`AMAP_API_ERROR`，不会回退成“已验证”距离。

偏好结构：

```json
{
  "filters": {
    "district": ["南山", "宝安"],
    "subject": ["数学", "物理"],
    "grade": ["初中", "高中"],
    "gender": ["男老师", "男女不限"]
  },
  "minPrice": 150,
  "onlyRange": false,
  "origin": "深圳市某地铁站",
  "routeMode": "cycling"
}
```

申请响应包含 `alreadyApplied`、`contact` 和当前 `applicant`。重复申请不会重复写入。

## 中介和订单接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/orders` | agency | 手工创建一条订单 |
| POST | `/api/parse` | agency | 拆分并预览粘贴文字，不写数据库 |
| POST | `/api/import` | agency | 批量解析/导入文本或已解析订单 |
| PATCH | `/api/orders/:id` | owner agency/admin | 中介编辑自己的订单；管理员只能改状态 |
| DELETE | `/api/orders/:id` | owner agency/admin | 删除订单 |
| POST | `/api/orders/:id/location/confirm` | owner agency/admin | 确认高德候选并保存标准地址、POI 和经纬度 |

候选确认请求为 `{ "candidate": { "id", "name", "district", "address", "location" }, "district": "南山" }`。服务端校验经纬度和区名冲突，成功后写入 `locationStatus: "confirmed"`。

### 批量导入

`POST /api/parse` 返回 `{ parserVersion, parsed, splitDiagnostics, ignoredBlocks }`。`splitDiagnostics` 中每项包含 `blockIndex`、`sourceBlockIndex`、`rawStart`、`rawEnd`、`boundaryReason`、`classification` 和 `confidence`。每段切割文本先经过订单最小证据分类；有效订单进入 `parsed[]`，群名、闲聊、广告前缀等非订单文本进入 `ignoredBlocks[]`，其中保留原文、跨度、分类证据和忽略原因。预览不会去重，也不会静默丢弃被忽略原文。

每个 `parsed[]` 项包含统一的 `structured` 契约。可抽取字段使用 `{ value, rawEvidence, confidence, source }`；`structured.locations.value[]` 同时保留地点原文、行政区、展示地点、`query/locationQueries`、附近语义和二选一关系。`structured.schedulePhases[]` 保留阶段、开始时间、频次、星期、时段、单次时长和课次范围。`structured.diagnostics.uncertainFields[]` 必须在导入前展示给用户确认。解析层只生成地点证据和查询文本，不负责调用地图服务。

最简单的请求：

```json
{
  "text": "<包含一条或多条订单的文字>"
}
```

也可提交 `{ "orders": [{ "raw": "...", "district": "..." }] }`。服务会重新建立解析默认值，再用传入字段覆盖。

成功响应：

```json
{
  "created": [],
  "duplicatesSkipped": 0,
  "incompleteSkipped": 0
}
```

### 修改权限

- 中介可修改：`status`、地点、科目、年级、价格、时间、性别、学生、要求和原文。
- 管理员通过单条 `PATCH` 只能修改 `status`。
- 状态值由前端使用 `open`、`matched`、`closed`；服务端当前没有严格枚举校验。

## 账号密码接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/account/password` | teacher/agency | 登录状态下修改当前角色密码 |
| POST | `/api/account/password-by-identity` | 公共 + 原密码 | 按名称/手机号同时修改双角色密码 |
| POST | `/api/admin/reset-password` | admin | 管理员重置同一身份的双角色密码 |

修改密码会撤销该身份全部记住登录令牌。

## 管理接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/admin/setup` | 未配置时公共 | 首次设置至少 8 位管理员密码 |
| POST | `/api/admin/login` | 公共 | 管理员密码登录 |
| POST | `/api/admin/batch-delete-orders` | admin | 最多接收 5000 个订单 ID |
| POST | `/api/admin/batch-delete-users` | admin | 删除选中身份、关联订单/申请/会话 |
| POST | `/api/admin/announcement` | admin | 发布或撤下公告 |
| POST | `/api/settings` | admin | 保存默认地址和距离参数；不接收高德 Key |
| POST | `/api/admin/reconcile-locations` | admin | 对指定或全部订单重新核验地点 |

批量删除订单请求：

```json
{ "orderIds": ["o-...", "o-..."] }
```

批量删除用户请求：

```json
{ "userIds": ["u-...", "u-..."] }
```

同一“名称 + 手机号”的老师和中介会作为一个身份一起删除。

## `/api/state` 返回裁剪

所有访问者都能得到公开订单、列表、公告和统计。返回内容根据 Bearer Token 变化：

- 老师：订单不包含申请人明细。
- 中介：自己的订单包含申请人明细，其他订单不包含。
- 管理员：所有申请人、用户列表和反馈列表可见。
- `passwordHash`、`adminPasswordHash`、记住登录令牌、图片文件名和内部导入指纹不会通过该接口返回。高德 Key 仅存在于服务端环境/Secret，任何 API 都不返回。

## CORS 和浏览器说明

当前响应设置 `Access-Control-Allow-Origin: *`，但没有完整生产级跨域配置。前端和 API 设计为同源部署。正式上线应限制允许域名，并明确 `Allow-Headers`、`Allow-Methods` 和凭证策略。
