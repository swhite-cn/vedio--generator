# T110 任务日志：scene 生成器改为 SceneSpec 选型

## 元信息
- 任务 ID：T110
- 状态：done
- 开始时间：2026-11-07 09:06
- 结束时间：2026-11-07 09:12
- 关联设计：方案 §4.4 第 3 阶段、§5.6 组件注册表、§5.8 契约版本
- 依赖任务：T108（注册表）、T102（copy v2）、T109（组件规格）
- 后续任务：T112（spec 判据）、T113（storyboard 聚合 API）、T201/T202（渲染与 React 组件）
- 变更文件：
  - `packages/pipeline/src/scene-spec-store.ts`（新增）
  - `packages/pipeline/src/scene-spec-build.ts`（新增）
  - `packages/pipeline/src/scene-generate.ts`（v2 分支 + 选型编排）
  - `packages/pipeline/src/prompts.ts`（`sceneV2System`）
  - `config/prompts/default/scene-v2-system.txt`（新增）
  - `packages/pipeline/src/index.ts`（导出）
  - `apps/server/src/agent/tools/stage-tools.ts`（v2 产物与摘要分支）
  - `tests/unit/scene-spec-v2.test.ts`（新增，10 例）
  - `tests/unit/agent-stage-tools.test.ts`（mock 常量补充）

## 意图
scene 阶段从"让模型输出 HTML"改为"让模型只选组件 ID 并填参数"，产物收敛为 `scenes/spec.json`（SceneSpec）。
非法组件/参数在装配期被拦截并降级关键词块，保证流水线不因单镜选型失败而中断；v1 项目继续走原 HTML 路径。

## 改动
- 新增 `scene-spec-store.ts`：`SCENE_SPEC_RELATIVE_PATH = scenes/spec.json`，`readSceneSpec`（缺失返回 null）/`writeSceneSpec`，结构非法 -> `ADAPTER_PROTOCOL_INVALID`。
- 新增 `scene-spec-build.ts`（纯逻辑，无网络调用）：
  - `parseSceneSelectionJson`：容忍围栏、结构校验、shotId 去重；
  - `formatComponentCatalog`：把注册表格式化为提示词清单；
  - `buildShotSpecs`：component 镜头优先模型选型，其次 copy 内手工 component；未知组件/缺参/非法参数 -> 降级关键词块（标题截断 18 字），注册表无关键词块时退化为 image 镜头；
  - `mergeSceneSpecShots`：增量合并（替换同 ID、保留其余、追加新增）。
- `scene-generate.ts`：用 `readCopyDocument` 分流；v2 分支只给 component 镜头调用 Ark 一次，落 `scenes/spec.json`；动效时长取主题 `motion` 边界内的 400ms；生成清单记录 `contractVersion: 2.0`；模型整体失败时全部 component 镜头降级并记录 `ok=false`。
- `prompts.ts` 增加 `sceneV2System`，读取 `config/prompts/<集>/scene-v2-system.txt`，缺失回退内置默认；提示词通过 `{catalog}` 注入可用组件清单。
- `scene_generate` 工具：v2 摘要按镜头数并返回 `scenes/spec.json`，v1 保持逐场景 HTML。
- 明确没有做：SceneSpec 断点判据（T112）、聚合 API（T113）、React 组件渲染（T202）、其余 4 类组件（T203）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/scene-spec-v2.test.ts tests/unit/agent-stage-tools.test.ts tests/unit/prompts.test.ts` | pass | 3 files / 44 tests |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过 |
| `pnpm test` | pass | 74 files / 625 tests |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  1. v2 编排（Ark 调用/记录/合并）只有纯逻辑单测，未 mock Ark 端到端验证；真实 Ark 端到端仍属全局未完成项。
  2. 一次请求包含全部待选型 component 镜头；镜头数接近上限（80）时输出可能较长，后续可按章节分批。
  3. 降级统一使用关键词块，可能改变原 visualType 语义；需 T206 质检与分镜编辑器暴露降级状态。
  4. `promptOverride` 仍只允许单场景，但 v2 一次请求可能包含该场景全部镜头。
- 恢复时第一步：进入 T112，为 copy/cue/ASS/SceneSpec 增加结构判据。

## 风险与后续
- 风险：`buildShotSpecs` 对非 component 镜头不写动效，渲染层需要为 image/symbol 提供默认动效，否则静帧质检可能告警。
- 下一步任务：`T112` 能力判据 v2（依赖 T107/T105/T110 均已完成）。
