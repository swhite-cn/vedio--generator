# T109 任务日志：3 类高频组件规格

## 元信息
- 任务 ID：T109
- 状态：done
- 开始时间：2026-11-07 09:04
- 结束时间：2026-11-07 09:06
- 关联设计：方案 §5.6 组件注册表、§7.3 组件选型、SKILL 组件库页
- 依赖任务：T108（注册表基础设施）
- 后续任务：T110（scene 选型）、T117（组件 API）、T202（React 组件）、T310（组件库页面）
- 变更文件：
  - `packages/template-sdk/src/components/registry.ts`（追加 3 条声明、fixture 读取、装配函数）
  - `packages/shared/src/contracts/component.ts`（`componentPreviewFixtureSchema`）
  - `config/components/fixtures/keyword-block.json` / `data-card.json` / `quote-card.json`（新增）
  - `tests/unit/component-registry.test.ts`（14 → 23 例）

## 意图
把参考片里最高频的 3 类版式（关键词块/数据卡/引语卡）落成可查询、可校验、可预览、可装配的规格，
让 scene 阶段的 LLM 只做选型填参，渲染层（T202）按 ID 取实现，无需改动流水线。

## 改动
- 内置注册表追加 3 条声明：
  - `keyword-block`（text）：title≤18 必填、subtitle≤28、underline ∈ none/sweep/grow；动效 title-in/underline-sweep；覆盖说明沿用方案中的 28%。
  - `data-card`（data）：label≤12、value≤12 必填，unit≤6、caption≤20、trend ∈ up/down/flat；动效 card-rise/number-count。
  - `quote-card`（quote）：quote≤48 必填，author≤20、role≤24、emphasis≤12；动效 quote-fade/quote-mark-in。
- 新增 `componentPreviewFixtureSchema`（shared）：`{ componentId, props }`；props 必须通过对应组件参数校验。
- 新增 `readComponentPreviewFixture(rootDir, componentId, registry?)`：按 `config/components/<previewFixture>` 读取，校验 ID 一致与参数合法；文件缺失/ID 不一致/参数非法 → `CONFIG_INVALID`，非 JSON/结构非法 → `ADAPTER_PROTOCOL_INVALID`。
- 新增 `assembleComponentShot({ shotId, componentId, props, animationDurationMs? })`：装配为 SceneSpec 单镜头规格（visualType=component、hard-cut、动效 300–800ms、默认 400ms），非法组件/参数拒绝。
- 新增 3 份 fixture 文件；参数均为示例值，不是真实统计。
- 明确没有做：React 组件实现（T202）、scene 提示词与选型（T110）、组件 API（T117）、其余 4 类组件（T203）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/component-registry.test.ts` | pass | 23 tests |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过 |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  1. 只有 `keyword-block` 有方案给出的 28% 覆盖说明；其余两类未填占比，避免编造真实统计。
  2. `data-card` / `quote-card` 的参数为规格推断，T202 实现 React 组件时若需要额外字段（如数值滚动格式）需回补 spec。
  3. fixture 的示例文案是占位内容，组件库页面需标注"示例"。
- 恢复时第一步：进入 T110，让 scene 生成器按注册表选型填参并装配 ShotSpec。

## 风险与后续
- 风险：装配函数把动效时长硬编码为 400ms 默认值；若主题 motion 边界更窄，需在 T110 用主题 `motion` 覆盖。
- 下一步任务：`T110` scene 生成器改为 SceneSpec 选型（依赖 T108/T102）。
