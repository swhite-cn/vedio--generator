# T005 任务日志：数据库迁移（v2 列与新表）

## 元信息
- 任务 ID：T005
- 状态：done
- 开始时间：2026-11-03 23:15
- 结束时间：2026-11-03 23:25
- 关联设计：方案 §6.1 表变更、§7.3 镜头级重生成
- 依赖任务：T002
- 后续任务：T006
- 变更文件：
  - `packages/shared/src/domain.ts`
  - `apps/server/src/db/schema.ts`
  - `apps/server/src/db/migrate.ts`
  - `apps/server/src/db/repositories/project-repository.ts`
  - `apps/server/src/db/repositories/run-repository.ts`
  - `apps/server/src/db/repositories/asset-repository.ts`
  - `tests/unit/db-schema.test.ts`
  - `tests/unit/project-repository.test.ts`
  - `tests/unit/run-repository.test.ts`
  - `tests/unit/asset-repository.test.ts`

## 意图
为 v2 契约、镜头级重生成、主题快照、素材分类和管理登录日志提供持久化位置，同时保证既有库可幂等升级、旧项目默认按 `1.0` 续跑。

## 改动
- `projects`：新增 `theme_id`、`contract_version`（默认 `1.0`）。
- `runs`：新增 `scope_json`（镜头级范围 JSON）、`contract_version`（默认 `1.0`）。
- `project_assets`：新增 `visual_category`（6 类素材库分类，可空）。
- 新增 `login_events` 表（追加式）：`user_id/username/ok/reason/ip/user_agent/created_at` 与两个索引。
- 迁移同时更新新库 CREATE 与旧库 `ensureColumn` 两条路径。
- 仓储回填新字段：项目创建可传 `themeId/contractVersion`；run 创建可传 `scope/contractVersion`；资产可传 `visualCategory` 并按分类筛选。
- 测试补充：v2 列存在、登录表结构、旧库升级默认 `1.0`、范围与分类的写入/读回。

明确没有做：
- 没有写登录事件（认证路由接入留给 T311）；
- 没有把新项目默认契约改成 `2.0`（留给 T102 的创建入口）；
- 没有实现镜头重生成逻辑（T115），本次只落数据位。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/db-schema.test.ts tests/unit/project-repository.test.ts tests/unit/run-repository.test.ts tests/unit/asset-repository.test.ts` | pass | 4 files / 28 tests passed |
| `pnpm run typecheck` | pass | 全仓 6 个 tsconfig 通过 |
| `pnpm --filter @videoforge/web build` | pass | 3263 modules，构建成功 |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm --filter @videoforge/web build`
- 恢复时第一步：读 `tasks.md` 当前焦点，进入 T006
- 已知风险：
  - `Project` / `Run` 新增必填字段后，外部若有手写对象字面量需补字段；本仓已检索，仅测试 socket 用 `as unknown as`，不受影响；
  - `scope_json` 解析失败会按整片 run 处理并告警，不阻断续跑；
  - Web 构建提示 chunk 1.64MB，`zod` 经 shared 导出可能进入前端产物；后续 T301 拆分 shared 子路径导入或在 Web 只引类型。

## 风险与后续
- 风险：`login_events` 目前是空表，管理页在 T311 前不能展示真实日志。
- 下一步任务：T006 质量报告契约与生成骨架。
