# 高德地点与路线实现审计

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
