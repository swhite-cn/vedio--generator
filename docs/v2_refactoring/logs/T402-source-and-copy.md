# T402 任务日志：来源标签 + 文案结构

## 元信息
- 任务 ID：T402
- 状态：done
- 开始时间：2026-11-08 09:20
- 结束时间：2026-11-08 10:25
- 关联设计：方案 §5.2 文案契约（sourceRef）/ §5.6 组件 / §7.4 质检（source-label 阻断）
- 依赖任务：T109（3 类组件 React 实现）、T206（质检 5 项检查）
- 后续任务：T403（主题一致性验收）
- 变更文件：
  - config/prompts/default/copy-v2-system.txt
  - packages/pipeline/src/prompts.ts（内置回退同步）
  - packages/shared/src/contracts/component.ts（`DATA_COMPONENT_IDS`）
  - packages/pipeline/src/quality/checks.ts
  - packages/remotion-engine/src/components/index.tsx
  - tests/unit/prompts.test.ts
  - tests/unit/remotion-components.test.tsx

## 意图
方案 §7.4 已有 `source-label` 阻断级质检（数据镜头缺来源会拦），但此前「数据镜头」清单在质检层是本地常量、渲染层则完全不叠来源标签——即使用户在 copy v2 里填了 `sourceRef`，成片画面上也看不到。同时文案提示词缺少结构约束（钩子/设问/风险免责），导致口播容易空泛。

## 改动
- **来源标签单一来源**：把「哪些组件属于数据组件」从质检层上移到 `packages/shared`（`DATA_COMPONENT_IDS = {data-card, comparison-bars, progress-ring}`）；`packages/pipeline/src/quality/checks.ts` 改为引用该常量，消除质检与渲染两处漂移风险。
- **渲染层叠加来源标签**：`packages/remotion-engine/src/components/index.tsx` 的 `ComponentShotVisual` 对 `DATA_COMPONENT_IDS` 且 `spec.source.label` 非空的镜头，在视觉层之上叠加一个 `pointerEvents: none` 的 `SourceTag`；非数据组件或未填来源时不叠加。
- **文案结构提示词**：`config/prompts/default/copy-v2-system.txt` 在 `sourceRef` 行后追加 4 条规则，并同步 `packages/pipeline/src/prompts.ts` 的 `BUILTIN_COPY_V2_SYSTEM`（保证无配置文件环境行为一致）：
  - `sourceRef.label ≤ 20 字`、可选 `note ≤ 40 字`；
  - 开头 1–2 镜必须给钩子（反常识结论 / 具体场景 / 悬念），禁止「今天我们来聊聊」；
  - 中段设问每 6–10 镜最多一次，问题在本镜、答案留下镜；
  - 医疗/法律/金融投资等风险主题，最后一镜 narration 或 onScreenText 必须含简短免责提示。
- **测试**：
  - `tests/unit/prompts.test.ts` 新增「copy v2 提示词的文案结构规则（T402）」2 例：内置回退与仓库默认集都包含来源长度/钩子/设问/免责四类规则；
  - `tests/unit/remotion-components.test.tsx` 新增「数据组件带来源时叠加来源标签，非数据组件不叠加」1 例（data-card 含 `来源：CERN 公开资料`，keyword-block 不含）。
- 明确没有做：不改 `sourceRef` 契约字段；不做来源标签的“真实可信度”校验（仅长度与存在性）；`visualType=image/video/symbol` 镜头不叠标签（渲染层只处理组件镜头）；不动 scene/tts 提示词。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/prompts.test.ts` | pass | 9 tests（新增 2 例规则断言） |
| `pnpm exec vitest run tests/unit/remotion-components.test.tsx` | pass | 13 tests（新增 1 例来源叠加） |
| `pnpm test` | pass | 94 files / 848 tests |
| `pnpm run typecheck` | pass | 8 个 tsconfig |
| `pnpm run web:build` | pass | 3306 modules |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  - 提示词规则是**软约束**，只保证模型被告知；真实 Ark 输出是否严格遵守需 T503 端到端验收。
  - 来源标签的“长度 ≤20 字”与质检无强绑定：报告只判“数据镜头缺来源”，不判标签长度超限；超长标签由渲染层单行展示自行截断/换行。
  - `DATA_COMPONENT_IDS` 与 `componentRegistry` 的 category 字段目前是两套描述（前者为 ID 清单），新增数据组件时需同时更新两处；已在 shared 内集中，改动点仍是 1 个文件。

## 风险与后续
- 风险：若后续新增数据类组件（如 `timeline-bar`）只加注册表未加 `DATA_COMPONENT_IDS`，渲染层不会叠来源标签而质检也不会判缺来源，形成“静默漏检”。建议在 T310（组件库）新增组件指引中显式提示同步该常量。
- 下一步任务：T403。
