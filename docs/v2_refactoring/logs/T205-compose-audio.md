# T205 任务日志：compose：ASS + BGM + loudnorm

## 元信息
- 任务 ID：T205
- 状态：done
- 开始时间：2026-11-07 13:00
- 结束时间：2026-11-07 14:30
- 关联设计：方案 §5.3（合成层：画面+旁白+BGM+ASS 烧录+loudnorm）、§7.3、D6（字幕独立 ASS，compose 烧录）、M2 出口判据
- 依赖任务：T105（captions/subtitle.ass）、T204（v2 帧目录 build/render/<dir>/shots/<shotId>/）
- 后续任务：T206（质检：静帧检测消费成片）、T209（legacy 开关）、T210（性能基线）
- 变更文件：
  - `packages/pipeline/src/compose.ts`（composeVideo 扩展：loudnessTarget/assPath/cwd；音频链重构为 filter_complex：loudnorm → aresample → BGM amix → apad）
  - `packages/pipeline/src/compose-video.ts`（新增 `composeVideoStepV2` + `materializeShotFrames`；v1 `composeVideoStep` 保留并补可选 loudnessTarget）
  - `apps/server/src/agent/tools/stage-tools.ts`（compose_video 参数扩展 captions/bgm/bgmVolume/loudnessTarget + v2 分派 + `resolveBgmAsset`）
  - 测试：`tests/unit/compose.test.ts`（+4 例）、`tests/unit/compose-v2.test.ts`（新增 9 例）、`tests/unit/agent-stage-tools.test.ts`（+4 例，1 例更新）

## 意图
v2 compose 消费镜头级帧目录与逐镜音频：物化连续帧序列 → ffmpeg 合成 final.mp4；
可选烧录 ASS 字幕（开关可配）、混入 BGM（项目资产 ID 解析）、对混音后音轨做 loudnorm
（响度目标可配）。v1 compose 链路保留。

## 设计决策
1. **帧物化而非 concat demuxer**：把 `shots/<shotId>/element-N.jpeg`（Remotion 绝对帧号、
   各镜头目录内不连续）硬链接（EXDEV/不支持时回退复制）为 `build/compose/<dir>/frames/%08d.jpeg`
   连续序列，尾停顿重复末帧——沿用 composeVideo 的 `%08d` image2 输入，改动集中；
   物化前清空输出目录，重跑幂等。
2. **音频链**：逐镜音频 concat → `loudnorm=I=<目标>:TP=-1.5:LRA=11` → `aresample=48000`
   → BGM（volume 压低 + `amix=inputs=2:duration=first`）→ `apad` 补静音 → `-shortest`
   以视频长度收口（apad 修复了旁白短于视频时画面被截断的问题，v1 语义随之增强）。
3. **ASS 烧录**：`-vf ass=captions/subtitle.ass`（相对路径）+ spawn `cwd=projectDir`，
   规避 Windows 盘符冒号在 filter 字符串中的转义。
4. **BGM 入参无路径**（阶段工具铁律）：`bgm` 传项目资产 ID，服务端解析
   `<projectDir>/assets/uploads/<assetId>/` 下唯一文件；含路径分隔符 / 目录不存在 /
   文件数 ≠1 报 CONFIG_INVALID。
5. **响度目标**：LUFS 数值，范围 [-70, -5]，缺省 -16（v2 默认传 -16；v1 缺省 undefined 不改变原行为）。
6. **字幕开关**：`captions` 仅 v2 生效（v1 无 ASS 产物）；v2 默认烧录，ASS 缺失且未关闭时报
   CONFIG_INVALID（提示完成 captions_generate 或关闭字幕）。

## Checkpoint
- 2026-11-07 13:00 任务开始：读 T105/T204 日志与方案 §5.3/D6；确认 remotion 帧命名为
  `element-[frame].[ext]`（绝对帧号）；设计定稿。
- 2026-11-07 14:00 compose.ts/compose-video.ts/stage-tools.ts 完成；typecheck 通过
  （v1 composeVideoStep 补 loudnessTarget 可选参数，缺省行为不变）。
- 2026-11-07 14:25 测试修复三处：fake 子进程补 stdout（concatAudioFiles 的 runProcess 读取）；
  mock spawn 改 `mockImplementation`（`mockReturnValue` 让两次 spawn 共享同一实例，
  第二次 close 永不触发导致超时）；重跑幂等用例补 sh-002 帧夹具。
- 2026-11-07 14:28 `pnpm run typecheck` + `pnpm test` 全过（82 files / 710 tests）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm run typecheck` | pass | 7 个 tsconfig 全通过 |
| `pnpm test` | pass | 82 files / 710 tests（较 T204 的 693 净增 17） |
| `pnpm vitest run tests/unit/compose-v2.test.ts` | pass | 9 例（物化 4：连续编号+尾停顿/幂等/缺目录/缺帧；step v2 5：loudnorm+ass+cwd/关闭字幕/缺 ASS/v1 拒绝/缺 audio） |
| `pnpm vitest run tests/unit/compose.test.ts` | pass | 9 例（+4：loudnorm 链与 cwd/响度越界/-vf ass/无 BGM 的 anull+apad） |
| `pnpm vitest run tests/unit/agent-stage-tools.test.ts` | pass | 37 例（+4：v2 透传与 BGM 解析/缺省值/bgm 传路径拒绝/资产不存在拒绝） |

## 断点 / 未完成
- 未完成项：本任务范围内无遗留。
- 已知边界与风险：
  1. loudnorm 为单遍模式（响度达标但不如两遍线性模式精确）；两遍模式留 T210 性能基线后评估。
  2. BGM 恒定音量（volume 压低），不做自动闪避（ducking）；如需侧链压缩另立任务。
  3. `apad` 语义变化：旁白短于视频时画面不再被 `-shortest` 截断（v1 时间轴本就帧频对齐，实际影响极小）。
  4. 真实 ffmpeg 端到端（真 BGM + loudnorm）未在单测覆盖（spawn mock）；冒烟链路不含 Ark/ffmpeg 真跑，
     首次真实项目合成时需人工核对响度与字幕效果。
- 恢复时第一步：进入 T206（质检 5 项实现）。

## 风险与后续
- 风险：v2 compose 依赖 `captions/subtitle.ass` 与 shots/ 帧目录齐备；缺产物时 CONFIG_INVALID
  并提示补跑阶段（断点续跑判据 T112 已覆盖 cue/ASS 结构校验）。
- 下一步任务：`T206` 质检 5 项实现（静帧/字幕溢出/来源/对比度/动效时长，依赖 T204/T105 均已就绪）。
