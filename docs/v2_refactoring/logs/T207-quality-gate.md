# T207 任务日志：质检接入引擎 + 报告 API

## 元信息
- 任务 ID：T207
- 状态：done
- 开始时间：2026-11-07 14:55
- 结束时间：2026-11-07 15:05
- 关联设计：方案 §7.1（GET /api/projects/:id/quality）、§7.2（quality.updated）、§7.4（质检执行点）、§7.3（单镜重生成后 quality 全量重跑）
- 依赖任务：T206（5 项检查）、T006（报告契约）、T204/T205（compose 物化帧）、T119（SSE 类型表）
- 后续任务：T404（质检失败定位与重跑、门禁拦截）、T307（Run 详情展示质检门禁）
- 变更文件：
  - `packages/pipeline/src/quality/checks.ts`（freeze 口径修正：镜头覆盖率 ≥80% + skipShotIds）
  - `apps/server/src/domain/quality-gate.ts`（新增：runQualityGate——质检执行 + 报告落盘）
  - `apps/server/src/workflow/engine.ts`（onStageCompleted 阶段完成钩子，抛错只告警）
  - `apps/server/src/app.ts`（钩子接线：v2 + compose → runQualityGate + `quality.updated` 推送）
  - `apps/server/src/http/routes/quality.ts`（新增 GET /api/projects/:id/quality）、`http/index.ts`（注册）
  - 测试：`tests/unit/quality-checks.test.ts`（freeze 口径重写 +2 例）、`tests/unit/quality-gate.test.ts`（新增 4 例）、`tests/unit/workflow-engine.test.ts`（+2 例）、`tests/integration/project-run-api.test.ts`（+1 例）

## 意图
把 T206 的检查接入运行链路：工作流引擎加阶段完成钩子，v2 项目 compose 完成后执行
质检门禁（报告落盘 `quality/report.json`）并向该会话推送 `quality.updated`；
新增只读 API 返回最新报告与服务端汇总。run 状态不受质检结论影响（门禁拦截留 T404）。

## 设计决策（含 T206 遗留口径裁决）
1. **freeze 假阳性裁决**：违规口径从"任意 ≥0.25s 冻结"改为"冻结时间覆盖镜头时长 ≥80%"
   （`FREEZE_SHOT_COVERAGE_RATIO`）——镜头内动效结束后的稳定显示是固定动效设计的预期形态，
   只有整镜近乎冻结才是渲染故障信号；同时 copy v2 中 `visualType=image` 的镜头
   （无动效设计）经 `skipFreezeShotIds` 整体剔除。T206 日志登记的口径风险就此关闭。
2. **执行时点**：compose 完成后（物化帧就绪，单次 ffmpeg 全片扫描）而非"render 后"
   逐镜头扫描——78 进程 vs 1 进程，且物化帧本来就在 compose 中生成；与方案 §7.4
   的"render 后"偏差已在本日志登记，语义等价（数据源同为帧序列）。
3. **钩子形态**：引擎只加通用 `onStageCompleted`（不含质检知识，阶段顺序/判据仍来自能力声明），
   质检装配在 app.ts 组装层；钩子抛错仅告警——质检结论不改变阶段状态与 run 成败。
4. **报告语义**：每次执行覆盖写最新报告（runId 关联本次 run），符合"最新质检报告"读取语义；
   追加式历史留待 T404（若需要）。
5. **API 口径**：`report`/`summary` 为 null 表示该项目从未跑过质检（v1 项目同此），
   不返回 404；summary 由服务端 `summarizeQualityReport` 计算，前端不推导。

## Checkpoint
- 2026-11-07 14:55 任务开始：读 T206 遗留口径与引擎主循环；设计定稿（钩子形态 + freeze 口径）。
- 2026-11-07 15:00 freeze 口径修正 + quality-gate + 引擎钩子 + app 组装 + 路由完成；
  typecheck 过（QualityReport 在 shared、QualitySummary 在 pipeline，两处 import 修正）。
- 2026-11-07 15:03 修 checkFreeze 写日志前未建父目录（ENOENT）。
- 2026-11-07 15:05 全量 typecheck + `pnpm test` 84 files / 733 tests 通过；
  集成 `project-run-api.test.ts`（VF_SMOKE）通过。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm run typecheck` | pass | 7 个 tsconfig 全通过 |
| `pnpm test` | pass | 84 files / 733 tests（较 T206 的 726 净增 7） |
| `pnpm vitest run tests/unit/quality-gate.test.ts` | pass | 4 例（齐备落盘/阻断/缺物化帧 freeze skipped/v1 拒绝） |
| `pnpm vitest run tests/unit/quality-checks.test.ts` | pass | 17 例（freeze 新口径：80% 覆盖违规、30% 不报、image 跳过） |
| `pnpm vitest run tests/unit/workflow-engine.test.ts` | pass | 24 例（+2：钩子按序触发/抛错不阻塞 run） |
| `$env:VF_SMOKE="1"; pnpm vitest run tests/integration/project-run-api.test.ts` | pass | 含 +1：GET /quality（null/报告/403） |

## 断点 / 未完成
- 未完成项：本任务范围内无遗留。
- 已知边界与风险：
  1. 质检结论当前**不拦截 run**（blocking 也只进报告与 SSE）；门禁拦截（run 失败/重跑引导）
     按任务板归属 T404（M4）。
  2. freeze 检查依赖 compose 物化帧；单镜重生成（T115）只重渲染目标镜头、compose 全片重跑后
     质检照常全量执行，符合方案 §7.3"quality 全量重跑"。
  3. `quality.updated` 仅在引擎钩子链路发布；直接调内核（CLI）不产生事件，与 asset.bound/
     preview.ready 同一口径。
- 恢复时第一步：进入 T208（Player 应用 + iframe 协议）。

## 风险与后续
- 风险：freezedetect 的 80% 覆盖率口径对"动效只在开头 300ms 的长镜头"不报违规（覆盖率 <80%）
  ——符合"整镜冻结才是故障"的设计意图；若 T206 质检发现漏报，调低阈值即可（常量已导出）。
- 下一步任务：`T208` Player 应用 + iframe 协议（依赖 T201，已就绪）。
