# T009 任务日志：v1 行为快照与回归基线

## 元信息
- 任务 ID：T009
- 状态：done
- 开始时间：2026-11-04 00:22
- 结束时间：2026-11-04 00:26
- 关联设计：方案 §10 M0、§11.1 自动化测试
- 依赖任务：T003
- 后续任务：T101
- 变更文件：
  - `tests/fixtures/v1/copy-v1.json`
  - `tests/fixtures/v1/timeline-golden.json`
  - `tests/unit/v1-baseline.test.ts`

## 意图
在 v2 改造前锁住 v1 的纯函数行为（copy 解析、场景级时间轴、帧数计算），保证后续替换链路时能区分"预期变化"和"误伤旧项目"。

## 改动
- 新增 v1 copy fixture（3 场景）与场景级时间轴 golden。
- 新增 4 个基线测试：
  - v1 copy 三场景结构；
  - `buildTimeline` 与 golden 完全一致（含 500ms 尾停顿）；
  - 空场景只保留尾停顿；
  - `sceneFrameCount` 向上取整且至少 1 帧。
- 未引入 Chromium，可进默认单测。

明确没有做：
- 没有做真实渲染帧快照（Chromium 冒烟仍只在 `test:smoke`）；
- 没有覆盖 image/scene/tts 的外部调用（需要 mock 或真实 Ark）；
- 没有锁定 v1 HTML 场景产物（T209/T501 前仍由现有冒烟兜底）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/v1-baseline.test.ts tests/unit/timeline.test.ts` | pass | 2 files / 6 tests passed |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm exec vitest run tests/unit/v1-baseline.test.ts tests/unit/timeline.test.ts`
- 恢复时第一步：进入 T101
- 已知风险：
  - golden 只覆盖纯函数，v1 真正的"视觉行为"仍未锁定；T210 渲染基线要补帧数与耗时；
  - 若 v2 故意修改 `buildTimeline`，需新增 v2 golden 而不是改这份 v1 快照。

## 风险与后续
- 风险：有人把 v1 golden 直接改成 v2 期望值，会失去回归价值；日志与任务板均约定"v1 快照只读，v2 另立文件"。
- 下一步任务：T101 copy 提示词 v2（一句一镜）。
