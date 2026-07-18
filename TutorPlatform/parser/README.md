# 订单识别模块

本目录是批量家教订单识别的唯一维护边界。页面、HTTP、账号、数据库和部署代码只能调用公开接口，不应在外部新增订单识别规则。

## 公开契约

- `splitter.js`：无损切割原文，返回 `blocks[]` 和每块的起止位置、边界原因、置信度。
- `classifier.js`：在切割后检查订单最小证据，区分有效订单与群名、闲聊等非订单文本；不负责字段抽取。
- `recognizer.js`：编排切割、分类、规则抽取、地点核验和结构化抽取，返回 `{ parserVersion, parsed, splitDiagnostics, ignoredBlocks }`。
- `pipeline.js`：生成带 `value/rawEvidence/confidence/source` 的结构化字段。
- `schema.js`、`validator.js`：定义和校验字段契约。
- `ai-provider.js`：可选 AI 抽取适配器；不得记录原文、密钥或请求正文。

## 依赖方向

`server.js -> recognizer -> splitter/pipeline`

地图核验和旧规则解析暂由 `server.js` 以函数形式注入 `recognizer`。这是一层兼容适配器，后续可逐步迁入本目录，但 HTTP 层的返回契约不需要变化。

## 回归要求

每个真实失败样例都要先匿名化，再加入 `tests/fixtures`。切割测试优先断言原文数量、覆盖率、无重叠和无串单；分类测试同时覆盖非订单误收与有效订单误杀。字段无法可靠提取时允许为空，但不能猜测；忽略段必须通过 `ignoredBlocks` 返回原文和原因。
