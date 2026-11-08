# T002 任务日志：共享契约 v2（schema + 类型 + fixtures + 单测）

## 元信息
- 任务 ID：T002
- 状态：done
- 开始时间：2026-11-03 07:58
- 结束时间：2026-11-03 08:02
- 关联设计：方案 §5 数据契约 v2
- 依赖任务：T001
- 后续任务：T003
- 变更文件：
  - `packages/shared/src/contracts/common.ts`
  - `packages/shared/src/contracts/copy.ts`
  - `packages/shared/src/contracts/timeline.ts`
  - `packages/shared/src/contracts/scene-spec.ts`
  - `packages/shared/src/contracts/quality.ts`
  - `packages/shared/src/contracts/theme.ts`
  - `packages/shared/src/contracts/component.ts`
  - `packages/shared/src/contracts/index.ts`
  - `packages/shared/src/index.ts`
  - `packages/shared/package.json`
  - `pnpm-lock.yaml`
  - `tests/fixtures/contracts-v2/*`
  - `tests/unit/contracts-v2.test.ts`

## 意图
先把方案 §5 的六类契约落成可执行 schema，后续 copy 生成、时间轴、scene 选型、质检、主题、组件库都从这里取类型，避免每条线上各写一份结构。

## 改动
- 新增 `common`：转场三型、资产引用、来源信息、风格锚、唯一性工具。
- 新增 `copy`：`scenes[].shots[]`、组件选择、视觉类型；校验 shotId 全片唯一、component 类型必须带组件、风格锚 key 唯一。
- 新增 `timeline`：镜头切点、旁白 cue、动效 cue；校验切点连续、cue 不越镜、动效 300–800ms、ID 唯一。
- 新增 `scene-spec`：组件 ID + props + 资产 + 转场 + 固定动效。
- 新增 `quality`：固定 5 项检查，报告必须齐全且不重复。
- 新增 `theme`：颜色、字体、字幕样式、动效边界；Profile 与主题解耦。
- 新增 `component`：7 类固定类别、参数声明、预览 fixture。
- `@videoforge/shared` 增加 `zod` 依赖并统一导出契约。

明确没有做：
- 没有改阶段数量（留给 T004）；
- 没有改 copy 读取行为（留给 T003）；
- 没有实现质检执行器、主题加载器或组件注册表运行时（后续任务）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm install --offline --no-frozen-lockfile` | pass | lockfile 更新，zod 4.6.5 复用 |
| `pnpm exec vitest run tests/unit/contracts-v2.test.ts` | pass | 20 passed |
| `pnpm --filter @videoforge/shared build` | pass | tsc 无错误 |
| `pnpm run typecheck` | pass | 全仓 6 个 tsconfig 通过 |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm run typecheck`
- 恢复时第一步：读 T003 日志
- 已知风险：
  - schema 比 v1 严格（如动效硬限 300–800ms），后续若发现表达不足需走契约变更而不是放宽在业务层；
  - `zod` 进入 `@videoforge/shared` 后，Web 若直接 import schema 值会增加包体；Web 只应引用类型。

## 风险与后续
- 风险：契约与 UI 设计稿文案可能仍有字段缺口（如主题 token 展示），T111/T117 时补齐。
- 下一步任务：T003 copy 读取器 v1/v2 兼容。
