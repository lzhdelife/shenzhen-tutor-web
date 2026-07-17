# Cloudflare 部署

本部署目标使用一个 Cloudflare Worker 同源提供静态页面和 `/api/*`，D1 保存业务数据。

## 资源

- Worker: `shenzhen-tutor-web`
- D1: `shenzhen-tutor-prod`，binding 为 `DB`
- 正式域名：`tutor.liuzonghao.top`

`wrangler.jsonc` 中的 D1 `database_id` 初始是占位值。执行 `wrangler d1 create` 后必须替换为 Cloudflare 返回的真实 UUID，不能把 API Token 或第三方密钥写入配置文件。

## 本地验证

```powershell
npm.cmd install
npm.cmd run cloudflare:test
npx.cmd wrangler d1 migrations apply shenzhen-tutor-prod --local
npm.cmd run cloudflare:dev
```

本地敏感配置放在 `.dev.vars`，模板见 `.dev.vars.example`。

## 正式资源与发布

```powershell
npx.cmd wrangler login
npx.cmd wrangler d1 create shenzhen-tutor-prod
npx.cmd wrangler d1 migrations apply shenzhen-tutor-prod --remote
npx.cmd wrangler secret put SESSION_SIGNING_SECRET
npx.cmd wrangler secret put AMAP_WEB_SERVICE_KEY
npm.cmd run cloudflare:deploy
```

`AMAP_WEB_SERVICE_KEY` 只允许通过 `wrangler secret put` 配置，不得放入 `wrangler.jsonc`、前端或 D1。未配置时地点接口返回 `AMAP_NOT_CONFIGURED`；部署验收应覆盖候选、确认保存和四种路线模式，并以响应中的 `source: "amap"` / `status: "verified"` 判断真实调用成功。

先使用 `*.workers.dev` 验收。Cloudflare zone 激活后，再为 Worker 添加 `tutor.liuzonghao.top` Custom Domain。正式环境必须保持 `SMS_DEV_MODE=0`。

## 数据与回滚

D1 migration 文件只包含表结构，不包含真实账号、手机号、订单或密钥。旧 `db.json` 的一次性迁移必须先停止本地写入并制作加密备份，再导入 D1，最后核对用户数、订单数和申请数。旧本地副本在正式验收后仍保留为只读备份。
