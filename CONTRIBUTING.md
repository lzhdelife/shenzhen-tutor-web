# 协作开发说明

## 开始之前

1. 阅读 `docs/TECHNICAL.md` 和与改动相关的专题文档。
2. 从默认分支创建短期功能分支。
3. 不要把真实手机号、密码、密钥、数据库、聊天文字或微信截图加入提交。
4. 解析规则需要测试时，使用自行编写的匿名合成语料。真实案例只能保存在已忽略的本机目录。

## 提交流程

```powershell
npm test
npm run check:secrets
git status --short
```

提交信息建议使用清晰的动词开头，例如：

- `fix: merge OCR pages without splitting long orders`
- `feat: persist teacher filter preferences`
- `docs: document SMS environment variables`

Pull Request 应说明：改了什么、为什么改、如何验证、是否改变数据结构或接口、是否需要新增环境变量。

## 代码约定

- 网站后端当前使用 Node.js 标准库，不要仅为很小的功能引入大型依赖。
- 前端保持原生 HTML/CSS/JavaScript，除非团队先明确决定迁移框架。
- OCR 助手需要兼容 Windows PowerShell 5.1，不要使用只在 PowerShell 7 存在的语法。
- 任何数据库字段变化都要同步更新 `docs/DATA_MODEL.md`，并提供兼容旧数据的迁移逻辑。
- 任何 API 变化都要同步更新 `docs/API.md`。
- 不要让测试访问真实短信、微信、高德或生产数据。

## 隐私测试素材

原项目本机保留了一套真实 OCR 回归素材，但 `.gitignore` 会排除两个模块原有的 `tests/` 目录。公开协作测试应放在仓库根目录 `tests/`，且只能包含合成数据。需要复现真实案例时，应先去除姓名、手机号、群名、精确住址、头像和订单原图中的其他身份线索。
