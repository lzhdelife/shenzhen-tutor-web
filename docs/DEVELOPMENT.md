# 本地开发与测试

## 环境要求

- Node.js 20 或更高版本。
- Windows 10/11（运行 OCR 助手时必须）。
- Windows PowerShell 5.1（OCR GUI 以 `-STA` 启动）。
- 电脑版微信（仅真实采集测试需要）。
- 可选：Tesseract OCR 5.x。

网站只使用 Node.js 标准库，因此不需要安装 npm 依赖。

## 启动网站

```powershell
npm start
```

或在 `TutorPlatform` 目录双击 `start.bat`。默认地址为 <http://localhost:8787>，端口可通过环境变量修改：

```powershell
$env:PORT = '9000'
node TutorPlatform/server.js
```

首次启动会创建 `TutorPlatform/data/db.json`。匿名初始结构见 `examples/TutorPlatform-db.example.json`。

## 本地短信模式

没有腾讯云账号时，可仅在本机临时启用开发模式：

```powershell
$env:SMS_DEV_MODE = '1'
npm start
```

此模式会在 API 响应中返回验证码，绝不能用于公网或共享环境。正式短信变量见 `.env.example`。应用不会自动加载 `.env`，需要在当前 PowerShell、服务管理器或部署平台中注入。

## 启动 OCR 助手

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File .\TutorOrderWatcher\TutorOrderWatcher.ps1
```

也可双击 `TutorOrderWatcher/启动家教订单助手.bat`。助手会自动创建 `data`、`temp` 和 `exports`，这些目录包含隐私数据并已忽略。

## 可选 Tesseract

1. 安装 Tesseract 5，并确保 `tesseract.exe` 在 `PATH`，或安装到脚本检查的标准目录。
2. 从官方 `tesseract-ocr/tessdata_fast` 获取 `chi_sim.traineddata`、`eng.traineddata`、`osd.traineddata`。
3. 放入 `TutorOrderWatcher/tessdata/`。

模型文件不在仓库内。没有 Tesseract 时仍会尝试 Windows 中文 OCR，但部分价格、英文和稀疏布局识别可能下降。

## 公开测试

```powershell
npm test
npm run check:secrets
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-powershell-syntax.ps1
```

根目录 `tests/` 只能放匿名合成数据。两个模块本机原有的 `tests/` 含真实截图和 OCR 文本，已被 `.gitignore` 排除。

## 调试 OCR

脚本支持若干环境变量测试入口，实际定义以 `TutorOrderWatcher.ps1` 中的 `TUTOR_*` 搜索结果为准。常用诊断流程：

1. 关闭自动切群，打开目标微信聊天。
2. 点击自动定位并查看上次截图，确认只有右侧聊天正文。
3. 单次识别并查看 OCR 文字。
4. 只在本机私有目录保存问题截图和 OCR 文本。
5. 用合成文本新增公开解析回归，避免提交真实聊天。

## 修改检查清单

- 解析规则：测试多单拆分、半单暂缓、重复订单和原图匹配。
- 权限：测试未登录、老师、中介订单所有者、其他中介、管理员五种情况。
- 数据字段：兼容缺失字段的旧 JSON，并更新 `docs/DATA_MODEL.md`。
- API：更新 `docs/API.md`。
- OCR UI：在 100% 和 200% 缩放下检查截图范围、停止按钮和跨屏滚动。
- 上传前：检查 `git status`，运行密钥扫描，并人工确认没有真实截图/聊天文本。
