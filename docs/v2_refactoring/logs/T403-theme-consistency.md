# T403 任务日志：主题一致性验收

## 元信息
- 任务 ID：T403
- 状态：done
- 开始时间：2026-11-08 09:30
- 结束时间：2026-11-08 10:25
- 关联设计：方案 §5.5 主题 / §8.5 组件库 / 批次出口判据 M4「同主题一致」
- 依赖任务：T111（主题加载器 + 创建时快照冻结）、T310（组件库预览）
- 后续任务：T404（质检失败定位与重跑）
- 变更文件：
  - tests/unit/theme-consistency.test.tsx（新增）

## 意图
M4 出口判据要求「同主题系列片色板/版式一致」。T111 已实现 `theme.resolved.json` 创建时快照冻结（`ensureThemeSnapshot` 不覆盖），T310 已实现组件库预览，但缺一条把这些语义固化成可回归的验收——“同主题两项目 token 一致”“切换主题不改既有快照”“组件选型与主题解耦”。本任务补验收测试，不改产品代码。

## 改动
- 新增 `tests/unit/theme-consistency.test.tsx`（`@vitest-environment node`，React SSR），4 例：
  - **主题快照一致性**：`loadTheme('documentary-dark')` 写入两个不同项目目录，`snapshotA.theme` 与 `snapshotB.theme` 深度相等，且 `readThemeSnapshot` 回读一致（系列片色板一致）。
  - **切换主题不改既有快照**：同一项目先用 `documentary-dark` 建快照，再用改用 `accent` 的变体主题调用 `ensureThemeSnapshot`，第二次返回仍等于第一次（`themeId` 保持 `documentary-dark`、`accent` 保持原值）。
  - **组件与主题解耦**：`assembleComponentShot` 对同一输入两次装配结果完全相等；序列化后的 SceneSpec 不含 `theme` 字段；`componentRegistry.list()` 与主题无关。
  - **渲染颜色来自传入主题**：同一 `keyword-block` 组件在主题 A（`accent=#B33630`）与 B（`accent=#E4B95B`）下，SSR HTML 文案都含「孤独的神经元」，但强调色分别为 `#B33630` / `#E4B95B`，两份 HTML 不相等。
- 测试用 `structuredClone` + 替换 `tokens.accent` 构造“另一个主题”，避免依赖真实存在的第二个主题目录。
- 明确没有做：不改 `theme.ts` / `ensureThemeSnapshot` 实现（T111 语义已满足）；不改组件实现；不新增主题；不做视觉回归截图基线（留 T503）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/theme-consistency.test.tsx` | pass | 4 tests |
| `pnpm test` | pass | 94 files / 848 tests |
| `pnpm run typecheck` | pass | 8 个 tsconfig |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  - “版式一致”只验证到 token 与装配结果一致，**像素级版式一致**未做（需视觉回归，属 T210/T503 范围）。
  - 快照冻结意味着用户**无法**在项目内切换主题——这是设计意图（创建时决定视觉语言），但若未来要支持“项目改主题需重跑”，需新增显式迁移路径。

## 风险与后续
- 风险：新增主题只改 `config/themes/*.yaml` 即可，但组件若硬编码颜色就会破坏一致性；本测试用 accent 变体覆盖了 `keyword-block`，未覆盖全部 7 类组件，属可接受的抽样。
- 下一步任务：T404。
