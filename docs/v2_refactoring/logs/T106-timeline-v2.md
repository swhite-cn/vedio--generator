# T106 任务日志：Timeline v2 构建

## 元信息
- 任务 ID：T106
- 状态：done
- 开始时间：2026-11-04 08:06
- 结束时间：2026-11-04 08:12
- 关联设计：方案 §5.2 TimelineDoc v2
- 依赖任务：T104
- 后续任务：T107
- 变更文件：
  - `packages/shared/src/contracts/timeline.ts`
  - `packages/pipeline/src/timeline-v2.ts`
  - `packages/pipeline/src/index.ts`
  - `tests/unit/timeline-v2.test.ts`

## 意图
把音频阶段的中间 cue 升级为渲染与字幕共用的完整时间轴：镜头切点、旁白 cue、动效 cue、帧率与尾停顿一次收敛。

## 改动
- 新增 `TIMELINE_V2_RELATIVE_PATH = timeline.json`。
- 新增 `buildTimelineV2`：消费 `AudioCuesDoc`，补齐 `fps/tailPauseMs/totalMs`，追加动效 cue 并按时间排序；结果过 `timelineDocV2Schema`。
- 新增 `readTimelineV2` / `writeTimelineV2`：读写均过契约校验，错误统一 `ADAPTER_PROTOCOL_INVALID`。
- 共享导出 `AnimationCue` 类型。
- 6 个测试：补齐字段、动效排序、越镜拒绝、非法 fps/负停顿、中文路径回读、非法写入拒绝。

明确没有做：
- 没有从 SceneSpec 自动收集动效 cue（接口已留 `extraCues`，T110 接入）；
- 没有改 storyboard 阶段（T107）；
- 没有把尾停顿配置化（仍为调用方传入）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/timeline-v2.test.ts tests/unit/audio-cues.test.ts tests/unit/contracts-v2.test.ts` | pass | 3 files / 31 tests passed |
| `pnpm run typecheck` | pass | 全仓通过 |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm run typecheck`
- 恢复时第一步：进入 T107
- 已知风险：
  - `totalMs = 最后镜头 end + tailPauseMs`，没有章节间额外停顿；设计稿需要时再加契约字段。
  - 排序按时间升序；同一时刻的 cue 顺序不稳定时用 cueId 兜底。

## 风险与后续
- 风险：动效 cue 的 `atMs` 现在按全片时间解释，T110 从 SceneSpec（镜头相对）转换时必须加上 shot.startMs。
- 下一步任务：T107 storyboard 阶段产出 v2。
