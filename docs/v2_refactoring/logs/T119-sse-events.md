# T119 任务日志：SSE 新事件

## 元信息
- 任务 ID：T119
- 状态：done
- 开始时间：2026-11-07 10:51
- 结束时间：2026-11-07 10:55
- 关联设计：方案 §7.2 SSE 事件增量、§7.3 镜头级重生成时序
- 依赖任务：T115（镜头重生成 + run scope）
- 后续任务：T204（render 切 Remotion 时补 `asset.bound`/`preview.ready` 发布点）、
  T207（质检接入引擎时启用 `quality.updated`）、T208（播放器 postMessage 消费 `preview.ready`）
- 变更文件：
  - `apps/server/src/http/event-bus.ts`（事件类型表 +4）
  - `apps/server/src/http/routes/shots.ts`（PATCH 后发布 `shot.updated`）
  - `tests/unit/sse-buffer.test.ts`（更新类型锁定 + 新增回放 1 例）
  - `tests/integration/project-run-api.test.ts`（PATCH 用例扩展 SSE 断言）

## 意图
方案 §7.2 要求四类新事件：`shot.updated`（镜头变更 → 局部刷新）、`quality.updated`（质检完成 → 刷新门禁卡）、
`asset.bound`（绑定变化 → 刷新素材库计数）、`preview.ready`（预览可用 → 播放器刷新），
且必须遵守既有 `Last-Event-ID + resync` 协议。

## 改动
- `SSE_EVENT_TYPES` 追加 4 类（保留方案原文点号命名；`resync`/`error` 保持在尾部）：
  - `shot.updated`：**发布点已落地**——`PATCH /api/projects/:id/shots/:shotId` 成功后发布，
    payload `{ projectId, shotId, changes, before, after, specUpdated }`；
  - `quality.updated`：协议面就绪；触发上游（质检接入引擎）属 T207，届时在报告落盘处发布；
  - `asset.bound`：协议面就绪；触发上游（image 阶段回填 `assetId`/`imagePath` 后）属 T204；
  - `preview.ready`：协议面就绪；触发上游（预览帧/片段产出）属 T204/T208。
- 发布机制零改动：事件总线按会话环形缓冲 + 全局单调 id，新类型天然进入缓冲并参与
  `replay`（命中续传 / 未命中 resync），`sse.ts` 直接透传 `event.type` 无白名单过滤。
- 明确没有做：项目级事件通道（事件仍按会话归属，工作台订阅项目最新会话）、
  引擎层发布点（T204 渲染闭环时一并处理）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm vitest run tests/unit/sse-buffer.test.ts` | pass | 类型锁定更新 + 新事件发布/续传 1 例 |
| `$env:VF_SMOKE="1"; pnpm vitest run tests/integration/project-run-api.test.ts` | pass | 27 tests（PATCH 用例断言 `agent_action` + `shot.updated` 下发、Last-Event-ID 命中续传、未命中 resync） |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过 |
| `pnpm test` | pass | 78 files / 660 tests |

## 断点 / 未完成
- 未完成项：`quality.updated` / `asset.bound` / `preview.ready` 的真实发布点分别随 T207 / T204 / T204+T208 落地
  （已在事件类型表注释与任务板对应行登记）。
- 已知风险：
  1. 事件按会话归属，未建会话的静默操作（未来若出现）需要先解析项目最新会话，否则无投递目标。
  2. 前端目前不消费新事件（旧 sse.ts 客户端按类型分发），T305/T306 工作台接入时按 §7.2 动作表处理。

## M1 收口说明
M1 数据面闭环任务（T101–T119）全部 done。出口判据核对：
- 一句一镜（T101/T102）、逐句字幕（T104/T105）、固定动效（T109/T110）✔；
- 单镜重生成不整片重跑（T114/T115，渲染层逐帧一致留 T204）✔；
- 旧项目可续跑（T003/T009）✔。
遗留单列项：T004（能力注册表切 8 阶段，需版本感知保护 v1 续跑）、T104b（原生/ASR 时间戳）。
