# T210 任务日志：渲染性能基线

## 元信息
- 任务 ID：T210
- 状态：done
- 开始时间：2026-11-07 15:45
- 结束时间：2026-11-07 16:25
- 关联设计：方案 §11.3（记录 78 shot / 4:51 成片的渲染耗时、帧数、并发配置；对比旧链路，给出帧复用与并发收益；不承诺"更快"，以实测为准）
- 依赖任务：T204（renderShots 镜头级渲染）
- 后续任务：M3 前端重写（T301 起）；M5 T501 删除 legacy 时可引用本基线
- 变更文件：
  - `tests/integration/render-baseline.test.ts`（新增：VF_BENCH 门控的真机基线测试）
  - `package.json`（+ `test:bench` 脚本）
  - `docs/v2_refactoring/baselines/render-baseline.json`（新增：基线测量结果，复跑覆盖）

## 意图
为 v2 渲染通道（Remotion 镜头级渲染）与 legacy 通道（Playwright 场景截屏）建立可复现的性能
基线：78 镜 / 4:51 样例的全量耗时、帧数、并发配置，单镜重渲的帧复用收益，以及并发档位曲线。
**只记录，不做性能断言，不承诺"更快"。**

## 设计决策
1. **样例程序化构造（确定性，零 LLM/零图片资产）**：13 场景 × 6 镜 = 78 镜、每镜 3730ms
   （总 290,940ms ≈ 4:51）、98 条旁白 cue（前 20 镜各 2 条 + 后 58 镜各 1 条）、7 类组件
   轮换（复用预览 fixture props）、documentary-dark、LANDSCAPE_1080P @30fps；构造后过
   `timelineDocV2Schema.parse` 自检，非法样例不流入测量。
2. **legacy 对照走渲染内核直连**：`renderSceneSequence` 是 legacy 通道的渲染负载本体
   （renderFrames 的额外逻辑只是读 copy/timeline 编排）；78 个场景用
   `buildFallbackSceneCode` + `wrapSceneDocument` 生成降级模板 HTML（渐变背景 + 字幕条 +
   GSAP），与 v2 的组件镜头同为"程序化视觉"，无图片资产变量。workers 与 v2 full 并发同档（4）。
3. **帧数口径差异如实记录**：v2 按 floor（remotion-engine frames.ts）→ 111 帧/镜 → 8658 帧；
   legacy 按 ceil（renderer sceneFrameCount）→ 112 帧/镜 → 8736 帧；差 78 帧（≈0.9%），
   两通道各自按自身口径断言与记录。
4. **门控与运行方式**：`VF_BENCH=1` 才运行（`describe.skipIf`），配合 `VF_SMOKE=1` 让 vitest
   include 指向 tests/integration；npm 脚本 `pnpm test:bench` 一键复跑；无本机 Chrome 整体跳过。
   单测（`pnpm test`）不受影响（integration 目录默认排除）。
5. **产物即弃**：渲染帧写 tmp 临时目录，跑完删除；唯一落盘产物是基线 JSON
   （`docs/v2_refactoring/baselines/render-baseline.json`，复跑覆盖），保证仓库不被 8600+ 帧污染。
6. **并发曲线用小子集**：前 4 镜（444 帧/档）× concurrency 1/2/4/6，每档独立 bundle；
   样本量声明"帧率含 bundle 开销，看相对趋势而非绝对值"。

## Checkpoint
- 2026-11-07 15:45 任务开始：读方案 §11.3 与 T201–T204 冒烟现状；确认 legacy 渲染内核
  可直连（renderSceneSequence 接口）、降级模板可程序化生成；设计定稿。
- 2026-11-07 15:50 基线测试 + test:bench 脚本完成；`pnpm test` 750 例确认无回归。
- 2026-11-07 15:53 首轮基线：v2 全段（full/regen/并发曲线）通过，**legacy 段失败**——
  场景 HTML 引用 `../vendor/gsap.min.js`，临时目录缺 vendor，`__videoforgeTimeline` 未注册。
- 2026-11-07 15:56 修复：`buildLegacyScenes` 前调 `vendorGsap(<workDir>/vendor)` 补齐 GSAP。
- 2026-11-07 16:04 重跑基线；16:17 通过（总 779.8s），JSON 落盘，帧数断言全过。
- 2026-11-07 16:25 `pnpm run typecheck` 通过（8 个 tsconfig）。

## 基线数据摘要（Intel Core 5 220H / 16 核 / 31.5GB / Node v24.21.0 / win32）

| 测量项 | 配置 | 帧数 | 耗时 | 帧率 |
|---|---|---|---|---|
| v2 全量（renderShots） | concurrency=4，含 1 次 bundle | 8658 | 502.7s | 17 帧/s |
| v2 单镜重渲（shotIds=[sh-001]） | concurrency=4，含 1 次 bundle | 111 | 7.6s | — |
| v2 并发曲线（4 镜子集） | 1 / 2 / 4 / 6 | 444/档 | 26.1 / 25.0 / 26.7 / 28.4s | 16–18 帧/s |
| legacy 全量（renderSceneSequence） | workers=4 | 8736 | 159.3s | 55 帧/s |

**解读（以实测为准，不做"更快"承诺）**：
1. **帧复用收益显著**：改 1 镜只渲 111 帧（7.6s）vs 全量 8658 帧（502.7s），墙钟收益约 **66 倍**；
   这是 v2 镜头级渲染（T115 承诺）的量化依据。
2. **legacy 单帧成本低于 v2 约 3.2 倍**（55 vs 17 帧/s）：Remotion 为组件化、契约一致性与
   镜头级重渲付出的单帧开销是实测事实；方案 §11.3"不承诺更快"即指此类差异，以记录为准。
3. **并发曲线在 444 帧小样本上被 bundle 开销主导**（各档 16–18 帧/s 几乎持平）：
   bundle 每次约 8s、渲染段仅约 20s，样本不足以区分并发收益；并发收益需在真实规模
   （数千帧）下看 v2Full 的 concurrency=4 结果（17 帧/s）与后续真实项目数据。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm test:bench` | pass | 1 test（779.8s 真机）：v2 全量 8658 帧 + 单镜重渲 111 帧 + 并发曲线 4 档 + legacy 8736 帧；JSON 落盘 |
| `pnpm run typecheck` | pass | 8 个 tsconfig 全通过 |
| `pnpm test` | pass | 86 files / 750 tests（基线测试在 integration 默认排除，不进单测） |

## 断点 / 未完成
- 未完成项：本任务范围内无遗留。
- 已知边界与风险：
  1. 并发曲线样本（444 帧/档）不足以量化并发收益，JSON 中已声明；后续可在真实项目上复跑补充。
  2. v2 样例无 image/symbol 镜头（image 镜头有 publicDir 复制变量，T204 已知每渲染复制 images/，
     T210 不重复测量）；真实项目帧率会略低于本基线。
  3. 基线依赖本机 Chrome 与硬件，JSON 的 runtime 字段记录解读上下文；跨机器比较无意义。
- 恢复时第一步：进入 M3 前端重写（T301 AppShell + 设计基元）。

## 风险与后续
- 风险：无阻塞性风险。legacy 通道的删除（T501）可引用本基线作为"性能换架构"的量化依据。
- 下一步任务：`T301` AppShell + 设计基元（M3 前端重写起点，依赖 T007 已就绪）。
- **M2 渲染闭环全部收口**（T201–T210 done）。
