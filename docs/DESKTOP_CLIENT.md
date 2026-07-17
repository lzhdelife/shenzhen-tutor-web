# 桌面剪贴板客户端接入说明（测试版）

桌面客户端只负责监听剪贴板、即时展示原文和维护本地待处理队列。订单解析、地点高德验证、路线距离与最终导入继续使用同一套 Cloudflare Worker 服务，客户端不得获取或保存高德 Key。

## 测试流程

1. 用户用现有姓名、手机号和密码登录，客户端在本地生成 `passwordProof` 后调用 `POST /api/login`，角色使用 `agency`。
2. 新剪贴板文本先立即进入本地队列并显示“正在识别”。
3. 客户端带 `Authorization: Bearer <token>` 调用 `POST /api/parse`，请求体为 `{ "text": "..." }`。
4. 客户端展示返回的 `parsed` 和 `splitDiagnostics`；只有用户确认后才调用 `POST /api/import`。
5. 断网或超时不得丢弃原文，状态改为“等待联网”，恢复网络后按顺序重试。

服务地址：`https://shenzhen-tutor-web.lzhdelife.workers.dev`

### 密码证明

`passwordProof` 使用 PBKDF2-SHA256：

- 密码：用户输入的 UTF-8 密码
- salt：UTF-8 字符串 `shenzhen-tutor-v1|{trim(name)}|{trim(phone)}`
- iterations：210000
- 输出：32 bytes
- 编码：base64url（去掉末尾 `=`）

客户端仍发送原始 `password` 仅用于服务端长度校验和兼容当前网站；服务端保存的是证明值的带密钥摘要，不保存明文密码。

## 当前公网基准

2026-07-18 从深圳用户网络之外的测试链路实测：

- 冷连接登录约 2.7 秒；
- 单条含高德地点确认的订单约 4.6 秒；
- 9 条批量订单约 17 秒，平均约 1.9 秒/条。

桌面端应采用异步渐进显示，不阻塞剪贴板监听。后续正式收费版再增加一次性激活码、设备授权、套餐额度和调用计量；这些授权只控制本服务访问，不向客户端发放高德 Key。
