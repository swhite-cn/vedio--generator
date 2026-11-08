# T203 任务日志：其余 4 类组件

## 元信息
- 任务 ID：T203
- 状态：done
- 开始时间：2026-11-07 11:36
- 结束时间：2026-11-07 12:27
- 关联设计：方案 §5.6（7 类组件）、§5.8 不变量（数据类组件必须有 sourceRef——来源标签为视觉出口）
- 依赖任务：T202（组件分发基础设施）
- 后续任务：T204（render 阶段切 Remotion）、T206（质检对照）
- 变更文件：
  - `packages/template-sdk/src/components/registry.ts`（+4 条目，7 类齐备）
  - `config/components/fixtures/`（+4 fixture）
  - `packages/remotion-engine/src/components/`（+4 React 实现）
  - `tests/unit/remotion-components.test.tsx`（+4 例）
  - `tests/integration/remotion-smoke.test.ts`（三组件用例扩展为七组件）
  - `tests/unit/component-registry.test.ts`（注册表锁定用例更新为 7 类）

## 意图
补齐方案 §5.6 的 7 类组件，使 LLM 在 scene 阶段可任选任一类并保证可渲染。
方案只冻结类名与类别枚举（compare/progress/chapter/source），参数 schema 由实现设计——
受注册表参数系统约束（仅标量 string/number/boolean/enum，无数组），
对比条采用「两组对比」表达（labelA/valueA/labelB/valueB）而非条目数组。

## 改动
- 注册表条目（`BUILTIN_COMPONENT_ENTRIES` 7 项齐备）：
  - `comparison-bars`（compare）：labelA/valueA/labelB/valueB（必填 ≤12 字）+ unit/caption；
  - `progress-ring`（progress）：label + percent（0–100）+ unit/caption；
  - `chapter-badge`（chapter）：chapter（≤6 字）+ title（≤16 字）+ subtitle；
  - `source-tag`（source）：label（≤20 字）+ note（≤40 字）。
- 4 个 fixture（`config/components/fixtures/*.json`），props 均过各自 paramsSchema。
- 4 个 React 实现（视觉 token 全走主题，动效夹在主题 motion 边界内）：
  - `ComparisonBars`：两行条形按数值比例生长（无法解析数值时等宽），进度驱动条宽；
  - `ProgressRing`：SVG 圆环（stroke-dasharray 按百分比 × 动效进度），中心 tabular 数值 + aria 标签；
  - `ChapterBadge`：accent 竖线 + 大号章节号 + 标题/副题，入场左移；
  - `SourceTag`：画面底部小字标注（来源圆点 + 文案 + 补充说明）。
- `components/index.tsx` 分发表登记至 7 项；"尚未实现"占位仅对未登记 ID 生效（当前无）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm vitest run tests/unit/remotion-components.test.tsx` | pass | 10 tests（新增 4 组件 SSR 断言：条形文本、SVG+aria、章节角标、来源标注） |
| `$env:VF_SMOKE="1"; pnpm vitest run tests/integration/remotion-smoke.test.ts` | pass | 3 tests（七组件一次 bundle，7 镜头 × 3 帧 = 21 帧逐一校验） |
| `pnpm run typecheck` | pass | 7 个 tsconfig 全通过 |
| `pnpm test` | pass | 81 files / 677 tests |

## 断点 / 未完成
- 未完成项：具名动效（bars-grow/ring-fill/badge-in/fade-in 目前由统一入场动效近似）；
  动效逐 effect 对齐留 T204/T206 质检联动。
- 已知风险：
  1. `comparison-bars` 仅支持两组对比；参考片中偶有多组对比，参数系统（标量）暂不表达数组，
     需要多组时由 LLM 拆多个对比条镜头（scene 提示词 T110 已按"一镜一组件"约束）。
  2. `progress-ring` 的 SVG 文本使用主题字体族，系统缺字体时回退由浏览器决定（同 T202 风险 3）。
  3. `source-tag` 是数据类镜头 `sourceRef` 的版式出口之一；质检"来源标签"检查的数据源是
     SceneSpec.source（T206），与组件选用解耦。
- 恢复时第一步：进入 T204，把 render 阶段从 legacy renderer 切到 `renderShots()`（镜头级、
  bundle 复用、资产路径映射、`asset.bound`/`preview.ready` SSE 发布点）。

## 风险与后续
- 下一步任务：`T204` render 阶段切 Remotion（依赖 T201/T112，均已 done；组件 7 类齐备）。
