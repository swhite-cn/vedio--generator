# T008 任务日志：契约版本写入 manifest/trace

## 元信息
- 任务 ID：T008
- 状态：done
- 开始时间：2026-11-04 00:08
- 结束时间：2026-11-04 00:18
- 关联设计：方案 §5.8 契约版本、§6.3 迁移
- 依赖任务：T003/T005
- 后续任务：T009、T102
- 变更文件：
  - `packages/pipeline/src/manifest.ts`
  - `packages/pipeline/src/project-manifest.ts`
  - `packages/pipeline/src/index.ts`
  - `apps/server/src/http/routes/projects.ts`
  - `tests/unit/pipeline-manifest.test.ts`
  - `tests/unit/project-manifest.test.ts`

## 意图
让"这条产物/这次 run 是按哪个契约版本产生的"在项目和生成记录两层都可追溯，避免 v1/v2 混跑时无法解释差异。

## 改动
- 生成清单记录新增 `contractVersion`：写入默认 `1.0`，旧记录读取时归一化为 `1.0`。
- 新增项目根目录 `manifest.json`（`PROJECT_MANIFEST_FILE`）：
  - 结构：`version/contractVersion/themeId/createdAt/updatedAt`；
  - `ensureProjectManifest` 幂等创建，已存在不覆盖历史快照；
  - 旧清单缺字段时归一化 `contractVersion=1.0`、`themeId=null`。
- 新建项目时写 `manifest.json`（失败只告警，不阻断建项目），并把 `project.contract_version` 传给首个 run。
- run 的 `contract_version` 已由 T005 落库，接口返回 run 时自动携带。

明确没有做：
- 没有把生成记录的实际版本从阶段工具透传（当前所有新记录默认 `1.0`，T102/T104 产 v2 时需显式传 `2.0`）；
- 没有在 trace 页展示版本（T307 前端展示）；
- 没有改 `run_stages` 表（版本归属在 run 级）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/project-manifest.test.ts tests/unit/pipeline-manifest.test.ts` | pass | 2 files / 17 tests passed |
| `pnpm run typecheck` | pass | 全仓通过 |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm run typecheck`
- 恢复时第一步：进入 T009
- 已知风险：
  - 项目清单写盘发生在建项目时，若存储目录不可写会只告警；此时 trace 仍可从 DB 得到版本，但导出文件缺清单；
  - 生成记录默认 `1.0` 是安全默认，若 T102 忘记显式传 `2.0`，审计会显示 v1 而实际产 v2——T102 验收必须覆盖这一点。

## 风险与后续
- 风险：两份 manifest（项目级 `manifest.json` 与 `manifest/generations.jsonl`）命名相近，文档需明确区别。
- 下一步任务：T009 v1 行为快照与回归基线。
