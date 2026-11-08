# T004b 任务日志：前端阶段标签与 SSE 落点扩到 8 阶段

## 元信息
- 任务 ID：T004b
- 状态：done
- 开始时间：2026-11-07 22:10
- 结束时间：2026-11-08 07:10
- 关联设计：方案 §7.2（SSE 事件）/ Web 专题 §5.2（阶段进度）
- 依赖任务：T004a（`PIPELINE_STAGES_V2`）、T119（SSE 新事件）
- 后续任务：T004（能力注册表切 8 阶段）
- 变更文件：
  - apps/web/src/components/state-mapping.ts
  - apps/web/src/stores/workbench-reducer.ts
  - apps/web/src/services/sse.ts
  - tests/unit/web-workbench-reducer.test.ts
  - tests/unit/web-state-map.test.ts

## 意图
让前端在运行时仍为 7 阶段的前提下，提前完整渲染 8 阶段（含 `captions`），并为 T119 的 4 类增量 SSE 事件提供落点，解锁 T305/T306 的工作台重写。

## 改动
- `state-mapping.ts`：`STAGE_LABELS` 增加 `captions: "字幕"`（`tts` 与 `storyboard` 之间）；`TOOL_LABELS` 增加 `captions_generate: "字幕生成"`。
- `workbench-reducer.ts`：`STAGE_ORDER` 由 `STAGE_LABELS` 键序生成（8 条）；`stagePlaceholders()` 返回 8 条；`WorkbenchState` 新增 `storyboardRefreshToken` / `qualityRefreshToken`；`applyEvent` 新增 `shot.updated` / `quality.updated` / `asset.bound` / `preview.ready` 分支（`preview.ready` 目前原样返回）。
- `sse.ts`：`NAMED_EVENT_TYPES` 增加 4 个增量事件名，保证具名事件不被丢弃。
- 未做：不切换服务端能力声明；不为旧 7 阶段 run 增加后端回填，仅在展示层补 `pending`。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/web-workbench-reducer.test.ts tests/unit/web-state-map.test.ts` | pass | reducer 38 例 / state-map 11 例 |
| `pnpm test` | pass | 91 files / 825 tests |
| `pnpm run typecheck` | pass | 8 个 tsconfig |
| `pnpm run web:build` | pass | 3303 modules |

## 断点 / 未完成
- 未完成项：无。
- 已知风险：`captions` 在旧 run 上显示「待执行」（pending），属服务端尚未回填 8 阶段记录的展示结果，非前端推导。

## 风险与后续
- 风险：T004 切换能力声明后，旧 run 的阶段集合需要版本感知，避免续跑阶段错位。
- 下一步任务：T305。
