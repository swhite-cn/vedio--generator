# T003 任务日志：copy 读取器 v1/v2 兼容

## 元信息
- 任务 ID：T003
- 状态：done
- 开始时间：2026-11-03 08:02
- 结束时间：2026-11-03 08:03
- 关联设计：方案 §5.8 契约版本与不变量
- 依赖任务：T002
- 后续任务：T004
- 变更文件：
  - `packages/pipeline/src/copy-contract.ts`
  - `tests/unit/copy-contract-compat.test.ts`

## 意图
在不动现有 v1 阶段工具的前提下，让读取层能识别 v2 文档并给出明确错误，避免新契约上线后旧调用方静默误读。

## 改动
- 新增 `readCopyDocument(path)`：无 `contractVersion` → v1；`2.0` → v2；其他版本抛 `ADAPTER_PROTOCOL_INVALID`。
- 新增 `writeCopyDocV2`。
- `readCopyDoc` 保持 v1 行为；遇到 v2 时抛出带提示的错误（提示改用 `readCopyDocument`）。
- 新增 6 个兼容性测试：v1、v2、未知版本、v2 误传 v1 读取器、v2 结构非法、中文路径写回。

明确没有做：
- 没有迁移 copy/image/scene/tts/storyboard 任一调用方（T101–T110）；
- 没有把 v2 写入 copy 生成流程（T102）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/contracts-v2.test.ts tests/unit/copy-contract.test.ts tests/unit/copy-contract-compat.test.ts` | pass | 3 files / 30 tests passed |
| `pnpm run typecheck` | pass | 全仓通过 |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm run typecheck`
- 恢复时第一步：进入 T004，先读 `packages/shared/src/domain.ts` 的 `PIPELINE_STAGES`
- 已知风险：
  - 现有阶段工具仍是 v1，新项目在 T102 前继续产 v1；这是有意的渐进路径；
  - `readCopyDoc` 对 v2 抛错属于临时保护，T107 完成后应移除该分支并统一迁移。

## 风险与后续
- 风险：若有旧项目手工写入 `contractVersion` 但结构仍是 v1，会被判为 v2 并报结构错误；属于预期（版本字段必须真实）。
- 下一步任务：T004 8 阶段常量与能力声明升版。
