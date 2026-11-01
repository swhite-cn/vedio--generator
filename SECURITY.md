# 安全策略

## 支持的版本

本项目当前处于早期阶段，仅对 `main` 分支的最新代码提供安全修复。

| 版本               | 支持 |
| ------------------ | ---- |
| `main`（最新提交） | 是   |
| 历史提交 / Fork    | 否   |

## 报告安全漏洞

**请不要在公开 Issue、讨论区或 PR 中披露漏洞细节或真实密钥。**

推荐方式：

1. 使用 GitHub 的 [Private vulnerability reporting](https://github.com/swhite-cn/vedio--generator/security/advisories/new)
   提交私密安全公告；
2. 若无法使用上述入口，请通过仓库所有者的 GitHub 主页所列联系方式私下联系维护者。

请在报告中尽量包含：

- 受影响的文件 / 接口 / 阶段；
- 复现步骤与最小示例；
- 影响评估（数据泄露、命令执行、越权等）；
- 你建议的修复方向（可选）。

我们会在确认后尽快回复，并在修复发布后致谢（如你愿意）。

## 密钥与敏感数据

- 密钥只允许存放在 `.env.local` 或同名系统环境变量：`ARK_API_KEY`、`JWT_SECRET`、`VF_ADMIN_INITIAL_PASSWORD`。
- 禁止把 `.env.local`、`config/system.local.yaml`、SQLite 数据库、生成工件提交到仓库。
- `llm_calls` 与 `trace.jsonl` 默认记录 LLM 完整请求/响应，可能包含业务敏感内容；部署前请评估存储与访问控制。
- 若怀疑密钥已泄露，请立即在火山方舟控制台轮换 `ARK_API_KEY`，并重新生成 `JWT_SECRET`。

## 部署边界

- 服务默认仅监听 `127.0.0.1`，不构成可对外部署的服务；不要直接改为公网绑定。
- `agent.allow_shell_write_edit` 默认开启（向 agent 放开 `bash` / `write` / `edit`），请在不可信输入场景中关闭。
