# VideoForge 开发者使用说明

本文面向需要在 Windows 本机安装、运行、测试或扩展 VideoForge 的开发者。文中命令以 PowerShell 为例，并从仓库根目录执行。

> **当前阶段：轻量本地 harness（单进程）。** 服务端已按"能力注册表 + 七阶段确定性工作流 + 内嵌 Pi agent 运行时 + 三级 trace + 多用户隔离"重建，Web 工作台按 Ant Design Vue 重建。**使用真实 Ark 服务的端到端冒烟仍未验收**（需本机填真实密钥与模型 ID 后人工验证）；Worker 独立进程与 Python 适配器已在 P12 移除。

## 1. 技术组成

| 部分         | 技术                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| Web 工作台   | Vue 3、Vite、Vue Router、Pinia、Ant Design Vue 4                                  |
| API / 工作流 | Node.js、TypeScript、Fastify 5、`@fastify/jwt`、`@earendil-works/pi-coding-agent` |
| 数据层       | SQLite、Drizzle ORM、better-sqlite3                                               |
| 媒体渲染     | Playwright、Chromium、ffmpeg、ffprobe                                             |
| 测试         | Vitest                                                                            |
| Workspace    | pnpm 10                                                                           |

主要目录：

```text
apps/
  server/                 Fastify 单进程（http / domain / agent / workflow / trace）
  cli/                    CLI 运维入口（doctor / status / db:migrate / db:user / storage:prune / project:verify）
  web/                    Vue 工作台（Ant Design Vue）
packages/
  shared/                 领域类型、能力注册表、错误码
  pipeline/               配置、Ark 客户端、ffmpeg/ffprobe、文案/生图/TTS/时间轴/合成能力
  renderer/               Playwright 场景渲染（单场景与多场景连续帧）
  template-sdk/           场景契约、内置动画模板、Profile 与 GSAP 供应商
config/                   默认配置、本机配置模板、提示词集、输出 Profile
tests/                    Vitest 单元测试；tests/integration 为真机冒烟（默认不入全量单测）
```

## 2. 环境准备

### 2.1 前置依赖

- Windows 10/11。
- Node.js ≥ 22.19.0（Pi SDK 的 `engines` 要求；见仓库根目录 `.nvmrc`）。
- pnpm 10.x。
- Git。
- `ffmpeg` 和 `ffprobe` 可从 PATH 调用。
- Chrome/Chromium；本机 Chrome 路径可通过配置指定。
- 建议工件盘至少预留 30 GB。

首次安装 Node.js 与 FFmpeg 时，以管理员 PowerShell 执行：

```powershell
PowerShell -ExecutionPolicy Bypass -File ".\scripts\bootstrap-windows.ps1"
```

安装后重新打开终端，再全局安装项目指定的 pnpm：

```powershell
npm install -g pnpm@10.0.0
```

### 2.2 安装项目依赖

```powershell
pnpm install
```

`better-sqlite3` 是原生依赖。若安装提示忽略构建脚本，可检查根 `package.json` 的 `pnpm.onlyBuiltDependencies` 后执行：

```powershell
pnpm rebuild better-sqlite3 esbuild
```

只有原生模块明确编译失败时才安装 Visual C++ Build Tools，参考[Windows 环境准备文档](../superpowers/specs/2026-09-29-windows-environment-setup.md)。

> P12 起不再需要 Python 环境：`adapters-python/` 与 Edge TTS 适配器已移除，语音链路统一走 Ark TTS。

## 3. 本机配置与密钥

首次配置时复制模板：

```powershell
Copy-Item config\system.local.example.yaml config\system.local.yaml
```

`config/system.local.yaml` 已加入 `.gitignore`。至少需要按本机环境调整存储路径与 Chrome 路径：

```yaml
runtime:
  storage_root: "D:/videoforge-storage"
  max_concurrent_stage: 1
  minimum_free_disk_gb: 30

tools:
  chromium_path: "C:/Program Files/Google/Chrome/Application/chrome.exe"
  ffmpeg_path: "ffmpeg"
  ffprobe_path: "ffprobe"

engines:
  endpoints:
    ark:
      base_url: "https://ark.cn-beijing.volces.com/api/plan/v3"
      chat_model: "<真实语言模型 ID>"
```

完整字段及注释见 [`config/system.local.example.yaml`](../../config/system.local.example.yaml) 与 [`config/default.yaml`](../../config/default.yaml)。

### 3.1 密钥（只允许环境变量或 `.env.local`）

| 变量                        | 用途                      | 要求                                                                |
| --------------------------- | ------------------------- | ------------------------------------------------------------------- |
| `ARK_API_KEY`               | 火山方舟文案 / 生图 / TTS | 必填；不得写入 YAML、SQLite、日志或 manifest                        |
| `JWT_SECRET`                | 签发与校验访问令牌        | **必填，至少 32 字符**；缺失或过短时服务启动直接报 `CONFIG_INVALID` |
| `VF_ADMIN_INITIAL_PASSWORD` | 覆盖 admin 初始口令       | 可选；未设置时使用内置初始口令，仅在首次建号时读取                  |

在仓库根目录创建 `.env.local`（已 gitignore）：

```text
ARK_API_KEY=<你的火山方舟 API Key>
JWT_SECRET=<至少 32 字符的随机串>
```

也可以改用同名系统环境变量（环境变量优先）。启动服务前当前终端需能读到 `JWT_SECRET`：

```powershell
$env:JWT_SECRET = "videoforge-local-dev-secret-key-0123456789"
```

### 3.2 Ark 端点约束

`engines.endpoints.ark.base_url` 必须保持 `https://ark.cn-beijing.volces.com/api/plan/v3`。这是 Agent Plan 专用路径，**改为 `/api/v3` 会产生额外费用**。TTS 走独立的 openspeech 地址（`tts_base_url`）。

## 4. 环境诊断

```powershell
pnpm run doctor
```

`doctor` 会检查 Node、pnpm、ffmpeg、ffprobe、Chrome 路径、存储盘剩余空间，并新增四项配置体检：`chat_model` 仍为占位值、`ARK_API_KEY` 缺失、`base_url` 被误改、`storage_root` 为空。stdout 输出一行 JSON 摘要，诊断信息走 stderr。

## 5. 本地开发与运行

根目录未提供 `pnpm dev` 一键编排命令。Web 与 API 分别在独立 PowerShell 窗口启动。

终端 A，启动 API（需先设置 `JWT_SECRET`）：

```powershell
$env:JWT_SECRET = "videoforge-local-dev-secret-key-0123456789"
pnpm run server:dev
```

启动日志会打印模型 provider/ID、阶段并发上限、中断恢复条数与 admin 是否新建，并监听 `http://127.0.0.1:3000`（端口取自 `server.port`，监听地址固定为本机回环，禁止改为公网绑定）。

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

终端 B，启动 Web：

```powershell
pnpm run web:dev
```

默认打开 `http://localhost:5173`。Vite 会读取 `server.port` 并代理 `/api`；只有部署或需绕过代理时才设置 `VITE_API_BASE`。停止服务时在对应终端按 `Ctrl+C`。

### 5.1 初始账号与强制改密

- 内置管理员用户名 `admin`，初始口令为内置值（本机文档不重复记录）或 `VF_ADMIN_INITIAL_PASSWORD` 指定的值。
- 首次登录会被路由守卫强制跳到 `/settings?force=1`，修改成功前无法访问其他页面。
- 忘记口令时用 CLI 本机救援通道重置：

```powershell
pnpm --filter @videoforge/cli start db:user --reset-password admin
```

新口令一次性输出到 stdout，不写入数据库明文；重置后该账号下次登录会再次要求改密。

## 6. 构建和测试

```powershell
pnpm test                 # 全量单元测试（默认排除 tests/integration）
pnpm build                # packages/* tsc --noEmit + web vite build
pnpm run web:build        # 仅构建 Web
pnpm test:smoke           # 真 Chromium 渲染冒烟（找不到本机 Chrome 时整体跳过）
```

单独检查应用 TypeScript：

```powershell
pnpm exec tsc -p apps/server/tsconfig.json --noEmit
pnpm exec tsc -p apps/cli/tsconfig.json --noEmit
```

`pnpm test:smoke` 通过 `VF_SMOKE=1` 只跑 `tests/integration/smoke-pipeline.test.ts`，用于兜底"mock 单测全绿、真机 seek 挂起"类回归。

## 7. 架构与七阶段流水线

### 7.1 服务端分层

- `src/http`：REST 路由（auth / capabilities / projects / sessions / runs / trace / artifacts / media / admin）、SSE 事件总线与票据、鉴权钩子、统一错误处理。
- `src/domain`：项目状态推导与存储布局。
- `src/agent`：Pi 运行时装配、Ark provider、阶段工具、内置工具与提示词、技能加载、会话注册表。
- `src/workflow`：能力注册表、run/阶段状态机、引擎主循环、审核点、重试、断点续跑、租约与中断恢复。
- `src/trace`：三级留痕（`run_stages` / `tool_calls` / `llm_calls`）+ `trace.jsonl`、脱敏器与结构化日志。

业务能力实现在 `packages/*`，服务端只做编排，不要在 `apps/server` 复制领域类型。

### 7.2 七阶段与审核点

阶段顺序固定为 `copy → image → scene → tts → storyboard → render → compose`，定义在 `packages/shared/src/domain.ts` 的 `PIPELINE_STAGES`。审核点固定在 `copy`、`image` 之后（`REVIEW_GATE_STAGES`）：命中后 run 进入 `waiting_review`，需通过 Web 工作台或 API 恢复。

新建项目时服务端会同步创建会话、首个 run 并异步触发工作流，因此工作台立即能看到 `运行中` 的 run。

### 7.3 提示词集（prompt set）

`copy`、`image`、`scene` 三个阶段使用 `config/prompts/<集名>/` 下的模板文件，而不是在代码里硬编码长提示词：

```text
config/prompts/
  default/
    copy-system.txt      copy 阶段 system 提示词，支持 {style}
    image-suffix.txt     追加在 imagePrompt 后的后缀（禁文字约束）
    scene-system.txt     scene 阶段 system 提示词，支持 {width} / {height}
```

选择优先级：配置 `prompts.default_set`（缺省 `default`）> 内置默认。指定的集目录不存在时报 `CONFIG_INVALID`；单文件缺失时该文件单独回退内置默认。

### 7.4 Trae skills（可选扩展点）

`.trae/skills/` 是 agent 的可选 skill 扩展点：运行时由 `src/agent/skills.ts` 的 `resolveSkillDirs` 检测目录是否存在并注入，目录不存在时返回空数组、不报错。**P12 已删除原先包装七个 CLI 命令（`copy:gen` 等）的五个旧 skill**，因为这些命令在 P10 已移除；当前编排由服务端 agent 与工作流引擎承担，工作台只负责展示与审核。

## 8. CLI 运维入口

CLI（`apps/cli`）只保留运维命令，约定 stdout 输出一行机器可读 JSON，诊断走 stderr；未知命令退出码 2，执行失败退出码 1。

| 命令             | 用途                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `doctor`         | 环境诊断（工具链 + 配置体检）                                                                    |
| `status`         | `/health` 探活、端口占用、磁盘、DB 路径/体积、活跃 run/会话数；server 离线时降级提示且不报错退出 |
| `db:migrate`     | 执行数据库迁移（幂等）                                                                           |
| `db:user`        | 列出用户 / `--create` 建号 / `--reset-password` 本机恢复口令                                     |
| `storage:prune`  | 按保留策略清理工件                                                                               |
| `project:verify` | 校验项目产物完整性                                                                               |

示例：

```powershell
pnpm --filter @videoforge/cli start status
pnpm --filter @videoforge/cli start db:user
pnpm --filter @videoforge/cli start project:verify --project <项目 id>
```

## 9. 数据与工件

启动 API 时，`startServer` 读取 `runtime.storage_root`，创建 `videoforge.db`，执行迁移并打开数据库。新领域共 8 张表：`users`、`projects`、`sessions`、`messages`、`runs`、`run_stages`、`tool_calls`、`llm_calls`。迁移会 `DROP` 旧 Build/Voice 领域表（P12 已彻底移除）。

- schema 与迁移：`apps/server/src/db/schema.ts`、`apps/server/src/db/migrate.ts`
- 仓储：`apps/server/src/db/repositories/`（actor-first 签名，按 `Actor` 隔离）
- 工件路径一律经 `packages/pipeline/src/path-safety.ts` 校验，限制在 `storage_root` 内

`run_stages` 为追加式多行（同一阶段每次重试各一行），Web trace 页按阶段折叠展示。事件、质检结果与审核记录均为追加式，不覆盖历史结论。

`tool_calls` 会带上 `run_id` / `stage_id`：会话在创建时构建工具闭包，引擎进入阶段时通过 `setStageTrace` 注入当前 run/阶段，退出时清空。`llm_calls` 同样带上 `run_id` / `stage_id`：provider 在每次请求时按 `streamOptions.sessionId` 反查会话注册表，取该会话专属的 trace store 与当前阶段上下文。三类记录（`run_stages` / `tool_calls` / `llm_calls`）都会双写项目目录下的 `trace.jsonl`，行首 `type` 字段区分 `run_stage` / `tool_call` / `llm_call`。

## 10. 常见问题

| 现象                            | 排查方法                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 启动报 `CONFIG_INVALID`（JWT）  | 设置 `JWT_SECRET`，长度至少 32 字符                                                                                        |
| `pnpm` 不存在                   | 重开 PowerShell；执行 `npm install -g pnpm@10.0.0`                                                                         |
| `doctor` 找不到 ffmpeg          | 检查 PATH，或在 `system.local.yaml` 的 `tools` 段写完整路径                                                                |
| Playwright 启动浏览器失败       | 检查 Chrome 路径；或安装 Playwright 管理的 Chromium：`pnpm --filter @videoforge/renderer exec playwright install chromium` |
| `better-sqlite3` 找不到 binding | 执行 `pnpm rebuild better-sqlite3`                                                                                         |
| Web 页面无法请求 API            | 确认 API 在 `127.0.0.1` 的 `server.port` 端口运行；开发模式由 Vite 自动代理                                                |
| `pnpm install` 报 lockfile 过期 | 依赖变更后执行 `pnpm install --no-frozen-lockfile` 更新 `pnpm-lock.yaml`                                                   |

## 11. 相关文档

- [操作者使用说明](operator-guide.md)
- [本地 harness 设计（主文档）](../../本地视频流水线Agent-v2.md)
- [Web 工作台设计（Web 专题）](../../本地视频流水线Agent-web-v2.md)
- [重构实施计划](../superpowers/plans/2026-10-25-videoforge-harness-rebuild.md)
- [Windows 环境准备](../superpowers/specs/2026-09-29-windows-environment-setup.md)
