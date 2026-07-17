# HTTP API

基础地址默认是 `http://localhost:8787`。请求和响应使用 JSON，图片读取接口除外。

## 认证方式

- 普通 API 使用 `Authorization: Bearer <token>`。
- 老师、中介和管理员 Token 由登录接口返回，只保存在服务进程内存中。
- 自动登录使用名为 `tutor_remember` 的 `HttpOnly` Cookie，浏览器请求需保持同源 Cookie。
- OCR 助手使用 `/api/login` 获取中介 Token，再调用 `/api/import`。

错误通常返回：

```json
{ "error": "可读的错误消息" }
```

## 公共和登录接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/state` | 可选登录 | 返回页面状态；管理员可看到用户/反馈，中介所有者可看到申请人 |
| GET | `/api/stats` | 公共 | 注册身份数和最近 5 分钟访客数 |
| GET | `/api/location-suggestions?q=` | 公共 | 地点输入候选，优先高德，缺少 Key 时返回有限本地候选 |
| GET | `/api/auth/config` | 公共 | 短信/微信登录是否启用及验证码时限 |
| POST | `/api/auth/sms/send` | 公共 | 发送 6 位短信验证码 |
| POST | `/api/auth/sms/verify` | 公共 | 验证码登录/注册一对老师和中介身份 |
| GET | `/api/auth/wechat/start` | 公共 | 跳转微信开放平台二维码 |
| GET | `/api/auth/wechat/callback` | 微信回调 | 换取微信身份，跳回登录页 |
| POST | `/api/auth/wechat/complete` | 公共 + ticket | 完成已绑定微信登录 |
| POST | `/api/account/login` | 公共 | 统一密码登录/首次注册，返回老师和中介双 Token |
| POST | `/api/account/remember-login` | 记住登录 Cookie | 轮换长期令牌并恢复双 Token |
| POST | `/api/login` | 公共 | 兼容单角色登录，OCR 助手当前使用此接口 |
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
  "autoLogin": false,
  "wechatBindTicket": ""
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

### OCR 兼容登录

```http
POST /api/login
Content-Type: application/json

{
  "role": "agency",
  "name": "微信自动采集",
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
| POST | `/api/import` | agency | 批量解析/导入文本或已解析订单，可携带原图 |
| POST | `/api/orders/:id/source-images` | owner agency/admin | 替换该订单的一张原图 |
| GET | `/api/orders/:id/source-images/:index` | 任意登录用户 | 读取原图二进制 |
| PATCH | `/api/orders/:id` | owner agency/admin | 中介编辑自己的订单；管理员只能改状态 |
| DELETE | `/api/orders/:id` | owner agency/admin | 删除订单和未被引用的原图 |

### 批量导入

最简单的请求：

```json
{
  "text": "<包含一条或多条订单的文字>"
}
```

OCR 助手使用的完整形式：

```json
{
  "text": "<跨屏合并后的 OCR 文字>",
  "images": ["data:image/png;base64,..."],
  "pages": [
    {
      "text": "<这一屏 OCR 文字>",
      "image": "data:image/png;base64,..."
    }
  ]
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

限制：请求体约 30 MiB；单张 Data URL 解码后最大 8 MiB；每次最多处理 40 张候选图；每条订单最终只保留一张原图。

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
| POST | `/api/settings` | admin | 保存默认地址、高德 Key 和距离参数 |
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
- `passwordHash`、`adminPasswordHash`、`amapKey`、记住登录令牌、图片文件名和内部导入指纹不会通过该接口返回。

## CORS 和浏览器说明

当前响应设置 `Access-Control-Allow-Origin: *`，但没有完整生产级跨域配置。前端和 API 设计为同源部署。正式上线应限制允许域名，并明确 `Allow-Headers`、`Allow-Methods` 和凭证策略。
