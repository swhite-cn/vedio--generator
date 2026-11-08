# T114 任务日志：镜头 PATCH API

## 元信息
- 任务 ID：T114
- 状态：done
- 开始时间：2026-11-07 10:13
- 结束时间：2026-11-07 10:16
- 关联设计：方案 §7.1 PATCH、§7.3 镜头级编辑、D4（复用 `agent_actions`，不新增审核表）
- 依赖任务：T113（storyboard 聚合读取）
- 后续任务：T115（镜头重生成）、T308（分镜编辑器）
- 变更文件：
  - `apps/server/src/domain/shot-patch.ts`（新增，纯逻辑）
  - `apps/server/src/http/routes/shots.ts`（新增）
  - `apps/server/src/http/index.ts`（注册路由）
  - `tests/unit/shot-patch.test.ts`（新增，9 例）
  - `tests/integration/project-run-api.test.ts`（+3 例）

## 意图
让分镜 Inspector 能以 PATCH 修改单个镜头的屏上文字、强调词、转场、组件与来源，且可逆：
每次编辑把 `before/after` 写入 `agent_actions.plan_json`，不新增审核表；非法组件/参数与非法 shot 直接拒绝，
copy.json 与已有 SceneSpec 同步，其余镜头保持不变。

## 改动
- 新增 `shot-patch.ts`：
  - `applyShotPatch(copy, shotId, changes, registry?)`：不可变修改 copy v2；支持 `onScreenText/emphasis/transitionIn/transitionOut/component/sourceRef`；
    组件使用注册表 `assertProps` 强校验，设置组件时 `visualType` 变为 `component`；结果再过 `copyDocV2Schema`；
    空补丁、未知 shot、非法转场/来源均报 `CONFIG_INVALID`。
  - `applyShotPatchToSpec(spec, before, after, options?)`：已有 SceneSpec 时同步该镜头；组件变化重新装配动效（时长取主题 motion 边界内 400ms），
    转场/来源直接覆盖，其他镜头原样保留；spec 中无该镜头时返回原对象。
- 新增 `PATCH /api/projects/:id/shots/:shotId`：
  - 请求体 `{ changes, sessionId?, messageId? }`，未知字段拒绝；
  - 仅 v2 项目可编辑（v1 明确 400）；先写 copy.json，再同步 spec；
  - 动作归属：显式 `sessionId` 必须属于项目，否则取最新会话；未传 `messageId` 时追加一条 `system` 消息（payload 含 before/after）作为审计锚点；
  - 写 `agent_actions(kind=reversible_edit, status=done, plan_json={shotId,changes,before,after,scope})` 并发布 `agent_action` 事件；
  - 返回 `{ shot, action, specUpdated }`（前端可再拉 `/storyboard` 获取聚合视图）。
- 明确没有做：镜头重生成（T115）、撤销 API（可从 plan_json 重建，未提供独立端点）、`shot.updated` SSE（T119）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/shot-patch.test.ts` | pass | 9 tests |
| `$env:VF_SMOKE="1"; pnpm exec vitest run tests/integration/project-run-api.test.ts` | pass | 21 tests（含新增 3 例） |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过 |
| `pnpm test` | pass | 76 files / 641 tests |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  1. PATCH 只同步 copy 与 SceneSpec，不自动重跑 image/tts/storyboard；改组件后像素产物仍是旧的，需 T115 重生成。
  2. 未传 `messageId` 时会追加 `system` 消息，聊天历史会出现一条编辑审计消息；若前端不希望展示，需在 T305 过滤 `system + shot.patch`。
  3. 撤销功能未提供独立端点，回滚依赖读取 `agent_actions.plan_json`（后续按需补 API）。
  4. 改 `onScreenText` 不触发字幕重算（字幕来自 cue/口播，不受屏上文字影响），符合当前口径。
- 恢复时第一步：进入 T115，设计 `runs.scope_json` 与单镜重生成。

## 风险与后续
- 风险：spec 同步以"整文件重写"实现，未做并发保护；同一项目并发 PATCH 可能后写覆盖，需在 T115 引入项目租约或版本号。
- 下一步任务：`T115` 镜头重生成 API + run scope（依赖 T114/T112，均已 done）。
