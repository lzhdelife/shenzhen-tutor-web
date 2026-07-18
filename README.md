# 深圳家教接单平台

以本地 PC 网站为主的家教订单录入、解析、发布和接单工具。Windows 剪贴板桥接器只负责接收手机或平板同步到电脑的文本，订单解析、高德地点核验、入库、筛选和管理统一由网站完成。

> 当前阶段：本地联网测试版。公网部署和移动端适配暂缓。

## 主要流程

1. 启动本地网站并登录发单账号。
2. 运行剪贴板桥接器。
3. 在手机或平板复制家教订单文字，通过系统或微信输入法同步到 Windows 剪贴板。
4. 网站自动接收文本，调用统一解析接口，忽略群名等非订单段，核验地点并导入订单。
5. 老师端按地区、学科、年级、教师性别、课酬和距离筛选，也可切换地图看单。

网页也保留手动粘贴入口，点击一次“识别并导入”即可完成同一流程。

## 当前功能

- 手机号 + 密码注册和登录，注册时设置昵称或机构名。
- 多条订单无损切割、结构化解析、证据和置信度展示。
- 非订单文本分类，不把群名、来源前缀或闲聊误导入订单。
- 高德地点候选、标准地址和经纬度确认、四种路线及距离计算。
- 老师端订单列表、组合筛选、距离评分和聚合地图。
- 发单端自动导入、手动粘贴、订单管理和批量清理测试订单。
- Windows 剪贴板监听、本机历史、失败重试和网站自动连接。
- Node 本地 JSON 存储，以及契约兼容的 Cloudflare Worker/D1 实现。

## 技术结构

```text
.
├─ TutorPlatform/
│  ├─ server.js                 # 本地 Node HTTP 服务和业务 API
│  ├─ parser/                   # 唯一的订单切割、分类和字段解析逻辑
│  ├─ public/                   # PC Web 前端
│  └─ data/                     # 本地运行数据，不提交 Git
├─ clipboard_bridge/            # Windows 剪贴板桥接器源码
├─ cloudflare/                  # 备用的 Worker/D1 后端适配
├─ shared/                      # Node 与 Worker 共用的订单契约
├─ tests/                       # 匿名合成回归测试
├─ scripts/                     # 本地启动、配置、打包和密钥扫描
└─ docs/                        # API、数据模型和开发文档
```

模块边界：前端和剪贴板桥接器不复制解析正则，也不直接调用高德 Web Service。它们只消费服务端 HTTP 契约；高德 Web Service Key 始终留在本地服务或云端 Secret 中。

## 本地启动

要求：Windows、Node.js 20 或更高版本。

```powershell
git clone https://github.com/lzhdelife/shenzhen-tutor-web.git
cd shenzhen-tutor-web
npm.cmd install
npm.cmd start
```

打开 <http://127.0.0.1:8787>。首次读写时会创建 `TutorPlatform/data/db.json`，该目录已被 Git 忽略。

也可以双击 `TutorPlatform/start.bat` 启动。

## 高德地图配置

地点搜索和路线需要“Web 服务”Key；地图视图还需要“Web端（JS API）”Key及其安全密钥。三项配置只写入被 Git 忽略的 `.env.local`。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure-amap-local.ps1
```

按提示输入配置并重新启动网站。可参考 `.env.example`，不要把真实 Key 写入代码、文档或提交记录。

## 剪贴板桥接器

源码运行：

```powershell
python .\clipboard_bridge\clipboard_collector.py
```

打包 Windows EXE：

```powershell
python -m pip install pyinstaller
powershell -ExecutionPolicy Bypass -File .\scripts\build-clipboard-bridge.ps1
```

输出文件为 `dist\clipboard-bridge\ShenzhenTutorClipboardBridge.exe`。`dist/` 是本机构建产物，不上传 GitHub。完整说明见 [剪贴板自动发单](docs/CLIPBOARD_AUTOMATION.md)。

## 验证

```powershell
npm.cmd test
npm.cmd run cloudflare:test
npm.cmd run check:secrets
```

回归测试覆盖解析精度、9 条批量无损切割、紧凑编号订单、非订单前缀、高德接口契约、登录、发单、接单和导入性能契约。测试数据必须是匿名合成内容。

## 数据和安全

- `.env.local`、`.dev.vars`、`TutorPlatform/data/`、`dist/`、`build/`、缓存和依赖目录均不纳入版本控制。
- 不提交真实手机号、密码、订单原文、聊天截图、家庭地址或地图密钥。
- 密码使用带随机盐的 scrypt 散列；服务端令牌只持久化散列。
- 本地 JSON 数据库适合开发和小规模测试，不应直接作为正式生产存储。

## 文档索引

- [技术架构](docs/TECHNICAL.md)
- [本地开发](docs/DEVELOPMENT.md)
- [HTTP API](docs/API.md)
- [数据模型](docs/DATA_MODEL.md)
- [解析准确性](docs/PARSER_ACCURACY.md)
- [剪贴板自动发单](docs/CLIPBOARD_AUTOMATION.md)
- [Cloudflare 备用实现](docs/CLOUDFLARE.md)
- [安全说明](SECURITY.md)

## 当前限制

- 当前优先保证本地 PC Web 流程，未完成移动端适配。
- 公网部署配置保留，但当前版本不以公网发布为验收目标。
- 本地服务采用单进程 JSON 文件存储，会话和部分缓存随进程重启而丢失。
- 仓库尚未声明开源许可证；公开分发前应由项目所有者选择许可证并完成隐私与合规评审。
