# T102 任务日志：copy 生成器 v2

## 元信息
- 任务 ID：T102
- 状态：done
- 开始时间：2026-11-04 07:36
- 结束时间：2026-11-04 07:45
- 关联设计：方案 §5.1 CopyDoc v2、§5.8 契约版本
- 依赖任务：T101
- 后续任务：T103
- 变更文件：
  - `packages/shared/src/contracts/copy.ts`
  - `packages/pipeline/src/copy-generate.ts`
  - `packages/pipeline/src/prompts.ts`
  - `apps/server/src/agent/tools/stage-tools.ts`
  - `apps/server/src/agent/session-registry.ts`
  - `tests/unit/contracts-v2.test.ts`
  - `tests/unit/copy-generate-v2.test.ts`
  - `tests/unit/agent-stage-tools.test.ts`
  - `tests/unit/prompts.test.ts`

## 意图
让 copy 阶段可以按项目契约版本产出 v2 文档（shots），但默认仍走 v1，保证 image/scene/tts/storyboard 尚未迁移时现有项目不被破坏。

## 改动
- `generateCopy` 新增 `contractVersion` / `themeId`：
  - `2.0` 时用 v2 提示词、用 `copyDocV2Schema` 解析、`writeCopyDocV2` 落盘、生成记录写 `contractVersion=2.0`；
  - 其它情况保持 v1 行为不变；
  - 返回值新增可选 `shotCount`。
- 新增 `parseCopyV2Json`（可单测）：注入 `contractVersion/topic/style/theme`，容忍 ```json 围栏。
- `StageToolContext` 新增 `contractVersion`，由 session-registry 从 `projects.contract_version` 注入；`copy_generate` 透传并输出"N 个镜头（M 个章节）"摘要。
- **契约放宽**：copy 阶段的 `visualType=component` 允许不带 `component`，组件选型由 scene 阶段负责；SceneSpec 仍强制 `componentId`。
- 测试补充：v2 解析成功/失败、shotId 重复拒绝、stage 工具透传与摘要、契约放宽。

明确没有做：
- 没有把新项目默认契约切成 `2.0`（下游 T103–T107 未迁移）；
- 没有让 image/scene/tts/storyboard 读取 v2（后续任务）；
- 没有为 v2 写入 `imagePrompt`（图片阶段将按 shot 推导）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/contracts-v2.test.ts tests/unit/prompts.test.ts tests/unit/copy-generate-v2.test.ts tests/unit/agent-stage-tools.test.ts` | pass | 4 files / 56 tests passed |
| `pnpm run typecheck` | pass | 全仓通过 |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm run typecheck`
- 恢复时第一步：进入 T103（image 按 shot + 锚点复用）
- 已知风险：
  - v2 生成路径尚未在真实 Ark 上验收；结构化输出是否稳定需要真实模型验证。
  - `generateCopy` 返回值多了 `shotCount`，CLI 若把它序列化到 stdout 需确认调用方兼容（当前 CLI 只取 out/sceneCount）。

## 风险与后续
- 风险：项目契约版本目前仍由创建入口固定 `1.0`，v2 链路只能通过测试或手工构造项目启用；真正切换要等 T107 完成。
- 下一步任务：T103 image 按 shot + 锚点复用。
