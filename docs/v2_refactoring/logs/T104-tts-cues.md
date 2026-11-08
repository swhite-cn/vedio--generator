# T104 任务日志：TTS 逐镜 + cue 时间戳

## 元信息
- 任务 ID：T104
- 状态：done
- 开始时间：2026-11-04 07:56
- 结束时间：2026-11-04 08:05
- 关联设计：方案 §5.2 TimelineDoc v2、§7.4 质量
- 依赖任务：T102/T103
- 后续任务：T105/T106
- 变更文件：
  - `packages/shared/src/contracts/copy.ts`
  - `packages/shared/src/contracts/timeline.ts`
  - `packages/pipeline/src/audio-cues.ts`
  - `packages/pipeline/src/tts-generate.ts`
  - `packages/pipeline/src/index.ts`
  - `apps/server/src/agent/tools/stage-tools.ts`
  - `tests/unit/audio-cues.test.ts`
  - `tests/unit/tts-generate-v2.test.ts`
  - `tests/unit/agent-stage-tools.test.ts`

## 意图
让配音从"整场一段、无时间信息"升级为"逐镜一段、逐句 cue"，为字幕轨与镜头切点提供可计算的时间真相。

## 改动
- 契约补充：shot 新增 `audioPath?`、`audioDurationMs?`；共享导出 `NarrationCue`、`TimingSource` 类型。
- 新增 `audio/cues.json`：
  - `audioShotSpanSchema`：shotId/sceneId/audioPath/durationMs/startMs/endMs；
  - `audioCuesDocSchema`：切点连续、cue 不越镜、ID 唯一；
  - `splitNarrationIntoCues`：按句号/问号/感叹号/分号拆句，按字符比例分配实测时长；
  - `buildAudioCuesDoc` / 读写函数。
- `generateSpeech` 双路径：
  - v1 原逻辑不变；
  - v2 逐 shot 合成，ffprobe 实测时长，回填 copy v2，并生成全片 cue；
  - 支持 `shotIds`/`sceneIds` 定向重合成；定向时其余镜头必须有已有时长，否则提示先全量运行；
  - 生成记录写 `contractVersion=2.0`、`shotId`、`durationMs`。
- 阶段工具 `tts_generate` 新增 `shotIds`，描述与产物路径同步支持镜头。

明确没有做：
- **未接入原生时间戳与 ASR 对齐**：当前 `timingSource` 固定为 `estimated`（逐镜实测时长 + 字符分配），契约与字段已预留；
- 没有生成 ASS（T105）；
- 没有生成最终 timeline.json（T106）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/audio-cues.test.ts tests/unit/tts-generate-v2.test.ts tests/unit/agent-stage-tools.test.ts` | pass | 3 files / 35 tests passed |
| `pnpm run typecheck` | pass | 全仓通过（首次缺 `TimingSource` 导出，已修复） |

## 断点 / 未完成
- 未完成项：原生/ASR 时间戳路径（建议单列 T104b）
- 最后运行的命令：`pnpm run typecheck`
- 恢复时第一步：进入 T105 或 T106
- 已知风险：
  - `estimated` 只能在句级分配时长，不能保证字级对齐；字幕可能出现轻微提前/滞后，质检需把它标为降级而不是静默通过。
  - 定向重合成依赖 copy v2 中已有 `audioDurationMs`；手工改 copy 后可能触发"请先全量运行"。
  - `splitNarrationIntoCues` 对极短音频 + 多句可能产生零时长 cue；真实 2–4 秒镜头不会触发，T206 需加保护。

## 风险与后续
- 风险：`audio/cues.json` 目前是中间产物，能力判据还没登记（T112）。
- 下一步任务：T105 字幕 ASS 生成 / T106 Timeline v2（可并行）。
