# T108 任务日志：组件注册表基础设施

## 元信息
- 任务 ID：T108
- 状态：done
- 开始时间：2026-11-07 09:02
- 结束时间：2026-11-07 09:04
- 关联设计：方案 §5.6 组件注册表、§4.3 `config/components`、§8 组件库
- 依赖任务：T002（v2 契约）
- 后续任务：T109（3 类组件规格）、T110（scene 选型）、T117（`/api/components`）、T202/T203（React 组件）
- 变更文件：
  - `packages/template-sdk/src/components/registry.ts`（新增）
  - `packages/template-sdk/src/index.ts`（导出）
  - `packages/shared/src/contracts/component.ts`（补 `ComponentCategory` 类型导出）
  - `tests/unit/component-registry.test.ts`（新增，14 例）

## 意图
建立"组件即数据"的注册表：组件只以 ID + 参数声明 + 动效 + 预览 fixture 登记，LLM 只能选型填参。
新增组件只需追加声明数组，不改 stages、pipeline 或 API，为 T109/T110 与 T117 组件库页面解锁。

## 改动
- 新增 `createComponentRegistry(entries)`：
  - 构造期用 `componentRegistryEntrySchema` 校验结构，ID 去重，类别必须是 7 类之一；
  - `previewFixture` 必须是相对路径、不得含 `..`（组件库读取安全）；
  - 提供 `list` / `listByCategory` / `get` / `require`，未知组件统一 `CONFIG_INVALID`。
- 新增参数校验：
  - `validateProps(id, props)` 不抛异常，返回 `{ ok, errors }`；未知参数、缺必填、类型错误、字符串长度（按 CJK 字符数）、数值边界、枚举取值逐项给出中文原因；
  - `assertProps(id, props)` 在装配期（scene/渲染前）抛 `CONFIG_INVALID`。
- `BUILTIN_COMPONENT_ENTRIES` 当前为空表（基础设施阶段不伪造组件），T109/T203 只需追加声明；
  `componentRegistry` 为默认实例，供 scene 阶段与服务端 API 共用。
- 明确没有做：具体组件规格与 fixture（T109/T203）、scene 选型提示词（T110）、`/api/components`（T117）、React 组件实现（T202/T203）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/component-registry.test.ts` | pass | 14 tests |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过（含 template-sdk） |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  1. 注册表暂放 `packages/template-sdk`，方案 §4.3 期望最终归 `packages/remotion-engine`；T201 建包时应迁移或转导出，避免两处声明。
  2. 内置注册表为空：T117 接口在 T109 之前会返回空列表，属预期中的过渡态。
  3. 参数校验只覆盖 `paramsSchema` 声明，不校验组件语义（如"来源标签必须带 source"），后者由 scene/质检负责。
- 恢复时第一步：进入 T109，在 `BUILTIN_COMPONENT_ENTRIES` 追加关键词块/数据卡/引语卡三条声明并配 fixture。

## 风险与后续
- 风险：`paramsSchema` 使用 `z.record`，未限制参数名格式；若后续需要前端表单自动生成，可补充命名约定校验。
- 下一步任务：`T109` 3 类高频组件规格。
