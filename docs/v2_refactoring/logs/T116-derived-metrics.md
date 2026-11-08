# T116 任务日志：服务端派生指标

## 元信息
- 任务 ID：T116
- 状态：done
- 开始时间：2026-11-07 10:41
- 结束时间：2026-11-07 10:45
- 关联设计：方案 §7.1（`GET /api/projects` 扩展字段）、§7.5 服务端派生指标
- 依赖任务：T106（timeline v2）、T118（copy v2 绑定计算口径）
- 后续任务：T303（能力中心最近运行表）、T304（项目列表卡片）
- 变更文件：
  - `apps/server/src/domain/project-metrics.ts`（新增，纯逻辑 + 受控文件读取）
  - `apps/server/src/http/routes/projects.ts`（列表/详情挂指标）
  - `tests/unit/project-metrics.test.ts`（新增，8 例）
  - `tests/integration/project-run-api.test.ts`（+1 例）

## 意图
项目列表与能力中心需要 shotCount/totalMs/progress/etaSeconds 等统计，方案 §7.5 明确前端不推导，
全部由服务端计算；v1 项目或产物缺失时字段为 `null`，列表页不因坏文件失败。

## 改动
- 新增 `project-metrics.ts`：
  - `deriveProjectMetrics({ projectDir, runs, runStages })` 组装入口，返回
    `{ shotCount, totalMs, averageShotMs, progress, etaSeconds, boundShotCount }`；
  - `shotCount`/`boundShotCount`：copy v2 shots 总数与"绑定过至少一个资产的镜头数"（Set 去重）；
    v1 项目、copy 缺失或非法 → `null`；
  - `totalMs`/`averageShotMs`：timeline v2 的 `totalMs` 与镜头 `durationMs` 平均；缺失/非法（含 v1 场景级
    timeline 被契约拒绝）→ `null`；
  - `progress`：`computeProgress(latestRunId, runStages)`——只统计最新 run 的每阶段最新 attempt，
    done/skipped 计 1、running 计 0.5，分母为运行时 `PIPELINE_STAGES`（7 阶段，与能力声明一致）；
  - `etaSeconds`：`computeEtaSeconds(latestRunId, runStages)`——剩余阶段（最新 run 未 done/skipped）
    逐阶段取本项目历史耗时中位数，缺历史的阶段回退全体样本中位数，无任何样本 → `null`；
    最新 run 全部完成 → `0`；向上取整为秒。
- `GET /api/projects` 与 `GET /api/projects/:id`：项目对象平铺扩展
  `...metrics` 与 `latestRun`（最新 run 或 `null`，方案 §7.1 的 `latestRun` 字段）；
  原状态推导逻辑不变，仅把 runs/run_stages 查询提取为 `assembleProjectView` 复用，避免双份查询。
- 明确没有做：`GET /api/projects/:id/overview` 独立端点（T305 工作台时按需拆）、
  eta 的全局（跨项目）历史样本池、progress 阶段加权配置化。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm vitest run tests/unit/project-metrics.test.ts` | pass | 8 tests（进度 3 + eta 3 + 组装 2） |
| `$env:VF_SMOKE="1"; pnpm vitest run tests/integration/project-run-api.test.ts` | pass | 26 tests（含新增列表/详情指标 1 例） |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过 |
| `pnpm test` | pass | 78 files / 659 tests |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  1. progress 分母用运行时 `PIPELINE_STAGES`（7 阶段）；T004 能力切换到 8 阶段后分母自动变 8，
     v1 项目进度数值会整体下移，前端只展示不持久化，无迁移问题。
  2. etaSeconds 以"阶段耗时中位数"估算，镜头级重生成 run（scope 窄、阶段快）会拉低中位数，
     整片 run 的预估会偏乐观；方案允许 `null` 与估算误差，暂不做 scope 感知。
  3. 列表页每项目重读 copy.json/timeline.json（O(项目数) 文件 IO）；本地单机规模可接受。
  4. `boundShotCount` 口径为"绑定过资产的镜头数"，与素材库单资产"已绑定 N 镜头"（引用次数）不同，
     前端文案需区分（T309 注意）。

## 风险与后续
- 下一步任务：`T117` 组件/主题读取 API（`/api/components`、`/api/themes`），依赖 T108/T111 均已 done。
