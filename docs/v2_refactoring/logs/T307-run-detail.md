# T307 任务日志：Run 详情 + 路由重定向

## 元信息
- 任务 ID：T307
- 状态：done
- 开始时间：2026-11-08 07:12
- 结束时间：2026-11-08 07:13
- 关联设计：方案 §8.4 路由表 / §8.5 Run 详情；Web 专题 §5.6
- 依赖任务：T305、T207（质检报告 API）
- 后续任务：T404
- 变更文件：
  - apps/web/src/views/RunDetailView.vue
  - apps/web/src/views/RunTraceView.vue（改为重定向页）
  - apps/web/src/router.ts
  - apps/web/src/components/ToolCallCard.vue
  - apps/web/src/components/ToolGroup.vue

## 意图
把 Run 详情从「trace 页」升级为项目内的一等路由，并保留旧 `/runs/:id/trace` 锚链可用。

## 改动
- `RunDetailView.vue` 新增：
  - 页头展示 run 状态、触发者、开始/结束/耗时；8 阶段列表（含重试次数与耗时）。
  - 失败时显示 banner，提供 `POST /api/runs/:id/resume {action:"retry"}`。
  - 质检门禁区块读取 `GET /api/projects/:id/quality`，未产出时显示空态。
  - 工具调用 / LLM 调用 / 事件三个 Tab；`admin=1` 时返回目标为 `/admin`，否则回项目工作台。
- `RunTraceView.vue` 重写为客户端重定向：先 `GET /api/runs/:id` 取 `project_id`，再 `router.replace` 到 `/projects/:project_id/runs/:runId`（保留 query）；失败给「返回项目列表」。
- `router.ts` 新增 `/projects/:id/runs/:runId`，保留 `/runs/:id/trace` 指向重定向页。
- `ToolCallCard.vue` / `ToolGroup.vue`：锚链优先新路由，缺项目上下文时回落旧 trace 路由。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm test` | pass | 91 files / 825 tests |
| `pnpm run typecheck` | pass | — |
| 浏览器目检 1440×900 / 390×844 | pass | `t313-run-detail-1440x900.png` / `t313-run-detail-390x844.png`，8 阶段无横向滚动 |

## 断点 / 未完成
- 未完成项：无。
- 已知风险：旧链接触发一次额外 `GET /api/runs/:id`，属可接受成本。

## 风险与后续
- 风险：`resume` 重试是否可用依赖 run 失败态，非失败 run 不展示 banner。
- 下一步任务：T308。
