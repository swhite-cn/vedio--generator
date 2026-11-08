# T206 任务日志：质检 5 项实现

## 元信息
- 任务 ID：T206
- 状态：done
- 开始时间：2026-11-07 14:40
- 结束时间：2026-11-07 14:50
- 关联设计：方案 §7.4（质检执行点与级别）、§5.4（QualityReport）、D6
- 依赖任务：T006（报告契约与读写骨架）、T204/T205（帧与成片产物）、T105（ASS/cues）、T110（SceneSpec）
- 后续任务：T207（质检接入引擎 + 报告 API + `quality.updated` 发布）、T404（质检失败定位与重跑）
- 变更文件：
  - `packages/pipeline/src/quality/checks.ts`（新增：5 项检查 + 组合入口）
  - `packages/pipeline/src/quality/index.ts`（导出）
  - `tests/unit/quality-checks.test.ts`（新增，16 例）

## 意图
把方案 §7.4 的 5 项检查落成可单测的检查函数：每项产出 `QualityCheck`（T006 契约），
正反样例穷举；组合入口 `runQualityChecks` 读项目产物、缺数据源的检查按条件跳过
（由 T207 的 `buildQualityReport` 补 skipped）。落盘与门禁拦截留 T207。

## 设计决策
1. **静帧检测用 ffmpeg `freezedetect`**：零新依赖（不引图像解码库），噪声阈值 n=0.001、
   冻结 ≥0.25s 报告（方案"每 0.25s 采样"口径）；解析 stderr 的 freeze_start/freeze_duration，
   区间起点映射到 timeline 镜头（violations 带 shotId）。检测执行失败降级为 warn 不抛错。
2. **字幕溢出（阻断）**：cue 去空白长度 > 主题 `max_chars_per_line`；ASS WrapStyle=2 不自动换行，
   超长必溢出。
3. **来源标签（阻断）**：数据展示型组件（data-card/comparison-bars/progress-ring）镜头必须带来源，
   优先 SceneSpec `source`，回退 copy v2 `sourceRef`；非数据组件不要求。
4. **画面对比度（警告）**：WCAG 2.x 相对亮度公式计算主题 text/background（及 secondary[0]）对比度，
   阈值 7.2:1。**降级说明**：方案中的"资产平均亮度"需要图像解码依赖，首版只做主题 token
   对比度；资产亮度留待有图像处理依赖时补（T210/T403 评估）。
5. **动效时长（警告）**：durationMs 超出主题 motion [min,max] 或 atMs+duration 越出镜头边界
   均为 warn（方案 §7.4 指定警告级；spec schema 已强制 300-800，此处为防御性校验 + 越镜检测）。
6. **组合入口**：freeze 需显式传 `framesPattern`（物化帧，T207 在 compose 后接入）；
   其余按产物存在性条件执行；copy 非 v2 抛 `ADAPTER_PROTOCOL_INVALID`。

## Checkpoint
- 2026-11-07 14:40 任务开始：读 T006 日志与方案 §7.4；确认报告契约（5 项固定 + violations）；
  设计定稿（freezedetect 方案、对比度降级口径）。
- 2026-11-07 14:45 checks.ts 完成；typecheck 修正两处（theme.motion 字段名为 snake_case；
  writeFileSync import）。
- 2026-11-07 14:48 测试修正三处：对比度断言精度（toFixed 实测值）；动效级别统一 warn
  （单 check 单 status，方案指定警告级）；组合入口 fixture 补 scenes/spec.json。
- 2026-11-07 14:50 `pnpm run typecheck` + `pnpm test` 全过（83 files / 726 tests）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm run typecheck` | pass | 7 个 tsconfig 全通过 |
| `pnpm test` | pass | 83 files / 726 tests（较 T205 的 710 净增 16） |
| `pnpm vitest run tests/unit/quality-checks.test.ts` | pass | 16 例：对比度公式 2 + 字幕溢出 2 + 来源 3 + 对比度 2 + 动效 2 + freeze 解析/映射/失败降级 3 + 组合入口 2 |

## 断点 / 未完成
- 未完成项：本任务范围内无遗留。
- 已知边界与风险：
  1. 对比度检查不含资产平均亮度（需图像解码依赖），暗色图片上的亮字不会被本检查发现——
     属方案 §7.4 的部分实现，已在函数注释与本日志声明。
  2. freezedetect 对"组件动画结束后完全静止"的画面也会报冻结——Remotion 渲染的镜头若整镜
     无动效（如 image 镜头），0.25s 阈值几乎必然命中。**这是口径问题而非 bug**：静帧警告的
     本意是发现"该动而未动"，image 镜头的持续静帧预期内。T207 接入时应考虑按镜头视觉类型
     过滤（image 镜头跳过静帧判定）或提高阈值——留 T207 裁决。
  3. freeze 检查消费物化帧（compose 后产物），与方案"render 后执行"的时点有偏差；
     T207 接线时统一（render 后逐镜头跑 or compose 后全片跑）。
- 恢复时第一步：进入 T207（质检接入引擎 + `GET /quality` + `quality.updated`）。

## 风险与后续
- 风险：freezedetect 假阳性（静止 image 镜头）可能让所有 v2 项目都带静帧警告——T207 接线时
  必须先处理该口径再启用，否则警告失去信号价值。
- 下一步任务：`T207` 质检接入引擎（阶段钩子 + 报告落盘 + `GET /api/projects/:id/quality`
  + `quality.updated` 发布）。
