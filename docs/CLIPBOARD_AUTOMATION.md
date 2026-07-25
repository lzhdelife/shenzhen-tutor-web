# 剪贴板自动发单

本地桥接器只负责监听 Windows 剪贴板、保存原文和可靠投递。账号登录、订单解析、地点确认、高德调用及订单入库仍由网站后端负责，桥接器不保存账号密码或高德 Key。

## 日常使用

1. 运行 `ShenzhenTutorClipboardBridge.exe`。程序固定连接本机网站，会自动尝试启动网站并打开发单端，不需要配置地址。
2. 在网站使用发单账号登录，保持“自动接收并导入剪贴板订单”开启。
3. 在手机或平板复制家教订单文本，并通过系统或微信输入法同步到 Windows 剪贴板。
4. 桥接器立即保存原文并投递到本地网站。网站按顺序调用统一的 `/api/parse` 和 `/api/import`，成功后订单出现在“我发布的订单”。

桥接器主界面只保留连接状态、最近记录、打开网站、暂停监听和失败重试。手动在网站粘贴时也只需点击一次“识别并导入”；解析预览仍会显示在右侧，但不再要求第二次确认。

网页关闭、未登录或本地服务暂时不可用时，原文分别保留在桥接器本地记录和网站待处理队列中。恢复后会自动重试。同一个 `captureId` 重发是幂等的，不会产生两份队列记录；订单层仍使用原有指纹去重。

网站会在原文进入待处理队列前使用解析模块的轻量分类器检查订单证据。非家教单直接返回 `ignored`，不显示到发单输入框、不调用高德、不入库。进入队列后仍无法识别为完整订单的内容也会以 `ignored` 终止，不按错误重试。EXE 收到 `completed` 或 `ignored` 后立即删除本机原文；只有网络或服务暂时不可用时才保留并重试。

## 源码启动

在仓库根目录运行：

```powershell
python .\clipboard_bridge\clipboard_collector.py
```

桥接器默认连接 `http://127.0.0.1:8787`。如果网站尚未启动，它会在能找到仓库时执行 `node scripts/start-local.js`。也可以通过环境变量 `SHENZHEN_TUTOR_ROOT` 指定仓库目录。

## 打包 EXE

```powershell
python -m pip install pyinstaller
powershell -ExecutionPolicy Bypass -File .\scripts\build-clipboard-bridge.ps1
```

输出路径：`dist\clipboard-bridge\ShenzhenTutorClipboardBridge.exe`。

## 本地接口

- `POST /api/clipboard/capture`：桥接器投递原文，仅接受本机请求和桥接器标头。
- `GET /api/clipboard/status`：桥接器查询网页是否已经完成导入。
- `GET /api/clipboard/inbox`：发单账号读取待处理原文。
- `POST /api/clipboard/:captureId/complete`：导入成功后确认并从待处理队列移除。
- `POST /api/clipboard/:captureId/fail`：记录失败并按指数退避重试。

待处理队列最多保存 500 条。队列已满时桥接器不会删除本机原文，而是保留并继续重试。
