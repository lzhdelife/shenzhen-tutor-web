# 本地开发与测试

## 环境要求

- Node.js 20 或更高版本。
- 网站只使用 Node.js 标准库，不需要安装 npm 依赖。

## 启动网站

```powershell
npm.cmd start
```

也可在 `TutorPlatform` 目录双击 `start.bat`。默认地址为 <http://localhost:8787>。

```powershell
$env:PORT = '9000'
node TutorPlatform/server.js
```

首次读写数据时会创建 `TutorPlatform/data/db.json`。匿名初始结构见 `examples/TutorPlatform-db.example.json`。

## 本地短信模式

没有腾讯云短信账号时，可仅在本机临时启用开发模式：

```powershell
$env:SMS_DEV_MODE = '1'
npm.cmd start
```

此模式会在 API 响应中返回验证码，绝不能用于公网或共享环境。正式短信变量见 `.env.example`。

## 公开测试

```powershell
npm.cmd test
npm.cmd run check:secrets
```

地图合成测试使用注入的假 HTTP 响应，不访问高德。需要本地联调时仅在当前进程环境设置 `AMAP_WEB_SERVICE_KEY`；无 Key 时 API 会明确返回未配置，且不会提供本地伪候选或伪路线。

根目录 `tests/` 只能包含匿名合成数据，不得提交真实用户、手机号、地址、聊天文字或订单图片。

## 修改检查清单

- 解析规则：测试多单拆分、半单暂缓、重复订单和原图匹配。
- 权限：测试未登录、老师、订单所有者、其他中介、管理员五种情况。
- 数据字段：兼容缺失字段的旧 JSON，并更新 `docs/DATA_MODEL.md`。
- API：更新 `docs/API.md`。
- 上传前：检查 `git status`，运行密钥扫描，并确认没有真实运行数据。
