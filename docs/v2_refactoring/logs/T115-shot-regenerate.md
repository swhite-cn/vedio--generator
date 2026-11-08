# T115 任务日志：镜头重生成 API + run scope

## 元信息
- 任务 ID：T115
- 状态：done
- 开始时间：2026-11-07 10:20
- 结束时间：2026-11-07 10:30
- 关联设计：方案 §7.3 镜头级重生成时序、§7.2 SSE 增量（run_start 带范围）
- 依赖任务：T114（镜头 PATCH）、T112（v2 判据）
- 后续任务：T119（SSE 新事件）、T204（render 只渲目标镜头帧区间）、T308（分镜编辑器）
- 变更文件：
  - `apps/server/src/workflow/stage-instruction.ts`（指令支持 scope）
  - `apps/server/src/workflow/engine.ts`（fromStage 起点强制、scope 透传与事件下发）
  - `apps/server/src/app.ts`（`run_start` SSE 携带 scope，修正受控偏差①）
  - `apps/server/src/db/repositories/agent-action-repository.ts`（`runId` 回填）
  - `apps/server/src/http/routes/shots.ts`（新增 regenerate 端点）
  - `tests/unit/workflow-engine.test.ts`（+4 例）
  - `tests/integration/project-run-api.test.ts`（+3 例）

## 意图
按方案 §7.3 时序落地单镜重生成：`POST /shots/:shotId/regenerate` 建 `agent_action(regenerate)` 与
带 `scope_json={shotIds, fromStage}` 的 run，引擎强制从 fromStage 开始，阶段指令明确"只处理目标镜头"。
关键约束：不触发整片重跑的前半段——数据面（copy/cue/spec）按范围收窄；像素级逐帧一致留 T204。

## 改动
- `stage-instruction.ts`：`StageInstructionInput` 新增 `scope`；带 `shotIds` 时指令追加"镜头级重生成"段，
  要求 image/tts 传 `shotIds`、scene 按 sceneIds 定向、确定性阶段全量重算。
- `engine.ts`：
  - `StageExecutionRequest` + `scope`（执行器可读）；
  - 阶段指令入参与落库消息均带 scope；
  - `run_started` 事件 payload 携带 scope；
  - `runWorkflow`：`scope.fromStage` 存在时强制 `startIndex` 为该阶段下标（未知阶段报 `CONFIG_INVALID`），
    前序阶段一律记 `skipped`，不受断点判据影响。
- `app.ts`：`run_start` SSE 现在下发 `fromStage/shotIds/scope`（消除此前"不下发 fromStage"的受控偏差）。
- `agent-action-repository.ts`：`createAgentAction` 支持直接传 `runId`；新增 `updateAgentActionRun` 回填。
- `shots.ts` 新增 regenerate 端点：
  - 校验：v2 项目、shotId 存在于 copy、请求体 `stages ⊆ image/scene/tts/storyboard/render/compose`（copy 不允许）、项目租约空闲；
  - 阶段去重并按 `PIPELINE_STAGES` 排序，最早阶段即 `fromStage`；
  - 落库：`system` 消息（shot.regenerate 审计锚点）→ `agent_action(kind=regenerate, status=executing)` → `run(scope)` → 回填 `action.run_id`；
  - 发布 `agent_action` 事件，异步触发引擎，返回 202 `{ action, run }`。
- 明确没有做：render 只渲染目标镜头帧区间（T204）、`shot.updated` 专用 SSE 事件（T119）、取消镜头重生成的独立端点（可复用 `POST /runs/:id/cancel`）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/workflow-engine.test.ts` | pass | 22 tests（含 fromStage 跳过/未知阶段/指令含范围） |
| `$env:VF_SMOKE="1"; pnpm exec vitest run tests/integration/project-run-api.test.ts` | pass | 24 tests（202+scope、400 反例、409 PROJECT_BUSY） |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过 |
| `pnpm test` | pass | 76 files / 645 tests |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  1. **"其余镜头逐帧不变"尚未闭环**：引擎只保证从 fromStage 开始跑；阶段工具是否真的只处理目标镜头取决于模型遵循指令
     （image/tts 工具已原生支持 shotIds 参数，storyboard/captions 为确定性全量重算）；render 复用其余帧需 T204。
  2. `fromStage` 之后的阶段会全量执行（如 render 全量渲染），单镜收益要到 T204 才体现。
  3. regenerate 与整片 run 共用租约，项目忙时 409；没有排队机制（按设计，单机 harness 不排队）。
  4. `captions` 尚未进入能力声明（T004），regenerate 的 `stages` 白名单暂不含 captions。
- 恢复时第一步：进入 T119（SSE `shot.updated` 等新事件），或 T116（派生指标）。

## 风险与后续
- 风险：模型可能忽略指令中的 shotIds 约束而全量重生成；T204 前建议在 image/tts 工具层增加"scope 存在时强制 shotIds"的服务端兜底。
- 下一步任务：`T119` SSE 新事件（依赖 T115，已 done）；`T116` 派生指标可并行。
