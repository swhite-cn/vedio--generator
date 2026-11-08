# T107 任务日志：storyboard 阶段产出 v2

## 元信息
- 任务 ID：T107
- 状态：done
- 开始时间：2026-11-04 08:12
- 结束时间：2026-11-04 08:20
- 关联设计：方案 §5.2 TimelineDoc v2、§7.4
- 依赖任务：T106
- 后续任务：T111/T105
- 变更文件：
  - `packages/pipeline/src/storyboard-generate.ts`
  - `apps/server/src/agent/tools/stage-tools.ts`
  - `tests/unit/storyboard-v2.test.ts`
  - `tests/unit/agent-stage-tools.test.ts`

## 意图
让 storyboard 阶段按 copy 版本分支：v1 保留 ffprobe 场景级时间轴，v2 直接消费 `audio/cues.json` 产出镜头级 `timeline.json`，避免重复探测与两套时间真相。

## 改动
- `generateStoryboard` 新增 `profile` 入参：
  - v2：读取 `audio/cues.json`，校验镜头顺序与 copy 完全一致，用 Profile fps + 500ms 尾停顿调用 `buildTimelineV2`，写 `timeline.json` v2；
  - v1：保持原 ffprobe 场景级逻辑，写回原结构。
- 阶段工具 `storyboard_generate` 传入 `ctx.profile`，描述同步说明 v1/v2 分支。
- 4 个测试：v2 产出、缺 cue 拒绝、镜头不一致拒绝、v1 仍走 ffprobe。

明确没有做：
- 没有把 SceneSpec 动效 cue 合入 timeline（`extraCues` 接口已留，T110 接入）；
- 没有把尾停顿配置化（仍为常量 500ms）；
- 没有切 8 阶段能力声明（T004/T004b）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/storyboard-v2.test.ts tests/unit/timeline-v2.test.ts tests/unit/agent-stage-tools.test.ts` | pass | 3 files / 36 tests passed |
| `pnpm run typecheck` | pass | 全仓通过 |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm run typecheck`
- 恢复时第一步：进入 T111（主题加载与快照）
- 已知风险：
  - v2 要求 `audio/cues.json` 的镜头顺序与 copy 完全一致；手工改 copy 后必须先重跑 TTS。
  - timeline v2 尚无动效 cue，渲染阶段只能按旁白节奏走；T110 完成后补。
  - `profile` 缺省为横屏 1080p；CLI 直接调用时必须显式传 portrait。

## 风险与后续
- 风险：断点判据仍指向旧 `timeline-contract` 校验器（T112 再升级），当前 v2 文件靠写入函数自身校验。
- 下一步任务：T111 主题加载与项目快照。
