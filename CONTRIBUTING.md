# 贡献指南

感谢你愿意为 VideoForge 做出贡献。本文说明本地开发、提交与评审的基本约定。

## 1. 开发环境

| 依赖     | 版本                                               |
| -------- | -------------------------------------------------- |
| Node.js  | ≥ 22.19.0（见 `.nvmrc`）                           |
| pnpm     | 10.x（`corepack enable`）                          |
| 操作系统 | Windows 10/11 为验收平台；Linux/macOS 欢迎但未验证 |

```powershell
pnpm install
pnpm run doctor      # 环境与配置自检
pnpm test            # 单元测试
pnpm build           # 构建全部子包与 Web
```

运行 API 前必须设置 `JWT_SECRET`（≥32 字符），详见 [开发者使用说明](docs/guides/developer-guide.md)。

## 2. 分支与提交

- 从 `main` 切出功能分支，例如 `feat/trace-events`、`fix/stage-cancel`。
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`feat:`、`fix:`、`refactor:`、`docs:`、`test:`、`chore:`。
- 一个提交只做一件事；避免把格式化改动与行为改动混在一起。
- 不要在提交中携带密钥、`.env.local`、`config/system.local.yaml`、SQLite 数据或生成工件。

## 3. 提交前检查

```powershell
pnpm run typecheck
pnpm run format:check
pnpm test
pnpm build
```

涉及前端交互时，请同时在浏览器检查桌面与约 390px 窄屏布局。

## 4. 代码约定

- TypeScript 严格模式、ESM、NodeNext；跨应用依赖使用 `workspace:*`。
- 新增函数需带简洁的函数级注释；关键服务动作保留有用日志，不记录敏感数据。
- 文件写入必须限制在 `storage_root` 内，复用 `packages/pipeline/src/path-safety.ts`。
- 错误统一使用 `VideoForgeError(code, message)`；错误码选择见 `AGENTS.md`。
- 代码风格由 Prettier 保证：`pnpm run format`。当前未配置 ESLint 规则集（欢迎贡献）。

## 5. 测试

- 行为变更应先补充或更新 `tests/unit` 下的 Vitest 用例。
- 外部进程（ffmpeg/ffprobe）、Chromium、Ark HTTP 均应在单测中 mock。
- `tests/integration` 为真机冒烟，默认不进入 `pnpm test`；请勿为了通过测试而弱化生产约束。

## 6. 文档

- 用户可见行为变化需同步更新 `docs/guides/developer-guide.md` 或 `operator-guide.md`。
- 涉及未实现能力时，请在文档与 README「已知限制」中明确标注状态。
- 设计文档位于 `docs/`，修改前请先阅读 `AGENTS.md` 中的项目现状与已知边界。

## 7. Pull Request

- 描述问题背景、改动范围与验证方式（命令与结果）。
- 关联相关 Issue（`Closes #123`）。
- 保持 PR 聚焦，必要时拆分为多个 PR。
- 维护者可能会要求补充测试或调整错误码语义。

## 8. 安全问题

请勿在公开 Issue 中披露漏洞或密钥。报告方式见 [SECURITY.md](SECURITY.md)。
