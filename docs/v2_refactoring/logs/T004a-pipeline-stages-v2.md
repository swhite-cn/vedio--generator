# T004a 任务日志：影子 8 阶段常量（不切换运行时）

## 元信息
- 任务 ID：T004a
- 状态：done
- 开始时间：2026-11-03 08:04
- 结束时间：2026-11-03 08:05
- 关联设计：方案 §4.4 八阶段定义、C1 阶段数裁决
- 依赖任务：T002
- 后续任务：T004（能力切换）、T004b（前端映射）
- 变更文件：
  - `packages/shared/src/domain.ts`
  - `tests/unit/pipeline-stages-v2.test.ts`

## 意图
在 UI 与契约层需要 8 阶段、但 `captions_generate` 工具尚未实现之间建立安全过渡：先提供 v2 顺序的影子常量，运行时仍保持 7 阶段，避免能力注册表引用不存在的工具导致流水线中断。

## 改动
- `shared` 新增 `PIPELINE_STAGES_V2`（copy/image/scene/tts/**captions**/storyboard/render/compose）与 `PipelineStageV2`。
- `PIPELINE_STAGES` 保持 7 项不变，现有引擎/工具/测试零改动。
- 新增 3 个测试：v1 仍 7 项、v2 字幕位置正确、去掉 captions 后与 v1 顺序一致。

明确没有做：
- 没有改能力注册表（留到 T004）；
- 没有改前端阶段标签（留到 T004b，避免 UI 提前出现无法执行的阶段）；
- 没有新增 `captions_generate` 工具（T105）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/pipeline-stages-v2.test.ts tests/unit/capability-registry.test.ts` | pass | 2 files / 10 tests passed |
| `pnpm run typecheck` | pass | 全仓通过 |

## 断点 / 未完成
- 未完成项：T004 能力切换与 T004b 前端映射。
- 最后运行的命令：`pnpm run typecheck`
- 恢复时第一步：读 `tasks.md` 当前焦点，进入 T005。
- 已知风险：
  - 影子常量与运行时可能长期并存；T004 必须删除/替换 `PIPELINE_STAGES`，不能留下两份可写来源；
  - 若 T105 迟迟未做，v2 契约与 8 阶段只存在于类型层，UI 不能声称已支持字幕阶段。

## 风险与后续
- 风险：任务顺序曾计划"先加 8 阶段"，实际会导致运行时空引用；已在任务板拆成 T004a/T004b/T004，并记录原因。
- 下一步任务：T005 数据库迁移。
