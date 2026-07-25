# 剪贴板自动发单

本地桥接器只负责监听 Windows 剪贴板、保存原文和可靠投递。匿名浏览器身份、订单解析、地点确认、高德调用及订单入库仍由网站后端负责，桥接器不保存账号密码或高德 Key。

## 日常使用

1. 运行 `ShenzhenTutorClipboardBridge.exe`。正式版程序默认连接官网并自动打开发单端；剪贴板原文会进入官网共享队列。
2. 打开网站即可自动建立匿名浏览器身份，保持“自动接收并导入剪贴板订单”开启。
3. 在手机或平板复制家教订单文本，并通过系统或微信输入法同步到 Windows 剪贴板。
4. 桥接器立即保存原文并通过 HTTPS 投递到官网。网站按顺序调用统一的 `/api/parse` 和 `/api/import`，成功后订单进入共享订单池。

桥接器主界面只保留连接状态、最近记录、打开网站、暂停监听和失败重试。手动在网站粘贴时也只需点击一次“识别并导入”；解析预览仍会显示在右侧，但不再要求第二次确认。

网页关闭或本地服务暂时不可用时，原文分别保留在桥接器本地记录和网站待处理队列中。恢复后会自动重试。同一个 `captureId` 重发是幂等的，不会产生两份队列记录；订单层仍使用原有指纹去重。

网站会在原文进入待处理队列前使用解析模块的轻量分类器检查订单证据。非家教单直接返回 `ignored`，不显示到发单输入框、不调用高德、不入库。进入队列后仍无法识别为完整订单的内容也会以 `ignored` 终止，不按错误重试。EXE 收到 `completed` 或 `ignored` 后立即删除本机原文；只有网络或服务暂时不可用时才保留并重试。

## 源码启动

在仓库根目录运行：

```powershell
python .\clipboard_bridge\clipboard_collector.py
```

桥接器正式版默认连接 `https://tutor.liuzonghao.top`，程序级共享授权在打包时内置，使用者不需要输入邀请码。开发本地版仍可通过环境变量 `SHENZHEN_TUTOR_ROOT` 启动 `http://127.0.0.1:8787`。

## 打包 EXE

```powershell
python -m pip install pyinstaller
powershell -ExecutionPolicy Bypass -File .\scripts\build-clipboard-bridge.ps1
```

输出路径：`dist\clipboard-bridge\ShenzhenTutorClipboardBridge.exe`。

## 本地接口

- `POST /api/clipboard/capture`：桥接器通过程序级授权投递原文，官网写入共享 D1 队列。
- `GET /api/clipboard/status`：桥接器查询网页是否已经完成导入。
- `GET /api/clipboard/inbox`：当前匿名浏览器的发单身份读取待处理原文。
- `POST /api/clipboard/:captureId/complete`：导入成功后确认并从待处理队列移除。
- `POST /api/clipboard/:captureId/fail`：记录失败并按指数退避重试。

待处理队列最多保存 500 条。队列已满时桥接器不会删除本机原文，而是保留并继续重试。
