# 重构任务日志（Ledger）

> 工作状态以 [tasks.md](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/tasks.md) 为准；本目录只保存**每个任务的执行证据**，不承担任务状态ownership。
> 设计依据：[VideoForge重构方案.md](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/VideoForge重构方案.md)

## 1. 命名与粒度

- 每任务一份：`T<编号>-<短横线英文描述>.md`，例如 `T002-shared-contracts-v2.md`；
- 一个任务跨会话继续时**不新建文件**，在末尾追加 `## 续跑记录`；
- 同一任务的补充证据（日志片段、命令输出）放在 `logs/artifacts/T<编号>/` 下，不把大文件贴进 markdown；
- 不记录密钥、令牌、真实用户凭据、完整私有对话。

## 2. 必填模板

```markdown
# T0xx 任务日志：<任务名>

## 元信息
- 任务 ID：T0xx
- 状态：done | partial | blocked
- 开始时间：YYYY-MM-DD HH:mm
- 结束时间：YYYY-MM-DD HH:mm
- 关联设计：方案 §x.x
- 依赖任务：Txxx
- 后续任务：Txxx
- 变更文件：
  - path/to/file

## 意图
一句话说明为什么做这个任务，以及它解锁了什么。

## 改动
- 做了什么（按文件或模块）
- 明确没有做什么（避免范围蔓延）

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/xxx.test.ts` | pass | 12 passed |
| `pnpm run typecheck` | pass | — |

## 断点 / 未完成
- 未完成项：
- 最后运行的命令：
- 恢复时第一步：
- 已知风险：

## 风险与后续
- 风险：
- 下一步任务：
```

## 3. 检查点写法（长任务必填）

执行中每完成一个可验证步骤，追加：

```markdown
### Checkpoint HH:mm
- 已完成：
- 验证：
- 下一步：
```

中断前最后一次检查点必须包含**可直接复制执行的恢复命令**。

## 4. 状态与耦合

- 任务完成：先在 `tasks.md` 改 `done`，再写日志；
- 任务中断：先写 `partial` 日志，再把 `tasks.md` 改 `partial`；
- 任务阻塞：日志写清阻塞原因与需要谁裁决，`tasks.md` 改 `blocked`；
- 代码改动与任务状态更新应处于同一逻辑变更集；未获用户要求不创建 Git commit。

## 5. 跳过策略

纯文档修正、格式化、无行为变化的注释更新可以不写独立日志，但必须在相关任务的日志里注明"已随 Txxx 完成"。
