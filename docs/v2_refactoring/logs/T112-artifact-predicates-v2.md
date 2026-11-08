# T112 任务日志：能力判据 v2（结构校验）

## 元信息
- 任务 ID：T112
- 状态：done
- 开始时间：2026-11-07 09:12
- 结束时间：2026-11-07 09:15
- 关联设计：方案 §6.5 断点续跑、§5.8 契约不变量、W15 判据
- 依赖任务：T107（timeline v2）、T105（ASS）、T110（SceneSpec）
- 后续任务：T004（能力声明切 8 阶段并引用 v2 判据）、T115（断点续跑验收）
- 变更文件：
  - `packages/shared/src/capability.ts`（`ArtifactPredicate.validator` 扩展 5 个 v2 校验器）
  - `apps/server/src/workflow/artifact-validators.ts`（新增）
  - `apps/server/src/workflow/breakpoint.ts`（解释器 switch 接入）
  - `tests/unit/artifact-predicates-v2.test.ts`（新增，7 例）

## 意图
断点判据从「文件存在」升级为「结构可校验」：copy 必须 v2、cue 必须覆盖全部口播、字幕条数必须
与 cue 一致、SceneSpec 必须覆盖全部镜头且组件参数合法、timeline 必须结构合法。
任何不满足统一按「未达标」处理，续跑从该阶段开始，避免"文件在但内容错"被误判为已完成。

## 改动
- `ArtifactPredicate` 文件判据的 `validator` 扩展：`copy-contract-v2`、`timeline-contract-v2`、`audio-cues`、`captions-ass`、`scene-spec`（v1 两个校验器保留）。
- 新增 `artifact-validators.ts`：
  - `assertCopyContractV2`：`readCopyDocument` 且版本必须 2；
  - `assertAudioCueCoverage`：按 shot 汇总 cue 文本，去空白后必须与 `narration` 完全相等（100% 覆盖率）；
  - `assertCaptionsCoverage`：ASS Dialogue 条数 > 0 且等于 cue 条数；
  - `assertSceneSpecCoverage`：spec 与 copy 镜头数/集合一致、`themeId` 一致、component 镜头的参数通过注册表校验；
  - `assertTimelineContractV2`：`readTimelineV2`（schema 校验切点连续、cue 不越镜、动效 300–800ms）。
- `breakpoint.ts` 解释器改为 switch：v2 校验器会读取同项目内的 copy/cue/ASS 做跨文件校验；任何异常仍按未达标返回 false。
- 明确没有做：能力声明切 8 阶段与实际引用（T004）；质量门禁（T206）；前端断点提示（T311）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/artifact-predicates-v2.test.ts` | pass | 7 tests（含 5 类不达标反例） |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过 |
| `pnpm test` | pass | 75 files / 632 tests |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  1. 能力声明仍使用 v1 判据，v2 校验器要等 T004 切换到 8 阶段后才会被真实调度使用；当前仅单测覆盖。
  2. cue 覆盖率用"去空白后字符串相等"判定；T104b 接入原生/ASR 时间戳后若断句不同，需要升级为字符级对齐。
  3. SceneSpec 判据要求镜头集合与 copy 完全一致；定向只重生成部分镜头时，必须与既有 spec 合并后再判定（T110 已实现合并）。
- 恢复时第一步：进入 T113（storyboard 聚合读取 API），或等 T004 把 v2 判据接入能力声明。

## 风险与后续
- 风险：`audio-cues` / `captions-ass` / `scene-spec` 判据消费固定相对路径，项目目录结构变化需同步修改。
- 下一步任务：`T113` storyboard 聚合读取 API（依赖 T107/T005）。
