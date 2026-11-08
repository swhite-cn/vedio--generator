# T202 任务日志：3 类组件 React 化

## 元信息
- 任务 ID：T202
- 状态：done
- 开始时间：2026-11-07 11:12
- 结束时间：2026-11-07 11:33
- 关联设计：方案 §5.6（组件规格与参数）、§4.2（模板层）、M2 出口判据
- 依赖任务：T201（remotion-engine 骨架）、T109（注册表参数 schema + fixture）
- 后续任务：T203（其余 4 类组件）、T204（render 阶段接线）、T206（质检对照视觉）
- 变更文件：
  - `packages/remotion-engine/src/components/`（新增：common/keyword-block/data-card/quote-card/index）
  - `packages/remotion-engine/src/composition.tsx`（component 视觉走分发）
  - `packages/remotion-engine/src/render.ts`（bundle 适配浏览器环境）
  - `packages/remotion-engine/package.json`（+template-sdk 依赖）
  - `package.json`（根 devDeps +react/react-dom/@types/react）
  - `vitest.config.ts`（include 扩 .tsx；remotion alias）
  - `tests/unit/remotion-components.test.tsx`（新增，6 例）
  - `tests/integration/remotion-smoke.test.ts`（+1 例：三组件一次 bundle 出帧）

## 意图
把 T109 定义的 3 类高频组件（关键词块/数据卡/引语卡）落成 Remotion 可渲染的 React 实现：
- 视觉 token 全部来自主题（`resolveRemotionTheme`），无魔法值；
- 动效固定时长、不随镜头拉伸（方案 §5.3），时长夹在主题 motion 边界内；
- props 由装配期（`assembleComponentShot` 注册表强校验）保证合法，渲染层不重复校验。

## 改动
- `components/common.tsx`：
  - `entranceProgress(frame, fps, theme, durationMs)` 纯函数（可穷举单测）+ `useEntranceProgress` hook
    （`useCurrentFrame` + `useVideoConfig` 包装）；
  - `componentShellStyle(theme)`：背景/安全区/字体族的统一容器样式。
- 3 个组件（均为 `{ props, theme }` 入参，主题色/字号/动效全走 token）：
  - `KeywordBlock`：主标题 + accent 下划线（sweep 按进度扫出 / grow 保底宽度 / none 隐藏）+ 副标题；
  - `DataCard`：指标名 + accent 大号数值（tabular-nums）+ 单位 + 趋势箭头（↑/↓/→）+ 口径说明；
  - `QuoteCard`：引号装饰 + 正文（emphasis 首次命中切分高亮）+ 落款（作者/身份）。
- `components/index.tsx`：`ComponentShotVisual` 按 `componentId` 分发；未知组件/缺失 ID 渲染占位层不抛错。
  **校验边界澄清**：渲染层不做 props 校验（装配期已拦截）——因此不 import 注册表的 node 依赖，
  浏览器 bundle 安全；单测锁定"超长 title 原样渲染"作为边界声明。
- `composition.tsx`：`visualType=component` 走 `ComponentShotVisual`；symbol/video 仍为占位（T203）。
- `render.ts` bundle 适配：
  - `extensionAlias` 把 NodeNext `.js` 相对导入映射回 `.tsx/.ts` 源；
  - alias 把 `node:fs/path/url/module` 置空（webpack `alias:false`；渲染链路无文件读取；
    `resolve.fallback` 对 `node:` scheme 无效，这是实测结论）。
- `vitest.config.ts`：include 扩展 `.test.tsx`；`remotion` alias 指向 remotion-engine 的安装实例
  （pnpm 严格隔离，保证 vi.mock 命中组件内的 hook）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm vitest run tests/unit/remotion-components.test.tsx` | pass | 6 tests（动效纯函数 1 + SSR 分发 5） |
| `$env:VF_SMOKE="1"; pnpm vitest run tests/integration/remotion-smoke.test.ts` | pass | 3 tests（fixture 单帧 PNG、3 帧序列、三组件一次 bundle 各 3 帧） |
| `pnpm run typecheck` | pass | 7 个 tsconfig 全通过 |
| `pnpm test` | pass | 80 files / 673 tests |

## 断点 / 未完成
- 未完成项：动效只有入场淡入/上移与下划线扫出；`title-in`/`number-count`/`quote-mark-in` 等
  具名动效（T109 登记的 animations 列表）按需在 T204/T206 对齐前后再做逐 effect 实现。
- 已知风险：
  1. `renderShots` 的 frameRange 是绝对帧号区间，每镜头目录内文件按 `element-0..n-1` 顺序命名
     （非全局帧号）；compose 层（T205）按目录内顺序通配即可。
  2. QuoteCard emphasis 只高亮首次命中；多次出现属文案问题，属 T402 文案结构范畴。
  3. DataCard/KeywordBlock 的字体依赖系统字体（Noto Sans SC 未随包分发）；T210 性能基线与
     T403 主题一致性验收时统一处理字体资产。
- 恢复时第一步：进入 T203，补对比条/进度环/章节角标/来源标签 4 类（注册表条目 + React 实现 + fixture）。

## 风险与后续
- 下一步任务：`T203` 其余 4 类组件（依赖 T202，已满足）。
