# T004 任务日志：能力注册表切到 8 阶段（判据切 v2）

## 元信息
- 任务 ID：T004
- 状态：done
- 开始时间：2026-11-08 10:40
- 结束时间：2026-11-08 11:50
- 关联设计：方案 §4.4（八阶段定义）、§6.2（项目产物清单）、SKILL §8（验收清单）
- 依赖任务：T004a、T105（`captions_generate` 工具）、T107（storyboard v2）、T112（v2 结构校验器）
- 后续任务：T503（全量验收）、T504（`project:verify` 覆盖 v2）
- 变更文件：
  - `packages/shared/src/domain.ts`（`PIPELINE_STAGES` 合并为 8 阶段；删除 `PIPELINE_STAGES_V2` / `PipelineStageV2` 影子常量）
  - `apps/server/src/workflow/capabilities.ts`（`STAGE_TOOL_AND_LABEL` 与 `buildVideoGenerationStages()` 切 8 阶段 + v2 判据）
  - `apps/server/src/workflow/engine.ts`、`apps/server/src/agent/tools/stage-tools.ts`（"七阶段"文案 → "八阶段"）
  - `apps/web/src/components/state-mapping.ts`、`apps/web/src/views/RunDetailView.vue`、`apps/web/src/views/LoginView.vue`（文案同步）
  - `AGENTS.md`、`docs/guides/developer-guide.md`、`docs/guides/operator-guide.md`（八阶段表述同步）
  - `tests/unit/pipeline-stages-v2.test.ts`（重写为 8 阶段锁定）、`capability-registry.test.ts`、`project-metrics.test.ts`、`workflow-breakpoint.test.ts`、`workflow-engine.test.ts`、`cli-project-verify.test.ts`、`web-capabilities.test.ts`、`web-login.test.ts`
  - `tests/unit/helpers/v2-project-fixture.ts`（新增；复用真实生成器产 v2 产物，供三处测试共用）

## 意图
T004a 只加了影子常量、T004b 只让前端能显示 `captions`；只要运行时的 `PIPELINE_STAGES` 仍是 7 阶段、能力声明仍用 v1 判据，T112 落地的 5 个 v2 结构校验器就不会被真实调度使用，`project:verify` 与引擎断点续跑也仍按 v1 判定。本任务把**唯一的阶段序列**与**能力声明判据**一并切到 v2，使八阶段工作流真正生效，并为 T503/T504 解锁。

## 改动
- **阶段常量合并**：`PIPELINE_STAGES` 由 7 项扩为 8 项（`copy → image → scene → tts → captions → storyboard → render → compose`），`captions` 位于 index 4；删除 `PIPELINE_STAGES_V2` 与 `PipelineStageV2` 影子常量，`PipelineStage` 继续由 `PIPELINE_STAGES` 派生（单一真源，避免双序列漂移）。
- **能力声明切 v2**：`buildVideoGenerationStages()` 返回 8 个阶段，每阶段 `artifact` 判据切到 v2 结构校验器：
  - `copy` → `copy.json` + `copy-contract-v2`
  - `image` → `images/*.png`（`minCount ≥ 1`）
  - `scene` → `scenes/spec.json` + `scene-spec`
  - `tts` → `audio/cues.json` + `audio-cues`
  - `captions` → `captions/subtitle.ass` + `captions-ass`
  - `storyboard` → `timeline.json` + `timeline-contract-v2`
  - `render` → `build/render/<profile>/frames/*.jpg`
  - `compose` → `final.mp4`
- **文案一致性收口**：全仓「七阶段」表述同步为「八阶段」（apps/web、apps/server、`AGENTS.md`、`docs/guides/*`、测试用例名与夹具注释）。
- **测试收敛**：把 6 个因"7→8"而失效的测试文件改为 v2 夹具驱动；抽出 `tests/unit/helpers/v2-project-fixture.ts`（直接调真实生成器产 `copy/cues/spec/captions/timeline`），供 `workflow-engine` / `workflow-breakpoint` / `cli-project-verify` 三处共用，避免手写易漂移的 JSON。

**明确没有做**：未改 v1 兼容读取（copy 读取器 v1/v2 并存，见 T003）；未删除 v1 校验器（`copy-contract` / `timeline-contract` 保留，供存量项目与解释器降级路径使用）；未新增 CLI 迁移提示（属 T504）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/pipeline-stages-v2.test.ts tests/unit/capability-registry.test.ts tests/unit/project-metrics.test.ts tests/unit/workflow-breakpoint.test.ts tests/unit/workflow-engine.test.ts tests/unit/cli-project-verify.test.ts` | pass | 6 files / 61 tests |
| `pnpm test` | pass | 88 files / 814 tests passed，exit 0 |
| `pnpm run typecheck` | pass | 7 个 tsconfig 全通过，exit 0 |

关键行为证明：`cli-project-verify.test.ts` 由 4 个 v1 用例改为 4 个 v2 用例并通过，即证明 `project:verify` 已真实覆盖 v2 产物判据（T504 的 CLI 覆盖诉求在此已具备）。

## 断点 / 未完成
- 未完成项：无（T503 全量验收、T504 迁移提示为后续任务，不属本任务范围）。
- 最后运行的命令：`pnpm run typecheck`（exit 0）。
- 恢复时第一步：无（任务已收口）。

## 风险与后续
- **受控偏差**：`tts` 判据采用 `audio/cues.json` + `audio-cues`（结构+覆盖校验），不再单独断 `audio/*.mp3` 计数——以 cue 覆盖口播、切点连续为准，已在 `capabilities.ts` 函数注释中登记。
- **受控偏差**：`captions` 在 `GENERATED_STAGE_KINDS` 中归类为 `timeline` 资产类型（`ProjectAssetKind` 无 captions 枚举），避免为一个阶段扩散资产类型枚举。
- **兼容性**：`PIPELINE_STAGES` 由 7 变 8 是破坏性变更；存量 v1 项目在新代码下进入工作台会多出一个 `captions` 阶段占位（前端由 `toStageProgress` 补 `pending`，见 T004b）。引擎对 v1 项目的断点判定仍可用，但**旧项目续跑与迁移提示的明确化属 T504**。
- 下一步任务：T503（SKILL §8 + 方案 §11 全量验收清单）、T504（旧项目迁移提示 + `project:verify` 覆盖 v2）。
