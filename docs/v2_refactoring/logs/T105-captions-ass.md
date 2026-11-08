# T105 任务日志：captions ASS 生成

## 元信息
- 任务 ID：T105
- 状态：done
- 开始时间：2026-11-07 08:59
- 结束时间：2026-11-07 09:01
- 关联设计：方案 §4.4（第 5 阶段 captions）、§4.5（字幕由 ffmpeg 烧录）、§7.4（字幕溢出质检数据来源）
- 依赖任务：T104（音频 cue）、T111（主题快照）
- 后续任务：T112（ASS 产物判据）、T205（compose 烧录/开关）、T206（字幕溢出质检）、T004（8 阶段切换）
- 变更文件：
  - `packages/pipeline/src/captions-ass.ts`（新增）
  - `packages/pipeline/src/index.ts`（导出）
  - `apps/server/src/agent/tools/stage-tools.ts`（新增 `captions_generate`，阶段工具 7→8）
  - `apps/server/src/agent/tools/index.ts`（注释同步）
  - `tests/unit/captions-ass.test.ts`（新增，8 例）
  - `tests/unit/agent-stage-tools.test.ts` / `agent-builtin-tools.test.ts`（工具数量与顺序同步）

## 意图
把 cue 时间真相转成独立字幕轨 `captions/subtitle.ass`：一条 cue 一条 Dialogue、样式全部取主题 token。
字幕与画面解耦，支持关闭字幕、单独重跑与审计；也为 T206 的字幕溢出质检提供确定的数据来源。
本任务先让工具可用，能力声明切 8 阶段留给 T004。

## 改动
- 新增 `captions-ass.ts`：
  - `buildAssSubtitle(cues, theme, title?)`：生成完整 ASS 文本；PlayRes 取主题 frame，字号/描边/底部距离取 `tokens.caption`，字体取字体族首项，主色/强调色转 ASS `&HAABBGGRR`，固定底部居中（Alignment=2）。
  - `formatAssTime(ms)`：毫秒 → `H:MM:SS.cc` 厘秒精度。
  - `countAssDialogueEvents(content)`：供判据/质检核对字幕条数。
  - `generateCaptions({ projectDir, theme? })`：读 `audio/cues.json` 与 `theme.resolved.json`，写 `captions/subtitle.ass`；cue 缺失或主题缺失报 `CONFIG_INVALID`。
  - 文本清洗：换行转 `\N`、花括号替换为全角括号，避免破坏 ASS 事件行。
- `stage-tools.ts`：新增 `captions_generate`（无路径入参、无参数），阶段工具顺序变为 `tts → captions → storyboard`；工具版本自检数组同步为 8。
- 明确没有做：ASS 烧录与字幕开关（T205）、字幕溢出质检（T206）、能力声明切 8 阶段（T004）、原生时间戳（T104b）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/captions-ass.test.ts tests/unit/agent-stage-tools.test.ts tests/unit/agent-builtin-tools.test.ts` | pass | 3 files / 53 tests |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过 |
| `pnpm test` | pass | 72 files / 592 tests |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  1. ASS 不做自动换行（WrapStyle=2），长 cue 会原样输出，由 T206 按 `max_chars_per_line` 拦截；cue 文本长度最终应由 copy v2 提示词约束。
  2. 字幕样式仅取主题 `caption` 与主色/强调色；阴影、边框样式固定为"描边 + 无阴影"，如需扩展需加主题 token。
  3. `captions_generate` 已注册但能力声明仍为 7 阶段，工作流不会调度它；T004 切换后才会进入正常流水线。
- 恢复时第一步：若继续，进入 T108（组件注册表基础设施），T112 需等 T110 完成。

## 风险与后续
- 风险：cue 文本含 ASS 保留字符时只做替换而非转义，极端文本可能与预期显示不同；当前口播文本为中文标点，风险低。
- 下一步任务：`T108` 组件注册表基础设施（独立主线）；`T104b` 原生/ASR 时间戳可并行。
