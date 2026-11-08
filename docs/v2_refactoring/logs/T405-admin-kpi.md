# T405 任务日志：管理 KPI 完善

## 元信息
- 任务 ID：T405
- 状态：done
- 开始时间：2026-11-08 09:50
- 结束时间：2026-11-08 10:45
- 关联设计：方案 §8.5 管理页 / 批次出口判据 M4
- 依赖任务：T311（管理页 KPI/用户/Runs/登录日志）
- 后续任务：T501（M5 收口）
- 变更文件：
  - apps/server/src/domain/admin-overview.ts（新增）
  - apps/server/src/http/routes/admin.ts
  - apps/web/src/stores/admin.ts
  - apps/web/src/views/AdminView.vue
  - tests/unit/admin-overview.test.ts（新增）

## 意图
T311 的管理页已有 4 个 KPI，但口径散落在路由处理器里：成功率的“分母是什么”“canceled 算不算”“本周从哪一刻起”都只能读代码推断，用户无法复算页面上的数字。本任务把口径抽成纯函数并写进接口响应（`basis`），前端直接展示分子分母，使 KPI 可验证。

## 改动
- **新增 `apps/server/src/domain/admin-overview.ts`**（纯函数，无 IO）：
  - `startOfWeekIso(now)`：本地时区「本周一 00:00」的 ISO 时间（`(getDay()+6)%7` 回退到周一）；
  - `summarizeAdminOverview({users, projects, runs, now})`：返回
    - `totalUsers` = 全部账号数；
    - `totalProjects` = 全站项目数；
    - `runsThisWeek` = `created_at >= weekStart` 的 run 数；
    - `successRate` = `done / (done + failed)`，保留 1 位小数（`Math.round(x*1000)/10`），分母为 0 时取 0，**canceled / running 不计入分子分母**；
    - `basis` = `{doneRuns, failedRuns, canceledRuns, completedRuns, weekStart, formula: "done / (done + failed)"}`。
- **`apps/server/src/http/routes/admin.ts`**：删除路由内的本地 `startOfWeekIso`，`GET /api/admin/overview` 改为 `summarizeAdminOverview({users, projects, runs})` 并直接返回结果（新增 `canceledRuns / weekStart / formula` 字段，原 4 个 KPI 值不变）。
- **前端**：
  - `stores/admin.ts` 的 `basis` 类型补 `canceledRuns? / weekStart? / formula?`；
  - `AdminView.vue` KPI hint 更新：「本周运行」提示改为「本周一 00:00 起（本地时区）」；「运行成功率」提示改为 `done N / (done+failed) M · canceled K 不计`，值直接取 `basis`，不自行推导。
- **测试** `tests/unit/admin-overview.test.ts`（3 例）：
  - `startOfWeekIso` 周日取前一周一、周一取当天 00:00；
  - 4 指标口径（3 done / 3 failed / 1 canceled / 1 running / 1 上周 → 本周 7、成功率 50），并断言 `successRate` 可由 `basis.doneRuns / basis.completedRuns` 复算；
  - 无已完成 run → 0；1 done / 3 completed → 33.3。
- 明确没有做：不改数据库查询（仍取全量 runs 后在内存汇总，数据量为本地单机级别）；不加时间范围筛选器；不改用户/项目/Runs 三个 Tab；不引入前端图表依赖。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/admin-overview.test.ts` | pass | 3 tests |
| `$env:VF_SMOKE='1'; pnpm exec vitest run tests/integration/admin-api.test.ts` | pass | overview 部分匹配（新增字段不影响 `toMatchObject`）断言通过 |
| `pnpm test` | pass | 94 files / 848 tests |
| `pnpm run typecheck` | pass | 8 个 tsconfig |
| `pnpm run web:build` | pass | 3306 modules |
| 浏览器目检 `/admin`（390×844） | pass | KPI 文案：`注册用户 3 全部账号` / `项目总数 2 全站项目` / `本周运行 0 本周一 00:00 起（本地时区）` / `运行成功率 20% done 1 / (done+failed) 5 · canceled 1 不计`；`scrollWidth - innerWidth = 0` |

> 目检数值与库内实况一致：done 1、failed 4 → 1/5 = 20%；全部 run 均在 2026-11-02（周一）之前创建，故本周运行 0。

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  - `weekStart` 用**本地时区**（Asia/Shanghai）计算，若服务部署到其他时区，页面“本周”含义随之改变；当前为单机本机使用，可接受。
  - `runsThisWeek` 依赖 `created_at >= weekStart` 的字符串比较，SQLite 存的是 ISO 字符串，排序键一致；若未来改成非 ISO 时间格式会失效。
  - 「运行成功率」不含 canceled 是刻意选择；若用户期望把 canceled 视为失败，需改 `summarizeAdminOverview` 并同步前端 hint 文案。

## 风险与后续
- 风险：KPI 全量加载 runs 在数据量增大后会变慢；单机场景暂不优化，如需要可改为 SQL 聚合（`COUNT(*) FILTER`）。
- 下一步任务：M5 收口（T501 起）。
