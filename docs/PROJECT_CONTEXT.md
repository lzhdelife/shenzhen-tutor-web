# 深圳家教接单平台：项目上下文

这份文档用于跨 Codex 任务、账号和开发人员交接。任何结论都应以当前 `main` 分支的实际代码、测试和其他文档为准；本文提供方向，不替代代码检查。

## 产品定位

- 网站是完整主系统，面向深圳家教订单的共同上传、识别、去重、浏览和地图看单。
- 普通用户打开即用，不要求注册或登录；浏览器生成匿名设备身份并在本地保存偏好。
- Windows 剪贴板 EXE 已不再作为主流程。网页保留粘贴文字和 TXT 导入，EXE 服务端接口只作兼容，不应让网页持续轮询。
- 当前优先级是公网 PC/手机网页的快速、高效和稳定。复杂、低使用率、持续消耗后端资源的功能应优先删减。
- 产品界面遵循直觉，不用大段说明文字解释基础操作。

## 核心流程

1. 用户在发单页粘贴一条或多条订单，或拖入 TXT。
2. 前端立即清空输入框并加入顺序队列，向用户显示排队、识别和发布状态。
3. 共享解析器负责切割、过滤非订单文本和结构化识别；UI、EXE 和地图模块不得复制解析逻辑。
4. 后端对未确认地点调用高德地点候选，保存结构化订单和地点结果。
5. 导入层使用原文规范化、订单编号和语义指纹阻止重复订单。
6. 开放订单在三天后按上海时区定时清理。

## 模块边界

- `TutorPlatform/parser/`：订单切割、分类和字段识别。
- `shared/`：前后端共享的去重、导入清洗、评分和保留期规则。
- `TutorPlatform/public/`：网页 UI 与交互，不实现解析或高德业务规则。
- `TutorPlatform/server.js`：本地 Node 后端，主要用于快速开发与回归测试。
- `cloudflare/worker.js`：正式站 API、权限、导入编排和定时任务。
- `cloudflare/storage.js`：D1 数据访问层。
- `cloudflare/amap-service.js`：服务端唯一的高德 Web 服务实现。
- `clipboard-bridge/`：低耦合兼容增强器，不是网站运行前提。

## 数据与隐私

- 正式业务数据存储在 Cloudflare D1 `shenzhen-tutor-prod`。
- 本地开发数据存储在 `TutorPlatform/data/db.json` 或 `TUTOR_DATA_DIR` 指定目录，不应覆盖或提交真实用户数据。
- 浏览器偏好和匿名设备 ID 存在 `localStorage`；会话令牌存在 `sessionStorage` 或 HttpOnly Cookie。
- 访客统计只保存随机浏览器访客 ID、首次活跃、最后活跃和访问次数，不保存定位或粘贴内容。
- 管理员凭证经过客户端派生和服务端 Pepper 保护；真实密钥只保存在 Cloudflare Worker Secret 或本地 `.dev.vars`。
- 禁止把真实密钥、Token、手机号、订单数据或导出 SQL 提交到 Git。

## 访问统计

- 公共“总访问量”是页面打开次数，刷新会增加。
- 管理端“累计访客”按浏览器 `localStorage.tutorPlatformVisitorId` 去重；清除浏览器数据或更换浏览器会被视为新访客。
- 管理端“实时在线”统计最近 90 秒内发送过可见页面心跳的访客。
- 心跳每 30 秒发送一次，仅更新最后活跃时间，不增加总访问量。
- 访客数据从 `0003_visitor_activity.sql` 上线后开始积累，无法从旧页面打开次数准确反推历史人数。

## 高德地图

详细调用表见 [AMAP_AUDIT.md](./AMAP_AUDIT.md)。关键边界：

- `AMAP_WEB_SERVICE_KEY`：服务端地点搜索、地理编码和路线 REST API。
- `AMAP_JS_API_KEY`：浏览器加载地图、标记聚合和 JS 路线插件。
- `AMAP_JS_SECURITY_CODE`：JS API 2.0 安全密钥，仅由 Worker 同源代理使用，不返回浏览器。
- 三者职责不同，不是三个可轮换的同类 Key，也不会在每个页面请求中一起调用。

## 部署

- GitHub：`https://github.com/lzhdelife/shenzhen-tutor-web`
- 稳定分支：`main`
- Worker：`shenzhen-tutor-web`
- 正式域名：`https://tutor.liuzonghao.top`
- 配置：`wrangler.jsonc`

标准发布顺序：

```powershell
npm.cmd test
npm.cmd run cloudflare:test
npm.cmd run check:secrets
git diff --check
npx.cmd wrangler d1 migrations apply shenzhen-tutor-prod --remote
npm.cmd run cloudflare:deploy
```

迁移必须先测试再应用；部署后检查正式域名的静态页面、核心 API 和移动端布局。提交应清晰，推送 GitHub 失败时不得影响已验证的本地提交或正式部署，但必须明确报告。

## 稳定性取舍

- 保留：粘贴/TXT 导入、去重、三天清理、列表/地图、地点候选、直线距离、核心管理操作。
- 已移除：普通用户登录门槛、问题反馈入口、平台公告、平台设置、网页端 EXE 队列高频轮询。
- 兼容但不主动运行：剪贴板桥接服务端 API 和旧公告数据表。
- 谨慎扩展：实时通信、第三方统计 SDK、AI 在线解析、大型管理报表。没有明确收益和容量方案时不引入。

## 开发交接

新任务开始时：

1. 进入仓库并检查 `git status --short --branch`、`git log -5 --oneline`。
2. 阅读本文及与任务相关的专项文档。
3. 以当前代码和测试为事实来源，不依赖旧聊天记忆。
4. 保留用户数据和密钥，不擅自部署其他公网环境。
5. 修改后运行与风险相称的测试、真实浏览器验收和 `git diff --check`。
