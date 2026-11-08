# T209 任务日志：legacy 渲染开关

## 元信息
- 任务 ID：T209
- 状态：done
- 开始时间：2026-11-07 15:25
- 结束时间：2026-11-07 15:40
- 关联设计：方案 §6.2（「旧 Playwright 渲染通道保留一个版本周期，用环境变量 `VF_RENDERER=legacy` 显式开启，M5 删除；新项目一律 v2」）
- 依赖任务：T204（render 阶段切 Remotion，v1/v2 分派点已就绪）
- 后续任务：T210（渲染性能基线）、T501（删除 legacy renderer）
- 变更文件：
  - `apps/server/src/domain/renderer-switch.ts`（新增：渲染通道决策表纯函数）
  - `apps/server/src/agent/tools/stage-tools.ts`（render_frames 分派依据从 `contractVersion` 换成 `resolveRendererKind`）
  - `tests/unit/renderer-switch.test.ts`（新增 8 例：决策表全组合）
  - `tests/unit/agent-stage-tools.test.ts`（既有 3 个 v1 render 用例补 stubEnv；新增 3 例拒绝路径；afterEach 补 `vi.unstubAllEnvs`）
  - `docs/guides/operator-guide.md`（§7 常见错误 + §8 当前限制补 legacy 续跑口径）

## 意图
T204 之前 render_frames 按 `ctx.contractVersion` 隐式分派（v2 → Remotion，v1 → Playwright），legacy
通道实际默认开启。本任务按方案 §6.2 把它改为**显式开关**：默认 Remotion；legacy 仅旧项目
（contractVersion 1.0）显式设置 `VF_RENDERER=legacy` 后可用；v2 项目要求 legacy、旧项目未显式
开启、环境变量值非法三种情况均报 `CONFIG_INVALID`。

## 设计决策
1. **开关语义取「gating」而非「override」**：方案原文「显式开启」+ 任务板「默认 Remotion」
   共同指向——旧项目续跑渲染必须显式设置环境变量，报错信息本身承担 T504（旧项目迁移提示）
   之前的提示职责；v1 + 默认若静默回退 legacy，则「显式开启」落空、开关退化为护栏。
2. **决策表是纯函数**：`resolveRendererKind(contractVersion, envValue)` 落在
   `apps/server/src/domain/renderer-switch.ts`，8 种组合全部可脱离进程环境单测；
   调用点只在 render_frames（Playwright 通道唯一真实消费方；compose 是 ffmpeg 不属于
   「渲染通道」，不 gate）。
3. **读取口径与密钥一致**：`VF_RENDERER` 支持系统环境变量或仓库根目录 `.env.local`；服务启动时
   `loadJwtSecret → loadLocalEnv` 已把 `.env.local` 装入 process.env（不覆盖已有变量），工具侧直接
   `process.env[VF_RENDERER_ENV]` 读取，不重复加载。值精确匹配 `remotion`/`legacy`（trim 后），
   不做大小写宽容——非法值报错并列出合法值，避免隐性行为。
4. **remotion-engine 内的 `renderFrames` 不受影响**：它是 `@remotion/renderer` 的同名函数
   （packages/remotion-engine/src/render.ts），与 `@videoforge/renderer` 的 Playwright 内核无关；
   gate 只落在 stage-tools 的 v1 分支，影响面最小。
5. **不扩 scope**：v1 scene 阶段 HTML 生成、v1 compose、T112 判据均不动；T009 基线测试只测纯函数
   （readCopyDoc/buildTimeline/sceneFrameCount），不经过 render_frames 工具层，不受影响。

## Checkpoint
- 2026-11-07 15:25 任务开始：读 T204 日志与方案 §6.2；确认 `renderFrames` 消费方仅 stage-tools
  v1 分支；确认 `loadLocalEnv` 幂等、启动链路已加载 `.env.local`；设计定稿（gating 语义）。
- 2026-11-07 15:30 renderer-switch.ts + stage-tools 分派改造 + 两个测试文件完成；首轮测试
  8 失败：`VideoForgeError` 字段名为 `code` 而非 `errorCode`（5 处断言修正）；既有 3 个 v1 render
  用例因未设环境变量进入拒绝路径（逐一补 `vi.stubEnv("VF_RENDERER", "legacy")`）。
- 2026-11-07 15:34 两测试文件 48 例全过（renderer-switch 8 + stage-tools 40）。
- 2026-11-07 15:35 `pnpm run typecheck` 通过（8 个 tsconfig）；`pnpm test` 全过
  （86 files / 750 tests，较 T208 净增 2 files / 11 tests）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm run typecheck` | pass | 8 个 tsconfig 全通过 |
| `pnpm test` | pass | 86 files / 750 tests（较 T208 的 739 净增 11） |
| `pnpm vitest run tests/unit/renderer-switch.test.ts` | pass | 8 例：决策表全组合（v2×未设/remotion/legacy、v1×未设/空白/remotion/legacy、未知值 4 种） |
| `pnpm vitest run tests/unit/agent-stage-tools.test.ts` | pass | 40 例（+3：v1 未设拒绝、v2+legacy 拒绝、未知值拒绝；既有 3 个 v1 用例改为显式开启后语义不变） |

## 断点 / 未完成
- 未完成项：本任务范围内无遗留。
- 已知边界与风险：
  1. **行为变更（预期内）**：存量 v1 项目续跑渲染阶段从「直接可用」变为「需显式设置
     `VF_RENDERER=legacy`」；报错信息即迁移提示，T504 将补 CLI 校验与更完整的迁移指引。
  2. legacy 开关只 gate render_frames；若 v1 项目从 copy 阶段重跑，scene 仍会生成 HTML 场景
     （方案 §6.2「不再产生 HTML 场景」针对新项目；v1 全链路随 T501 一并删除）。
  3. `VF_RENDERER` 在会话中途修改环境变量对进行中的 run 无效（进程启动时读取），属预期。
- 恢复时第一步：进入 T210（渲染性能基线：78 shot 样例耗时/帧数/并发记录，不承诺更快）。

## 风险与后续
- 风险：本任务未跑真机冒烟（VF_SMOKE 覆盖的是 v2 Remotion 路径，legacy 路径全 mock 单测）；
  legacy Playwright 通道行为未变，仅入口加 gate，回归风险低。
- 下一步任务：`T210` 渲染性能基线（依赖 T204，已就绪）。
