# VideoForge 轻量本地 harness 重构实施计划

> **For agentic workers:** 本计划按阶段执行，每阶段派发独立子代理实施 + 阶段间评审（subagent-driven）。步骤用 `- [ ]` 跟踪。
> **契约唯一权威来源**：[本地视频流水线Agent-v2.md](../../../本地视频流水线Agent-v2.md)（主文档，下称"主文档"）与 [本地视频流水线Agent-web-v2.md](../../../本地视频流水线Agent-web-v2.md)（Web 专题）。本计划只做任务分解，**不得与两份设计文档冲突**；凡设计文档已给字段名/错误码/接口路径，代码必须照搬。

**Goal:** 把当前"CLI + 外部 harness 编排 + 只读 Web 监控"的 MVP，重构为主文档第 3 章的**单进程本地 harness**：能力注册表驱动的七阶段确定性工作流 + 内嵌 Pi agent 运行时 + 三级 trace + 多用户隔离 + 全新 Ant Design Vue 工作台。

**Architecture:** `apps/server`（Fastify 单进程）= `http` + `domain` + `agent` + `workflow` + `trace`；能力内核下沉到 `packages/{shared,pipeline,renderer,template-sdk}`；`apps/cli` 降级为运维入口；`apps/web` 按 Web 专题重建。

**Tech Stack:** Node.js 20+ / TypeScript(ESM, NodeNext, strict) / pnpm 10 workspace / Fastify 5 + @fastify/jwt / better-sqlite3 + Drizzle / `@earendil-works/pi-coding-agent@1.4.0` / Playwright + ffmpeg / Vue 3 + Vite + Pinia + Vue Router + Ant Design Vue 4。

---

## 0. 基线事实（启动前已核对）

- 当前 `apps/server/src/app.ts` 只有 `/health`、`/api/workspaces`、`/api/media/*`、`/api/tts/*`、`/api/events/stream` 占位，无鉴权、无 run、无 agent。
- 七个流水线能力的**实现全部在 `apps/cli/src/video-commands.ts`（574 行）**，需下沉到 `packages/*` 才能被阶段工具复用。
- `pnpm-workspace.yaml` 只含 `apps/*`，需补 `packages/*`。
- `vitest.config.ts` 用 alias 把 `@videoforge/shared` 指向 `apps/server/src/shared`，迁移后需改指 `packages/*/src`。
- 依赖已安装（`node_modules` 存在，251 个 .pnpm 包）；`@earendil-works/pi-coding-agent` 未安装，npm registry 可达，`latest = 1.4.0`。

## 1. 执行约定（每阶段都适用）

- **验证命令**（阶段完成前必跑，按阶段选用）：
  - `pnpm install`
  - `pnpm test`（全量单测）
  - `pnpm exec vitest run <指定测试文件>`
  - `pnpm build`（`pnpm -r build`，含各包 tsc 与 web vite build）
  - `pnpm run doctor`
  - `pnpm run server:dev`（起服务，人工/脚本探活 `/health`）
- **代码规范**：严格模式 ESM，跨包 import 用 `@videoforge/<pkg>`；生成代码必须写**函数级注释**；关键动作写日志；**禁止记录密钥/密码/哈希**；路径统一走 `path-safety.ts`；不新增无关依赖。
- **测试纪律**：行为变更先补/改 Vitest 测试；不得为过测试弱化断言；删模块时同步删其测试（以"是否仍被引用"为准逐个人工核对，禁止批量盲删）。
- **阶段闸门**：每阶段结束必须给出「改动文件清单 + 验证命令 + 实际输出结论」，未通过不得进入下一阶段。
- **子代理纪律**：一次只派一个阶段的子代理；子代理必须自读本节 + 相关设计文档章节 + 目标文件后再改；不得跨阶段顺手重构。

## 2. 阶段总览与依赖

> **进度状态（最后更新 2026-10-26）**：P0 ✅ / P1 ✅ / P2 ✅ / P3 ✅ / P4 ✅ / P5 ✅ / P6 ✅ / **P7 ✅**（provider + 阶段工具 + 内置工具/提示词/技能 + 会话注册表/组合根 + §14.1 连通性验证 全部完成）/ **P8 ✅**（状态机/断点/租约 + 引擎主循环/阶段指令 全部完成）/ **P9 ✅**（P9-A 事件总线/SSE 帧/错误映射/鉴权 hook；P9-B auth/capabilities/projects/sessions 路由 + SSE 短时票据；P9-C runs/trace/artifacts/media/admin 路由（+ 4 个 admin 跨用户仓储纯追加）+ 21 条集成测试；P9-D `app.ts` 重写与启动编排 + 真实 `ChatPort`/`executeStage`/`workflow.emit → eventBus`/`traceForActor`/`disposeIdle`，`pnpm run server:dev` 冷启动 `/health` 探活通过） / **P10 ✅**（CLI 运维入口改造：删 7 个流水线命令与 `video-commands.ts`；`doctor` 移除 Python 校验并新增 `chat_model` 占位 / `ARK_API_KEY` 缺失 / `base_url` 误改 / `storage_root` 空 四项配置体检；新增 `status`（`/health` 探活 + 端口 + 磁盘 + DB 路径/体积 + 活跃 run/会话数，server 离线降级提示**不报错退出**）、`db:migrate`、`db:user`（列出/`--create`/`--reset-password`，新口令一次性 stdout 不入库）、`storage:prune`、`project:verify`；`pnpm test` 51 files/346 tests） / **P11 ✅**（Web 工作台按 Web 专题重建：`ant-design-vue@^4` + `@ant-design/icons-vue` 全量注册 + `ConfigProvider zhCN`/主题 token；8 条路由 + 纯函数守卫 `resolveNavigation`（未登录→`/login?redirect=`、已登录访问 `/login`→`/projects`、`mustChangePassword`→`/settings?force=1`、`requiresAdmin` 非 admin→`/projects`）；`AppLayout` 顶栏 48px/侧边栏 208px（折叠 48px）/<768px 转 `a-drawer`；七个页面（登录/能力中心/项目列表/工作台/trace/admin/settings）+ 工作台 <900px 左中右转顶部 Tab；SSE 接入遵守 `Last-Event-ID`/`resync`，前端不推导状态机；`pnpm test` 54 files/401 tests + `pnpm --filter @videoforge/web build` `BUILD_EXIT=0`（3252 modules）+ 浏览器桌面 1440×900 与约 390px 窄屏全流程实测通过；实测中发现并修复 trace 页阶段未按七阶段折叠的真实缺陷） / **P12 ✅**（旧领域彻底删除 + 文档同步：删 `apps/worker/`、`adapters-python/`、`voice-service.ts`、4 个旧仓储、6 张旧表 DDL 与 schema 定义、`packages/pipeline` 的 `quality/manifest/run-log/python-adapter/artifact-store`、`packages/shared` 的 `build-state/contracts` 与旧领域类型；同时移除 7 个活跃 generate/render 模块内的 `run-log` 记账调用、`config.ts` 的 `python.*` 与 `engines.tts_voice_default`、`toBuildConfigSnapshot`、`.trae/skills` 五个旧 CLI skill、`docs/guides/edge-tts-guide.md`；重写 `AGENTS.md`、`developer-guide.md`、`operator-guide.md` 为新架构；`pnpm test` 48 files/382 tests、`pnpm build` `BUILD_EXIT=0`、`pnpm run doctor` `DOCTOR_EXIT=0`、server/cli `tsc --noEmit` 均为 0）。
> 每阶段完成后在本节更新状态，并在对应 Phase 段落追加「执行记录」（改动文件 + 验证命令 + 结论 + 受控偏差）。

| 阶段 | 名称                                          | 依赖     | 可独立验证                       |
| ---- | --------------------------------------------- | -------- | -------------------------------- |
| P0   | 工作区与依赖就绪                              | —        | `pnpm install`                   |
| P1   | 内核迁移到 `packages/*`（旧测试全绿）         | P0       | `pnpm test`                      |
| P2   | shared 领域类型 + 能力注册表                  | P1       | 单测                             |
| P3   | 配置层改造（YAML/`config.ts`/`.pi`）          | P2       | 单测                             |
| P4   | 数据库 schema 重建 + 仓储 + 项目状态推导      | P3       | 单测                             |
| P5   | 鉴权（scrypt/JWT/节流/admin 初始化）          | P4       | 单测                             |
| P6   | trace 三级留痕 + 脱敏 + 结构化日志            | P4       | 单测                             |
| P7   | agent 运行时（Pi SDK/阶段工具/技能/系统提示） | P2,P3,P6 | 单测（mock Pi）                  |
| P8   | 工作流引擎（状态机/审核点/重试/断点/租约）    | P4,P7    | 单测                             |
| P9   | HTTP 路由 + SSE + 启动编排                    | P5,P6,P8 | 集成测试                         |
| P10  | CLI 运维入口改造                              | P9       | 单测                             |
| P11  | Web 工作台（Ant Design Vue）                  | P9       | 组件测试 + build                 |
| P12  | 旧领域删除 + 文档同步                         | P1..P11  | `pnpm test`/`build`/全仓引用扫描 |

---

### Phase 0：工作区与依赖就绪

**目标**：补齐 monorepo 包结构与全部新依赖，不改任何业务逻辑。

**Files:**

- Modify: `pnpm-workspace.yaml` → `packages: ["apps/*", "packages/*"]`
- Create: `packages/shared/{package.json,tsconfig.json}`, `packages/pipeline/{...}`, `packages/renderer/{...}`, `packages/template-sdk/{...}`（先只建包元数据与 `src/index.ts` 占位，P1 填内容）
- Modify: `vitest.config.ts`（alias 改为 `@videoforge/shared` → `packages/shared/src/index.ts` 等四个包）
- Modify: 根 `package.json`（新增脚本：`cli:status`、`db:migrate`；保留现有脚本）
- Modify: `apps/server/package.json`、`apps/cli/package.json`、`apps/web/package.json`（增依赖）

**要点：**

- 包命名与 `package.json`：
  - `@videoforge/shared`、`@videoforge/pipeline`、`@videoforge/renderer`、`@videoforge/template-sdk`，`"type": "module"`，`"main": "src/index.ts"`，`exports` 指向 `./src/index.ts`（tsx 直跑 + tsc 类型检查，与现状一致）。
- 新依赖（版本以 npm latest 为准，锁到具体版本）：
  - server：`@earendil-works/pi-coding-agent`（**锁 1.4.0**，见主文档 §14.4）、`@fastify/jwt`
  - web：`ant-design-vue@^4`、`@ant-design/icons-vue`、`dayjs`（antd 4 的时间组件依赖）
- 各包 `tsconfig.json` 继承 `tsconfig.base.json`，`include: ["src"]`。
- **SPIKE（本阶段必做，产出写入 `docs/notes/pi-sdk-api.md`）**：安装后读 `node_modules/@earendil-works/pi-coding-agent` 的类型声明，核实并记录：会话创建 API、`steer`/`followUp` 语义、`ModelRegistry`/`AuthStorage` 的 provider 注册方式、`DefaultResourceLoader({ systemPromptOverride })`、内置工具清单与自定义工具（TypeBox schema）注册签名、会话消息状态字段名（对应主文档 §5.1-§5.6、§14.1、§14.3）。**若 provider 注册与 Ark Agent Plan 不兼容或 SDK 导出与设计不符，在本阶段结论中显式记录偏差与替代方案，作为 P7 输入。**

- [ ] **Step 1:** 改 `pnpm-workspace.yaml` 与四个包元数据
- [ ] **Step 2:** 写 `vitest.config.ts` 新 alias，跑 `pnpm test` 确认仍全绿（此时 alias 指向 P1 才创建的 `packages/*/src/index.ts`，可先让两个任务并行落地）
- [ ] **Step 3:** 各 app 增依赖 → `pnpm install`
- [ ] **Step 4:** Pi SDK SPIKE，产出 `docs/notes/pi-sdk-api.md`
- [ ] **Step 5:** `pnpm install && pnpm test` 全绿

---

### Phase 1：内核迁移到 `packages/*`（旧测试全绿）

**目标**：把内核从 `apps/server/src/{pipeline,renderer,template-sdk,shared}` 原子迁移到 `packages/*`，并把 `apps/cli/src/video-commands.ts` 的实现下沉为可复用函数；**此阶段不删任何旧领域模块，不改行为**，保证 `pnpm test` 全绿。

**Files（迁出 → 迁入，均为 move，不留副本）:**

- `apps/server/src/shared/{errors,contracts,domain,build-state,index}.ts` → `packages/shared/src/`
- `apps/server/src/pipeline/*` → `packages/pipeline/src/`（**暂含** `manifest.ts`/`quality.ts`/`run-log.ts`/`python-adapter.ts`，P12 删）
- `apps/server/src/renderer/*` → `packages/renderer/src/`
- `apps/server/src/template-sdk/*` → `packages/template-sdk/src/`
- Create: `packages/pipeline/src/copy-generate.ts`、`image-generate.ts`、`scene-generate.ts`、`tts-generate.ts`、`storyboard-generate.ts`
- Create: `packages/renderer/src/render-frames.ts`
- Modify: `apps/cli/src/video-commands.ts`（改为薄封装，仅解析参数与格式化 stdout，逻辑全部调 `packages/*`；P10 再整体删除）
- Modify: 全仓 import 路径 `@videoforge/server/src/...` → `@videoforge/{shared,pipeline,renderer,template-sdk}`

**要点：**

- 从 `video-commands.ts` 中**原样抽出**每条命令的核心逻辑为纯函数（不改变行为、不改变错误码与 stdout 契约）：
  - `generateCopy({ topic, style, promptSet?, config, outPath })` → 写 `copy.json`
  - `generateImages({ projectDir, config })` → `images/<sceneId>.png`
  - `generateScenes({ projectDir, config })` → `scenes/<sceneId>.html`
  - `generateSpeech({ projectDir, config, speaker? })` → `audio/<sceneId>.mp3`
  - `generateStoryboard({ projectDir, config })` → `timeline.json`
  - `renderFrames({ projectDir, profile, config })` → `build/render/<profile>/frames/`
  - `composeVideo({ projectDir, profile, config })` → `final.mp4`
  - **签名约定**：一律"目录 + 显式参数"入参、不读 `process.argv`、不打印人类可读日志（日志用注入的 logger 或 `console.info` 到 stderr 由调用方控制），供 P7 阶段工具直接进程内调用（主文档 §5.4 要求不 spawn 子进程）。
- 迁移后内核入口 `packages/pipeline/src/index.ts` 逐项 `export`；每包 `src/index.ts` 为该包唯一公开出口。
- 迁 `run-log.ts` 时**保持原行为**（仍在写 `run-log.jsonl`），P12 随 CLI 命令一起删除，避免阶段 1 出现半迁移状态。

- [ ] **Step 1:** 建包目录并 move 内核文件（git mv 语义）
- [ ] **Step 2:** 抽 7 个纯函数（先补/保留既有单测，确保抽函数后 `tests/unit/cli-video-commands.test.ts` 仍绿）
- [ ] **Step 3:** 全仓改 import，删除 `@videoforge/server/src/...` 子路径引用
- [ ] **Step 4:** 更新 `vitest.config.ts` alias 与 `apps/server/package.json` 依赖（`workspace:*`）
- [ ] **Step 5:** `pnpm test && pnpm build` 全绿

---

### Phase 2：shared 领域类型 + 能力注册表

**目标**：建立新领域类型与能力声明，作为后续所有模块的类型基础。

**Files:**

- Modify: `packages/shared/src/errors.ts`（错误码按主文档 §4.5 扩充）
- Modify: `packages/shared/src/domain.ts`（裁剪为 User/Project/Session/Message/Run/RunStage/ToolCall/LlmCall + 枚举，删 Build/Task/Review/ContentVersion 领域类型）
- Create: `packages/shared/src/capability.ts`（Capability 声明类型）
- Create: `apps/server/src/workflow/capabilities.ts`（内置能力注册表，含 `video-generation`）
- Modify: `packages/shared/src/index.ts`
- Test: `tests/unit/capability-registry.test.ts`

**要点：**

- 错误码枚举（主文档 §4.5）：`AUTH_INVALID | AUTH_FORBIDDEN | PROJECT_BUSY | RUN_STATE_INVALID | CONFIG_INVALID | TOOL_UNAVAILABLE | ADAPTER_FAILED | ADAPTER_PROTOCOL_INVALID | PATH_OUTSIDE_STORAGE`；保留 `VideoForgeError(code, message)` 形制（`message` 前缀仍是 `${code}: `）。**`INTERRUPTED` 不是错误码**，仅作为 `runs.error_code` 值（用独立常量 `RUN_ERROR_INTERRUPTED = "INTERRUPTED"`）。
- 状态枚举（主文档 §11）：
  - `PROJECT_STATUSES = ["draft","running","review","done","failed"]`
  - `RUN_STATUSES = ["queued","running","waiting_review","done","failed","canceled"]`
  - `RUN_STAGE_STATUSES = ["pending","running","done","failed","skipped"]`
  - `RUN_TRIGGERS = ["user","retry","resume"]`
  - `MESSAGE_ROLES = ["user","assistant","tool","system"]`
  - `PIPELINE_STAGES = ["copy","image","scene","tts","storyboard","render","compose"]`（有序数组即阶段顺序）
- `Capability` 声明类型（主文档 §3.6）：`{ id, name, description, stages: { stage, tool, reviewGate, artifactPredicate }[], reviewGates: Stage[], paramsSchema, skillDirs, finalArtifact }`。
  - `artifactPredicate` 用可序列化的描述（如 `{ kind: "file", relativePath: "copy.json", validator: "copy-contract" }`），由 P8 引擎解释，**不要在声明里放函数**（声明要能原样经 `GET /api/capabilities` 返回）。
- `video-generation` 声明取值（主文档 §3.6）：7 阶段线性链；审核点 `["copy","image"]`；`paramsSchema` 含 `topic`(必填)/`style`(可选)/`profile`(枚举 `landscape-1080p|portrait-1080p`，默认 `landscape-1080p`)；`skillDirs = [".trae/skills"]`；`finalArtifact = "final.mp4"`。
- 测试：注册表返回 1 个能力、阶段数 7 且顺序正确、审核点仅 copy/image、`GET` 视图可 JSON 序列化（无函数字段）。

- [ ] **Step 1:** 写 `capability-registry.test.ts`（期望失败）
- [ ] **Step 2:** 实现 `errors.ts` / `domain.ts` / `capability.ts` / `capabilities.ts`
- [ ] **Step 3:** `pnpm exec vitest run tests/unit/capability-registry.test.ts` 通过
- [ ] **Step 4:** `pnpm test` 全绿（旧测试若引用被删类型，按 P12 顺序**暂留**兼容导出，并在文件头注释 `@deprecated 待 P12 删除`）

---

### Phase 3：配置层改造

**目标**：YAML 与 `config.ts` 按主文档 §12 增删，新增 `.pi/settings.json`。

**Files:**

- Modify: `config/default.yaml`、`config/system.local.example.yaml`
- Modify: `packages/pipeline/src/config.ts`（zod schema + 新字段）
- Create: `.pi/settings.json` → `{"skills": ["../.trae/skills"]}`
- Modify: `.env.example`（补 `JWT_SECRET`、`VF_ADMIN_INITIAL_PASSWORD` 说明，**只写键名不写值**）
- Test: `tests/unit/config.test.ts`、`tests/unit/config-layout.test.ts`（改造既有）

**要点：**

- 新增（§12.1）：`server.jwt_secret_env=JWT_SECRET`、`server.access_token_ttl=12h`、`server.allow_registration=true`、`server.admin_password_env=VF_ADMIN_INITIAL_PASSWORD`、`server.max_projects_per_user=50`、`agent.allow_shell_write_edit=true`、`workflow.max_stage_retry=2`、`runtime.max_concurrent_stage=1`。
- 删除（§12.2）：`runtime.worker_concurrency`、`python.*`、`engines.tts_default`、`engines.tts_voice_default`、`engines.t2i_default`；`retention.*` 一并删除（无引用方）。
- 每个叶子字段必须带用途注释（单位/范围、空值默认行为、敏感值安全边界），沿用现有注释风格。
- `loadSystemConfig` 行为保持：default → system.local → override 深合并；相对路径绝对化；校验失败抛 `CONFIG_INVALID`。新增**校验**：`access_token_ttl` 形如 `12h`/`30m`；`max_projects_per_user` 1..1000；`max_stage_retry` 0..5；`max_concurrent_stage` ≥1。
- `JWT_SECRET` **不进 YAML/不进 config 对象**：仅在启动时由 `#loadJwtSecret()`（P5）按 `server.jwt_secret_env` 读环境变量。
- 测试：合法配置加载、删字段后不报错、非法 `access_token_ttl` 报 `CONFIG_INVALID`、`.pi/settings.json` 存在且 skill 路径指向 `.trae/skills`。

- [x] **Step 1:** 改测试（期望失败）→ **Step 2:** 改 YAML 与 `config.ts` → **Step 3:** 指定测试通过 → **Step 4:** `pnpm test` 全绿

**P3 执行记录（2026-10-25 完成）：**

- 改动文件：`config/default.yaml`、`config/system.local.example.yaml`、`packages/pipeline/src/config.ts`、`.pi/settings.json`（新建）、`.env.example`、`tests/unit/config.test.ts`、`tests/unit/config-layout.test.ts`、`tests/unit/cli-video-commands.test.ts`（最小 default.yaml 夹具补齐新增必填键）。
- **与 §12.2 的受控偏差**：`python.*` 与 `engines.tts_voice_default` 已从两个 YAML 模板移除，但**在 zod schema 中保留为带默认值的 `@deprecated 待 P12 删除` 字段**——因为 `apps/server/src/voice-service.ts`（Edge TTS 声音目录/试听）在 P12 之前仍读取它们，直接删类型会导致 `tsc` 失败，违背"先迁移保测试，后删旧领域"。这两个字段的 schema 定义必须在 P12 删除 voice-service 时一并移除。
- 既有环境性失败已修复：原 `tests/unit/config.test.ts` 直接以仓库根为 `rootDir` 加载配置，会被开发机 gitignored 的 `config/system.local.yaml` 覆盖（该文件把 `chat_model` 改为 `kimi-k3`）。改造后测试统一使用临时 `rootDir` + 夹具 `default.yaml`，只有断言"仓库默认配置保留占位模型"的用例直接解析 `config/default.yaml` 文本，**不读** `system.local.yaml`，断言未被弱化。
- 验证结果：`pnpm exec vitest run tests/unit/config.test.ts tests/unit/config-layout.test.ts` → 10 passed；`pnpm test` → 26 files / 116 tests 全绿；`pnpm build` → 通过；`pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → 通过；`pnpm run doctor` → PASS。

---

### Phase 4：数据库 schema 重建 + 仓储 + 项目状态推导

**目标**：按主文档 §11 重建 8 张表，落地 actor-first 仓储与路径隔离。

**Files:**

- Modify: `apps/server/src/db/schema.ts`（新 8 表；删旧 Build 领域表定义）
- Modify: `apps/server/src/db/migrate.ts`（新 DDL + `DROP TABLE IF EXISTS` 旧表 12 张，按 §10.1 清单）
- Create: `apps/server/src/db/repositories/{user,project,session,message,run,run-stage,trace}-repository.ts`
- Create: `apps/server/src/domain/project-status.ts`
- Create: `apps/server/src/domain/storage-layout.ts`（`resolveUserProjectDir(storageRoot, userId, name)`）
- Modify: `packages/pipeline/src/path-safety.ts`（新增项目名校验 `validateProjectName`：去首尾空白与末尾点、长度 1..64、禁 `/ \ ..`、禁 `: * ? " < > |` 与控制字符、NFC 归一化、**允许中文与空格**；新增 `assertInsideUserRoot`）
- Test: `tests/unit/{db-schema,user-repository,project-repository,run-repository,project-status,storage-layout}.test.ts`

**要点：**

- 8 表字段严格照主文档 §11：`users / projects / sessions / messages / runs / run_stages / tool_calls / llm_calls`；JSON 文本列存字符串（写入前 `JSON.stringify`）；`users.username` 唯一索引（大小写不敏感：存 `username_lower` 或统一 lower 后比较，二选一在实现注释中写明并加测试）；`projects` 有 `unique(user_id, name)`。
- **仓储签名铁律**（§8.3 查询层）：每个用户态方法第一个参数是 `actor: { userId, role }`，SQL 一律 `where ... and user_id = ?`；**严禁先按 id 查再内存判归属**。
- 需要跨用户只读的方法**只允许**出现在 `#listAllUsers/#listAllProjects/#listAllRuns`（供 `/api/admin/*`）等显式命名的方法里，且方法名带 `admin` 前缀（如 `adminListRuns`），便于评审。
- `project-status.ts`：输入 `{ runs, runStages, artifacts }` → 输出 `draft|running|review|done|failed`，规则照 §8.4 表格；`done` 唯一判据是 `final.mp4` 存在。**纯函数、无 IO**，便于穷举测试。
- 测试覆盖（§13.1）：状态推导 5 态边界 + 迁移幂等（连跑两次）+ 项目名校验（中文/空格/非法字符/重名追加 `-2`）+ A 用户访问 B 资源全部失败。

- [x] **Step 1:** 写状态推导与项目名校验测试（期望失败）
- [x] **Step 2:** 实现 schema + migrate + path-safety + storage-layout
- [x] **Step 3:** 实现仓储（含 actor-first 隔离测试）
- [x] **Step 4:** 实现 `project-status.ts`，测试通过
- [x] **Step 5:** `pnpm test` 全绿（旧仓储 `build/event/task/voice-repository` 暂留至 P12）

**P4 执行记录（2026-10-25 完成）：**

- 改动文件：`apps/server/src/db/schema.ts`、`apps/server/src/db/migrate.ts`、`apps/server/src/db/index.ts`、`packages/pipeline/src/path-safety.ts`；新建 `apps/server/src/db/repositories/{user,project,session,message,run,run-stage,trace}-repository.ts`、`apps/server/src/domain/{project-status,storage-layout}.ts`；新建 `tests/unit/{db-schema,user-repository,project-repository,run-repository,project-status,storage-layout}.test.ts`。
- **旧表处理（受控调整，与 §10.1 全量 DROP 的差异已论证）**：§10.1 要求删除 12 张旧表，但其中 `builds`/`tasks`/`build_events`/`tts_voices`/`tts_catalog_state`/`tts_preview_cache` 仍被 `repositories/{build,event,task,voice}-repository.ts` 与 `tests/unit/voice-repository.test.ts`、`tests/integration/{build-repository,task-lease,voice-api}.test.ts` 使用；若在 P4 直接 DROP 会打挂"暂留至 P12"的旧仓储单测，违背 Step 5 的"`pnpm test` 全绿"。因此 P4 仅删除经全仓核对**确认无引用**的 5 张表（`content_versions`/`artifacts`/`quality_results`/`reviews`/`metric_snapshots`）与旧 `projects`（同名替换，不沿用旧数据），其余 6 张表保留 DDL 并加 `@deprecated 待 P12 删除` 注释，P12 随旧仓储一并移除。
- 用户名大小写不敏感：选定"写入前 `toLowerCase()` 归一化 + `username` 唯一索引"，不新增 `username_lower` 列；决策已写入 `schema.ts` 注释并有测试覆盖。
- `validateProjectName` 非法名错误码选用既有 `PATH_OUTSIDE_STORAGE`（现有错误码集合中无语义更贴近者，且与 `assertInsideUserRoot`/`resolveArtifactPath` 越界语义一致）。
- `runs."trigger"` 是 SQLite 保留字，DDL 中加引号。
- 验证结果：6 个新增测试文件 43 passed；`pnpm test` → 32 files / 159 tests 全绿（基线 26/116，无回归）；`pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → 通过；`pnpm build` → 通过。

---

### Phase 5：鉴权模块

**目标**：scrypt 密码、JWT 签发校验、登录节流、admin 幂等初始化。

**Files:**

- Create: `apps/server/src/auth/{password.ts,jwt.ts,throttle.ts,bootstrap.ts,secret.ts}`
- Test: `tests/unit/auth-{password,jwt,throttle,bootstrap}.test.ts`

**要点（主文档 §8.1，逐条对齐）：**

- `password.ts`：`hashPassword` / `verifyPassword`；scrypt `N=16384,r=8,p=1`，salt 16 字节；存储格式 `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`；`timingSafeEqual` 比较；长度 8..128 校验，不做复杂度强制。
- `jwt.ts`：`@fastify/jwt` HS256；载荷 `{ sub, username, role, iat, exp }`（**不含任何密钥**）；TTL 取 `server.access_token_ttl`；校验失败统一 `AUTH_INVALID`(401)。
- `secret.ts`：`loadJwtSecret(config)` 按 `server.jwt_secret_env` 读环境变量，缺失或 `<32` 字符 → 抛 `CONFIG_INVALID`（**不现场生成**）。
- `throttle.ts`：进程内 Map，同 `username` 连续失败 5 次 → 60s 内一律拒绝；常量写死代码（不进配置）；重启清零；**admin 无例外**。
- `bootstrap.ts`：`ensureAdminUser({ db, config })` 幂等——不存在 `username='admin'` 才创建（`role='admin'`、`must_change_password=1`）；已存在原样跳过（不重置密码、不改字段）；初始密码取 `server.admin_password_env` 指定环境变量，未设置回退常量 `mongoose-admin`；**只在首次创建时读取**；明文不得进 YAML/日志/trace/测试快照。
- 测试覆盖（§13.1）：哈希格式与校验、参数错误格式拒绝、TTL 解析、缺 `JWT_SECRET` 启动失败、节流第 6 次拒绝、admin 初始化幂等（全新库创建 / 重启不覆盖已改密码）、默认口令可登录、`must_change_password` 流转。

- [x] **Step 1:** 写测试（期望失败）→ **Step 2:** 实现 → **Step 3:** 指定测试通过 → **Step 4:** `pnpm test` 全绿

**P5 执行记录（2026-10-25 完成）：**

- 新增文件：`apps/server/src/auth/{password,jwt,throttle,bootstrap,secret}.ts`；新增测试 `tests/unit/auth-{password,jwt,throttle,bootstrap}.test.ts`（4 文件 / 25 用例）。未修改既有文件。
- 实现要点：scrypt `N=16384,r=8,p=1`、salt 16B、派生 64B，存储串 `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`，`timingSafeEqual` 比较，非法存储串返回 `false` 不抛；JWT HS256 载荷严格 `{sub,username,role,iat,exp}`，TTL 取 `access_token_ttl`；节流为进程内 Map（键按 P4 规则 lower-case 归一化），阈值 5 次 / 窗口 60s 写死为代码常量，admin 无例外；`ensureAdminUser` 幂等（存在即跳过，不读环境变量、不改字段），初始密码仅首次创建时读取，未设置回退 `mongoose-admin`。
- 受控偏差（已在子代理报告中列出并接受）：
  1. `loadJwtSecret(config, rootDir)` 为双参（需要 `rootDir` 定位 `.env.local`）；计划原文写作 `loadJwtSecret(config)` 属简写。
  2. 额外导出 `verifyAccessToken(app, token)` 作为统一校验入口（"校验失败统一映射 `AUTH_INVALID`" 需要一个落点）；`registerJwt` 为 `async`（Fastify 插件注册本身异步）。
  3. `loadJwtSecret` 的测试并入 `tests/unit/auth-jwt.test.ts`（计划未单列 secret 测试文件）。
  4. `tests/unit/auth-jwt.test.ts` 从 `apps/server/node_modules/fastify/fastify.js` 相对路径导入 fastify：pnpm 严格隔离下根 `node_modules` 不暴露 `fastify`，未改动 `vitest.config.ts` 属有意取舍。
  5. "重置密码置 1"路径的断言由 P4 `user-repository.test.ts` 覆盖，P5 只覆盖 §13.1 点名的"初始化置 1 / 改密置 0"。
- 验证结果：4 个新增测试文件 25 passed；`pnpm test` → 36 files / 184 tests 全绿（基线 32/159，无回归）；`pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → 通过；`pnpm build` → 通过。

---

### Phase 6：trace 三级留痕 + 脱敏 + 结构化日志

**目标**：run/stage/tool/llm 四级记录同库落盘并双写 `trace.jsonl`。

**Files:**

- Create: `apps/server/src/trace/{redact.ts,trace-store.ts,logger.ts}`
- Test: `tests/unit/trace-{redact,store}.test.ts`

**要点（主文档 §7）：**

- `redact.ts`：已知敏感值（`ARK_API_KEY`、`JWT_SECRET`、admin 初始密码及常见环境变量赋值形态如 `ARK_API_KEY=xxx`）统一子串替换为 `***`；先加载敏感值集合再替换（值本身不得出现在日志/trace/DB/manifest）。
- `trace-store.ts` 提供：`recordToolCall({sessionId, runId?, stageId?, tool, args, ok, errorCode?, durationMs, artifactPaths})`、`recordLlmCall({...同 §11 字段..., requestJson, responseJson, promptTokens, completionTokens})`、`recordStage(...)`；每条记录**先过脱敏器**，再同事务写 SQLite 与 append `<项目>/trace.jsonl`（每行一条 JSON，字段与表一致）。
- 自由对话记录 `runId/stageId` 为空，仅挂 `sessionId`（§7.1）。
- `logger.ts`：Fastify logger 配置 JSON 行输出 + `redact` 钩子；**stdout 只承载机器可读、诊断走 stderr** 的约定沿用（CLI 侧）。
- 字段命名向 OTel 靠拢，**不得为短期需求删改字段**（§7.5）。

- [x] **Step 1:** 写脱敏与双写一致性测试（期望失败）→ **Step 2:** 实现 → **Step 3:** 测试通过 → **Step 4:** `pnpm test` 全绿

**P6 执行记录（2026-10-25）：**

- 改动文件：
  - 新建 `apps/server/src/trace/redact.ts`：`collectSensitiveValues(rootDir, extra?)`（`loadLocalEnv` 后读 `ARK_API_KEY`/`JWT_SECRET`/`VF_ADMIN_INITIAL_PASSWORD` + 内置 `mongoose-admin` + 附加值，去重并过滤长度 < 6 的短串）、`redactText(text, secrets)`（先按键名赋值/CLI 形态替换后跟值，再按长度降序做已知值子串替换，不抛错）、`redactDeep(value, secrets)`（递归 + `WeakSet` 防循环）、`createRedactor(rootDir)`（缓存敏感值集合）。
  - 新建 `apps/server/src/trace/trace-store.ts`：`createTraceStore({db, actor, storageRoot, rootDir})` 返回 `recordToolCall` / `recordLlmCall` / `recordStage`；每条记录**先 `redactDeep` 脱敏 → 委托既有 `trace-repository` 写 SQLite → 追加 `<项目目录>/trace.jsonl`**（`assertInsideUserRoot` 复核 + `mkdirSync(recursive)` + `appendFileSync` UTF-8 逐行 JSON）。`recordStage` 按 `(runId, stage, attempt)` upsert。
  - 新建 `apps/server/src/trace/logger.ts`：`createLoggerOptions(redactor)` 返回 Fastify 5 日志配置（JSON 行、`LOG_LEVEL` 缺省 `info`），`redact` 按字段路径脱敏 + `formatters.log` 对整条日志对象走 `redactDeep` 兜底。
  - 修改 `apps/server/src/db/repositories/run-stage-repository.ts`：**仅新增** `findRunStageByAttempt(db, actor, runId, stage, attempt)`（未改任何既有签名）。
  - 新建测试 `tests/unit/trace-redact.test.ts`（8 例）、`tests/unit/trace-store.test.ts`（6 例）。
- 受控偏差（已接受）：
  1. `trace.jsonl` 每行在**保留全部表字段**的前提下追加一个判别字段 `type: "tool_call" | "llm_call" | "run_stage"`——三表同写一个文件，无判别字段外部工具无法区分行类型；属 §7.5 允许的追加式新增字段，不删改既有字段。
  2. `trace-store` 的方法签名在计划所列字段之外，通过**工厂 options**（`db`/`actor`/`storageRoot`/`rootDir`）注入 actor 与存储上下文——既有 `trace-repository` 的归属校验需要 actor，且项目目录需由 `session/run → project` 解析。
  3. `redactDeep` 对循环引用返回 `"[Circular]"`（仅为日志兜底防死循环）。
- 未接线说明：本次未改 `app.ts`，`createTraceStore` / `createLoggerOptions` 暂无调用方，接线属 P9。
- 验证结果：`pnpm exec vitest run tests/unit/trace-redact.test.ts tests/unit/trace-store.test.ts` → 2 files / 14 tests passed；`pnpm test` → **38 files / 198 tests 全绿**（基线 36/184，净增 2 文件 / 14 用例，无回归）；`pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → 通过；`pnpm build` → 通过。

---

### Phase 7：agent 运行时

**目标**：`apps/server/src/agent/` 内嵌 Pi agent 运行时：会话注册表、Ark provider（带 LLM 全文埋点）、7 个阶段工具 + 内置工具、技能注入、系统提示。

**前置输入**：Phase 0 的 `docs/notes/pi-sdk-api.md`。

**Files:**

- Create: `apps/server/src/agent/{runtime.ts,session-registry.ts,prompt.ts,skills.ts}`
- Create: `apps/server/src/agent/pi/{provider.ts,auth-storage.ts,resource-loader.ts}`
- Create: `apps/server/src/agent/tools/{index.ts,stage-tools.ts,builtin-tools.ts,stage-tool-defs.ts}`
- Test: `tests/unit/agent-{session-registry,stage-tools,prompt}.test.ts`、`tests/unit/ark-provider.test.ts`

**要点（主文档 §5）：**

- `session-registry.ts`：`Map<sessionId, { session, userId, projectId, projectDir }>`；创建时注入 `projectDir`（= `resolveUserProjectDir`）、`modelId`、历史消息；**恢复**：从 `messages` 表重建 `session.agent.state.messages`（含 `role=system` 阶段指令）；销毁：空闲超时。
- `pi/provider.ts`：**自实现 provider**（不依赖 Pi 内置 Ark 适配），`base_url` 固定 `https://ark.cn-beijing.volces.com/api/plan/v3`、OpenAI 兼容（`openai-completions`）、model = `engines.endpoints.ark.chat_model`、key 只从 `ARK_API_KEY` 读；**每次请求/响应经 `trace.recordLlmCall` 全文埋点**（含 token 与耗时，落库前脱敏）；模型仍是占位值 `PLEASE_FILL_CHAT_MODEL_ID` 时抛 `CONFIG_INVALID`。
- `stage-tools.ts`：7 个工具（TypeBox schema），**入参不含任何路径**，项目目录由运行时注入；`profile` 只接受 `config/profiles/` 下存在的目录名，非法 → `CONFIG_INVALID`；handler **全部 try/catch 兜底**为 `tool_end.ok=false`（异常不冒泡）；内核异常 `VideoForgeError` 原样透传 `errorCode`；渲染/合成阶段加超时（代码常量），超时按 `TOOL_UNAVAILABLE` 收尾。
- `builtin-tools.ts`：`read/grep/find/ls` 恒开；`bash/write/edit` 由 `agent.allow_shell_write_edit` 控制（默认 true）；`cwd` 固定项目目录；**全部工具调用（含内置）写入 `tool_calls`**（bash 记命令原文 + 退出码；write/edit 记相对路径）。
- `skills.ts` + `.pi/settings.json`：渐进式披露（常驻 name+description，按需 read SKILL.md）。
- `prompt.ts`：`DefaultResourceLoader({ systemPromptOverride })` 注入系统提示——角色、产物布局与 `final.mp4` 命名、**引擎纪律**（只执行收到指令的阶段、只调对应工具、不自行跳阶段）、输出纪律（不复述密钥、失败给错误码与建议）、行为边界（只在当前项目内写、不改仓库源码与配置、不读/回显 `.env.local`、不删项目外文件）。
- 节奏：**先做最小连通性验证**（§14.1）——用 mock provider 跑通"建会话 → 发消息 → 收 text_delta"，再接入真实 Ark provider（真实联调需用户填 `chat_model` 与 `ARK_API_KEY`，本节不做真机验收）。

- [x] **Step 1:** 实现 provider + `ark-provider.test.ts`（mock HTTP，断言全文埋点字段与脱敏）
- [x] **Step 2:** 实现 stage-tools + 映射测试（mock 内核，断言参数→内核调用与错误码透传）
- [x] **Step 3:** 实现 session-registry（mock Pi SDK）+ 恢复测试
- [x] **Step 4:** 实现 prompt/skills/builtin-tools 与工具集差异测试（`allow_shell_write_edit` true/false）
- [x] **Step 5:** `pnpm test` 全绿（每次交付均需全绿，阶段收口前再跑一次）

**P7 执行记录（已完成，2026-10-25）**

已交付的四块 + 收口验证（均为子代理实施 + 主代理逐文件核查 + 亲自重跑验证）：

1. **P7-A · Ark provider + LLM 全文留痕**（Step 1 ✅）
   - 新增 `apps/server/src/agent/pi/ark-chat.ts`（唯一 HTTP 出口，SSE 解析与 `delta.tool_calls[].index` 聚合）、`apps/server/src/agent/pi/provider.ts`（`createArkStreamSimple` / `createArkModelRuntime`）。
   - 留痕上下文用**闭包注入**（`ArkTraceContext`），每次请求成功/失败都调 `trace.recordLlmCall`；`base_url` / `chat_model` 取自配置，密钥只从 `ARK_API_KEY` 读，绝不入 body / 返回值 / 日志。
   - 新增 `tests/unit/ark-provider.test.ts`（8 例）。
2. **P7-B1 · 7 个阶段工具**（Step 2 ✅）
   - 新增 `apps/server/src/agent/tools/stage-tools.ts`（`createStageTools`，TypeBox schema，**入参不含任何路径**）与 `apps/server/src/agent/tools/index.ts`。
   - `PROFILE_NAME_TO_OUTPUT_PROFILE` 显式映射表（`landscape-1080p` / `portrait-1080p`），非法 profile → `CONFIG_INVALID`；handler 全量 try/catch，`VideoForgeError` 透传 `errorCode`，其它异常收口 `TOOL_UNAVAILABLE`；渲染 30min / 合成 20min 代码常量超时。
   - 新增 `tests/unit/agent-stage-tools.test.ts`（21 例）。
3. **P7-B2 · 内置工具 + 工具调用留痕 + 提示词 + 技能**（Step 4 ✅）
   - 新增 `apps/server/src/agent/tools/tool-trace.ts`（`withToolTrace`：通用工具留痕包装，异常不吞、留痕失败不影响工具、`write`/`edit` **只记相对路径不记正文**、`bash` 记命令原文 + `exit_code`）、`apps/server/src/agent/tools/builtin-tools.ts`（`read/grep/find/ls` 恒开，`bash/write/edit` 由 `allow_shell_write_edit` 控制，`cwd` 锁项目目录）。
   - `apps/server/src/agent/tools/index.ts` 新增 `createAgentTools`：阶段工具 + 内置工具组合，**阶段工具也套 `withToolTrace`**（主文档 §7.3 要求"每次工具调用（含 Pi 内置工具）记录 `tool_calls`"）。
   - 新增 `apps/server/src/agent/prompt.ts`（`buildSystemPrompt` 覆盖 §5.6 五条 + `createAgentResourceLoader` + `resolveAgentDir`）、`apps/server/src/agent/skills.ts`（`resolveSkillDirs`）。
   - 新增 `tests/unit/agent-builtin-tools.test.ts`（13 例）、`tests/unit/agent-prompt.test.ts`（8 例）。
4. **P7-C1 · 会话注册表 + 组合根**（Step 3 ✅）
   - 新增 `apps/server/src/agent/session-registry.ts`：进程内 `Map<sessionId, AgentSessionEntry>`；`getOrCreate` 九步（内存命中先校验归属 → 按 actor 查会话/项目 → `resolveUserProjectDir` → 历史 `appendMessage` 重放 → 组装 `createAgentTools` → `createAgentResourceLoader` → `port.createAgentSession` → 写表）；`release` / `disposeIdle`（30min 常量）/ `disposeAll` / `touch` / `get` / `size`。
   - 新增 `apps/server/src/agent/runtime.ts`：`createAgentRuntime` 把「`createArkModelRuntime` → `loadSystemConfig().engines.endpoints.ark.chat_model` 解析模型 → `createSessionRegistry`」按依赖顺序拼成组合根；`chat_model` 为占位值时抛 `CONFIG_INVALID`。
   - 新增 `tests/unit/agent-session-registry.test.ts`（12 例）：假 SDK 端口 + 真实 SQLite 临时目录，覆盖创建/复用（`toBe` 同一 session 引用）/历史重放顺序/损坏历史不阻断/跨用户越权 `AUTH_FORBIDDEN`/内存命中归属不符/`release`/`disposeIdle`（可控时钟）/`disposeAll`/工具集含与不含写类工具。
5. **收口 · §14.1 最小连通性验证**（Step 5 ✅）
   - 新增 `apps/server/src/agent/connectivity-check.ts`（可执行入口）：注册 mock provider（自实现 `streamSimple`，分片回放 `text_delta`）→ `createAgentSession`（`SessionManager.inMemory` + `noTools:"all"`，cwd/agentDir 均指向临时目录）→ `session.prompt()` → 订阅并累积 `text_delta` → 断言拼接结果等于预期文本。
   - 运行方式：`pnpm exec tsx apps/server/src/agent/connectivity-check.ts`；退出码 0 = 通过、1 = 失败。**结论：Pi 的「provider 注册 → 会话创建 → 发消息 → 收 `text_delta`」机制在本机可用**；Ark `/api/plan/v3` 端点的协议兼容性仍需用户填真实 `chat_model` 与 `ARK_API_KEY` 后单独联调（本节不做真机验收）。

受控偏差（P7 累计）：

- 新增依赖 `@earendil-works/pi-ai@1.4.0`（P7-A）与 `typebox@1.3.27`（P7-B1）；首次 `pnpm install` 需 `--no-frozen-lockfile`，`pnpm-lock.yaml` 已同步。
- 计划 Files 列出的 `stage-tool-defs.ts` 未创建：7 个工具定义集中在 `stage-tools.ts`，无独立引用方。
- 主文档 §5.6 写 `DefaultResourceLoader({ systemPromptOverride })`，但其类型是 `(base) => string | undefined`（函数），实际改用 `systemPrompt: "<完整字符串>"`（SPIKE §7.1 已记录）。
- 主文档 §5.5 写 `.pi/settings.json` 声明相对技能路径；因项目目录位于 `<storage_root>/users/<uid>/projects/<name>` 而非仓库根下，相对路径不可靠，改用 `additionalSkillPaths` 注入**绝对路径** `<rootDir>/.trae/skills`（语义等价）。
- `withTimeout` 的 `abort()` 为尽力而为（内核签名不接收 `AbortSignal`）。
- `redactDeep` 对循环引用返回 `"[Circular]"`（日志兜底，仅防死循环）。
- **每会话 `traceContext` 未接线**（P7-C1）：`createArkStreamSimple` 用闭包注入 `traceContext`，而一个 `ModelRuntime` 被多会话共用，单一闭包无法承载 per-session 上下文；`runtime.ts` 因此只传 `trace` 不传 `traceContext`，`provider.ts` 遇「有 trace 无 traceContext」时 `console.warn` 并**跳过 LLM 留痕**（既有行为，未改 `provider.ts`）。per-session 注入留给 P9 的 HTTP/SSE 编排层。
- **会话恢复改用官方途径**（P7-C1）：设计 §5.2 措辞"重建 `session.agent.state.messages`"已被 SPIKE §3.2 证伪，实际改为 `SessionManager.inMemory(cwd)` + 逐条 `appendMessage()` 重放（数据库是唯一历史来源，不落 Pi session 文件）。
- **补充 `noTools: "builtin"`**（P7-C1，设计未提）：内置工具已由 `createBuiltinTools`（带留痕）自己提供，不禁用 Pi 自带内置工具会出现重名工具。
- **`runId` / `stageId` 在会话注册表内留空**（P7-C1）：创建会话时尚无 run/stage，两字段由 P8 工作流引擎在创建 run、进阶段时注入。
- 会话注册表单测对 `@videoforge/pipeline` 采**部分 mock**（`importOriginal` 保留 `validateProjectName` 等真实路径安全函数，仅 stub 6 个会发真实网络/子进程的生成函数）。
- 计划 Files 列出的 `tests/unit/agent-runtime.test.ts` 未创建：`createAgentRuntime` 为薄组装层，其两处调用（provider 注册、会话注册表）已分别被 `ark-provider.test.ts` / `agent-session-registry.test.ts` 覆盖。

验证结果（主代理亲自重跑，文件定稿状态）：

- `pnpm exec vitest run tests/unit/agent-session-registry.test.ts` → 1 file / 12 tests passed。
- `pnpm test` → **43 files / 260 tests 全绿**（P5 后基线 36/184 → P6 38/198 → P7-A 39/206 → P7-B1 40/227 → P7-B2 42/248 → P7-C1 43/260，全程无回归）。
- `pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → `TSC_EXIT=0`（含 `connectivity-check.ts`）。
- `pnpm build` → 通过（`apps/server` 本身无 build 脚本，符合既有事实）。
- `pnpm exec tsx apps/server/src/agent/connectivity-check.ts` → `EXIT=0`，stdout 打印 mock 分片文本 + `[agent-connectivity] PASS`。
- 未接线说明（全部留给后续阶段）：`createAgentRuntime` / `createSessionRegistry` 尚无调用方（P9 接线）；per-session `traceContext` 未接线（P9，LLM 调用暂不落 `llm_calls`）；`disposeIdle` 需外部定时器（P9）；「Pi 会话 → `messages` 表」落库未接线（P9）。

---

### Phase 8：工作流引擎

**目标**：确定性七阶段 DAG 编排：状态机、审核点暂停、重试上限、断点续跑、项目租约、重启恢复。

**Files:**

- Create: `apps/server/src/workflow/{engine.ts,run-state.ts,breakpoint.ts,lease.ts,stage-instruction.ts}`
- Test: `tests/unit/workflow-{engine,run-state,breakpoint,lease}.test.ts`

**要点（主文档 §6、§8.4）：**

- `run-state.ts`：run 状态机与阶段状态机的**合法流转表**；非法流转抛 `RUN_STATE_INVALID`(409)。
- `engine.ts`：按能力声明驱动（**引擎不含阶段知识**）；从 `projects.profile` 注入 `profile` 参数；每阶段开始前 `pending→running`，产物判据通过才 `done`；审核点阶段 `done` 后 run → `waiting_review` 并发 `review_gate`；全阶段 `done` 且 `final.mp4` 存在 → run `done`。
- `breakpoint.ts`：按阶段顺序扫描产物存在性（判据与 `project:verify` 一致），返回起始阶段并把已达标阶段标 `skipped`（**文件是唯一断点依据**）。
- `lease.ts`：创建 run 前检查同项目活跃 run（`queued|running|waiting_review`）→ 冲突抛 `PROJECT_BUSY`(409)；`waiting_review` **同样持租约**；启动恢复时把 `running`/残留 `queued` 置 `canceled` + `error_code='INTERRUPTED'`，`waiting_review` 不动。
- `stage-instruction.ts`：向 `messages` 写 `role=system` 阶段指令（落库），如"执行 copy 阶段：调用 `copy_generate`，topic=… style=… promptSet=…"。
- 重试：agent 自救重试超 `workflow.max_stage_retry` → 阶段 `failed`、run `failed`。
- `resume(action)`：`approve` → `running` 继续；`retry`（可带 `feedback`，注入会话）→ 重跑该阶段/从失败阶段续跑；对终态 run 调 resume → `RUN_STATE_INVALID`。
- 全局阶段并发信号量上限 `runtime.max_concurrent_stage`。
- 测试（§13.1）：全部合法/非法流转、断点与 `skipped`、重试上限、审核点暂停与 resume 两分支、取消、租约冲突（含 `waiting_review`）、重启后 `INTERRUPTED`。

- [x] **Step 1:** 状态机与流转测试 → [x] **Step 2:** 断点与租约测试 → [x] **Step 3:** 引擎主循环（mock 内核与 agent）→ [x] **Step 4:** `pnpm test` 全绿

**P8-A 执行记录（已完成，2026-10-25）**

改动文件：

1. 新增 `apps/server/src/workflow/run-state.ts`（112 行，Step 1 ✅）：冻结流转表 `RUN_TRANSITIONS`（`queued → running|canceled`；`running → waiting_review|done|failed|canceled`；`waiting_review → running|canceled`；`failed → running`；`done`/`canceled` 无出边）与 `RUN_STAGE_TRANSITIONS`（`pending → running|skipped`；`running → done|failed`；`failed → running`；`done`/`skipped` 无出边），来源设计文档 §6.2 / §8.4。导出 `canTransitionRun`/`canTransitionStage`/`assertRunTransition`/`assertStageTransition`（非法抛 `RUN_STATE_INVALID` 并带 `from -> to`）/`isRunTerminal`/`isRunActive`（活跃 = `queued|running|waiting_review`）。
2. 新增 `apps/server/src/workflow/breakpoint.ts`（123 行，Step 2 ✅）：`verifyStageArtifact(projectDir, predicate, profile)` 解释能力声明的 `ArtifactPredicate`（`kind:"file"` → `existsSync` + 可选 `copy-contract` 校验；`kind:"glob"` → 自实现最小 glob 计数 `>= minCount`，`<profile>` 占位符替换）；`resolveBreakpoint(projectDir, declaration, profile)` 按阶段顺序扫描，返回首个未达标阶段下标与该阶段之前的 `skipped` 列表。所有 IO 异常统一按「未达标」处理（返回 `false`），**不向上抛错**。路径解析复用 `assertInsideUserRoot` 复核。
3. 新增 `apps/server/src/workflow/lease.ts`（45 行，Step 2 ✅）：`assertProjectLease(db, actor, projectId)` 复用 `findActiveRun`，命中活跃 run 抛 `PROJECT_BUSY`(409)；`recoverInterruptedRuns(db)` 委托仓储同名函数（保持单一实现）。
4. 修改 `apps/server/src/db/repositories/run-repository.ts`（**只增不改**，Step 2 ✅）：新增 `recoverInterruptedRuns(db): number`（系统启动专用、跨用户、无 actor 归属校验），把 `status ∈ {running, queued}` 全部置 `canceled` + `error_code = RUN_ERROR_INTERRUPTED`；`waiting_review` 不重置；新增 `import { RUN_ERROR_INTERRUPTED }`。
5. 新增 `tests/unit/workflow-run-state.test.ts`（9 例）：穷举全部 `(from,to)` 组合断言合法性与 `RUN_STATE_INVALID`；逐条比对 §6.2 流转表；终态无出边；`isRunTerminal`/`isRunActive` 全状态判定与互斥性。
6. 新增 `tests/unit/workflow-breakpoint.test.ts`（15 例）：`copy-contract` 合法/非法/非 JSON；`timeline-contract` 降级为 JSON 可解析；路径越界 `..` 按未达标（不抛错）；glob 命中数 `minCount` 边界、目录不存在、`<profile>` 替换；`resolveBreakpoint` 无产物 / 仅 copy 达标 / 前三阶段达标 / 末阶段缺 `final.mp4` 四类起点与 `skipped` 组合。
7. 新增 `tests/unit/workflow-lease.test.ts`（11 例）：真实 SQLite 临时库；`assertProjectLease` 无活跃 run 通过、`queued`/`running`/`waiting_review` 三态均抛 `PROJECT_BUSY`、`done`/`failed`/`canceled` 不阻塞、跨 actor 归属校验不误报；`recoverInterruptedRuns` 只重置 `running`+残留 `queued`（`waiting_review` 与终态不动）、无待恢复返回 0、恢复后项目租约解除可再次发起 run。

受控偏差（P8-A）：

- `validator:"timeline-contract"` 降级为「文件存在且内容可被 `JSON.parse`」——本仓库尚无 timeline 契约校验器，先用 JSON 可解析作最小判据，待 timeline 契约落地后替换（`breakpoint.ts` 内已注释）。
- glob 为自实现最小匹配（`readdirSync` + 仅文件名段 `*`/`?` 转正则，不支持 `**`）——能力声明的模式全部形如 `<dir>/*.<ext>`，无需递归，未新增依赖。
- `recoverInterruptedRuns` 恢复时一并补写 `ended_at = now`——设计只要求 `status = canceled` + `error_code = 'INTERRUPTED'`，补 `ended_at` 便于审计排序。

验证结果（主代理亲自重跑，文件定稿状态）：

- `pnpm exec vitest run tests/unit/workflow-{run-state,breakpoint,lease}.test.ts` → 3 files / 35 tests passed（9 + 15 + 11）。
- `pnpm test` → **46 files / 295 tests 全绿**（基线链 … → P7-C1 43/260 → P8-A 46/295，全程无回归）。
- `pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → `TSC_EXIT=0`。
- `pnpm build` → `BUILD_EXIT=0`。
- 未接线说明（全部留给后续阶段）：`assertRunTransition`/`assertStageTransition` 与 `resolveBreakpoint` 尚无调用方（P8-B `engine.ts`）；`assertProjectLease` 留给 P9 `http/routes/runs.ts`；`recoverInterruptedRuns` 留给 P9 `startServer`；`verifyStageArtifact` 供引擎判据与未来 `project:verify`。

**P8-B 执行记录（已完成，2026-10-25）**

改动文件：

1. 新增 `apps/server/src/workflow/stage-instruction.ts`（104 行，Step 3 ✅）：`StageInstructionInput` + `buildStageInstruction(input)`（纯函数）+ `buildStageInstructionMessage(input)`（落库负载）。指令正文由「`stage.label` + `stage.tool` + 项目 `topic`/`style`/`profile`」拼装，**无按阶段的 `switch`**（`style` 为空则省略片段；`attempt > 0` 追加重试说明与 `previousErrorCode`；`feedback` 非空追加用户反馈段）。落库负载为 Pi 兼容 `SystemMessage`：`{ role: "system", content: [{ type: "text", text }] }`（已核对 `@earendil-works/pi-ai@1.4.0` 的 `dist/types.d.ts`：`SystemMessage.content: string | TextContent[]`）。
2. 新增 `apps/server/src/workflow/engine.ts`（599 行，Step 3 ✅）：`createWorkflowEngine({ db, storageRoot, config, executeStage, emit?, now? })` → `{ run, resume, cancel }`。要点：
   - `run(actor, runId)`：`getRun` → `assertRunTransition(status,"running")` → `getCapability(project.capability_id)`（缺失抛 `CONFIG_INVALID`）→ `resolveUserProjectDir` → `resolveBreakpoint` 定位起点 → **幂等补建阶段行**（`attempt=0`，断点前 `skipped`、其余 `pending`）→ 委托 `advance`。
   - `advance`：置 `running`（保留首次 `started_at`）+ `emit run_started` → 按 `capability.stages` 顺序（**引擎无阶段知识**）逐阶段 `executeStageWithRetry` → 阶段 `done` 后写 `current_stage` → 声明 `reviewGate` 为真则 `running → waiting_review` + `emit review_gate`（含 `artifactPaths`）并**停止推进返回**；全部阶段 `done` 后以 `verifyStageArtifact(projectDir, {kind:"file", relativePath: capability.finalArtifact}, profile)` 为唯一 `done` 判据，缺失则 `failed` + `error_code = ARTIFACT_MISSING`。
   - `executeStageWithRetry`：整段（含重试）由**自实现计数信号量**（上限 `runtime.max_concurrent_stage`，无新依赖，释放时把执行位直接交接队首等待者）包住；起始 `attempt` 取该阶段首个 `pending` 行（首跑 0、审核点 retry 为「最大 attempt + 1」）；每轮 `pending → running`（先 `assertStageTransition`）→ 指令以 `role=system` 经 `appendMessage` **落库**（挂 `runId`）→ `emit stage_started` → `await executeStage(...)` → `satisfied = result.ok && verifyStageArtifact(projectDir, declaration.artifact, profile)`；`done` 记 `artifactPaths`，`failed` 记 `errorCode` 并在余额内继续下一 attempt，超限返回 `failed` 由上层收口 run。
   - `resume(actor, runId, "approve"|"retry", feedback?)`：`assertRunTransition(status,"running")`；`approve` **仅对 `waiting_review` 合法**（对 `failed` 做 approve 抛 `RUN_STATE_INVALID`，避免跳过失败阶段），从审核点阶段下标 +1 继续；`retry` 对 `waiting_review`/`failed` 均合法，取 `current_stage` 为目标阶段、**新建 `attempt = 最大 attempt + 1` 的 `pending` 行**（`done` 无出边，故重跑必须新建行）并从该阶段下标续跑，`feedback` 透传进指令。
   - `cancel(actor, runId)`：`assertRunTransition(status,"canceled")`（终态抛 `RUN_STATE_INVALID`）+ 写 `ended_at` + `emit run_canceled`。
   - 执行器抛异常**不冒泡**：收口为 `{ ok:false, errorCode:"TOOL_UNAVAILABLE" }` 并 `console.warn`。引擎**不写 `project.status`**（状态由 `deriveProjectStatus` 推导）。
   - 新增模块内常量 `RUN_ERROR_ARTIFACT_MISSING = "ARTIFACT_MISSING"`（`runs.error_code` 取值、非 API 错误码，沿用 `RUN_ERROR_INTERRUPTED` 惯例）与 `EXECUTOR_FAILURE_ERROR_CODE = "TOOL_UNAVAILABLE"`。
3. 新增 `tests/unit/workflow-engine.test.ts`（494 行 / 16 例）：真实 SQLite 临时库 + 注入假执行器（按 `request.stage` 写达标产物、记录调用序列与最大同时在跑数）；其中含 `buildStageInstruction` 纯函数 describe。覆盖：首跑到 `copy` 审核点、`approve` 到 `image` 审核点、连续 `approve` 至 `done`（`final.mp4` 存在）、断点续跑（`copy` 行 `skipped`、首调即 `image`）、重试上限（3 次尝试全 `failed` → run `failed`）、重试后成功、审核点 `retry`（新 `attempt=1` 行 + `feedback` 进入指令）、对 `done` run 的 `run`/`resume`/`cancel` 均抛 `RUN_STATE_INVALID`、`cancel` 与重复 `cancel`、阶段指令以 `role=system` 落库且 `payload` 与 `buildStageInstruction` 一致、`max_concurrent_stage=1` 下两个 run 并发最大同时在跑数为 1。

受控偏差（P8-B）：

- **`stage-instruction.ts` 属本块交付**（Phase 8 Files 原列在 Create 清单内）：P8-A 阶段落盘过一版与契约不符的内容，P8-B 按契约重写，故本阶段记录中归到 P8-B。
- `advance` 内再次 `assertRunTransition(run.status, "running")`（`run`/`resume` 入口已断言一次）：`advance` 拿到的是变更前的 run 快照，属防御式校验，非逻辑冗余。
- 阶段 `done` 后写 `current_stage` 用 `updateRunStatus({ status:"running", currentStage })` 且**不做断言**（`running → running` 非真实流转，仅更新当前阶段字段），已在代码注释说明。
- 「阶段内自救重试」按**引擎层重试**实现（每轮新建 `attempt+1` 行、至多 `max_stage_retry + 1` 次），而非依赖 agent 在单轮内自行重试——引擎无法观测 agent 内部重试次数，落到 `attempt` 列后可审计。
- per-stage `runId`/`stageId` 注入到**工具留痕**仍未接线：`withToolTrace` 的上下文在会话创建时（`session-registry.ts`）固化，`executeStage` 端口已携带 `runId`/`stageId`，实际注入点留给 P9 装配层。

验证结果（主代理亲自重跑，文件定稿状态）：

- `pnpm exec vitest run tests/unit/workflow-engine.test.ts` → 1 file / 16 tests passed。
- `pnpm test` → **47 files / 311 tests 全绿**（基线链 … → P7-C1 43/260 → P8-A 46/295 → P8-B 47/311，全程无回归）。
- `pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → `TSC_EXIT=0`。
- `pnpm build` → `BUILD_EXIT=0`。
- 未接线说明：`StageExecutor` 目前仅由单测注入假实现，接会话注册表（取会话 → 下发指令 → 等 agent 跑完）属 **P9**；`WorkflowEvent` 出口缺省 no-op，接 SSE 事件总线属 **P9**；`createWorkflowEngine` 尚无生产装配调用方（P9 `startServer`）。

---

**P9-A 执行记录（已完成，2026-10-25）**

改动文件（4 新源文件 + 2 新测试）：

1. 新增 `apps/server/src/http/errors.ts`（103 行，Step 1 ✅）：`ERROR_STATUS: Readonly<Record<VideoForgeErrorCode, number>>`（照 §4.5 六条 + §8.3 的 `PATH_OUTSIDE_STORAGE`→403 + 文档未列的 `QUALITY_BLOCKED`/`EVENT_IMMUTABLE` 按内核失败归 500）；`describeError`（剥离 `VideoForgeError.message` 的 `` `${code}: ` `` 前缀）；`toErrorBody`（统一 `{error:{code,message}}`；`VideoForgeError` 透传码与去前缀 message，未预期错误只回中性文案"服务器内部错误"且绝不含原始 message/堆栈）；`resolveStatusCode`；`registerErrorHandler(app)`（`setErrorHandler` + `setNotFoundHandler` 返回 404 + `NOT_FOUND`）。
2. 新增 `apps/server/src/http/auth-hook.ts`（92 行）：`extractActor(app, header)`（`Bearer` 大小写不敏感解析 → `verifyAccessToken` → `{userId, role}`；缺失/格式非法/令牌无效一律 `AUTH_INVALID`，**绝不记录令牌原文**）；`createAuthPreHandler(app)`（写 `request.actor`）；`requireActor(request)`；`requireAdmin(actor)`（非 admin 抛 `AUTH_FORBIDDEN`）；用 `declare module "fastify"` 给 `FastifyRequest` 挂 `actor?: Actor`（不用 `any`）。文件头注释写明 §8.1 内部信任边界（agent/workflow 只接受 actor，不传令牌、不二次鉴权）。
3. 新增 `apps/server/src/http/event-bus.ts`（233 行，Step 1 ✅）：`EVENT_BUFFER_SIZE = 200`；`SSE_EVENT_TYPES`（10 种，逐字照 §4.4）与 `SseEventType`；`SessionEvent{id,sessionId,type,payload,at}`；`createEventBus({bufferSize?, now?})` → `{publish, subscribe, replay, bufferSize}`。内部 `RingBuffer`（超容量 `shift` 丢最旧）；`publish` 分配**全局单调递增十进制序列号**并同步投递给活订阅者（单订阅者异常逐个 try/catch，不影响其他订阅者与返回值）；`replay` 四分支（无 `Last-Event-ID` → 空 + `resync:false`；命中 → 其后事件 + `resync:false`；缓冲不存在/未命中/已被挤出 → 空 + `resync:true`）。
4. 新增 `apps/server/src/http/sse.ts`（88 行）：`formatSseEvent`（可选 `id:` 行 → `event:` 行 → **单行** `data:` 行 → `\n\n`）；`writeSseEvent` / `writeSseComment`（经 `reply.raw.write`）；`SSE_HEARTBEAT_MS = 15000` 与 `startHeartbeat`（`setInterval` + `unref?.()`，返回停止函数）；`getSseHeaders()`。文件头注释记录 Fastify 5 的 SSE 用法（`reply.hijack()` + 直写 `reply.raw`，路由属 P9-B）。
5. 新增 `tests/unit/sse-buffer.test.ts`（270 行 / 20 例）：id 全局严格递增、事件字段与 ISO 时间戳（注入时钟）、缓冲上限（`bufferSize:3`/`bufferSize:5` 阈值 + `EVENT_BUFFER_SIZE === 200` 常量）、订阅（顺序/取消幂等/抛异常隔离）、`replay` 四分支、会话隔离（跨会话 id 不命中）、`formatSseEvent` 两种形态、`writeSseEvent`/`writeSseComment`/`startHeartbeat`（假 `FastifyReply` + `vi.useFakeTimers`）/`getSseHeaders`。
6. 新增 `tests/unit/http-errors.test.ts`（143 行 / 11 例）：`ERROR_STATUS` 逐条断言、`describeError` 前缀剥离与回退、`toErrorBody` 三类输入（含"不泄漏原始 message"断言）、`resolveStatusCode`、以及用 `Fastify inject` 验证 `registerErrorHandler`（403 形状 / 500 中性文案 / 404 `NOT_FOUND`）。

受控偏差（P9-A）：

- **SSE 事件 `id` 采用总线内全局单调递增序列号**（`"1"`、`"2"`…），而非 §4.4 字面"等于落库后的主键 id"：主文档 §11 第 619 行明确「**刻意不建 `events` 表**」，不存在"事件行的主键"。改为自增序列以保证严格递增、唯一、可比较，满足 `Last-Event-ID` 续传语义；**未新建 `events` 表、未改任何 schema**。已在 `event-bus.ts` 文件头注释登记。
- 新增两个**非领域**错误码取值 `INTERNAL_ERROR`（500，未预期错误）与 `NOT_FOUND`（404，未注册路由）：§4.5 未列，二者不属于 `VideoForgeErrorCode`、`VideoForgeError` 永不携带，仅作 HTTP 响应体取值（`errors.ts` 常量注释已标注）。
- `QUALITY_BLOCKED` / `EVENT_IMMUTABLE` 在 §4.5 未列，按内核失败归 500（代码注释已标注）。
- `auth-hook.ts` 未配单测：其真实校验路径依赖 `app.jwt`（由 P9-C 的 `registerJwt` 装配），本阶段以类型与契约注释固化；接线后由 P9-B/C 的路由集成测试覆盖（越权/401 用例）。

验证结果（主代理亲自重跑，文件定稿状态）：

- `pnpm exec vitest run tests/unit/sse-buffer.test.ts tests/unit/http-errors.test.ts` → 2 files / 31 tests passed（20 + 11）。
- `pnpm test` → **49 files / 342 tests 全绿**（基线链 … → P8-B 47/311 → P9-A 49/342，全程无回归）。
- `pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → `TSC_EXIT=0`。
- `pnpm build` → `BUILD_EXIT=0`。
- 未接线说明（全部留给 P9-B/P9-C）：路由注册（含 `GET /api/sessions/:id/events` 的 `reply.hijack()` 流）、`registerErrorHandler`/`createAuthPreHandler`/`registerJwt` 在 `app.ts` 的装配、`startServer` 的迁移→admin 初始化→中断恢复→引擎就绪→监听链路、SSE ticket 鉴权（主文档唯一未定项）。

---

**P9-B 执行记录（已完成，2026-10-25）**

改动文件（10 新增 + 2 修改）：

1. 新增 `apps/server/src/http/deps.ts`（28 行）：HTTP 层依赖契约。`ChatPort{ send(actor,sessionId,message):Promise<void>; abort(actor,sessionId):void }`；`HttpDeps{ db; config; rootDir; storageRoot; eventBus; workflow; chat }`。签名冻结，供 P9-C/P9-D 复用与测试注入假实现。
2. 新增 `apps/server/src/http/index.ts`（21 行）：`registerHttpRoutes(app, deps)` = `registerErrorHandler(app)` + 四组路由（auth / capabilities / projects / sessions），逐路由传 `preHandler: createAuthPreHandler(app)`（SSE 路由内部自鉴权，见下）。
3. 新增 `apps/server/src/http/routes/auth.ts`（161 行）：`POST /api/auth/register`（受 `server.allow_registration` 控制；保留名 `admin` 与已占用用户名返回**完全相同**的 403 `AUTH_FORBIDDEN`，不通过错误差异暴露保留名）、`POST /api/auth/login`（先查节流再校验口令，失败与节流同一文案；成功 `clearLoginFailures` + `updateLastLogin` + 签 token）、`POST /api/auth/logout`（no-op）、`GET /api/auth/me`（重新读库取最新 `must_change_password`）、`POST /api/auth/password`（先验当前口令，成功后清强制改密标志）。导出 `PublicUser` / `toPublicUser(user)`（剥离 `password_hash`，供 P9-C 复用）。
4. 新增 `apps/server/src/http/routes/capabilities.ts`（17 行）：`GET /api/capabilities` → `{ capabilities: listCapabilities() }`（`CapabilityView` 已剥离 `paramsSchema`）。
5. 新增 `apps/server/src/http/routes/projects.ts`（183 行）：`GET /api/projects`（列表 + 逐项推导状态）、`POST /api/projects`（能力存在性 → `paramsSchema.safeParse` 结构化校验（**不 import zod**）→ 名额上限 → 建项目 → 自动建会话 → `assertProjectLease` → 建首个 run → `void workflow.run(...)` **非阻塞**触发）、`GET /api/projects/:id`（状态 + 产物索引）、`GET /api/projects/:id/sessions`、`POST /api/projects/:id/sessions`。私有 `deriveStatusForProject` 聚合 `listRuns` + `listRunStages` + `verifyStageArtifact` 后交给纯函数 `deriveProjectStatus`。
6. 新增 `apps/server/src/http/routes/sessions.ts`（135 行）：`POST /api/sessions/:id/messages`（归属校验 → `appendMessage` 落库 → `chat.send`，202）、`POST /api/sessions/:id/abort`、`POST /api/sessions/:id/events-ticket`（Bearer + 归属校验 → 签票据）、`GET /api/sessions/:id/events`（**不挂** `createAuthPreHandler`，处理函数内手工：优先 `Authorization` → 否则 `?ticket=` → 归属校验 → `reply.hijack()` + 写 SSE 头 → `eventBus.replay`（`resync` 先发）→ `subscribe` + `startHeartbeat` → `request.raw.on("close")` 释放）。**鉴权与归属校验全部在 `hijack()` 之前完成**。
7. 新增 `apps/server/src/http/event-ticket.ts`（71 行）：`EVENT_TICKET_TTL_MS = 60_000`、`EVENT_TICKET_SCOPE = "sse"`、`EventTicketPayload{ scope; sid; uid; urole; iat?; exp? }`、`signEventTicket(app, actor, sessionId)`、`verifyEventTicket(app, ticket, sessionId)`（签名/过期/`scope` 不符/`sid` 与会话不符一律 401，且不泄露原因）。
8. 新增 `apps/server/src/http/artifacts.ts`（64 行）：`ArtifactEntry{ stage; label; relativePath; sizeBytes }`、`ArtifactIndex{ finalVideoExists; entries }`、`buildArtifactIndex(projectDir, capability, profile)`（按能力阶段顺序逐阶段 `listStageArtifacts` + `statSync` 取 size，取不到按 0；`finalVideoExists` 用 `verifyStageArtifact` 判 `finalArtifact`）。
9. 新增 `tests/integration/auth-api.test.ts`（312 行 / 9 例）：真 SQLite 临时库 + 真 Fastify（`registerJwt` + `registerHttpRoutes` + 假 workflow/chat）。覆盖注册开关 403、注册成功且响应体不含哈希/明文口令、保留名与重名同错、登录节流（5 次后第 6 次仍 401）、登录成功、`/me` 401/200 与 `must_change_password` 透传、改密（旧口令失效 / 新口令生效）、未知路径 404 `NOT_FOUND`、能力列表剥离 `paramsSchema`。
10. 新增 `tests/integration/sse-events.test.ts`（335 行 / 7 例）：无凭据 401、跨用户 Bearer 403 `AUTH_FORBIDDEN`、`events-ticket` 401/403/200（`expiresInMs=60000`）、票据 `sid` 绑定时 A 票访问 B 会话 401、真实 `listen({port:0})` + `fetch` 读流的快乐路径（含 `id:`/`event:`/`data:` 帧断言，`waitForFrame` 带超时 + `AbortController`）、`Last-Event-ID` 命中补发其后事件、未命中先发 `resync`(`buffer-miss`)。

修改：

11. `apps/server/src/http/auth-hook.ts`（92 → 105 行）：`extractActor` 验签后新增三道加固——`payload.sub` 必须为非空字符串、载荷带 `scope` 即拒绝、`USER_ROLES.includes(payload.role)`。既有错误文案与其余函数未动。
12. `apps/server/src/workflow/breakpoint.ts`（123 → 163 行）：**纯新增**导出 `listStageArtifacts(projectDir, predicate, profile): string[]`（`file` 只判存在返回 `[relativePath]`；`glob` 替换 `<profile>` 后拆目录段/文件名段、`readdirSync` 过滤 `isFile()` 且匹配、返回相对路径并按文件名 `localeCompare` 排序；整体 try/catch，异常 `console.warn` 返回 `[]`）。复用既有私有 `resolveProjectPath` / `globSegmentToRegExp`，**既有函数行为未变**。

受控偏差（P9-B）：

- **SSE 鉴权方式已定夺为「短时票据」**（主文档唯一未定项）：`EventSource` 不支持自定义头，故采用目的域受限票据——独立 JWT（`{scope:"sse", sid, uid, urole}`，TTL 60s），刻意**不与 access token 共用 claim 名**（用 `uid`/`urole` 而非 `sub`/`role`）；配合 `auth-hook` 的 `scope` 拒绝分支形成**双向隔离**（票据不能当 access token，access token 无 `scope`/`sid` 不能当票据）。SSE 路由同时接受 `?ticket=`（EventSource 路径）与 `Authorization: Bearer <access token>`（fetch/测试路径）。已回写 Web 专题 §5.4.5 与 §9。
- **`POST /api/sessions/:id/events-ticket` 为表单外新增路由**：主文档 §4.2 的 21 条用户 API 未列此条，属 SSE 鉴权方案的必要配套（Web 专题 §5.4.5 已建议该路径）。
- **`POST /api/auth/logout` 无鉴权且为 no-op**：§8.1 明确登出仅前端清 token、服务端不做黑名单（无状态 JWT 的已知取舍）。
- **`GET /api/projects/:id` 响应形状为 `{ project: {...project, status}, artifacts }`**：§4.2 未规定字段层级，按「详情 = 项目 + 状态 + 产物索引」聚合。
- **`POST /api/projects` 的校验顺序与非阻塞触发**：能力存在性 → 参数 schema → 名额上限 → 建项目/会话/run → `void workflow.run(...)` 异步触发（`await` 会让 HTTP 长时间挂起），失败仅 `app.log.error`。
- **跨用户一律 `AUTH_FORBIDDEN`**（含「项目/会话不存在」）：§8.3 要求不区分「不存在」与「不属于你」。

验证结果（主代理亲自重跑，文件定稿状态）：

- `pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → `TSC_EXIT=0`。
- `$env:VF_SMOKE="1"; pnpm exec vitest run tests/integration/auth-api.test.ts tests/integration/sse-events.test.ts` → **2 files / 16 tests passed**（9 + 7）。
- `pnpm test` → **49 files / 342 tests 全绿**（与 P9-A 基线完全一致，无回归；新增集成测试不计入默认 `pnpm test`）。
- `pnpm build` → `BUILD_EXIT=0`。
- 未接线说明（全部留给 P9-C/P9-D）：runs/trace/artifacts/media/admin 五组路由（`/api/media/*` 归 P9-C）、`app.ts` 的 `createApp`/`startServer` 重写与真实 `ChatPort`、`workflow.emit → eventBus` 转发、`disposeIdle` 定时器与退出钩子。

---

**P9-C 执行记录（已完成，2026-10-25）**

改动文件（6 新增 + 4 修改，其中 3 个仓储文件为纯追加）：

1. 新增 `apps/server/src/http/routes/runs.ts`：`registerRunRoutes(app, deps)` 注册 6 条 — `GET /api/projects/:id/runs`（先 `getProject` 判归属再列出）、`POST /api/projects/:id/runs`（会话解析 → `assertProjectLease` → `createRun(trigger:"user")` → **非阻塞** `void workflow.run(...).catch(log)` → 201）、`GET /api/runs/:id`（`{run, stages}`）、`POST /api/runs/:id/resume`（`action` 非 `approve|retry` → 400 `CONFIG_INVALID`；取当前 run 快照后非阻塞 `void workflow.resume(...)` → 202）、`POST /api/runs/:id/cancel`（同步 `workflow.cancel` → 200）、`GET /api/runs/:id/trace`（阶段实例不分页；`toolCalls`/`llmCalls` 按 `runId` 过滤后切片分页，`total` 为切片前长度）。私有 `parsePaging(query)`：`limit` 默认 50、范围 1..200，`offset` 默认 0，非法值回落默认。
2. 新增 `apps/server/src/http/routes/artifacts.ts`：`GET /api/projects/:id/artifacts` → `resolveUserProjectDir` → `buildArtifactIndex(projectDir, capability, project.profile)`；能力缺失回落 `{ finalVideoExists:false, entries:[] }`。
3. 新增 `apps/server/src/http/routes/media.ts`：`GET /api/media/*` → 空路径 → `PATH_OUTSIDE_STORAGE`；`resolve(storageRoot, relative)` + `assertInsideUserRoot(storageRoot/users/<userId>, target)`（拒绝 `../` 逃逸与跨用户）+ 前缀必须 `users/<actor.userId>/`；非普通文件 → 404 `NOT_FOUND`（用 `reply.code(404).send` + `NOT_FOUND_CODE`，不经 `VideoForgeError`）；扩展名映射 Content-Type 后 `createReadStream` 流式返回；响应体与日志均不含绝对路径；admin 也只读本人媒体。
4. 新增 `apps/server/src/http/routes/admin.ts`：5 条 §4.3 路由，每条 `preHandler` + 首行 `requireAdmin(requireActor(request))` — `GET /api/admin/users`（经 `toPublicUser` 剥离 `password_hash`）、`POST /api/admin/users/:id/reset-password`（`newPassword` 必填，`hashPassword` → `adminResetPassword`；**不回传新密码**）、`GET /api/admin/projects`、`GET /api/admin/runs?status=&errorCode=`（仅非空字符串入 filter）、`GET /api/admin/runs/:id/trace?limit=&offset=`（形状同用户 trace，走跨用户 admin 仓储）。文件内自带同规则私有 `parsePaging`（避免跨文件导出私有工具）。
5. 新增 `tests/integration/project-run-api.test.ts`（12 例）：run 列表 401/403/200、发起 run 201 且落库且 `workflow.run` 被调用（带超时等待）、已有活跃 run → 409 `PROJECT_BUSY`、run 详情 200/跨用户 403、resume 非法 action 400 与合法 202、cancel 403/200、trace 分页（默认 50、`limit=1&offset=1` 切片、`limit=abc` 回落）、artifacts 200（空目录 `finalVideoExists=false`）/跨用户 403、media 越界 403 / 跨用户 403 / 缺失 404 / 真实文本文件 200 且 `content-type` 为 `text/plain`。
6. 新增 `tests/integration/admin-api.test.ts`（9 例）：5 条 `/api/admin/*` 普通用户 403；admin 用户列表 200 且响应体不含 `password_hash`/明文口令；重置密码 200 且目标用户 `must_change_password=true`、不存在用户 400；`?status=running` 过滤只返回该状态。

修改：

7. `apps/server/src/http/index.ts`：追加 `registerRunRoutes` / `registerArtifactRoutes` / `registerMediaRoutes` / `registerAdminRoutes` 四组注册，注释更新为「P9-C 已追加」。
8. `apps/server/src/db/repositories/run-repository.ts`（纯追加）：`adminGetRun(db, actor, runId)`（复用既有私有 `assertAdmin` + `toRun`，按 id 直查不过滤 `user_id`）。
9. `apps/server/src/db/repositories/run-stage-repository.ts`（纯追加）：私有 `assertAdmin(actor)` + `adminListRunStages(db, actor, runId)`（复用 `toRunStage` 与 `PIPELINE_STAGES` 排序）。
10. `apps/server/src/db/repositories/trace-repository.ts`（纯追加）：私有 `assertAdmin(actor)` + `adminListToolCalls(...)` / `adminListLlmCalls(...)`（复用 `toToolCall`/`toLlmCall`/`TraceFilter`）。**既有函数签名与行为零改动；未改 schema、未加迁移、未加依赖。**

受控偏差（P9-C）：

- **trace 分页参数 `limit`/`offset` 为文档未规定的自定值**：默认 `limit=50`、上限 200、`offset>=0`；以代码常量落地、**不进配置**（避免为只读查询引入配置面）。
- **`POST /api/projects/:id/runs` 的会话选择规则**：`sessionId` 可显式传入（须属于该项目）；缺省取该项目**最新会话**（`created_at` 降序第一条）；无任何会话 → 400 `CONFIG_INVALID`。
- **`/api/media/*` 的错误码语义**：路径越界/跨用户 → 403 `PATH_OUTSIDE_STORAGE`（依本计划 Phase 9 要点；§8.3 的「跨用户统一 `AUTH_FORBIDDEN`」是同状态码不同错误码，此处取 `PATH_OUTSIDE_STORAGE` 以表达文件层语义）；文件不存在/非普通文件 → 404 `NOT_FOUND`（非 `VideoForgeErrorCode`，直接用 `reply.send` + `NOT_FOUND_CODE`）。
- **admin trace 需新增跨用户仓储函数**：既有 `listRunStages`/`listToolCalls`/`listLlmCalls` 均为 actor-first，无法跨用户；故纯追加 `adminGetRun` / `adminListRunStages` / `adminListToolCalls` / `adminListLlmCalls`（均以私有 `assertAdmin` 守卫），admin 仍是唯一跨用户只读通道。
- **media 归属校验用 `resolve(deps.storageRoot, relative)` + `assertInsideUserRoot(userRoot, target)`**（而非 `resolve(userRoot, relative)`）：因相对路径本身以 `users/<userId>/` 开头，两者等价；再叠加 `users/<actor.userId>/` 前缀校验形成双保险，`assertInsideUserRoot` 始终是唯一安全判定，无字符串拼接。
- **`admin.ts` 内自带一份同规则私有 `parsePaging`**：不跨文件导出私有工具，保持路由文件低耦合（非逻辑分歧）。

验证结果（主代理亲自重跑，文件定稿状态）：

- `pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → `TSC_EXIT=0`。
- `$env:VF_SMOKE="1"; pnpm exec vitest run tests/integration/project-run-api.test.ts tests/integration/admin-api.test.ts` → **2 files / 21 tests passed**（12 + 9）。
- `pnpm test` → **49 files / 342 tests 全绿**（与 P9-B 基线完全一致，无回归）。
- `pnpm build` → `BUILD_EXIT=0`。
- 未接线说明（全部留给 P9-D）：`app.ts` 的 `createApp`/`startServer` 重写与真实 `ChatPort` 实现、`workflow.emit → eventBus` 转发、启动编排（迁移 → admin 初始化 → 中断恢复 → 引擎就绪 → `listen`）与 `disposeIdle`/进程退出钩子。

**P9-D 执行记录（已完成，2026-10-25）**

改动文件清单：

1. `apps/server/src/app.ts`（**重写**，492 行）：删除全部旧占位实现（`MEDIA_TYPES`、`registerWorkspaceRoutes`、假 `POST /api/projects`、假 `/api/events/stream`、三个 `/api/tts/*` 路由与 `createVoiceService` 接线）。新增：
   - `CreateAppOptions{ deps; jwtSecret; logging? }` 与异步 `createApp(options): Promise<FastifyInstance>`，装配顺序为「结构化脱敏日志 → `registerJwt` → `/health` → `registerHttpRoutes`」（`registerJwt` 必须先于路由，`auth-hook`/`event-ticket` 依赖 `app.jwt`）。
   - 私有 `createChatPort({ sessions, eventBus })`：`send` 先订阅 Pi 事件再 `prompt(text, isStreaming ? { streamingBehavior: "followUp" } : undefined)`，`finally` 退订 + `touch`；事件映射 `message_update/text_delta → text_delta{text}`、`tool_execution_start → tool_start{toolCallId, tool, args}`、`tool_execution_end → tool_end{toolCallId, ok, durationMs}`、`turn_end → turn_end{message}`；`abort` 对不存在/非本人会话静默返回，失败仅 `console.warn`。
   - 私有 `createStageExecutor({ db, sessions })`：`getOrCreate → prompt(request.instruction) → 回报 { ok: true, artifactPaths }`；异常收口 `{ ok:false, errorCode:"TOOL_UNAVAILABLE" }`。**不重复落库指令**（引擎已在 `stage_started` 前 `appendMessage(role:"system")`），**不改写达标判定**（由引擎 `verifyStageArtifact` 裁决）。产物清单经 `getProject → getCapability → capability.stages.find → listStageArtifacts` 解析。
   - 私有 `forwardWorkflowEvent(eventBus, event)`：8 种引擎事件 → §4.4 的 `run_start`/`run_stage`/`review_gate`/`run_end`，全部发布到 `event.sessionId`。
   - 重写 `startServer({ rootDir?, configOverride? })`：19 步编排 = 根目录 → 配置 → `loadJwtSecret`（快速失败，不打印） → `mkdir` → 迁移+开库 → 幂等 `closeDatabase` → `ensureAdminUser` → `recoverInterruptedRuns` → `createEventBus` → 按 actor 缓存的 `traceForActor` → `createAgentRuntime`（传 `traceForActor`，**不传全局 `trace`**） → `createStageExecutor` → `createWorkflowEngine({ emit })` → `createChatPort` → `HttpDeps` → `createApp` → 就绪日志（provider/model/并发上限/恢复条数/adminCreated，**无密钥**） → `setInterval(disposeIdle, 60_000).unref()` → `onClose`（清定时器 + `disposeAll` + 关库） → `listen({ host: "127.0.0.1" })`；末尾保留直接运行入口 + SIGINT/SIGTERM 优雅退出。
2. `apps/server/src/agent/session-registry.ts`（**最小修改**）：`AgentSessionRegistryOptions` 新增可选 `traceForActor?: (actor: Actor) => TraceStore`；`getOrCreate` 组装 `customTools` 前计算 `resolvedTrace = traceForActor ? traceForActor(actor) : trace` 并替换内置工具的 `trace`。理由：`createTraceStore` 创建时绑定单个 actor，而注册表是进程级单例，整表复用一份 store 会在多用户场景跨用户串写 trace（违反 §8.3 文件/事件层隔离）。
3. `apps/server/src/agent/runtime.ts`（**最小修改**）：`CreateAgentRuntimeOptions` 声明同名可选 `traceForActor`（靠既有 `...options` 透传给会话注册表）。
4. `tests/unit/workspace-api.test.ts`（**删除**）：3 个用例全部测本阶段必然移除的旧 `/api/workspaces` 与旧 `/api/media/*`（越界期望 400、`workspace/w1/images/s1.png` 期望 200），且位于默认 `pnpm test` 范围内。

受控偏差（P9-D）：

- **删除 `tests/unit/workspace-api.test.ts` 提前于计划 Phase 12**：其原因是被测路由与语义在本阶段被必然移除（P9-C 的 `/api/media/*` 已改为要求 `users/<uid>/...` 前缀且越界返回 403），不删则无法满足 Step 6 的「`pnpm test` 全绿」。影响面：默认单测由 49 files/342 tests 变为 48 files/339 tests。后续无遗留（旧路由已彻底移除）。
- **移除全部旧占位路由与 `/api/tts/*` voice 路由接线**：新 HTTP 层（`registerHttpRoutes`）已按 §4.2/§4.3 覆盖全部契约路由且不含任何 `/api/tts/*`；`voice-service.ts` 本次**只解除接线、文件保留**（`@deprecated 待 P12 删除`），因此 `packages/pipeline/src/config.ts` 中 `python.*` 与 `engines.tts_voice_default` 的 deprecated 字段**仍需保留**至 P12。
- **`run_start` 不下发 `fromStage`**：§4.4 要求 `{ runId, trigger, fromStage }`，但引擎 `run_started` 事件不携带断点信息（`startIndex` 只存在于引擎内部）。前端可从随后的 `run_stage` 序列顺序推断；如需精确值，应由引擎在 `run_started` 补充，属后续阶段。
- **`review_gate.summary` 由 `artifactPaths` 派生**：§4.4 要求 `{ runId, stage, summary }`，引擎 payload 只给 `{ artifactPaths }`；本次以「有产物则 `artifactPaths.join("、")`，无产物则固定文案『阶段产物已就绪，等待确认』」派生，非自然语言摘要。
- **LLM 全文留痕 `traceContext` 缺口保持现状（不新增偏差、也不新增能力）**：`runtime.ts` 仍只接受单一 `trace`，`provider.ts` 遇「有 trace 无 traceContext」时 `console.warn` 并跳过 `llm_calls`；本次 `startServer` 因按 actor 缓存而**不向 `createArkModelRuntime` 传 trace**，故生产环境 `llm_calls` 暂为空，与 §344 行登记的 P7 缺口一致，收口方案为「按会话构造 provider」。
- **`startServer` 初始化失败路径只保证 `closeDatabase()`**（不调 `runtime.sessions.disposeAll()`）：进程即将退出，会话内存态随进程回收；`onClose` 钩子仍覆盖正常关停路径。
- **`tool_start`/`tool_end` 不携带 `errorCode`**：Pi SDK 公共类型无该字段（仅 `isError`），不臆造；`tool_end` 只回报 `{ toolCallId, ok, durationMs }`。

验证结果（主代理亲自重跑，文件定稿状态）：

- `pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → `TSC_EXIT=0`。
- `$env:VF_SMOKE="1"; pnpm exec vitest run tests/integration/auth-api.test.ts tests/integration/sse-events.test.ts tests/integration/project-run-api.test.ts tests/integration/admin-api.test.ts` → **4 files / 37 tests passed**。
- `pnpm test` → **48 files / 339 tests 全绿**（基线 49/342 减去 `workspace-api.test.ts` 的 1 file/3 tests，无其他回归）。
- `pnpm build` → `BUILD_EXIT=0`。
- `pnpm run server:dev` 冷启动探活（临时注入 ≥32 位随机 `JWT_SECRET`，**未写入任何文件**）→ `GET /health` 返回 `200 {"status":"ok","service":"videoforge-server"}`；启动日志可见 `[ark-provider] 已注册 provider=ark model=kimi-k3`、`{"modelProvider":"ark","model":"kimi-k3","maxConcurrentStage":1,"recoveredRuns":0,"adminCreated":false,"msg":"agent 运行时与工作流引擎已就绪"}`、`Server listening at http://127.0.0.1:3000`；**日志中无任何密钥明文**；探活后已终止进程并复核 3000 端口空闲。
- 未接线说明（全部留给 P10/P11/P12）：CLI 运维入口改造（P10）、Web 工作台（P11）、旧领域删除与文档同步（P12）；`apps/server` 类型检查仍只能走 `tsc -p apps/server/tsconfig.json --noEmit`（无 build 脚本）。

---

### Phase 9：HTTP 路由 + SSE + 启动编排

**目标**：按主文档 §4.2/§4.3/§4.4 提供全部 REST/SSE；`startServer` 完成迁移 → admin 初始化 → 中断恢复 → 引擎就绪 → 监听 `127.0.0.1`。

**Files:**

- Create: `apps/server/src/http/{errors.ts,auth-hook.ts,routes/{auth,capabilities,projects,sessions,runs,trace,artifacts,media,admin}.ts,sse.ts,event-bus.ts,artifacts.ts}`
- Modify: `apps/server/src/app.ts`（重写 `createApp` / `startServer`）
- Test: `tests/integration/{auth-api,project-run-api,sse-events,admin-api}.test.ts`、`tests/unit/sse-buffer.test.ts`

**要点：**

- 路由与路径**逐条**照 §4.2/§4.3；HTTP 错误体 `{error:{code,message}}`；鉴权失败 401 `AUTH_INVALID`，越权 403 `AUTH_FORBIDDEN`（**不区分"不存在"与"不属于你"**）。
- `auth-hook.ts`：解析 Bearer → `actor:{userId,role}` 传给 handler；`src/agent`/`src/workflow` 只接受 actor，不传令牌、不做二次鉴权（§8.1 内部信任边界）。
- 路由需在 `src/http/routes/*` 中显式命名将要暴露的接口——`/api/admin/*` 全部走 `admin*` 仓储方法；普通路由**无任何**跨用户路径。
- `event-bus.ts`：每会话最近 200 条已落库事件的内存环形缓冲，事件 `id` = 落库主键；`Last-Event-ID` 命中则补发，超出缓冲先发 `resync`；事件类型与载荷照 §4.4。
- ~~SSE 鉴权（主文档未定的**唯一未定项**）：优先 `POST /api/sessions/:id/events-ticket` 签发短时 ticket；未实现则退化为查询参数 `?token=`，**必须在安全备注与本计划结论中登记**，并回写 Web 专题 5.4.5。~~ **✅ 已定夺（P9-B）**：采用 `POST /api/sessions/:id/events-ticket` 签发**短时票据**（独立 JWT，`{scope:"sse", sid, uid, urole}`，TTL 60s），**不采用** `?token=` 退化方案；已回写 Web 专题 §5.4.5 与 §9。
- `/api/media/*` 只接受 `users/<当前 userId>/...` 相对路径，先校验归属再读（admin 也只读自己媒体）；越界 403 `PATH_OUTSIDE_STORAGE`。
- `startServer`：校验 `JWT_SECRET` → 加载配置 → 迁移 → `ensureAdminUser` → 中断恢复 → 引擎与 agent 就绪日志（可见模型 provider 与工作流引擎）→ `listen({ host: "127.0.0.1" })`。
- 集成测试用 **mock provider + mock 内核**：登录 → 建项目 → 自动首个 run → 收到 SSE 阶段事件 → 审核点暂停 → resume → 产物落盘。
- SSE 重连测试：`Last-Event-ID` 命中缓冲补发 / 超缓冲下发 `resync`。

- [x] **Step 1:** 事件总线与缓冲测试 ✅（P9-A）
- [x] **Step 2:** auth/capabilities/projects/sessions 路由 + 集成测试 ✅（P9-B；SSE 鉴权定夺为短时票据 `POST /api/sessions/:id/events-ticket`）
- [x] **Step 3:** runs/trace/artifacts/media 路由 ✅（P9-C）
- [x] **Step 4:** admin 路由与越权测试 ✅（P9-C）
- [x] **Step 5:** 重写 `app.ts` 与启动编排（P9-D）✅
- [x] **Step 6:** `pnpm test` 全绿 + `pnpm run server:dev` 冷启动探活成功（P9-D）✅（`pnpm test` 48 files/339 tests；`/health` 返回 200 `{"status":"ok","service":"videoforge-server"}`）

---

### Phase 10：CLI 运维入口改造

**目标**：`apps/cli` 只保留运维入口，彻底移除 7 个流水线命令。

**Files:**

- Modify: `apps/cli/src/index.ts`（命令分发：`doctor`/`status`/`db:migrate`/`db:user`/`storage:prune`/`project:verify`；未知命令报错退出码 2）
- Modify: `apps/cli/src/doctor.ts`（移除 Python 校验，新增 `chat_model` 占位、`ARK_API_KEY` 存在、`base_url` 误改校验）
- Create: `apps/cli/src/{status.ts,db-user.ts,db-migrate.ts,storage-prune.ts,project-verify.ts}`
- Delete: `apps/cli/src/video-commands.ts`、`tests/unit/cli-video-commands.test.ts`（先确认无引用）
- Test: `tests/unit/cli-{doctor,status,project-verify,db-user}.test.ts`

**要点（主文档 §3.5）：**

- CLI 与流水线**解耦**：不写 `messages`/`runs`/`tool_calls`，不依赖 server 在线（`status` 在 server 不可用时降级提示，**不报错退出**）。
- `status`：探活 `/health`，输出端口占用、`storage_root`、磁盘可用量、DB 路径与体积、活跃 run/会话数。
- `db:user`：列出用户；`--create <username> [--role admin]`（注册关闭时建号）；`--reset-password <username>`（置随机口令 + `must_change_password=1`，stdout 输出新口令一次，**不写库明文**）。
- `storage:prune <项目>`：清理帧序列/临时音轨，保留 `copy.json`/`images/`/`audio/`/`timeline.json`/`final.mp4`；需显式确认参数。
- `project:verify <项目>`：只读体检（契约文件齐全性、`timeline.json` 与成片时长一致性判定）。
- 契约不变：stdout 一行 JSON，诊断走 stderr，错误码 `VideoForgeError` 原样透传。

- [x] **Step 1:** 改造 `doctor` + 测试 → **Step 2:** `status`（含降级）→ **Step 3:** `db:migrate`/`db:user` → **Step 4:** `storage:prune`/`project:verify` → **Step 5:** 删流水线命令与测试，确认无引用 → **Step 6:** `pnpm test` 全绿 ✅（P10；`pnpm test` 51 files/346 tests）

**P10 执行记录（已完成，2026-10-25）**

改动文件清单：

1. `apps/cli/src/index.ts`（**修改**，70 行）：文件头注释登记 CLI 定位（主文档 §3.5）；删除 `video-commands.ts` 全部 import 与 7 个流水线 handler；`handlers` 收敛为 `status`/`db:migrate`/`db:user`/`storage:prune`/`project:verify` 五项，`doctor` 单独分支；未知命令文案列出 6 个可用命令并 `process.exitCode = 2`；保留 stdout 只承载一行 JSON、`toErrorPayload` 保 `VideoForgeError` 原码、失败退出码 1。
2. `apps/cli/src/doctor.ts`（**修改**，124 行）：常量 `ARK_PLAN_BASE_URL`、`PLACEHOLDER_CHAT_MODEL`；新增纯函数 `evaluateConfigChecks({ config, env })` 四项 —— `ark.chat_model` 为占位值、`ARK_API_KEY` 去空格为空、`ark.base_url !== https://ark.cn-beijing.volces.com/api/plan/v3`（提示改为 `/api/v3` 会产生额外费用）、`storage_root` 为空；`runDoctor` 改为合并 `validateEnvironment` 结果（过滤 `python` 项）+ 配置体检，全部诊断走 stderr，不写 stdout。
3. `apps/cli/src/status.ts`（**新建**，186 行）：`buildStatusReport(rootDir, deps)` 输出 `{ serverOnline, port, portInUse, storageRoot, freeDiskGb, dbPath, dbSizeBytes, activity, hints }`；默认实现含 `fetch /health`（2s 超时）、TCP 端口探测、`statfsSync` 磁盘可用量、SQLite 活跃 run（`queued|running|waiting_review`）与会话计数（DB 不存在时返回 `null` **不创建文件**，异常 warn 后降级）；`runStatus` 无任何非 0 退出。
4. `apps/cli/src/db-migrate.ts`（**新建**，22 行）：`loadSystemConfig` → 解析 `<storage_root>/videoforge.db` → `mkdirSync` → `migrateDatabase` → stdout `{ dbPath, migrated: true }`。
5. `apps/cli/src/db-user.ts`（**新建**，161 行）：固定 `CLI_ADMIN_ACTOR = { userId: "cli", role: "admin" }`；`generateRandomPassword`（base64url，字节 6..96 保护，默认 18B）；`--create`/`--reset-password` 互斥报 `CONFIG_INVALID`；列出不含 `password_hash`；`--create admin` 报 `AUTH_FORBIDDEN`（保留用户名）；新口令一次性 stdout，库中只存哈希。
6. `apps/cli/src/storage-prune.ts`（**新建**，123 行）：`--project <名>` 定位项目（`adminListProjects`，同名跨用户多命中拒绝）；`--yes` 之外一律 `CONFIG_INVALID` 拒绝；写入前 `assertInsideUserRoot` 复核；仅删 `build/`（帧序列），保留 `copy.json`/`images/`/`scenes/`/`audio/`/`timeline.json`/`final.mp4`；输出 `freedBytes`/`freedMb`。
7. `apps/cli/src/project-verify.ts`（**新建**，203 行）：`verifyProjectArtifacts({ projectDir, declaration, profile, ffprobePath, probe? })` 逐阶段校验能力声明产物 → 读取 `timeline.json` 的 `totalMs` → `probe` 成片时长并判定 `|delta| <= TIMELINE_TOLERANCE_MS(1500)`；`runProjectVerify` 从 `getCapability` 取声明、`config.tools.ffprobe_path` 取探针路径，stdout 一行 JSON。
8. `apps/cli/src/video-commands.ts`（**删除**，原 148 行）：7 个流水线命令薄封装及其 `parseProfile`/`parseBoolFlag`。
9. `tests/unit/cli-video-commands.test.ts`（**删除**，原 367 行 / 16 用例）：随被测模块移除。
10. `tests/unit/cli-doctor.test.ts`（**新建**，4 用例）：覆盖 `chat_model` 占位 / `ARK_API_KEY` 缺失 / `base_url` 误改 / `storage_root` 空四类 FAIL/PASS。
11. `tests/unit/cli-status.test.ts`（**新建**，4 用例）：全依赖注入（不打真网络/磁盘），覆盖在线 hints 为空、离线降级、`activity === null` 提示 `db:migrate`、端口占用提示。
12. `tests/unit/cli-project-verify.test.ts`（**新建**，4 用例）：造临时项目产物，覆盖容差内 `true`、9000ms 偏差 `false` + hint、缺 `timeline.json` → `consistent: null`、`probe` 抛错降级不失败。
13. `tests/unit/cli-db-user.test.ts`（**新建**，10 用例）：真 SQLite 临时库，覆盖列出无 `password_hash`、`--create` 一次性口令 + `must_change_password=1` + `verifyPassword` 可校验、`--role admin`、`--create admin` → `AUTH_FORBIDDEN`、`--reset-password`、目标不存在 → `CONFIG_INVALID`、`--create`/`--reset-password` 互斥、`generateRandomPassword` 长度与上下界保护。

受控偏差（P10）：

- **`storage:prune`/`project:verify` 用 `--project <名>` 标志替代位置参数**：`apps/cli/src/args.ts` 的 `parseArgs` 只解析 `--key value`（不支持位置参数）；为不改动公共解析器，主文档 §3.5 中的 `<项目>` 改为 `--project <项目>`。
- **CLI 使用固定 admin actor**：CLI 无 HTTP 鉴权上下文，仓储 `admin*` 方法只校验 `role === 'admin'`，故以 `CLI_ADMIN_ACTOR = { userId: "cli", role: "admin" }` 调用；不写入任何 `messages`/`runs`/`tool_calls`。
- **`storage:prune` 删除范围限定 `build/`**：主文档提「清理帧序列/临时音轨」，本次仅删能力声明产物中的 render 帧目录 `build/`；`audio/*.mp3` 属正式产物（应保留），故不纳入清理。
- **同名跨用户多命中一律拒绝**：CLI 无当前用户上下文，`--project <名>` 命中多条（不同用户下同名）时直接报 `CONFIG_INVALID`，要求人工确认，避免误删他人项目。
- **`generateRandomPassword` 增加字节上下界保护（6..96）**：避免调用方传入 0/负数或过大值；默认 18 字节 → 24 字符 base64url，满足 §8.1 的 8..128 口令长度要求。
- **`project:verify` 的 `final` 恒返回对象**：任务书措辞为 `{...} | null`，实现为缺成片时 `{ exists: false, timelineMs, videoMs, deltaMs, consistent: null }`；语义仍满足「缺 `timeline.json` → `consistent === null`」，且前端消费无需判空。
- **`apps/cli/package.json` 的 `@videoforge/renderer`/`@videoforge/template-sdk` 依赖暂留**：这两个依赖随流水线命令移除后已无引用，但清理归属 Phase 12（旧领域删除），本阶段不顺手改。

验证结果（主代理亲自重跑，文件定稿状态）：

- `pnpm exec tsc -p apps/cli/tsconfig.json --noEmit` → `TSC_CLI_EXIT=0`。
- `pnpm exec vitest run tests/unit/cli-{doctor,status,project-verify,db-user}.test.ts` → **4 files / 22 tests passed**（Duration 962ms）。
- `pnpm test` → **51 files / 346 tests passed**（Duration 4.17s）。
- `pnpm build` → `BUILD_EXIT=0`（web dist 111.58 kB；shared/template-sdk/pipeline/renderer 四包 Done）。
- `pnpm --filter @videoforge/cli start status` → `STATUS_EXIT=0`，一行 JSON：`{"serverOnline":false,"port":3000,"portInUse":false,"storageRoot":"D:/videoforge-storage","freeDiskGb":403.33,"dbPath":"D:\\videoforge-storage\\videoforge.db","dbSizeBytes":413696,"activity":{"activeRuns":0,"sessions":0},"hints":["本机 server 未运行（/health 探活失败）：请先执行 pnpm run server:dev"]}`（server 离线 → 降级提示且退出码 0）。
- `pnpm --filter @videoforge/cli start db:user` → `DBUSER_EXIT=0`，`{"users":[{"id":"ac41e5a0-…","username":"admin","role":"admin","mustChangePassword":true,"createdAt":"2026-10-25T15:34:40.108Z","lastLoginAt":null}]}`（含 admin、不含 `password_hash`）。
- `pnpm --filter @videoforge/cli start copy:gen …`（已删除命令）→ `UNKNOWN_EXIT=2` + 未知命令提示（未知命令分支符合预期）。

遗留（交给 P12）：

- `apps/cli/package.json` 中 `@videoforge/renderer`、`@videoforge/template-sdk` 依赖已无引用，随旧领域一并清理。
- `db:migrate` 已在开发机创建真实 `D:\videoforge-storage\videoforge.db`，属本机副作用。

---

### Phase 11：Web 工作台（Ant Design Vue）

**目标**：按 Web 专题第 3-7 章重建 `apps/web`：路由、布局、七个页面、Pinia store、SSE 接入。**严格照 Web 专题，不自行发挥布局与文案。**

**Files:**

- Modify: `apps/web/package.json`、`apps/web/src/main.ts`（Ant Design Vue 全量注册 + `ConfigProvider` zhCN + theme token）
- Rewrite: `apps/web/src/router.ts`（登录守卫、`mustChangePassword` 强制 `/settings?force=1`、admin 守卫）
- Create: `apps/web/src/layouts/{AppLayout.vue}`、`apps/web/src/components/{StateTag.vue,StageSteps.vue,CapabilityCard.vue,NewProjectModal.vue,ToolCallCard.vue,ReviewCard.vue,MessageBubble.vue,ArtifactTabs.vue}`
- Create: `apps/web/src/views/{LoginView,CapabilitiesView,ProjectsView,WorkbenchView,RunTraceView,AdminView,SettingsView}.vue`
- Modify: `apps/web/src/services/api.ts`（axios/fetch 封装 + 401 拦截 + 错误码模板"操作失败：{message}（{code}）"）、`apps/web/src/services/sse.ts`（`Last-Event-ID`/`resync`/断线 3 次 Alert）
- Create: `apps/web/src/stores/{auth,capabilities,projects,workbench,trace,admin}.ts`
- Delete: `apps/web/src/stores/builds.ts`、旧视图（`BuildDetailView`/`ReviewView`/`TraceView`/`VoicesView`/`ProjectsView`(旧)/`Workspace*`），P12 统一核对残留
- Test: `tests/unit/web-{state-map,review-card,sse-reducer,router-guard}.test.ts`

**要点（Web 专题 §2-§8，逐条对齐）：**

- 状态色映射以 Web 专题 §2.3 为**唯一权威表**（项目 5 态 / run 6 态 / 阶段 5 态，含 `INTERRUPTED` Tooltip、`skipped` 虚线 + Tooltip）。
- SSE 事件 → UI 映射以 §7.2 为唯一权威；**前端不推导状态机**，仅渲染服务端字段。
- 关键交互：审核卡片（`通过，继续` / `重跑此阶段` + feedback）→ `POST /api/runs/:id/resume`；工具卡片折叠与产物定位；产物面板六 Tab；trace 页双栏与分页；admin 三只读 Tab + 重置密码（不回显明文）。
- 响应式：<768px 侧边栏抽屉；工作台 <900px 转 Tab；无障碍（键盘可达、`focus-visible`、`aria-live="polite"`、`prefers-reduced-motion` 关动画）；文案全站简体中文。
- **不引入除 `ant-design-vue` / `@ant-design/icons-vue` 外的其他 UI 依赖**（Web 专题 §2.1）。
- 验证：组件级 Vitest（状态映射、审核卡片交互、SSE reducer）+ `pnpm --filter @videoforge/web build` + 浏览器检查桌面与约 390px 窄屏关键页（用 webapp-testing 或 agent-browser，`pnpm run web:dev` + `pnpm run server:dev`）。

- [x] **Step 1:** 依赖与 `main.ts` 主题/语言接入 → **Step 2:** router + 守卫 + stores + services（含单测）→ **Step 3:** 登录/能力中心/项目列表 → **Step 4:** 工作台（核心页）→ **Step 5:** trace / admin / settings → **Step 6:** build + 浏览器桌面/390px 验证

**执行记录（P11 ✅，2026-10-26 收口）**

改动文件清单：

- **P11-A（Step 1–3：基座 + 路由守卫 + 前三个页面）**
  - Modify: `apps/web/package.json`（+ `ant-design-vue@^4`、`@ant-design/icons-vue`）、`apps/web/src/main.ts`（全量注册 Ant Design Vue + `ConfigProvider :locale="zhCN" :theme` token）、`apps/web/src/App.vue`、`apps/web/src/styles/global.css`
  - Rewrite/Create: `apps/web/src/router.ts`（8 条路由，工作台页 `meta:{layout:"workbench"}`、admin 页 `meta:{requiresAdmin:true}`）、`apps/web/src/router-guard.ts`（纯函数 `resolveNavigation`）
  - Create: `apps/web/src/services/api.ts`（相对路径请求 + 401 清 token 跳登录 + 错误码模板「操作失败：{message}（{code}）」）、`apps/web/src/services/sse.ts`（`Last-Event-ID`/`resync`/断线重连）
  - Create: `apps/web/src/stores/{auth,capabilities,projects}.ts`、`apps/web/src/layouts/AppLayout.vue`、`apps/web/src/components/{StateTag.vue,CapabilityCard.vue}`、`apps/web/src/views/{LoginView,CapabilitiesView,ProjectsView}.vue`
  - Test: `tests/unit/web-router-guard.test.ts`
  - Delete: 旧 Web 视图与 `apps/web/src/stores/builds.ts`（P12 统一核对残留）
- **P11-B（Step 4–5：工作台 + trace/admin/settings）**
  - Create: `apps/web/src/stores/{workbench,workbench-reducer,trace,admin}.ts`、`apps/web/src/components/{StageSteps.vue,NewProjectModal.vue,ToolCallCard.vue,ReviewCard.vue,MessageBubble.vue,ArtifactTabs.vue,state-mapping.ts,format.ts,markdown-lite.ts,media-url.ts,review-logic.ts}`、`apps/web/src/views/{WorkbenchView,RunTraceView,AdminView,SettingsView}.vue`
  - Modify: `apps/web/src/views/ProjectsView.vue`（接入新建项目 Modal）
  - Test: `tests/unit/web-{state-map,review-card,sse-reducer,workbench-reducer}.test.ts`（+ 既有 `web-vite-config.test.ts`）
- **P11 收口闸门修复**
  - Modify: `apps/web/src/views/RunTraceView.vue`（见下「受控偏差」第 3 条）

验证结果（实际输出）：

- `pnpm test` → **54 files / 401 tests passed**（Duration 4.16s）。
- `pnpm --filter @videoforge/web build` → `BUILD_EXIT=0`（v7.3.6，3252 modules transformed；`dist/index.html` 0.36 kB、`index-*.css` 18.41 kB / gzip 4.74 kB、`index-*.js` 1620.41 kB / gzip 503.14 kB）。
- 浏览器实测（`JWT_SECRET=<本地开发密钥> pnpm run server:dev` + `pnpm run web:dev`，Playwright 驱动）：
  - **桌面 1440×900**：`/login` 登录/注册双 Tab 正常；admin 首登**强制跳 `/settings?force=1`** 并提示「首次登录请先修改初始密码 / 修改成功前，其他页面暂不可访问」；侧边栏 208px（菜单：能力中心 / 项目 / 管理）、顶栏 48px。
  - **注册 → 自动登录 → `/projects`**；**新建项目**两步 Modal（选择能力「短视频生成」→ 名称/主题/风格/输出 Profile「横屏 1080p（landscape-1080p）」）→ 跳 `/projects/:id` 工作台。
  - **工作台**：页头显示项目名 / 能力 Tag / 项目状态 Tag / run 状态 Tag + `发起 run`/`取消 run`/`查看 Trace`；阶段进度 1 文案「运行中」（含「第 1 次尝试 / 耗时」）、2–7「待执行」；产物面板六 Tab（文案/图片/场景/音频/时间轴/成片）空态「该产物尚未生成」；对话流空态文案正确。
  - **窄屏 390×844**：侧边栏消失，顶栏出现 `aria-label="打开导航"` 按钮 → 打开 `a-drawer`；工作台转顶部 Tab `对话/进度/产物`（`.wb-stages` 显示七阶段，`.wb-chat` 隐藏）；`matchMedia` 768/900 断点行为符合 Web 专题。
  - **取消 run**：`Popconfirm` 文案「确定取消当前运行？」+「继续等待 / 取消运行」，确认后 run 状态变「已取消」。
  - **管理视图 `/admin`**：三 Tab `用户/项目/Runs`；用户表 admin 与普通用户分列、每行「重置密码」；Runs 表 `Trace` 按钮 → `/runs/:id/trace?admin=1`，「← 返回」回 `/admin`。
  - **trace 页**：步骤条 7 行且序号正确、选中态高亮，右侧 `工具调用 / LLM 调用 / 事件` 三 Tab。
  - **改密**：`/settings` 提交成功后跳 `/projects`。

受控偏差（均已登记，不跨阶段顺手重构）：

1. **SSE `error` 事件与 HTTP 错误码同名冲突**：主代理在 P11-B 评审时发现前端曾把 SSE `error` 帧误当请求失败处理，已改为按 Web 专题 §7.2 映射（`error` 帧只渲染为运行错误提示，不触发登出/跳转）。
2. **新建项目 Modal 的输出 Profile 为前端固定两项**：服务端本期未提供 Profile 列表接口，Modal 内已显式标注「选项来源：前端固定两项（服务端暂未提供 Profile 列表接口）」，符合 Web 专题 §1.2「后端契约未提供的数据一律不展示/不虚构」。
3. **trace 页阶段未按七阶段折叠（本阶段真实缺陷，已修复）**：服务端 `run_stages` 为**追加式多行**（同一阶段每次重试一行，实测该 run 的 `copy` 有 a0/a1/a2 三行），原 `RunTraceView.vue` 直接 `trace.stages.map(...)` 渲染，导致步骤条出现 9 行、序号错乱（1,1,1,4,5,…），违反 Web 专题 §5.5「左：`Steps` 竖排七阶段」。已改用 `toStageProgress(trace.stages)` 折叠为七阶段，并新增 `stageInstanceIds`/`selectedStageIds` 使右侧明细按「阶段名」聚合该阶段全部重试尝试；修复后浏览器 reload 验证 `stepCount: 7` 且序号正确。
4. **契约层缺口登记（P11-B 子代理发现，未修，属后端范畴）**：①「事件」Tab 无对应后端查询路由（服务端未提供 trace 事件列表接口），页面渲染 `a-empty`；② `GET /api/admin/projects` 不做 `deriveStatusForProject`，admin 项目列表状态恒为库内「草稿」；③ trace 工具/LLM 调用按 `stage_id` 过滤依赖 `tool_calls`/`llm_calls` 的 `stage_id` 列有值；④ 分页仅覆盖工具/LLM 调用，阶段实例不分页；⑤ `POST /api/runs/:id/cancel` 不终止在途阶段（见下）。
5. **服务端遗留（workflow engine，属 P7/P8 范畴，未在本阶段修）**：`POST /api/runs/:id/cancel` 仅把 run 置 `canceled`，**不终止在途阶段**；在途 `copy` 阶段结束后会把 run 覆写为 `failed`（违反 `run-state.ts` 中 `canceled` 为终态无出边），且工作台上取消后该阶段仍显示「运行中」。已登记待后续处理。
6. **实测副作用（已回滚）**：为验证强制改密流程，admin 口令曾由内置 `mongoose-admin` 临时改为 `VfAdminCheck2026`，实测结束**已改回 `mongoose-admin`**；另注册了实测账号 `vfuicheck` 与项目「UI 实测项目」（留在本机 DB，不影响仓库）。

---

### Phase 12：旧领域删除 + 文档同步

**目标**：把 P1 暂留的旧模块彻底移除，仓库无残留引用；同步文档与 Agent Guide。

**Files:**

- Delete: `apps/worker/`、`adapters-python/`、`apps/server/src/voice-service.ts`
- Delete: `apps/server/src/db/repositories/{build,event,task,voice}-repository.ts`
- Delete: `packages/pipeline/src/{quality,manifest,run-log,python-adapter}.ts`
- Delete: 旧 Web 残留（见 P11）
- Delete: 对应测试（`tests/integration/{api-build-review,build-repository,task-lease,voice-api}.test.ts`、`tests/unit/{quality,run-log,python-adapter,voice-repository,voices-view,build-state,workspace-api,workspace-views}.test.ts` 等，**逐个核对引用后再删**）
- Delete: `docs/guides/edge-tts-guide.md`
- Modify: `AGENTS.md`（项目现状、目录、命令全部改为新架构；明确"端到端冒烟尚未自动执行"）、`docs/guides/developer-guide.md`、`docs/guides/operator-guide.md`

**要点：**

- 全仓扫描 `@videoforge/server/src`、`run-log`、`worker`、`python-adapter`、`voices`、`builds`、`quality`、`manifest` 无残留引用。
- `retention.*` 与 `config/system.local.example.yaml` 的 `python.*` 同步清理。
- 文档明确标注本期能力边界（§2.3 的明确不做清单）。

- [x] **Step 1:** 逐模块删除 + 引用扫描 → **Step 2:** 文档同步 → **Step 3:** `pnpm install && pnpm run doctor && pnpm test && pnpm build` 全绿

**执行记录（P12 ✅，2026-10-26 收口）**

删除的代码模块：

- `apps/worker/`（整目录：`src/index.ts`、`src/worker.ts`、`package.json`、`tsconfig.json`）。
- `adapters-python/`（整目录：Edge TTS JSON CLI 适配器、`.venv`、pytest 缓存）。
- `apps/server/src/voice-service.ts`。
- `apps/server/src/db/repositories/{build,event,task,voice}-repository.ts`。
- `packages/pipeline/src/{quality,manifest,run-log,python-adapter,artifact-store}.ts`。
- `packages/shared/src/{build-state,contracts}.ts`。
- `.trae/skills/{vf-copywriter,vf-image-gen,vf-scene-gen,vf-tts,vf-storyboard}`（五个 skill 包装的七个 CLI 命令已在 P10 删除，保留即死文档）。
- `docs/guides/edge-tts-guide.md`。
- 测试：`tests/integration/{api-build-review,build-repository,task-lease,voice-api}.test.ts`、`tests/unit/{quality,run-log,python-adapter,voice-repository,build-state,artifact-store}.test.ts`。

清理的引用点：

- `apps/server/src/db/index.ts`：移除 4 个旧仓储导出。
- `apps/server/src/db/schema.ts`：移除 6 张旧表定义（`builds`/`tasks`/`build_events`/`tts_voices`/`tts_catalog_state`/`tts_preview_cache`）。
- `apps/server/src/db/migrate.ts`：旧表由 `CREATE` 改为 `DROP TABLE IF EXISTS`（幂等清理）。
- `packages/pipeline/src/index.ts`：移除 5 个已删模块导出。
- `packages/shared/src/index.ts`：移除 `build-state`/`contracts` 导出。
- `packages/shared/src/domain.ts`：删除 `BuildStatus`/`BuildStage`/`TaskStatus`/`ArtifactKind`/`QualitySeverity`/`ReviewDecision`，保留仍被渲染内核使用的 `OutputProfile`。
- `packages/pipeline/src/config.ts`：删除 `python.*`、`engines.tts_voice_default`、`toBuildConfigSnapshot`，以及 `loadSystemConfig` 内的 Python 路径绝对化逻辑。
- **7 个仍被阶段工具使用的模块移除 `run-log` 记账**（这是删除 `run-log.ts` 的必要前置，原计划未显式列出）：`packages/pipeline/src/{copy,image,scene,tts,storyboard}-generate.ts`、`packages/pipeline/src/compose-video.ts`、`packages/renderer/src/render-frames.ts`。改为直接执行业务逻辑；运行轨迹统一由新架构的 `run_stages`/`tool_calls`/`llm_calls` + `trace.jsonl` 承担。
- `apps/cli/package.json`：移除无引用的 `@videoforge/renderer`、`@videoforge/template-sdk`。
- `config/system.local.yaml`：清理本机旧字段（`runtime.worker_concurrency`、`python.*`、`engines.tts_default`/`t2i_default`、`retention.*`），保留 storage/Chrome/Ark 等有效配置。
- `tests/unit/config.test.ts`：移除 `toBuildConfigSnapshot` 导入与用例。
- `tests/unit/db-schema.test.ts`：`KEPT_TABLES` 合并进 `REMOVED_TABLES`，断言旧表全部不存在。

文档同步：

- `AGENTS.md`：全量改写为单进程 harness 架构（目录、命令、配置约定、已知边界、前端约定、测试交付）。
- `docs/guides/developer-guide.md`：全量改写（技术组成、目录、环境、`JWT_SECRET`/`ARK_API_KEY` 密钥要求、诊断、启动、初始账号与救援、构建测试、服务端分层、七阶段与审核点、提示词集、CLI 运维 6 命令、数据与工件、FAQ）。
- `docs/guides/operator-guide.md`：全量改写（能力表、启动、初次登录与强制改密、新建项目/工作台/审核/trace/admin、运维命令、错误对照、当前限制）。
- 删除 `docs/guides/edge-tts-guide.md`。

验证结果（实际输出）：

- `pnpm install --no-frozen-lockfile` → 成功（`pnpm-lock.yaml` 已同步移除 `apps/worker` 与 cli 的两个无引用依赖）。
- `pnpm test` → **48 files / 382 tests passed**（TEST_EXIT=0；基线 54/401，减少 6 个旧领域测试文件、19 条用例）。
- `pnpm build` → **BUILD_EXIT=0**（shared/pipeline/renderer/template-sdk `tsc --noEmit` + web vite build 3252 modules）。
- `pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → `TSC_SERVER_EXIT=0`。
- `pnpm exec tsc -p apps/cli/tsconfig.json --noEmit` → `TSC_CLI_EXIT=0`。
- `pnpm run doctor` → **DOCTOR_EXIT=0**（9 项全 PASS，含 `chat_model = kimi-k3`、`ARK_API_KEY` 已检测、`base_url` 正确、`storage_root` 非空）。
- 残留扫描（`*.ts`/`*.vue`/`*.json`/`*.yaml` 搜 `voice-service`、`build-repository`、`task-repository`、`event-repository`、`python-adapter`、`artifact-store`、`toBuildConfigSnapshot`、`build-state`、`BuildStatus`、`adapters-python`、`apps/worker`）→ **No matches found**。

受控偏差 / 补充说明：

1. **`run-log.ts` 的删除需要先改造 7 个使用方**：计划假设该模块仅被测试引用，实际 `copy/image/scene/tts/storyboard/compose-video` 与 `renderer/render-frames` 仍通过 `logStep`/`appendRunEvent` 记账。已按「旧模块彻底移除」目标移除这些记账调用，未改变任何业务产物与外部契约。
2. **`artifact-store.ts` 一并删除**：`createBuildLayout`/`writeArtifact` 属旧 Build 目录布局，新架构使用 `domain/storage-layout.ts`，删除后无引用。
3. **`.trae/skills` 五个 skill 一并删除**：其内容全部是已移除 CLI 命令的包装，保留会误导 agent；`.trae` 现无 skill，`resolveSkillDirs` 对不存在目录返回空数组、不报错。
4. **`config/system.local.yaml` 属本机 gitignored 文件**：已同步清理旧字段，但未改动 storage/Chrome/Ark 等本机有效值。
5. **未删除**：`本地视频流水线搭建方案.md`（旧版 MVP 方案，作为历史设计输入保留），以及 `tests/integration/{admin-api,project-run-api,sse-events,auth-api}.test.ts`（新架构集成测试，默认不入 `pnpm test`）。

---

## 3. 验收对照（主文档 §15）

| #   | 验收项                                                                                               | 覆盖阶段                                 |
| --- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | `pnpm install && pnpm run doctor && pnpm test` 通过                                                  | 全阶段                                   |
| 2   | `server:dev` 单进程启动（provider + 引擎就绪日志）；`web:dev` 可接入                                 | P9、P11                                  |
| 3   | 两用户互相隔离；普通用户访问 `/api/admin/*` 被拒                                                     | P4、P5、P9                               |
| 4   | `admin`/`mongoose-admin` 首次可登录；改密并重启后初始密码失效；admin 可读全站 run 与任意 trace       | P5、P9                                   |
| 5   | `GET /api/capabilities` 返回能力声明；API+SSE 跑通"主题→成片"（审核点暂停/恢复、成片与语音总长 ±1s） | P2、P8、P9（真机需用户填 key，人工验收） |
| 6   | trace 完整：`run_stages`/`tool_calls`/`llm_calls` + `trace.jsonl` 一致 + 全链路无密钥明文            | P6、P7、P9                               |
| 7   | run 中重启 server → `canceled`/`INTERRUPTED`，续跑不重复已达标阶段                                   | P8、P9                                   |
| 8   | 旧模块（worker、adapters-python、Build/Review 页面与领域表、`run-log.jsonl`）彻底移除                | P12                                      |
| 9   | CLI 只剩运维入口：`doctor`/`status` 可用，原流水线命令不可用，`project:verify` 可判定                | P10                                      |

## 4. 待定与风险

- ~~**SSE 鉴权方式**（ticket vs `?token=`）：P9 决定，登记安全备注并回写 Web 专题 5.4.5。~~ **✅ 已定夺（P9-B）**：短时票据方案 —— `POST /api/sessions/:id/events-ticket` 签发独立 JWT（`{scope:"sse", sid, uid, urole}`，TTL 60s，与会话 `sid` 绑定）；SSE 路由接受 `?ticket=` 或 `Authorization: Bearer`；与 access token **双向隔离**（票据带 `scope` 被 `auth-hook` 拒绝，access token 无 `scope`/`sid` 被 `verifyEventTicket` 拒绝）；重连需重新签票。已回写 Web 专题 §5.4.5 与 §9。
- **Pi SDK 兼容性**（主文档 §14.1/§14.3）：P0 SPIKE 结论是 P7 的前提；不兼容则改 `ModelRegistry.find` + 自定义 provider / 落 Pi session 文件重启回读。
- **真机端到端未做**：需要用户在 `config/system.local.yaml` 填真实 `chat_model`、`.env.local` 填 `ARK_API_KEY`，文档必须保留"端到端冒烟尚未自动执行"的声明（§13.3）。
- **存储膨胀**（§14.5）：`llm_calls` 全文默认开启、不提供开关；本期只写手工 SQL 清理说明，不牺牲语料完整性。
- **测试覆盖真空**（§14.8）：已按"先迁移保测试 → 后删旧领域 → 最后加新测试"排序。

---

## 5. 交付后热修复记录（2026-10-27）

用户在真实浏览器跑「主题 → 成片」时，run 停在 copy 阶段连续失败且界面无任何错误说明。定位到三处真实缺陷并修复：

1. **Ark provider 从未把工具声明发给模型（根因）**
   - 现象：`copy` 阶段 3 次重试全部失败，`tool_calls` 表无 `copy_generate` 记录；模型只输出纯文本。
   - 证据：直接调用 Ark `kimi-k3` 带 `tools` 时返回 `finish_reason: "tool_calls"`，说明模型支持 function calling。
   - 根因：`apps/server/src/agent/pi/provider.ts` 调 `callArkChat` 时未传 `tools`。Pi 的 `TranscriptContext` 只携带 `messages`，工具声明编码在 system 消息的 `toolsAdded` 中。
   - 修复：用 `resolveTranscriptTools(messages, "none")` 提取当前工具并转成 OpenAI `tools`，有工具时带 `tool_choice: "auto"`。
2. **阶段失败时 `error_code` 为 `null`**
   - 根因：执行器自报 `ok:true` 但产物判据未通过时，engine 取 `result.errorCode ?? null`。
   - 修复：`engine.ts` 未达标分支补 `RUN_ERROR_ARTIFACT_MISSING`；工作台 `StageSteps.vue` 展示错误码（Web 专题 §5.5）。
3. **`tool_calls` 的 `run_id` / `stage_id` 恒为 `null`（trace 页查不到）**
   - 根因：工具闭包在会话创建时构建，那时 run/阶段尚未确定，`runId/stageId` 被写死为 `null`。
   - 修复：`ToolTraceOptions` 支持函数式 `TraceIdSource`；`AgentSessionEntry.stageTrace` 保存当前阶段上下文，引擎经 `sessions.setStageTrace()` 在进入阶段时注入、退出时清空。

验证：

- `pnpm test` → **48 files / 385 tests passed**；`pnpm exec tsc -p apps/server/tsconfig.json --noEmit` → 0；`pnpm --filter @videoforge/web build` → `BUILD_EXIT=0`。
- 真实 Ark 端到端（本机 admin）：新建项目 → `copy | done | attempt=0`，run 进入 `waiting_review`；`GET /api/runs/:id/trace` 返回 `toolCalls=2`，且 `tool_calls.stage_id` 指向 copy 阶段行。

仍遗留：`llm_calls` 为空（provider 为多会话共享的单一 `ModelRuntime`，无法按 `sessionId` 注入 `traceContext`）；取消 run 不终止在途阶段；trace「事件」Tab 无查询路由。
