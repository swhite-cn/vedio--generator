# T504 任务日志：旧项目迁移提示 + CLI 校验

## 元信息
- 任务 ID：T504
- 状态：done
- 开始时间：2026-11-08 11:52
- 结束时间：2026-11-08 12:20
- 关联设计：方案 §6.3（迁移，行 572-578）、§11.2（验收清单「旧项目可续跑或有明确可执行提示」）
- 依赖任务：T501（删除 legacy 渲染通道，旧项目 scene 起明确失败）
- 后续任务：T503（全量验收）
- 变更文件：
  - `apps/server/src/domain/project-contract.ts`（新增：契约可运行判定 + 迁移提示文案，供 HTTP 层与 CLI 共用）
  - `apps/server/src/http/routes/runs.ts`（`POST /api/projects/:id/runs` 发起 run 前拦截非 v2 项目）
  - `apps/cli/src/project-verify.ts`（输出 `contractVersion`；非 v2 追加迁移提示并判 `ok=false`）
  - `tests/unit/project-contract.test.ts`（新增：3 例锁定判定与文案）
  - `tests/unit/cli-project-verify.test.ts`（补 `contractVersion` 断言 + 存量 v1 用例）
  - `tests/integration/project-run-api.test.ts`（`seedProject` 增契约版本参数；两例改 v2；新增 v1 拦截用例；reconcile 用例切 v2 夹具）

## 意图
T501 删除 legacy 渲染通道后，存量 v1 项目（`projects.contract_version = '1.0'`）在新代码下从 scene 阶段起会失败，但失败信息散落在各阶段工具内部、且发起 run 时不会提前告知，用户无法从入口处得到「不可续跑 + 该如何做」的明确指引。本任务把判定与迁移提示集中到一处，并在**唯一续跑入口**（`POST /api/projects/:id/runs`）与 `project:verify` 两处暴露，使方案 §11.2「旧项目可续跑或有明确可执行提示」在 API 与 CLI 两层同时成立。

## 改动
- **集中迁移判定** `apps/server/src/domain/project-contract.ts`：
  - `legacyProjectMigrationHint(contractVersion)` → 返回可直接展示的中文提示（携带实际契约版本、说明 legacy 通道已移除、给出「新建项目」的可执行动作）。
  - `isRunnableContract(contractVersion)` → 仅 `2.0` 视为可续跑。
  - `assertProjectRunnable(contractVersion)` → 非 v2 抛 `VideoForgeError("CONFIG_INVALID", hint)`，`VideoForgeError` 的 message 会带 `CONFIG_INVALID: ` 前缀。
- **HTTP 入口拦截** `apps/server/src/http/routes/runs.ts`：`POST /api/projects/:id/runs` 改为先取回 project（缺失时 `AUTH_FORBIDDEN`，与既有越权语义一致），随后 `assertProjectRunnable(project.contract_version)`。旧项目在「发起 run」时即返回 400 + 迁移提示，避免跑出中间产物后才失败。
- **CLI 覆盖 v2** `apps/cli/src/project-verify.ts`：`VerifyReport` 新增 `contractVersion`；`verifyProjectArtifacts` 增可选 `contractVersion`（缺省按 v2 处理，新项目一律 v2）；非 v2 时向 `hints` 追加迁移提示且 `ok = runnable && ...`；`runProjectVerify` 传入 `project.contract_version`。
- **测试**：新增 `tests/unit/project-contract.test.ts`；`cli-project-verify.test.ts` 补 `contractVersion` 断言与存量 v1 用例；`tests/integration/project-run-api.test.ts` 的 `seedProject` 增加契约版本参数（默认 `1.0`）、成功/409 两例改 v2、新增 v1 拦截用例，并把 reconcile 用例改为 v2 夹具（v2 tts 判据需结构合法的 `audio/cues.json`）。

**明确没有做**：未做 v1→v2 数据迁移（方案 §6.3 约定旧项目不迁移、只提示重建）；未改 `GET /api/projects` 等只读接口（旧项目仍可查看）；未新增前端弹窗（迁移提示经 API/CLI 暴露，文案集中化已具备复用条件）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/project-contract.test.ts tests/unit/cli-project-verify.test.ts` | pass | 8 tests |
| `$env:VF_SMOKE="1"; pnpm exec vitest run tests/integration/project-run-api.test.ts` | pass | 1 file / 30 tests |
| `pnpm test` | pass | 89 files / 818 tests passed，exit 0 |
| `pnpm run typecheck` | pass | 7 个 tsconfig 全通过，exit 0 |

关键行为证明：
- 存量 v1 项目发起 run → 400 + `CONFIG_INVALID`，message 含「契约版本为 1.0」与「新建项目」，且未触发引擎（`workflowState.run` 未被调用）。
- v2 项目发起 run → 201 正常，引擎被触发（既有两例改 v2 后通过）。
- `project:verify` 对 v1 项目输出 `contractVersion: "1.0"`、`hints` 含「无法续跑」、`ok=false`；对 v2 项目输出 `contractVersion: "2.0"` 且 `ok=true`。

## 断点 / 未完成
- 未完成项：无（T503 全量验收为后续任务）。
- 最后运行的命令：`pnpm run typecheck`（exit 0）。
- 恢复时第一步：无（任务已收口）。

## 风险与后续
- **行为变更**：存量 v1 项目此前可在 API 层发起 run（随后在 scene 阶段失败），现在在发起时即被拦截返回 400。此变更符合方案 §6.3「旧项目不迁移、给明确提示」的验收要求，已在 `operator-guide` 记录。
- **受控偏差**：迁移提示文案集中在服务端 `project-contract.ts`（CLI 通过 `@videoforge/server` 子路径复用），未在 CLI 内复制第二份文案，避免 HTTP/CLI 文案漂移。
- `projects.contract_version` 的 DB 默认值仍为 `1.0`（存量语义）；创建入口固定写 `CONTRACT_VERSION_V2`，不受影响。
- 下一步任务：T503（SKILL §8 + 方案 §11 全量验收清单；含 `pnpm test:bench` 重跑移除 legacy 段）。
