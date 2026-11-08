# T201 任务日志：remotion-engine 包骨架

## 元信息
- 任务 ID：T201
- 状态：done
- 开始时间：2026-11-07 11:00
- 结束时间：2026-11-07 11:20
- 关联设计：方案 §4.1/§4.2（模板层 + 渲染层职责）、§4.3 目录变更、M2 出口判据
- 依赖任务：T109（组件注册表/fixture）、T111（主题加载与快照）
- 后续任务：T202（3 类组件 React 化）、T203（其余 4 类）、T204（render 阶段接线）、T208（Player）
- 变更文件：
  - `packages/remotion-engine/`（新增包：package.json / tsconfig.json / src×5）
  - `package.json`（typecheck 脚本纳入新包；pnpm-lock 更新）
  - `tests/unit/remotion-engine.test.ts`（新增，7 例）
  - `tests/integration/remotion-smoke.test.ts`（新增，2 例，VF_SMOKE）

## 意图
按方案 §3.1"两条线推倒"，渲染层由 `packages/renderer`（Playwright+GSAP，冻结）切换为
`packages/remotion-engine`（Remotion）。T201 交付包骨架：Composition、主题解析、
`renderShots()` 镜头级渲染接口，并用组件预览 fixture 验证"契约可出帧"。

## 改动
- 新包 `@videoforge/remotion-engine`（依赖 `remotion` + `@remotion/bundler` + `@remotion/renderer` + react 18）：
  - `theme.ts`：`resolveRemotionTheme(theme)`——主题 token → 渲染常量（安全边距=宽高较小值×safe_area），
    无魔法值；
  - `frames.ts`：`buildShotFramePlan(timeline)`（ms→帧确定性换算，帧数下限 1）、
    `msToFrame`、`selectShotPlans(plan, shotIds)`（镜头级重渲的过滤口径，保持原顺序）；
  - `composition.tsx`：`ShotsComposition`——按帧计划排布 `<Sequence>`；视觉层按 `visualType` 分发，
    image 走资产引用占位、component/symbol/video 渲染占位层（组件实现留 T202/T203）；
    `calculateShotsMetadata` 由 inputProps 动态算宽高/帧率/总帧数（含尾停顿帧）；
  - `entry.tsx`：`registerRoot` + `<Composition>`（zod schema 驱动：inputProps 用
    `themeSchema`/`timelineDocV2Schema`/`shotSpecSchema` 组合，bundle 期即可校验输入）；
  - `render.ts`：
    - `renderShots()`：一次 bundle → selectComposition → 逐镜头 `renderFrames`（按镜头分目录
      `outputDir/<shotId>/`，帧区间来自帧计划），支持 `shotIds` 局部渲染、`browserExecutable`
      复用本机 Chrome、进度回调；错误归 `TOOL_UNAVAILABLE`/`CONFIG_INVALID`；
    - `renderShotStill()`：单帧（镜头预览/质检采样），镜头不存在或偏移越界报 `CONFIG_INVALID`；
    - `bundleEntryPoint()`：webpack `extensionAlias` 把 NodeNext 的 `.js` 相对导入映射回 `.tsx/.ts`
      源——这是 Remotion 与本仓库 TS 约定共存的必要适配。
- `package.json`：typecheck 增加 `packages/remotion-engine`。
- 明确没有做：3 类组件真实实现（T202）、render/compose 阶段接线与帧区间复用（T204）、
  ASS 字幕烧录（T205）、Player（T208）、资产路径 publicDir 映射（T204 接线，image 视觉层暂不渲染图片内容）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm vitest run tests/unit/remotion-engine.test.ts` | pass | 7 tests（主题映射 2 + 帧计划 3 + 过滤 2） |
| `$env:VF_SMOKE="1"; pnpm vitest run tests/integration/remotion-smoke.test.ts` | pass | 2 tests（本机 Chrome：fixture 出 PNG 魔数校验 + 3 帧连续 jpeg 序列） |
| `pnpm run typecheck` | pass | 7 个 tsconfig 全通过（含新包） |
| `pnpm test` | pass | 79 files / 667 tests |

## 断点 / 未完成
- 未完成项：组件视觉实现与渲染接线留 T202/T204；冒烟依赖本机 Chrome，CI/无浏览器环境自动跳过。
- 已知风险：
  1. remotion 帧文件命名为 `element-N.jpeg`（jpeg 格式），compose 层（T205）通配时按 `.jpeg` 匹配。
  2. `bundleEntryPoint` 每次 renderShots/renderShotStill 独立 bundle（无持久缓存聚合）；
     T204 接入引擎时应 bundle 一次复用（serveUrl 透传），否则逐镜头重复打包。
  3. image 视觉层的 `<img src={assetId}>` 是占位——真实资产路径映射（publicDir/相对路径）在 T204 处理。
  4. Windows 下首帧渲染 ~2s（bundle+启动 Chrome）；T210 性能基线需要单独记录，不在此承诺。

## 风险与后续
- 下一步任务：`T202` 3 类高频组件 React 化（keyword-block/data-card/quote-card，消费 T109 的
  参数 schema 与 fixture）；随后 `T203` 其余 4 类、`T204` render 阶段切换。
