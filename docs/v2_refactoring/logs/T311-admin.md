# T311 任务日志：管理页（KPI + 登录日志）

## 元信息
- 任务 ID：T311
- 状态：done
- 开始时间：2026-11-08 07:16
- 结束时间：2026-11-08 07:18
- 关联设计：方案 §7.1 管理 API / §8.5 管理页
- 依赖任务：T301、T005（`login_events` 表）
- 后续任务：T405
- 变更文件：
  - apps/server/src/db/repositories/login-event-repository.ts
  - apps/server/src/http/routes/auth.ts
  - apps/server/src/http/routes/admin.ts
  - apps/web/src/views/AdminView.vue
  - apps/web/src/stores/admin.ts
  - tests/integration/admin-api.test.ts

## 意图
补齐管理页所需的服务端数据面：4 个 KPI 与登录日志此前只有表没有 API，前端无法展示真实口径。

## 改动
- 新增 `login-event-repository.ts`：`createLoginEvent`（不写口令/哈希）、`adminListLoginEvents`（仅 admin，上限 500，按时间倒序）、`toLoginEventView`。
- `auth.ts`：登录成功/凭据失败/节流失败三处写入登录事件（`reason` 为 `INVALID_CREDENTIALS` / `THROTTLED`），写库异常仅 warn 不影响登录。
- `admin.ts` 新增：
  - `GET /api/admin/overview`：注册用户、项目总数、本周运行（本地时区周一 00:00 起）、成功率 = done/(done+failed) 保留 1 位，并返回 `basis` 计数。
  - `GET /api/admin/login-events?limit=`：返回 `events`。
- `AdminView.vue`：4 KPI 卡 + 4 Tab（用户/项目/Runs/登录日志）；登录日志列：时间/用户/结果/原因/IP/UA；Runs 详情跳新路由 `/projects/:project_id/runs/:id?admin=1`。
- `stores/admin.ts`：新增 `AdminOverview`/`LoginEventView` 与 `loadOverview()`/`loadLoginEvents()`。
- 未做：不做用户禁用/删除；不记录口令与令牌。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `$env:VF_SMOKE='1'; pnpm exec vitest run tests/integration/admin-api.test.ts` | pass | 12 例（含 overview 403、登录日志不含口令、搜索三类） |
| `pnpm run typecheck` | pass | — |
| 浏览器目检 1440×900 / 390×844 | pass | `t313-admin-1440x900.png`、`t313-admin-logins-1440x900.png`、`t313-admin-390x844.png` |

## 断点 / 未完成
- 未完成项：无。
- 已知风险：KPI 口径（本周、成功率）为当前实现口径，T405 会固定并复算校验。

## 风险与后续
- 风险：登录事件写入失败不影响登录，审计可能缺行（已接受）。
- 下一步任务：T312。
