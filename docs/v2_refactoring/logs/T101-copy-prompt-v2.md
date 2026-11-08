# T101 任务日志：copy 提示词 v2（一句一镜）

## 元信息
- 任务 ID：T101
- 状态：done
- 开始时间：2026-11-04 07:30
- 结束时间：2026-11-04 07:40
- 关联设计：方案 §5.1 CopyDoc v2、§4.4 八阶段
- 依赖任务：T003
- 后续任务：T102
- 变更文件：
  - `config/prompts/default/copy-v2-system.txt`
  - `packages/pipeline/src/prompts.ts`
  - `tests/unit/prompts.test.ts`

## 意图
把"一句一镜 + 风格锚 + 来源"写成可切换的 v2 提示词，同时保留 v1 提示词文件不改，避免旧项目在 T102 之前被新提示词误伤。

## 改动
- 新增 `copy-v2-system.txt`：限定 40–80 镜、每镜 12–32 字、shotId 全片唯一、屏上文字 ≤18 字、数据镜头必须带 `sourceRef`、3–6 个 `styleAnchors`、转场三型。
- `PromptSet` 新增 `copyV2System`，内置默认与文件覆盖双路径；`copy-system.txt` 保持 v1 原文。
- 测试：内置 v2 提示词包含"一句一镜"；新增 v2 文件只覆盖 v2，不影响 v1。

明确没有做：
- 没有把 `prompts.default_set` 切到 v2；
- 没有改 copy 生成器的解析逻辑（T102）；
- 没有删除 v1 提示词。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/prompts.test.ts` | pass | 7 tests passed |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm exec vitest run tests/unit/prompts.test.ts`
- 恢复时第一步：进入 T102
- 已知风险：
  - v2 提示词要求"不要输出 component 字段"，因此 copy 契约必须允许 component 缺省；已在 T102 同步放宽并调整测试。
  - 提示词长度较大，真实模型是否稳定遵守 40–80 镜需在真实 Ark 验收时观察；失败由 T102 的结构校验兜底。

## 风险与后续
- 风险：若默认集目录缺 `copy-v2-system.txt`，会回退内置 v2 提示词；两处文案需保持一致（文件与内置常量）。
- 下一步任务：T102 copy 生成器 v2。
