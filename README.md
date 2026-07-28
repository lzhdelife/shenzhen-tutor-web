# 深圳家教接单平台

面向深圳家教订单共创的公网 Web 平台，提供订单录入、解析、去重、发布、筛选、接单和地图浏览。正式站同时支持手机和 PC；Windows 剪贴板桥接器仅作低耦合兼容，不是网站运行前提。

正式站：<https://tutor.liuzonghao.top>

## 主要流程

1. 普通用户打开网站即可浏览、筛选和地图看单，无需注册登录。
2. 发单用户提交称呼和微信号/手机号完成登记后，立即获得发单权限。
3. 用户粘贴一条或多条家教单，或拖入 TXT；网页按顺序切割、过滤、去重和发布。
4. 后端仅为新增订单调用高德核验地点并保存坐标。
5. 老师按地区、学科、年级、课酬和距离筛选，或在地图中查看订单及路线。

## 当前功能

- 无普通登录页；筛选、住址和匿名设备身份保存在当前浏览器。
- 发单信息自动登记；相同称呼和联系方式可跨浏览器恢复发单身份。
- 多条订单无损切割、结构化解析、证据和置信度展示。
- 非订单文本分类，不把群名、来源前缀或闲聊误导入订单。
- 高德地点候选、标准地址和经纬度确认、四种路线及距离计算。
- 老师端订单列表、组合筛选、本地直线距离排序和聚合地图；真实通勤路线仅在打开单条地图详情时计算。
- 发单端粘贴/TXT 顺序队列、明显处理反馈、结果历史和批量订单管理。
- 点击申请接单后可复制原文，并按需获取发单人或管理员联系方式。
- 异常订单复核、访客/在线统计和平台侧高德调用监控。
- 正式站使用 Cloudflare Worker 与 D1；Node JSON 实现用于本地开发。

## 技术结构

```text
.
├─ TutorPlatform/
│  ├─ server.js                 # 本地 Node HTTP 服务和业务 API
│  ├─ parser/                   # 唯一的订单切割、分类和字段解析逻辑
│  ├─ public/                   # PC Web 前端
│  └─ data/                     # 本地运行数据，不提交 Git
├─ clipboard_bridge/            # Windows 剪贴板桥接器源码
├─ cloudflare/                  # 正式站 Worker、D1 存储与迁移
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

## 剪贴板桥接器（兼容）

源码运行：

```powershell
python .\clipboard_bridge\clipboard_collector.py
```

打包 Windows EXE：

```powershell
python -m pip install pyinstaller
powershell -ExecutionPolicy Bypass -File .\scripts\build-clipboard-bridge.ps1
```

输出文件为 `dist\clipboard-bridge\ShenzhenTutorClipboardBridge.exe`。`dist/` 是本机构建产物，不上传 GitHub。当前主流程已改为网页粘贴和 TXT 导入，桥接器不应驱动网页高频轮询。完整说明见 [剪贴板自动发单](docs/CLIPBOARD_AUTOMATION.md)。

## 验证

```powershell
npm.cmd test
npm.cmd run cloudflare:test
npm.cmd run check:secrets
```

回归测试覆盖解析精度、9 条批量无损切割、紧凑编号订单、非订单前缀、高德接口契约、匿名设备身份隔离、发单、申请和导入性能契约。测试数据必须是匿名合成内容。

## 数据和安全

- `.env.local`、`.dev.vars`、`TutorPlatform/data/`、`dist/`、`build/`、缓存和依赖目录均不纳入版本控制。
- 不提交真实手机号、密码、订单原文、聊天截图、家庭地址或地图密钥。
- 匿名设备标识只以散列形式参与服务端身份映射；管理员密码仍使用带随机盐的 scrypt 散列。
- 本地 JSON 数据库适合开发和小规模测试，不应直接作为正式生产存储。

## 文档索引

- [技术架构](docs/TECHNICAL.md)
- [本地开发](docs/DEVELOPMENT.md)
- [HTTP API](docs/API.md)
- [数据模型](docs/DATA_MODEL.md)
- [解析准确性](docs/PARSER_ACCURACY.md)
- [剪贴板自动发单](docs/CLIPBOARD_AUTOMATION.md)
- [Cloudflare 正式部署](docs/CLOUDFLARE.md)
- [项目交接手册](docs/PROJECT_CONTEXT.md)
- [安全说明](SECURITY.md)

## 当前限制

- 正式站依赖 Cloudflare Worker、D1 和高德服务可用性；高德官方额度以其控制台为准。
- 本地服务采用单进程 JSON 文件存储，仅用于开发，会话和部分缓存随进程重启而丢失。
- 仓库尚未声明开源许可证；公开分发前应由项目所有者选择许可证并完成隐私与合规评审。
