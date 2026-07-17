# 深圳家教接单平台

面向老师、家教中介和管理员的 Web 应用。本仓库只包含网站代码，不包含桌面 OCR 或微信自动化脚本。

## 当前能力

- 姓名/机构名 + 手机号 + 短信验证码登录，兼容密码登录和微信开放平台扫码登录。
- 老师接单、多条件筛选、路线和距离预览。
- 中介手工发单、粘贴文本批量解析、查看申请老师和联系方式。
- 管理员公告、反馈、订单状态、账号与密码管理。
- 高德地点候选、地点核验和路线规划；未配置 Key 时使用本地估算。

## 本地启动

要求：Node.js 20 或更高版本。项目只使用 Node.js 标准库，无需安装 npm 依赖。

```powershell
git clone <repository-url>
cd shenzhen-tutor-web
npm.cmd start
```

打开 <http://localhost:8787>。网站首次读写数据时会创建 `TutorPlatform/data/db.json`，该目录已被 Git 忽略。

## 验证

```powershell
npm.cmd test
npm.cmd run check:secrets
```

## 文档

- [完整技术说明](docs/TECHNICAL.md)
- [本地开发与测试](docs/DEVELOPMENT.md)
- [HTTP API](docs/API.md)
- [数据模型](docs/DATA_MODEL.md)
- [部署说明](docs/DEPLOYMENT.md)
- [安全说明](SECURITY.md)

## 重要限制

当前版本使用单个 JSON 文件同步写入数据，登录会话和地图缓存保存在进程内存中。它适合本地验证和小规模演示；大规模生产投入前应迁移到数据库、对象存储和持久会话，并补充限流、审计、备份和监控。

本仓库尚未声明开源许可证。公开发布前应由项目所有者选择许可证，并完成隐私与合规审核。
