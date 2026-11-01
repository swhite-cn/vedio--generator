# VideoForge Agent Guide

本文是仓库级协作说明。修改代码前先核对目标模块的源码和测试；设计文档描述的目标不一定已经实现。

## 项目现状

VideoForge 是面向 Windows 本机使用的 pnpm monorepo，当前为**轻量本地 harness（单进程）**。核心链路是「能力 → 项目 → run」：`apps/server`（Fastify）按能力注册表驱动七阶段确定性工作流（`copy → image → scene → tts → storyboard → render → compose`），内嵌 Pi agent 运行时执行阶段工具，三级 trace（`run_stages` / `tool_calls` / `llm_calls` + `trace.jsonl`）留痕；`apps/web` 是 Ant Design Vue 工作台（只读渲染服务端数据，不推导状态机）；`apps/cli` 是运维入口（`doctor`/`status`/`db:migrate`/`db:user`/`storage:prune`/`project:verify`）。

七个阶段均有单测（Ark HTTP、ffprobe/ffmpeg、Chromium 全部 mock）。审核点固定在 `copy`、`image` 之后；新建项目时服务端同步建会话、首个 run 并异步触发工作流。

已知边界（不要把以下能力描述成已上线）：

- **真实 Ark 端到端验收仍未完成**：需用户在 `config/system.local.yaml` 填真实 `chat_model`、在 `.env.local` 填 `ARK_API_KEY` 与 `JWT_SECRET` 后手动验证；`pnpm test:smoke` 仅覆盖真 Chromium 渲染段（`tests/integration`，不含 Ark 调用，找不到本机 Chrome 时跳过，不进全量单测）。
- `POST /api/runs/:id/cancel` 只把 run 置为 `canceled`，**不终止在途阶段**；在途阶段结束后可能把 run 覆盖为 `failed`。属工作流引擎待修项。
- trace 页「事件」Tab 无后端查询路由；`GET /api/admin/projects` 不做项目状态推导，状态恒为库内 `draft`。
- `tool_calls` / `llm_calls` 均按 run / 阶段归属：工具调用由引擎注入会话阶段上下文，LLM 调用由 provider 按 `streamOptions.sessionId` 反查会话留痕目标；`trace.jsonl` 同时写入 `tool_call` / `llm_call` / `run_stage` 三类行。
- 新建项目 Modal 的输出 Profile 为前端固定两项（服务端未提供 Profile 列表接口）。
- 服务端仅监听 `127.0.0.1`，不构成可对外部署的服务。

## 技术栈与目录

- `apps/web`：Vue 3、Vite、Vue Router、Pinia、Ant Design Vue 4（全量注册 + `ConfigProvider` zhCN）；页面为 `/login`、`/capabilities`、`/projects`、`/projects/:id`（工作台）、`/runs/:id/trace`、`/settings`、`/admin`。
- `apps/server`：Node.js、TypeScript、Fastify 5，按职责分层：
  - `src/http`：REST 路由（auth / capabilities / projects / sessions / runs / trace / artifacts / media / admin）、SSE 事件总线与票据、鉴权钩子、统一错误处理。
  - `src/domain`：项目状态推导、存储布局。
  - `src/agent`：Pi 运行时装配、Ark provider、阶段工具、内置工具、提示词、技能加载、会话注册表。
  - `src/workflow`：能力注册表、run/阶段状态机、引擎主循环、审核点、重试、断点续跑、租约与中断恢复。
  - `src/trace`：三级留痕、脱敏器、结构化日志。
  - `src/db`：SQLite、Drizzle schema、迁移、actor-first 仓储。
- `apps/cli`：命令行运维入口（tsx 直跑，无构建步骤）。
- `packages/shared`：领域类型（含 `PIPELINE_STAGES`、`REVIEW_GATE_STAGES`）、能力注册表、错误码。
- `packages/pipeline`：配置、Ark 客户端、ffmpeg/ffprobe、文案/生图/TTS/时间轴/合成能力、`path-safety`。
- `packages/renderer`：Playwright 单场景与多场景连续帧渲染。
- `packages/template-sdk`：场景契约、内置动画模板、Profile、GSAP 供应商。
- `config`：默认配置、本机配置模板、提示词集、输出 Profile。
- `tests`：Vitest 单元测试（`tests/integration` 为真机冒烟，默认排除）。
- `.trae/skills`：可选的 agent skill 扩展点（当前为空）；运行时会按目录是否存在注入，不存在不报错。

TypeScript 使用严格模式、ESM 和 NodeNext 解析。跨应用依赖使用 `workspace:*`；`apps/cli` 通过 `@videoforge/server` 子路径导入共享代码，不要在应用间复制领域类型。

## 环境与常用命令

开发环境要求 Node.js ≥ 22.19.0（Pi SDK 的 `engines` 要求，见 `.nvmrc`）、pnpm 10.x。Windows 命令示例使用 PowerShell，并从仓库根目录执行：

```powershell
pnpm install
pnpm run doctor
pnpm test
pnpm build
pnpm run server:dev
pnpm run web:dev
pnpm test:smoke
```

启动 API 前必须提供 `JWT_SECRET`（≥32 字符），否则启动即报 `CONFIG_INVALID`：

```powershell
$env:JWT_SECRET = "videoforge-local-dev-secret-key-0123456789"
pnpm run server:dev
```

API 与 Web 需在两个独立终端启动。仓库当前没有统一 lint 命令，不要假设存在 `pnpm lint`。

## 配置与服务约定

- 配置默认值在 `config/default.yaml`；本机覆盖文件为 `config/system.local.yaml`，模板为 `config/system.local.example.yaml`。
- 火山方舟配置在 `engines.endpoints.ark`：`base_url` 必须保持 `https://ark.cn-beijing.volces.com/api/plan/v3`（改为 `/api/v3` 会产生额外费用）；`chat_model` 默认为占位值 `PLEASE_FILL_CHAT_MODEL_ID`，填真实 ID 前 copy 阶段会拒绝执行。
- 密钥只允许出现在仓库根目录 `.env.local`（`ARK_API_KEY`、`JWT_SECRET`）或同名系统环境变量中；`.env.local`、本机配置、SQLite 数据和生成工件均已 gitignore 且不得提交。不要读取、输出或复制密钥到日志、数据库或 manifest。
- YAML 新增叶子字段时，添加用途注释；注明单位/范围、空值默认行为，以及路径或敏感值的安全边界。
- `copy`/`image`/`scene` 的模型提示词已配置化：`config/prompts/<集名>/` 下 `copy-system.txt`、`image-suffix.txt`、`scene-system.txt` 三个模板文件构成一套提示词集，支持 `{style}`、`{width}`、`{height}` 变量与单文件缺失回退内置默认；默认集由配置 `prompts.default_set` 决定（缺省 `default`）；显式指定不存在的集报 `CONFIG_INVALID`。修改提示词行为优先改模板文件，不要在阶段工具里重新硬编码长提示词。
- API 端口从配置读取。Web 开发环境由 `apps/web/vite-server-config.ts` 配置 Vite 代理。
- API 与 SSE 客户端使用相对路径；不要在 `apps/web/src/services/api.ts` 或 `sse.ts` 硬编码主机名或端口。只有确有部署需求时才使用已有的 `VITE_API_BASE` 覆盖。
- API 端口可配置不代表服务已开放外网监听；当前监听边界以服务代码为准（127.0.0.1），禁止擅自改成公网绑定。

## Windows、路径与子进程

- 文件路径必须兼容 Windows，包含中文、空格和正斜杠配置路径；优先复用 `packages/pipeline/src/path-safety.ts`，不要用字符串拼接构造安全敏感路径。
- CLI 运维命令 stdout 只输出一行机器可读 JSON，诊断走 stderr；未知命令退出码 2、执行失败退出码 1。
- 启动外部进程时使用参数数组和受控的工作目录，避免拼接 shell 命令；保留足够的错误上下文，但不得记录密钥。
- 原生依赖 `better-sqlite3` 在 Windows 上可能需要重新构建；仅在明确出现编译问题时再要求安装 Visual C++ Build Tools。

## 数据与生产安全

- 保持「项目 → 会话 → run」的领域边界；`run_stages`、事件、审核记录与质量结论采用追加式记录，不覆盖历史结论。
- API/UI 返回的临时 ID 或本地组件状态不能被表述为已持久化记录。
- 新领域共 8 张表：`users`、`projects`、`sessions`、`messages`、`runs`、`run_stages`、`tool_calls`、`llm_calls`。不要重新引入旧 Build/Voice 领域表。
- 文件写入应限制在配置的存储根目录内；新增路径操作时覆盖越界、空格、中文和 Windows 分隔符测试。
- 不要在日志、数据库、manifest、测试快照或文档中加入真实 API 密钥、令牌或个人凭据。

## 前端约定

- 沿用 Vue 单文件组件、现有全局样式 `apps/web/src/styles/global.css` 及各页面的 scoped 样式；新增视觉行为时保持响应式和键盘可用性。
- 布局与状态色以 Web 专题（`本地视频流水线Agent-web-v2.md`）为唯一权威：项目 5 态 / run 6 态 / 阶段 5 态；前端只渲染服务端字段，不推导状态机。
- SSE 事件接入遵守 `Last-Event-ID` + `resync`，事件语义以 Web 专题 §7.2 的 10 类映射为准。
- 保持表单标签、可访问名称、焦点状态及适当的 ARIA 状态。交互改动应同时覆盖指针和键盘路径。
- 新增函数时添加简洁的函数级注释；对关键服务动作保留有用日志，避免记录敏感数据或高频无效日志。
- 不为单个控件引入新的 UI 依赖，除非用户明确要求或已有依赖无法满足需求（当前 UI 依赖仅 `ant-design-vue` 与 `@ant-design/icons-vue`）。

## 测试与交付

- 行为变更应先补充或更新 Vitest 测试，优先运行相关测试，再运行 `pnpm test` 和受影响应用的类型检查或构建。
- API、数据库或适配器协议变更要同步验证调用方、错误提示和边界测试。
- 前端交互/样式变更除单元测试和构建外，还应在浏览器检查关键交互及桌面、约 390px 窄屏下的布局。
- 更新用户可见行为时同步维护 `docs/guides/developer-guide.md` 或 `operator-guide.md`；涉及未实现能力时明确标注状态。
- 错误码体系统一为 `VideoForgeError(code, message)`：外部进程/网络失败用 `TOOL_UNAVAILABLE` 或 `ADAPTER_FAILED`，配置问题用 `CONFIG_INVALID`，协议解析问题用 `ADAPTER_PROTOCOL_INVALID`。
- 不要为了通过测试而弱化生产约束或删除有效断言。
- 除非用户明确要求，不创建 Git commit；不要覆盖或清理工作区内已有改动。

## 参考文档

- [开发者使用说明](docs/guides/developer-guide.md)
- [操作者使用说明](docs/guides/operator-guide.md)
- [本地 harness 设计（主文档）](本地视频流水线Agent-v2.md)
- [Web 工作台设计（Web 专题）](本地视频流水线Agent-web-v2.md)
- [重构实施计划](docs/superpowers/plans/2026-10-25-videoforge-harness-rebuild.md)
