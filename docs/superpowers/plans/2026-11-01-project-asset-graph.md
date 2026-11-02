# 项目资产图谱与对话式素材协作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户将项目产物与手工上传的文档、图片、背景音乐作为长期项目资产，在聊天中结构化引用，并按 Agent 动作影响等级直接执行或确认后执行。

**Architecture:** 在现有“项目 → 会话 → run”链路外新增项目资产、消息引用和 Agent 动作三个追加式领域对象。上传、引用与动作计划统一由服务端执行归属校验；工作台只渲染服务端资产和动作状态。七阶段流水线保持不变，高影响操作通过确认后的新 run 进入既有工作流。

**Tech Stack:** TypeScript、Vue 3、Pinia、Ant Design Vue、Fastify 5、`@fastify/multipart`、SQLite、Drizzle、Vitest、Pi Agent。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `packages/shared/src/domain.ts` | 资产、引用、Agent 动作的共享类型与状态常量 |
| `packages/shared/src/errors.ts` | 资产与动作稳定错误码 |
| `packages/pipeline/src/config.ts` | 上传限制配置 schema 与类型 |
| `config/default.yaml`、`config/system.local.example.yaml` | 有注释的上传限制默认值与本机覆盖模板 |
| `apps/server/src/db/schema.ts`、`migrate.ts` | 三张追加式表、索引与既有库升级 |
| `apps/server/src/db/repositories/asset-repository.ts` | 项目资产与消息引用 actor-first 仓储 |
| `apps/server/src/db/repositories/agent-action-repository.ts` | Agent 动作状态与确认仓储 |
| `apps/server/src/domain/project-assets.ts` | 资产类型、MIME、路径、上传校验与产物同步 |
| `apps/server/src/http/routes/assets.ts` | 资产清单、上传与元数据 API |
| `apps/server/src/http/routes/sessions.ts` | 带资产引用的消息发送与历史输出 |
| `apps/server/src/http/routes/agent-actions.ts` | 高影响动作确认与取消 API |
| `apps/server/src/http/deps.ts`、`http/index.ts`、`app.ts` | 注入资产服务，注册路由，并将资产上下文传给 Agent |
| `apps/server/src/agent/asset-context.ts` | 安全构造 Agent 的结构化资产上下文 |
| `apps/server/src/agent/tools/asset-tools.ts` | 列举、检查、计划与可逆动作工具 |
| `apps/server/src/agent/tools/index.ts`、`session-registry.ts`、`prompt.ts` | 注册资产工具、给会话传入资产服务、收紧提示词 |
| `apps/web/src/stores/assets.ts` | 资产清单、上传和筛选状态 |
| `apps/web/src/components/AssetPicker.vue` | `@` 资产选择器 |
| `apps/web/src/components/AssetReferenceChips.vue` | 草稿引用芯片 |
| `apps/web/src/components/ProjectAssetPanel.vue` | 项目资产筛选、预览和引用入口 |
| `apps/web/src/components/AssetReferenceCards.vue` | 已发送消息的资产引用摘要 |
| `apps/web/src/components/AgentActionCard.vue` | 高影响动作确认 / 取消卡 |
| `apps/web/src/stores/workbench.ts`、`history-messages.ts`、`workbench-reducer.ts` | 发送 `assetIds`、回放引用与动作事件 |
| `apps/web/src/views/WorkbenchView.vue` | 紧凑的对话输入、右栏资产面板与窄屏 Tab |
| `tests/unit/*`、`tests/integration/project-asset-api.test.ts` | 数据、校验、路由、Agent 上下文与前端交互验证 |

## Task 1: 扩展领域契约、错误码和配置

**Files:**
- Modify: `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/pipeline/src/config.ts`
- Modify: `config/default.yaml`
- Modify: `config/system.local.example.yaml`
- Test: `tests/unit/config.test.ts`
- Test: `tests/unit/http-errors.test.ts`

- [ ] **Step 1: 编写配置与错误码失败测试**

在 `tests/unit/config.test.ts` 新增覆盖：缺少 `assets` 使用默认配置、单文件大小不是正整数、项目总容量小于单文件限制、引用数量超出范围时均抛 `CONFIG_INVALID`。在 `tests/unit/http-errors.test.ts` 新增断言：

```ts
expect(toErrorBody(new VideoForgeError("ASSET_TYPE_UNSUPPORTED", "类型不支持"))).toEqual({
  error: { code: "ASSET_TYPE_UNSUPPORTED", message: "类型不支持" },
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/unit/config.test.ts tests/unit/http-errors.test.ts`  
Expected: FAIL，缺少 `assets` 配置类型和资产错误码。

- [ ] **Step 3: 增加共享领域常量与接口**

在 `packages/shared/src/domain.ts` 增加并导出：

```ts
export const PROJECT_ASSET_SOURCES = ["generated", "uploaded"] as const;
export const PROJECT_ASSET_KINDS = [
  "document", "image", "audio", "copy", "scene", "timeline", "video", "frames",
] as const;
export const AGENT_ACTION_KINDS = [
  "analyze", "reversible_edit", "regenerate", "render", "compose",
] as const;
export const AGENT_ACTION_STATUSES = [
  "executing", "waiting_confirmation", "done", "failed", "canceled",
] as const;
```

同时添加 `ProjectAsset`、`MessageAssetRef`、`AgentAction` 接口。所有接口使用 snake_case 字段，与仓储 API 返回一致；`metadata_json` 与 `plan_json` 维持 `unknown`，不把前端视图结构塞进共享领域层。

- [ ] **Step 4: 增加错误码和上传配置**

在 `packages/shared/src/errors.ts` 的 `VideoForgeErrorCode` 联合类型增加：

```ts
"ASSET_TYPE_UNSUPPORTED" | "ASSET_TOO_LARGE" | "ASSET_INVALID" |
"ASSET_NOT_FOUND" | "ACTION_CONFIRMATION_REQUIRED" | "ACTION_NOT_CONFIRMABLE"
```

在 `configSchema` 增加：

```ts
assets: z.object({
  max_upload_bytes: z.number().int().min(1),
  max_project_upload_bytes: z.number().int().min(1),
  max_message_refs: z.number().int().min(1).max(32),
}).refine((value) => value.max_project_upload_bytes >= value.max_upload_bytes, {
  message: "assets.max_project_upload_bytes 必须不小于单文件上限",
}),
```

在两个 YAML 文件中添加中文用途注释，默认值为：

```yaml
assets:
  # 单个上传文件最大字节数，范围 1-1073741824；超限返回 ASSET_TOO_LARGE。
  max_upload_bytes: 52428800
  # 单个项目用户上传文件总量最大字节数；必须不小于 max_upload_bytes。
  max_project_upload_bytes: 524288000
  # 单条聊天消息可引用资产数，范围 1-32；超限返回 ASSET_INVALID。
  max_message_refs: 12
```

- [ ] **Step 5: 运行通过测试**

Run: `pnpm exec vitest run tests/unit/config.test.ts tests/unit/http-errors.test.ts`  
Expected: PASS。

- [ ] **Step 6: 检查格式**

Run: `pnpm exec prettier --check packages/shared/src/domain.ts packages/shared/src/errors.ts packages/pipeline/src/config.ts config/default.yaml config/system.local.example.yaml tests/unit/config.test.ts tests/unit/http-errors.test.ts`  
Expected: PASS。

## Task 2: 建立追加式资产、引用与动作数据层

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/db/migrate.ts`
- Modify: `apps/server/src/db/index.ts`
- Create: `apps/server/src/db/repositories/asset-repository.ts`
- Create: `apps/server/src/db/repositories/agent-action-repository.ts`
- Modify: `packages/shared/src/domain.ts`
- Test: `tests/unit/asset-repository.test.ts`
- Test: `tests/unit/agent-action-repository.test.ts`
- Test: `tests/unit/db-schema.test.ts`

- [ ] **Step 1: 编写仓储失败测试**

创建临时 SQLite 库、两个 actor、两个项目和一个会话。覆盖：

```ts
expect(listProjectAssets(db, actorB, projectA.id)).toEqual([]);
expect(() => getProjectAsset(db, actorB, assetA.id)).toThrow("AUTH_FORBIDDEN");
expect(() => createMessageAssetRefs(db, actorA, messageB.id, [assetA.id])).toThrow(
  "AUTH_FORBIDDEN",
);
```

动作仓储测试必须验证 `waiting_confirmation → executing → done` 合法，`done → executing` 抛 `ACTION_NOT_CONFIRMABLE`。

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/unit/asset-repository.test.ts tests/unit/agent-action-repository.test.ts`  
Expected: FAIL，模块和表尚不存在。

- [ ] **Step 3: 添加 schema 与迁移**

在 `schema.ts` 增加 `projectAssets`、`messageAssetRefs`、`agentActions` 三张表，字段遵循已确认规格。关键索引为：

```ts
uniqueIndex("idx_project_assets_path").on(table.projectId, table.relativePath)
index("idx_project_assets_project_created").on(table.projectId, table.createdAt)
index("idx_message_asset_refs_message").on(table.messageId)
index("idx_agent_actions_message").on(table.messageId)
```

在 `migrate.ts` 的 `CREATE TABLE IF NOT EXISTS` 和索引列表中增加等价 DDL。新表全部使用 `CREATE TABLE IF NOT EXISTS`，不得 DROP 新领域表或既有数据。

- [ ] **Step 4: 实现 actor-first 仓储**

`asset-repository.ts` 至少导出：

```ts
createProjectAsset(db, actor, input): ProjectAsset
listProjectAssets(db, actor, projectId, query): ProjectAsset[]
getProjectAsset(db, actor, assetId): ProjectAsset | undefined
getProjectAssetsByIds(db, actor, projectId, assetIds): ProjectAsset[]
createMessageAssetRefs(db, actor, messageId, assetIds): MessageAssetRef[]
listMessageAssetRefs(db, actor, messageIds): Map<string, MessageAssetRef[]>
sumUploadedAssetBytes(db, actor, projectId): number
```

每个函数先经项目 / 会话 / 消息所属关系限定 actor；任何不属于当前 actor 的 ID 不可通过内存比较绕过 SQL 范围。批量资产查询必须验证返回数量与去重后的请求数量相等，否则路由返回 `AUTH_FORBIDDEN`。

`agent-action-repository.ts` 导出创建、按消息查询、确认、取消、完成和失败更新函数。动作状态更新由 `status + id + 项目归属` 构成条件，避免并发确认双执行。

- [ ] **Step 5: 运行数据层测试**

Run: `pnpm exec vitest run tests/unit/asset-repository.test.ts tests/unit/agent-action-repository.test.ts tests/unit/db-schema.test.ts`  
Expected: PASS。

- [ ] **Step 6: 验证迁移对既有库可重复执行**

Run: `pnpm exec tsx apps/server/src/db/migrate.ts :memory:`  
Expected: 退出码 0，日志只报告迁移完成。

## Task 3: 实现上传校验、项目资产同步和资产路由

**Files:**
- Modify: `apps/server/package.json`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/src/domain/project-assets.ts`
- Create: `apps/server/src/http/routes/assets.ts`
- Modify: `apps/server/src/http/index.ts`
- Modify: `apps/server/src/http/deps.ts`
- Modify: `apps/server/src/http/artifacts.ts`
- Test: `tests/unit/project-assets.test.ts`
- Test: `tests/integration/project-asset-api.test.ts`

- [ ] **Step 1: 编写文件校验失败测试**

在 `tests/unit/project-assets.test.ts` 覆盖扩展名与魔数不一致、`CON.png`、`../escape.png`、空文件、超限文件、非白名单 MIME，以及带中文和空格的安全文件名。断言所有安全路径都位于：

```ts
resolveUserProjectDir(storageRoot, actor.userId, project.name) / "assets" / "uploads" / assetId
```

- [ ] **Step 2: 编写 API 失败测试**

新增 `tests/integration/project-asset-api.test.ts`，沿用 `project-run-api.test.ts` 的真 SQLite + Fastify 注入方式。先写：

```ts
const forbidden = await app.inject({
  method: "GET",
  url: `/api/projects/${projectA.id}/assets`,
  headers: { authorization: `Bearer ${tokenB}` },
});
expect(forbidden.statusCode).toBe(403);
expect(forbidden.json()).toMatchObject({ error: { code: "AUTH_FORBIDDEN" } });
```

并增加 multipart 上传成功、`ASSET_TYPE_UNSUPPORTED`、`ASSET_TOO_LARGE`、同项目容量超限、资产元数据读取和生成产物同步幂等测试。

- [ ] **Step 3: 运行失败测试**

Run: `pnpm exec vitest run tests/unit/project-assets.test.ts tests/integration/project-asset-api.test.ts`  
Expected: FAIL，资产服务和路由尚不存在。

- [ ] **Step 4: 注册受控 multipart 能力**

在 `apps/server/package.json` 添加 `@fastify/multipart`，使用项目锁文件更新依赖。`createApp` 中只注册：

```ts
await app.register(multipart, {
  limits: { files: 1, fileSize: options.deps.config.assets.max_upload_bytes },
});
```

路由只接收单文件；不得把 multipart 全量缓冲到未受限制的内存。上传失败时删除已写入的临时文件。

- [ ] **Step 5: 实现项目资产领域服务**

`project-assets.ts` 提供具函数级注释的纯函数与服务函数：

```ts
classifyUpload(mimeType: string, filename: string): ProjectAssetKind
validateUploadName(filename: string): string
resolveUploadPath(projectDir: string, assetId: string, filename: string): string
syncGeneratedAssets(db, actor, project, artifactIndex, runId?): ProjectAsset[]
```

`syncGeneratedAssets` 只为现有 `ArtifactIndex.entries` 和 `final.mp4` 创建缺失记录；同一 `(project_id, relative_path)` 已登记时返回既有记录，不覆盖 metadata 或版本关系。阶段到资产类型的映射集中在该模块，禁止散落在路由或 Vue 中。

- [ ] **Step 6: 实现资产 HTTP 路由**

`assets.ts` 注册：

```ts
GET  /api/projects/:id/assets
POST /api/projects/:id/assets/upload
GET  /api/projects/:id/assets/:assetId
```

上传顺序必须是：项目归属 → 内容类型 / 文件大小 / 文件名校验 → 生成 UUID → 在项目受控目录写入临时文件 → 原子 rename → `createProjectAsset`。若数据库登记失败，删除最终文件。返回体只返回 `asset` 元数据，不返回本机绝对路径。

在项目详情和既有 `/artifacts` 路由读取前调用 `syncGeneratedAssets`，以保证既有产物进入项目资产视图，但不移除原 `ArtifactIndex`，避免现有客户端回归。

- [ ] **Step 7: 运行上传与路由测试**

Run: `pnpm exec vitest run tests/unit/project-assets.test.ts tests/integration/project-asset-api.test.ts tests/integration/project-run-api.test.ts`  
Expected: PASS。

- [ ] **Step 8: 构建服务端**

Run: `pnpm --filter @videoforge/server build`  
Expected: PASS。

## Task 4: 让消息具备资产引用与可回放上下文

**Files:**
- Modify: `apps/server/src/db/repositories/message-repository.ts`
- Modify: `apps/server/src/http/routes/sessions.ts`
- Create: `apps/server/src/agent/asset-context.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/http/deps.ts`
- Modify: `apps/server/src/agent/session-registry.ts`
- Test: `tests/unit/message-repository.test.ts`
- Test: `tests/unit/agent-asset-context.test.ts`
- Test: `tests/integration/project-asset-api.test.ts`

- [ ] **Step 1: 编写消息引用失败测试**

扩展消息仓储与 API 测试，先断言：

```ts
await expect(
  app.inject({
    method: "POST",
    url: `/api/sessions/${session.id}/messages`,
    headers,
    payload: { text: "分析 @图", assetIds: [foreignAsset.id] },
  }),
).resolves.toMatchObject({ statusCode: 403 });
```

同时验证重复 `assetIds` 只生成一条引用、超过 `max_message_refs` 返回 `ASSET_INVALID`、历史分页的 user message 含 `asset_refs`。

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/unit/message-repository.test.ts tests/unit/agent-asset-context.test.ts tests/integration/project-asset-api.test.ts`  
Expected: FAIL，消息没有引用字段和资产上下文构造器。

- [ ] **Step 3: 扩展会话消息 API**

将请求解析改为：

```ts
const body = request.body as { text?: unknown; assetIds?: unknown };
const assetIds = Array.isArray(body.assetIds)
  ? [...new Set(body.assetIds.filter((id): id is string => typeof id === "string"))]
  : [];
```

验证非空文本、引用数量和当前会话所属项目资产；先创建用户消息，再在同一 SQLite 事务内创建 `message_asset_refs`。`GET /messages` 用 `listMessageAssetRefs` 为每条 user 消息附加：

```ts
asset_refs: [{ id, label, kind, mime_type, relative_path, size_bytes }]
```

保留原 `Message` payload，使 Pi 会话重放不依赖前端专用字段。

- [ ] **Step 4: 实现资产上下文构造器**

`asset-context.ts` 仅构造文本上下文，严禁让用户传入绝对路径：

```ts
export function buildAssetContext(assets: ProjectAsset[]): string {
  return [
    "## 当前消息引用的项目资产",
    "只可读取以下资产及当前项目受控目录；不得读取仓库、配置或 .env.local。",
    ...assets.map((asset) => `- [${asset.id}] ${asset.kind} ${asset.label} (${asset.relative_path}, ${asset.mime_type}, ${asset.size_bytes} bytes)`),
  ].join("\n");
}
```

文档摘要仅由后续 `inspect_project_asset` 工具在受控大小上限内读取，消息 API 不直接把用户文件全文写入数据库或 prompt。

- [ ] **Step 5: 将上下文传给 Agent**

扩展 `ChatPort.send` 的输入或新增 `sendWithAssets` 方法，让 `app.ts` 在收到用户消息后读取引用资产并调用：

```ts
await entry.session.prompt(
  `${buildAssetContext(assets)}\n\n## 用户请求\n${text}`,
  options,
);
```

历史重放仍仅重放原始 Pi payload，引用上下文只注入本轮；避免每次重建会话把同一文件列表累积到历史记录中。

- [ ] **Step 6: 运行消息与上下文测试**

Run: `pnpm exec vitest run tests/unit/message-repository.test.ts tests/unit/agent-asset-context.test.ts tests/integration/project-asset-api.test.ts`  
Expected: PASS。

## Task 5: 实现 Agent 动作分级、确认与执行边界

**Files:**
- Create: `apps/server/src/agent/action-policy.ts`
- Create: `apps/server/src/agent/tools/asset-tools.ts`
- Modify: `apps/server/src/agent/tools/index.ts`
- Modify: `apps/server/src/agent/session-registry.ts`
- Modify: `apps/server/src/agent/prompt.ts`
- Create: `apps/server/src/http/routes/agent-actions.ts`
- Modify: `apps/server/src/http/index.ts`
- Modify: `apps/server/src/http/deps.ts`
- Modify: `apps/server/src/app.ts`
- Test: `tests/unit/agent-action-policy.test.ts`
- Test: `tests/unit/agent-asset-tools.test.ts`
- Test: `tests/integration/project-asset-api.test.ts`

- [ ] **Step 1: 编写动作分级失败测试**

在 `tests/unit/agent-action-policy.test.ts` 先覆盖：

```ts
expect(classifyAgentAction({ requestedStages: [] })).toBe("analyze");
expect(classifyAgentAction({ requestedStages: ["copy"] })).toBe("regenerate");
expect(classifyAgentAction({ requestedStages: ["compose"] })).toBe("compose");
```

确认 API 测试覆盖未确认不创建 run、首次确认创建一次 run、再次确认返回 `ACTION_NOT_CONFIRMABLE`、跨用户确认返回 `AUTH_FORBIDDEN`。

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/unit/agent-action-policy.test.ts tests/unit/agent-asset-tools.test.ts tests/integration/project-asset-api.test.ts`  
Expected: FAIL，策略、工具和确认路由不存在。

- [ ] **Step 3: 实现确定性动作策略**

`action-policy.ts` 不能让模型直接决定权限，必须基于结构化请求和阶段集合分类：

```ts
export function requiresConfirmation(kind: AgentActionKind): boolean {
  return ["regenerate", "render", "compose"].includes(kind);
}
```

只读分析和可逆编辑分别创建 `executing` 动作，结束时更新为 `done` 或 `failed`。高影响操作仅创建 `waiting_confirmation` 动作，其 `plan_json` 必含 `summary`、`assetIds`、`affectedStages`、`expectedOutputs`。

- [ ] **Step 4: 实现受控资产工具**

`asset-tools.ts` 提供：

```ts
list_project_assets
inspect_project_asset
prepare_asset_action
apply_reversible_asset_action
```

工具上下文由会话注册表注入 `actor`、`projectId`、`projectDir`、仓储和配置，禁止工具参数传 projectId 或绝对路径。`inspect_project_asset` 文本读取设置严格字符上限，二进制文件只返回 metadata；任何读取都通过路径安全函数确认仍在项目目录内。

在 `createAgentTools` 中统一以现有 `withToolTrace` 包装这些工具，保证 `tool_calls` 和 `trace.jsonl` 都有记录。

- [ ] **Step 5: 收紧系统提示**

在 `prompt.ts` 的行为边界增加：

```text
- 用户引用的资产只可通过资产工具读取；不得猜测、拼接或扫描未引用的用户文件；
- 仅分析和可逆局部调整可直接执行；
- 涉及重新生成、时间轴、渲染或合成时，必须先调用 prepare_asset_action 生成待确认计划，不能直接调用阶段工具。
```

- [ ] **Step 6: 实现确认和取消 API**

`agent-actions.ts`：

```ts
POST /api/agent-actions/:id/confirm
POST /api/agent-actions/:id/cancel
```

确认动作在事务内把状态由 `waiting_confirmation` 改为 `executing`，再通过已有 `createRun` 和 `workflow.run` 非阻塞启动。开始失败时写动作失败状态与稳定错误码；取消只允许待确认动作，成功后状态为 `canceled`。服务端通过 SSE 发布 `agent_action` 事件，前端不自行猜测状态。

- [ ] **Step 7: 运行分级与确认测试**

Run: `pnpm exec vitest run tests/unit/agent-action-policy.test.ts tests/unit/agent-asset-tools.test.ts tests/integration/project-asset-api.test.ts tests/unit/agent-stage-tools.test.ts`  
Expected: PASS。

## Task 6: 构建前端资产状态、上传和引用组件

**Files:**
- Create: `apps/web/src/stores/assets.ts`
- Create: `apps/web/src/components/AssetPicker.vue`
- Create: `apps/web/src/components/AssetReferenceChips.vue`
- Create: `apps/web/src/components/ProjectAssetPanel.vue`
- Create: `apps/web/src/components/AssetReferenceCards.vue`
- Modify: `apps/web/src/services/api.ts`
- Modify: `apps/web/src/stores/workbench-reducer.ts`
- Modify: `apps/web/src/stores/history-messages.ts`
- Modify: `apps/web/src/components/MessageBubble.vue`
- Test: `tests/unit/web-assets.test.ts`
- Test: `tests/unit/web-history-messages.test.ts`

- [ ] **Step 1: 编写前端状态与回放失败测试**

`web-assets.test.ts` 覆盖按关键词与类型过滤、同一资产不能重复加入草稿、移除不改变资产列表。扩展 `web-history-messages.test.ts`：

```ts
expect(mapHistoryMessages([message("m1", "user", {
  role: "user",
  content: [{ type: "text", text: "请分析" }],
  asset_refs: [{ id: "a1", label: "参考图.png", kind: "image" }],
})])[0]).toMatchObject({
  kind: "user",
  assetRefs: [{ id: "a1", label: "参考图.png" }],
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/unit/web-assets.test.ts tests/unit/web-history-messages.test.ts`  
Expected: FAIL，资产状态和消息模型尚未支持引用。

- [ ] **Step 3: 实现资产 Pinia store 和上传 API**

`assets.ts` 维护 `items`、`loading`、`uploading`、`query`、`kindFilter`，并实现：

```ts
load(projectId: string): Promise<void>
upload(projectId: string, file: File): Promise<ProjectAsset>
```

上传使用 `FormData` 与现有相对 API 基址；不要手动设置 multipart `Content-Type`。请求封装需支持传入 `FormData` 并保持 Authorization。上传成功后将服务端返回的资产合并入 store，不产生仅本地伪资产。

- [ ] **Step 4: 实现可访问的资产组件**

`AssetPicker.vue` 使用现有 Ant Design Vue `a-select` 或 `a-auto-complete`，支持 `@` 触发、关键词过滤、键盘上下选择、Enter 确认、Escape 关闭。

`AssetReferenceChips.vue` 展示已选择资产，移除按钮必须有 `aria-label="移除引用：${label}"`。

`ProjectAssetPanel.vue` 实现类型筛选、文本搜索、媒体缩略预览与“引用到对话”；媒体 URL 使用既有 `buildMediaUrl` 和票据，不硬编码 API 主机。

`MessageBubble.vue` 在用户文本下渲染 `AssetReferenceCards`，只显示 label、kind、大小和安全媒体预览，不能展示本机绝对路径。

- [ ] **Step 5: 运行前端单元测试**

Run: `pnpm exec vitest run tests/unit/web-assets.test.ts tests/unit/web-history-messages.test.ts tests/unit/web-chat-grouping.test.ts`  
Expected: PASS。

## Task 7: 升级工作台输入区、资产面板与确认卡

**Files:**
- Create: `apps/web/src/components/AgentActionCard.vue`
- Modify: `apps/web/src/stores/workbench.ts`
- Modify: `apps/web/src/stores/workbench-reducer.ts`
- Modify: `apps/web/src/services/sse.ts`
- Modify: `apps/web/src/views/WorkbenchView.vue`
- Modify: `apps/web/src/styles/global.css`
- Test: `tests/unit/web-workbench-reducer.test.ts`
- Test: `tests/unit/web-agent-actions.test.ts`

- [ ] **Step 1: 编写工作台失败测试**

增加 reducer 测试：

```ts
const next = reduceWorkbench(state, {
  type: "agent_action",
  data: { id: "act-1", status: "waiting_confirmation", kind: "compose" },
});
expect(next.messages.at(-1)).toMatchObject({ kind: "agentAction" });
```

增加发送测试，断言 `workbench.sendMessage("分析这两张图", ["asset-a", "asset-b"])` 的请求体包含 `assetIds`。

- [ ] **Step 2: 运行失败测试**

Run: `pnpm exec vitest run tests/unit/web-workbench-reducer.test.ts tests/unit/web-agent-actions.test.ts`  
Expected: FAIL，SSE、消息模型和 Agent 动作卡不存在。

- [ ] **Step 3: 扩展工作台状态和 SSE**

在 workbench reducer 的 `WorkbenchMessage` 联合类型中增加：

```ts
| { kind: "agentAction"; id: string; action: AgentActionView; at?: string }
```

在 `sse.ts` 事件类型列表增加 `agent_action`，在 reducer 按服务端状态新增或更新动作卡。`workbench.ts` 扩展 `sendMessage(text, assetIds)`、`confirmAction(actionId)`、`cancelAction(actionId)`，所有动作后的真实状态依赖 API / SSE 回写。

- [ ] **Step 4: 实现确认卡**

`AgentActionCard.vue` 显示动作摘要、引用资产数、受影响阶段、预计输出和状态。仅在 `waiting_confirmation` 显示“确认执行”和“取消”，按钮在请求期间禁用；错误使用现有 `formatApiError` 统一提示。

- [ ] **Step 5: 重组工作台**

在 `WorkbenchView.vue`：

1. 注入 `useAssetsStore`；
2. 使用 `selectedAssetIds` 保存草稿引用；
3. 输入区从单个 textarea 改成“芯片条 + textarea + 工具栏”；
4. 上传按钮限制 accept 为 `.txt,.md,.pdf,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.ogg`；
5. 右栏下半部分以 `ProjectAssetPanel` 替换仅有的产物 Tab，但保留生成产物的文案、图片、场景、音频、时间轴、成片预览入口；
6. 窄屏 Tab 的“产物”改名为“资产”，保持 `<900px` 断点和输入区可达；
7. 调用 `send()` 成功后清空草稿和 `selectedAssetIds`，失败时保留两者。

所有新增函数均添加函数级注释；布局继续使用现有 `--vf-*` tokens，不引入新 UI 依赖。

- [ ] **Step 6: 运行前端测试与构建**

Run: `pnpm exec vitest run tests/unit/web-workbench-reducer.test.ts tests/unit/web-agent-actions.test.ts tests/unit/web-assets.test.ts && pnpm run web:build`  
Expected: 全部 PASS；构建可有现存 chunk-size 警告，不得有类型或编译错误。

## Task 8: 集成同步、文档与全量验证

**Files:**
- Modify: `docs/本地视频流水线Agent-v2.md`
- Modify: `docs/本地视频流水线Agent-web-v2.md`
- Modify: `docs/guides/developer-guide.md`
- Modify: `docs/guides/operator-guide.md`
- Modify: `README.md`
- Modify: `README.en.md`
- Test: `tests/integration/project-asset-api.test.ts`

- [ ] **Step 1: 增加工作流完成后的资产同步测试**

在集成测试中模拟一个带阶段产物的 run，调用项目详情 / 资产列表后断言：

```ts
expect(response.json().assets.items).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ source: "generated", relative_path: "images/s1.png" }),
  ]),
);
```

重复调用不得创建重复资产；同一生成文件在新 run 出现时创建新版本关联或保留原记录，具体行为以 `supersedes_asset_id` 断言。

- [ ] **Step 2: 完成用户与开发文档**

同步说明：

- 项目资产的范围、支持类型、容量和不可跨项目共享；
- `@` 引用、上传、移除引用与资产预览；
- 直接执行与需要确认动作的边界；
- 版本保留、Trace 与真实 Ark 手工验收限制；
- 本地文件安全、Windows 路径与媒体票据约束。

README 仅概述已落地能力；不要把真实 Ark 多模态验收描述为已完成。

- [ ] **Step 3: 运行相关测试**

Run: `pnpm exec vitest run tests/unit/asset-repository.test.ts tests/unit/agent-action-repository.test.ts tests/unit/project-assets.test.ts tests/unit/agent-asset-context.test.ts tests/unit/agent-action-policy.test.ts tests/unit/agent-asset-tools.test.ts tests/unit/web-assets.test.ts tests/unit/web-agent-actions.test.ts tests/integration/project-asset-api.test.ts`  
Expected: PASS。

- [ ] **Step 4: 运行全量质量门禁**

Run: `pnpm test && pnpm run typecheck && pnpm run web:build && pnpm run format:check`  
Expected: 全部 PASS。

- [ ] **Step 5: 浏览器验收**

启动 API 与 Web 后在浏览器完成：

1. 1920px 视口：上传一份文档、一张图片、一段音频；确认其显示在右栏资产面板并自动加入草稿引用；
2. 使用 `@` 选择既有生成图片和上传音频；发送后确认用户消息显示引用卡，刷新后仍可回放；
3. 发起仅分析请求，确认无需确认卡；发起重生成或合成请求，确认出现影响范围明确的确认卡；
4. 确认与取消各一次，确认状态、Run 和 Trace 留痕一致；
5. 约 390px 视口：验证“对话 / 进度 / 资产”Tab、上传、选择、移除、发送与确认按钮可键盘访问且无横向溢出。

真实 Ark 只在配置了有效 `ARK_API_KEY`、`JWT_SECRET` 和 `chat_model` 后手工验证；未满足条件时记录为未执行，不得替换为 mock 结果。

- [ ] **Step 6: 汇总交付**

记录测试命令、浏览器验收证据、真实 Ark 手工验证状态、已知限制与未涉及的跨项目共享范围。只有用户明确要求时，才按仓库既有提交规范创建 Git commit。
