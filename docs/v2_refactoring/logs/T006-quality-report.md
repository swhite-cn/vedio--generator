# T006 任务日志：质量报告契约与生成骨架

## 元信息
- 任务 ID：T006
- 状态：done
- 开始时间：2026-11-03 23:38
- 结束时间：2026-11-03 23:42
- 关联设计：方案 §5.4 QualityReport、§7.4 质检执行点
- 依赖任务：T002
- 后续任务：T206/T207
- 变更文件：
  - `packages/shared/src/contracts/quality.ts`
  - `packages/pipeline/src/quality/report.ts`
  - `packages/pipeline/src/quality/index.ts`
  - `packages/pipeline/src/index.ts`
  - `tests/unit/quality-report.test.ts`

## 意图
先把质检报告的落盘、读取、合并与阻断判定固化，后续 T206 的 5 项检查只需"填检查项"，不必再各写读写逻辑；UI 的"N 项待处理"与失败重跑也依赖统一汇总口径。

## 改动
- 新增 `QUALITY_REPORT_RELATIVE_PATH = quality/report.json`（供能力判据与阶段钩子共用）。
- 新增 `createEmptyQualityReport`：5 项固定检查，默认 `skipped`。
- 新增 `buildQualityReport`：合并部分结果、缺失补 `skipped`、按契约校验、固定顺序。
- 新增 `readQualityReport` / `writeQualityReport`：读写前后都走 schema，错误统一 `ADAPTER_PROTOCOL_INVALID`。
- 新增 `summarizeQualityReport` 与 `isBlockingFailure`：字幕溢出、来源标签为阻断项。
- `shared` 补导出 `QualityStatus` 类型（实现时发现缺失）。

明确没有做：
- 没有实现任何具体检查算法（T206）；
- 没有接入阶段钩子或 HTTP API（T207）；
- 没有新增数据库表（首版用 JSON 产物 + trace）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/quality-report.test.ts` | pass | 7 tests passed |
| `pnpm run typecheck` | pass | 全仓通过（首次失败于缺少 `QualityStatus` 导出，已修复） |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm run typecheck`
- 恢复时第一步：进入 T007 或 T206
- 已知风险：
  - `summarizeQualityReport` 的 `failed` 是"检查项数"，不是"违规条数"；设计稿 Run 详情头部的"3 项待处理"看起来统计的是 **violations 总条数**（2 项 fail、共 3 处违规）。T207 接 UI 时必须明确口径，建议提供 `pendingCount = Σ violations.length`。
  - 阻断策略目前硬编码在 `BLOCKING_QUALITY_CHECK_IDS`；若后续需要按项目配置，改成读取配置而不是散落判断。

## 风险与后续
- 风险：报告先于检查实现落地，若 T206 迟迟未做，`quality/report.json` 会长期全是 `skipped`，UI 不能宣称"已质检"。
- 下一步任务：T007 设计令牌与深色主题映射。
