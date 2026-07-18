# 本地开发与测试

## 环境要求

- Node.js 20 或更高版本。
- Node 本地服务只使用标准库；Cloudflare 本地工具由 `npm.cmd install` 安装。

## 启动网站

```powershell
npm.cmd start
```

也可在 `TutorPlatform` 目录双击 `start.bat`。默认地址为 <http://localhost:8787>。

`npm.cmd start` 和 `start.bat` 会自动读取仓库根目录中被 Git 忽略的 `.env.local`。首次配置高德时，双击 `TutorPlatform/配置本地高德Key.bat`，按提示输入 Web 服务 Key、Web端（JS API）Key和安全密钥，然后重新启动网站。

```powershell
$env:PORT = '9000'
node TutorPlatform/server.js
```

首次读写数据时会创建 `TutorPlatform/data/db.json`。匿名初始结构见 `examples/TutorPlatform-db.example.json`。

## 公开测试

```powershell
npm.cmd test
npm.cmd run cloudflare:test
npm.cmd run check:secrets
```

地图合成测试使用注入的假 HTTP 响应，不访问高德。需要本地联调时仅在当前进程环境设置 `AMAP_WEB_SERVICE_KEY`；无 Key 时 API 会明确返回未配置，且不会提供本地伪候选或伪路线。

地图视图本地联调还需设置 `AMAP_JS_API_KEY` 和 `AMAP_JS_SECURITY_CODE`。前者必须是“Web端（JS API）”类型并配置本地域名，后者只留在 Node/Worker 环境；页面通过同源 `/_AMapService` 代理使用安全密钥。

根目录 `tests/` 只能包含匿名合成数据，不得提交真实用户、手机号、地址、聊天文字或订单图片。

## 修改检查清单

- 解析规则：测试多单拆分、非订单文本分类、弱字段订单、重复订单和原文无损覆盖。
- 权限：测试未登录、老师、订单所有者、其他中介、管理员五种情况。
- 数据字段：兼容缺失字段的旧 JSON，并更新 `docs/DATA_MODEL.md`。
- API：更新 `docs/API.md`。
- 上传前：检查 `git status`，运行密钥扫描，并确认没有真实运行数据。
