# 高德地点与路线实现审计

## 三类配置与实际调用

三个配置不是三把同类 Key，不会轮换分摊额度，也不会在每次操作中全部调用。

| 配置 | 所在位置 | 实际用途 | 直接请求的高德接口 |
| --- | --- | --- | --- |
| `AMAP_WEB_SERVICE_KEY` | Cloudflare Worker Secret / 本地服务端环境变量 | 服务端地点候选、订单地点补全、起点地理编码、批量距离 | `/v3/place/text`、`/v3/geocode/geo`、四类路线接口 |
| `AMAP_JS_API_KEY` | Worker Secret，经 `/api/map-config` 返回浏览器 | 加载高德 JS API 2.0、地图底图、标记、聚合、地图内路线插件 | JS API Loader 及插件发起的地图资源/路线请求 |
| `AMAP_JS_SECURITY_CODE` | Worker Secret，不返回浏览器 | 为 JS API 2.0 请求提供安全代理签名 | Worker 将 `/_AMapService/*` 转发到高德并附加 `jscode` |

`AMAP_WEB_SERVICE_KEY` 的明确 REST 调用：

- 地点文本搜索：`/v3/place/text`。用户输入“我的位置”获取下拉候选时调用；导入订单时，每个尚未确认的地点或备选地点也可能调用一次。
- 地理编码：`/v3/geocode/geo`。计算服务端路线时，如果起点或终点只有文字、没有经纬度才调用；已有经纬度则不调用。
- 步行路线：`/v5/direction/walking`。
- 骑行路线：`/v5/direction/bicycling`。
- 驾车路线：`/v5/direction/driving`。
- 公交路线：`/v3/direction/transit/integrated`。

`AMAP_JS_API_KEY` 与 `AMAP_JS_SECURITY_CODE` 总是配合 JS 地图使用，但承担不同职责：前者标识 Web 端应用，后者由同源代理附加安全签名。打开列表页、粘贴纯文本、查看订单详情都不会因此加载地图；切换到地图视图才加载地图 SDK 和聚合插件，点击“规划路线”才由 Walking、Riding、Driving 或 Transfer 插件发起相应路线请求。

### 一次操作大致产生的调用

- 只浏览订单列表：0 次高德调用。
- 输入位置候选：防抖后通常 1 次 `/v3/place/text`；相同查询可命中边缘缓存，命中时不请求高德。
- 导入一条地点未确认的订单：通常 1 次 `/v3/place/text`；二选一地点通常最多各搜索一次。
- 服务端计算一个订单的一种通勤方式：通常 1 次路线调用；起点是文字时额外 1 次地理编码。多个地点选项会分别规划路线。
- 第一次打开地图：加载一次 JS API 及地图资源；标记和聚合在浏览器内完成，不逐条调用地点搜索。
- 在地图中规划一条路线：JS 路线插件发起一次规划请求，并通过 `/_AMapService` 使用 Security Code。

当前管理端没有展示高德控制台的额度消耗。真实扣量应以高德开放平台控制台为准；平台侧若以后需要精确监控，应在 `cloudflare/amap-service.js` 和 `/_AMapService` 代理层增加按接口聚合计数，而不是在前端估算。

## 基线 `005502f`

- Node 后端真实调用高德 POI、输入提示、地理编码和路线 API，但吞掉超时/限流/错误响应；路线失败后使用硬编码区/地点公里数并标为“估算”。
- Node 允许管理页面提交 `amapKey` 并持久化到 `db.json`，虽然公开状态会裁剪该字段，仍不符合服务端 Secret 边界。
- Cloudflare 解析适配器会把 Worker Secret 传给 Node 地点解析，因此 `/api/parse` 可真实查高德；但 Worker 本身没有地点候选、候选确认或路线预览接口，公网闭环不完整。
- 前端预览可选择单地点候选并把 POI/经纬度带入导入请求，但标准地址只用候选名称拼接；地点二选一没有逐项候选确认控件。
- Cloudflare D1 的 `order_locations` 已能保存候选、POI、经纬度、多个地点选项，存储层不是阻塞点。

## 当前实现边界

- Cloudflare `/api/location-suggestions` 只返回真实高德候选，并支持深圳区名约束；无 Key、无结果、超时、限流和上游错误互相区分。
- 单地点和“地点二选一”均可在预览中人工确认。已保存订单还可通过 `/api/orders/:id/location/confirm` 服务端校验并持久化标准地址、POI 和经纬度。
- `/api/distance-preview` 只为已确认且有经纬度的地点调用高德路线，支持步行、骑行、开车和公共交通；返回 `source: "amap"` 与 `status: "verified"`，失败不回退成本地估算。
- Key 只从 Node 环境变量或 Cloudflare Worker Secret `AMAP_WEB_SERVICE_KEY` 读取。浏览器、Node 设置数据库和 D1 均不接收或返回 Key。
- 合成测试注入 HTTP 响应，不访问真实高德，也不包含真实 Key。

## 订单地图扩展

- 老师端支持列表/地图切换，地图仅加载开放订单中已确认的坐标，并使用 `AMap.MarkerCluster` 聚合。
- 地图标记弹层只展示现有订单摘要，可跳回并高亮列表卡片；地点二选一可产生两个关联点。
- Web端（JS API）Key 与 Web 服务 Key 分离。浏览器 Key 由 `/api/map-config` 提供并应绑定域名，安全密钥只由 Node/Worker 的 `/_AMapService` 同源代理使用。
- 精确坐标从老师鉴权的 `/api/map-orders` 最小接口获取；非订单所有者的普通状态响应会裁剪精确地址和坐标。
