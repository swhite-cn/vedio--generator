# VideoForge 重构设计：轻量本地 harness（内置视频工作流）

> 日期：2026-10-25
> 状态：设计待评审（尚未进入实施）
> 前置文档：[项目搭建方案](../../../本地视频流水线搭建方案.md)

---

## 1. 背景与决策记录

### 1.1 现状问题

当前项目把"主题 → 成片"的能力实现得比较完整（7 个 CLI 命令 + 5 个 SKILL.md + 流水线内核），但**编排层依赖外部 harness**：由 Trae / OpenClaw 中的 agent 读取 `.trae/skills/*/SKILL.md` 后手工驱动 CLI。

由此产生四个问题：

1. **使用门槛高**：终端用户必须懂 monorepo、pnpm、CLI 参数与工作目录约定，无法自己用。
2. **状态散落**：编排状态只存在于对话上下文里，Web 端只能做只读监控，无法形成任务闭环。
3. **无用户概念**：全局单一 `storage_root`，所有工作区混在一起，无法多用户协作。
4. **无运行留痕**：`run-log.jsonl` 只记录阶段 start/end，没有任务运行（run）概念，也没有 LLM 调用级数据，无法支撑任务监控与未来的 agent 自进化分析。

### 1.2 本次决策（已与需求方确认）

| 议题             | 决策                                                   | 说明                                                                                                                             |
| ---------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 项目定位         | 轻量化本地 harness，内置视频生成工作流                 | 推倒重来为"非完整但可用"的项目，砍掉一批现有模块，见第 10 节                                                                     |
| 进程形态         | **单进程**：agent 运行时是 `apps/server` 的内嵌模块    | Pi SDK 以库方式进程内使用；不设独立 harness 进程、无内部 HTTP/SSE 转发，见第 3 节                                                |
| harness 实现     | 使用 Pi Agent SDK（`@earendil-works/pi-coding-agent`） | 极简运行时，只做会话 + 工具 + 技能，不做多 Agent 编排                                                                            |
| 工作流编排       | **确定性引擎为主**                                     | 七阶段 DAG 由代码状态机驱动；agent 负责阶段内执行、审核点对话与失败自救，见第 6 节                                               |
| 能力模型         | **平台能力注册表**：能力 → 项目 → 任务（run）          | 当前仅内置"短视频生成"一个能力；对外统一命名"项目"（UI/API/表名），"工作区"降级为内部落盘/隔离概念，见 3.6                       |
| 工具与技能       | 维持现在的模式                                         | 7 个流水线能力不动，改由阶段工具承载；5 个 SKILL.md 保持"文件夹 + 薄封装"形态                                                    |
| CLI 定位         | 从"流水线命令入口"改为"运维入口"                       | 不再暴露 7 个流水线命令；只做项目环境、服务状态与运维实用小工具（见 3.5）                                                        |
| 内置工具放开策略 | **默认放开** `bash` / `write` / `edit`                 | 由 `agent.allow_shell_write_edit` 控制（默认 `true`）；设为 `false` 则退回只读                                                   |
| Trace 与日志     | **run 三级留痕 + LLM 全文**                            | run → stage → tool/llm call；LLM 请求/响应全文落库 + JSONL 双写，面向自进化，见第 7 节                                           |
| 用户权限         | 完整登录鉴权 + **最简角色**                            | 账号密码 + JWT + scrypt；`users.role ∈ admin\|user`，admin 可读全站 run/trace 并重置他人密码；不引入 RBAC 与管理后台页面，见 8.2 |
| 内置管理员       | `admin` / 初始密码 `mongoose-admin`                    | 启动幂等初始化，仅作兜底账号；`role = admin`，见 8.1                                                                             |
| Web 形态         | 仅定义 API/SSE 契约，交互细节另立专题                  | 本文档不展开 Web 界面设计，见第 9 节                                                                                             |
| 访问边界         | 只监听 `127.0.0.1`                                     | 沿用现有安全边界，不擅自改动                                                                                                     |

### 1.3 名词约定

- **agent 运行时**：`apps/server` 内嵌的极简 agent 模块（`src/agent/`），基于 Pi SDK 编程式 API，不再是独立进程。
- **工作流引擎**：`apps/server` 内嵌的确定性编排模块（`src/workflow/`），驱动七阶段 DAG。
- **run（任务运行）**：一次"把项目推向 `done`"的执行尝试，是任务监控与 trace 的顶层单位。
- **阶段工具**：agent 运行时暴露给 agent 的 7 个流水线执行工具。
- **内核**：`packages/pipeline` / `packages/renderer` / `packages/template-sdk` 中的纯能力实现。
- **能力（Capability）**：平台注册的一类工作流，声明阶段 DAG、参数、审核点、产物契约与技能集（见 3.6）；当前仅内置"短视频生成"（`video-generation`）。
- **项目（Project）**：用户在某能力下创建的任务单元，一个能力 0..N 个项目；UI、API、数据库与文档对外统一使用此名。
- **工作区**：纯内部技术概念——项目的落盘目录与隔离边界（`storage/users/<userId>/projects/<项目名>/`），**不出现在 UI 与 API**。
- **CLI**：仓库运维命令行（`apps/cli`），面向开发者与操作者，**不参与流水线编排**（见 3.5）。
- **trace**：run 三级留痕（run → run_stage → tool_call / llm_call）的总称，含数据库表与 `trace.jsonl` 文件两种载体。

---

## 2. 目标与范围边界

### 2.1 目标

构建**轻量化本地 harness**：把"输入主题，产出成片"内置为平台确定性工作流，以单进程提供 agent 能力、任务 trace 与多用户隔离；Web 界面作为消费方接入（交互细节另立专题）。

### 2.2 平台职责与需求清单

| 编号 | 职责            | 需求要点                                                                          | 对应章节      |
| ---- | --------------- | --------------------------------------------------------------------------------- | ------------- |
| R1   | Agent 运行时    | 会话生命周期、Ark 模型接入、阶段工具 + 内置工具、SKILL.md 技能注入与扩展          | 第 5 章       |
| R2   | 工作流引擎      | 七阶段确定性编排、审核点暂停/继续、失败重试、断点续跑                             | 第 6 章       |
| R3   | 任务与状态      | run 概念、项目状态机、并发租约、重启恢复                                          | 6.2 / 8.4     |
| R4   | Trace 与日志    | run 三级留痕、LLM 调用全文、工具调用留痕、结构化日志 + 脱敏、面向自进化的数据契约 | 第 7 章       |
| R5   | 用户与权限      | 注册/登录/JWT、内置 admin、最简角色、项目级数据隔离                               | 第 8 章       |
| R6   | 产物与存储      | 用户目录隔离、产物索引、媒体读取                                                  | 8.3 / 4.2     |
| R7   | 对外 API 与运维 | 供 Web 消费的 REST + SSE；CLI 运维入口                                            | 4.2-4.4 / 3.5 |

### 2.3 明确不做（保持"非完整项目"）

- 云端执行 / 云端沙箱 / 设备离线自动切换。
- 移动端与多端任务同步。
- 多 Agent 编排（subagent、团队调度）。
- 模板市场、插件市场、扩展系统。
- 能力的可视化注册/编排界面（新增能力 = 代码级注册声明 + 技能文件夹，见 3.6）。
- 定时任务 / 批量任务 / 自动化触发。
- 审核结论持久化闭环（审核仅体现为 run 的等待/继续状态与对话交互）。
- 外网或局域网监听。
- 面向多机部署的分布式存储与锁。
- RBAC 权限矩阵、管理后台页面（admin 能力仅开放少量只读/救援 API，见 8.2）。
- OpenTelemetry 等外部 trace 基础设施（自建 SQLite + JSONL，字段命名向 OTel 靠拢以便未来导出，见 7.1）。
- Web 界面交互细节（另立专题，见第 9 节）。

### 2.4 不动的部分

- 7 个流水线能力的内核实现（`pipeline` / `renderer` / `template-sdk` 逻辑），仅入口从 CLI 迁移到阶段工具。
- 5 个 SKILL.md 的形态：文件夹 + SKILL.md 薄封装 + 按错误码的失败排查。
- 音画自动对齐机制：TTS → ffprobe 实测时长 → `buildTimeline` → 逐帧截图 → ffmpeg `-shortest`。
- 配置分层：`config/default.yaml` + `config/system.local.yaml` + `.env.local`。

---

## 3. 目标架构

### 3.1 分层图

```
┌──────────────────────────────────────────────────────────┐
│ Web 工作台（Vue3，交互细节另立专题）                          │
└───────────────┬──────────────────────────────────────────┘
                │ 相对路径 /api（JWT）+ SSE
┌───────────────▼──────────────────────────────────────────┐
│ apps/server（Fastify 单进程，唯一持久化方，127.0.0.1:3000）   │
│ ├─ src/http      路由、鉴权、SSE、媒体读取                  │
│ ├─ src/domain    用户/项目/会话/run 仓储（Drizzle）          │
│ ├─ src/agent     内嵌 agent 运行时（Pi SDK 编程式使用）      │
│ │     会话 Map、7 阶段工具 + 内置工具、技能注入、Ark 接入     │
│ ├─ src/workflow  确定性工作流引擎（DAG/状态机/审核点/重试）   │
│ └─ src/trace     run 三级留痕、LLM 全文、结构化日志、脱敏     │
└───────────────┬──────────────────────────────────────────┘
                │ 直接函数调用（不 spawn 子进程）
┌───────────────▼──────────────────────────────────────────┐
│ packages/{shared,pipeline,renderer,template-sdk} 能力内核层   │
│ 产物：storage/users/<userId>/projects/<项目名>/…/final.mp4    │
└──────────────────────────────────────────────────────────┘
```

`apps/cli` 不在上述链路内：它是独立的运维入口（项目环境 / 服务状态 / 运维工具），可脱离服务单独运行，见 3.5。

**单进程取舍**：原双进程方案（server + harness 内部 HTTP/SSE 转发）消除了一整套伴随成本——内部 API、SSE 双侧转发、`HARNESS_UNAVAILABLE` 降级、跨进程会话恢复。代价是崩溃不隔离：agent 运行时异常可能拖垮 server。对本机工具这是可接受的（进程崩了用户一样不可用）；缓解见 5.1（工具异常捕获、阶段级超时）与 14.2 风险表。

### 3.2 进程内模块职责

| 模块           | 职责                                                 | 可替换点                     |
| -------------- | ---------------------------------------------------- | ---------------------------- |
| `src/http`     | REST 路由、JWT 鉴权、SSE 推送、媒体读取              | 端口 `server.port`           |
| `src/domain`   | users / projects / sessions / runs 等仓储与领域规则  | Drizzle schema               |
| `src/agent`    | 会话生命周期、模型接入、工具集、技能注入             | Pi 模型 provider、工具集     |
| `src/workflow` | 能力注册表、阶段 DAG、run 状态机、审核点、重试与断点 | 能力声明（数据驱动，见 3.6） |
| `src/trace`    | run/stage/call 三级留痕、LLM 全文、日志脱敏          | JSONL 落盘开关               |
| `packages/*`   | 文案/图片/场景/语音/时间轴/渲染/合成                 | 模型 ID 与提示词集           |

### 3.3 关键机制：单进程单持久化

- agent 运行时只持有内存中的活跃会话（`AgentSession`）；所有事件（消息、工具调用、LLM 调用、阶段流转）由 `src/trace` 同库同事务落库，再经 SSE 广播给 Web——**不存在双侧写入的一致性问题**。
- 进程重启后，内存会话丢失，用已落库的历史消息重建运行时（见 5.2）；处于 `running` 的 run 标记为中断，可从断点续跑（见 6.5）。

### 3.4 数据流（一次任务运行）

1. 用户选定能力并新建项目（主题必填）→ server 建项目 + 会话 + **自动创建首个 run**。
2. 工作流引擎从断点选择起始阶段（首跑为 `copy`），向会话注入阶段指令（落库为 `messages` role=system）。
3. agent 接收指令 → 调用阶段工具（示例：`copy_generate`）→ 内核产出 `copy.json`；每次 LLM 请求与工具调用由 `src/trace` 留痕。
4. SSE 向 Web 推送 `text_delta` / `tool_start` / `tool_end` / `run_stage` 等事件。
5. 到达审核点（copy、image 后）→ run 置 `waiting_review`，引擎暂停，等用户确认（`POST /api/runs/:id/resume`）。
6. 七阶段全部 `done` 且 `final.mp4` 存在 → run 置 `done`，项目状态推导为 `done`。

### 3.5 CLI 定位：项目环境、服务状态与运维工具

`apps/cli` **不再暴露 7 个流水线命令**（`copy:gen` / `image:gen` / `scene:gen` / `tts:gen` / `storyboard:gen` / `render` / `compose`）——这些能力改由阶段工具承载（见 5.4），`video-commands.ts` 及其测试一并移除。CLI 的定位调整为**仓库运维入口**，面向开发者与操作者，分三类：

| 分类     | 命令                    | 作用                                                                                                                                                                 |
| -------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目环境 | `doctor`                | 逐项校验本机依赖（Node、pnpm、ffmpeg / ffprobe、Chromium）与配置（`chat_model` 是否仍为占位值、`ARK_API_KEY` 是否存在、`base_url` 是否被误改）；移除 Python 相关校验 |
| 服务状态 | `status`                | 探活 server `/health`，输出端口占用、`storage_root`、磁盘可用量、数据库路径与体积、活跃 run/会话数                                                                   |
| 运维工具 | `db:migrate`            | 手工执行待应用的 Drizzle 迁移                                                                                                                                        |
| 运维工具 | `db:user`               | 列出用户；`--create <username>` 在注册关闭时建号；`--reset-password <username>` 供本机救援（重置为随机口令并置 `must_change_password=1`，见 8.1）                    |
| 运维工具 | `storage:prune <项目>`  | 清理中间产物（帧序列、临时音轨），保留 `copy.json` / `images/` / `audio/` / `timeline.json` / `final.mp4`；需显式确认                                                |
| 运维工具 | `project:verify <项目>` | 只读体检：契约文件齐全性、`timeline.json` 与成片时长是否一致                                                                                                         |

约定：

- **与流水线解耦**：CLI 不参与编排，不写 `messages` / `runs` / `tool_calls`，不依赖 server 在线（`status` 在 server 不可用时降级为提示，不报错退出）。
- **契约不变**：stdout 只输出一行机器可读 JSON，诊断走 stderr；错误码沿用 `VideoForgeError`。
- **实现**：`doctor` 由现有 `doctor.ts` 改造，`status` 与运维工具新增；能力内核算在 `packages/*`，CLI 只做参数解析与输出格式化。

### 3.6 能力注册表（Capability）

平台按"**能力 → 项目 → 任务（run）**"三层模型组织，能力注册表是平台可扩展性的锚点：当前只有视频生成，但所有 UI 与 API 都按多能力设计。

- **能力声明**（代码常量，数据驱动）：`id`、`name`、`description`、`stages`（阶段 DAG，含每阶段的阶段工具与产物判据）、`reviewGates`（审核点阶段集合）、`paramsSchema`（创建项目时的参数契约，如 `topic` / `style` / `profile`）、`skillDirs`（该能力注入的技能目录）。
- **内置能力**：`video-generation`（短视频生成）——七阶段线性链 `copy → image → scene → tts → storyboard → render → compose`，审核点在 `copy`、`image` 之后，最终产物 `final.mp4`，技能集为 `.trae/skills/` 下五个 SKILL.md。第 6 章的引擎行为即该能力声明的执行语义。
- **对外契约**：`GET /api/capabilities` 返回能力列表（上述声明的只读视图）；创建项目必须指定 `capabilityId`，项目落库记录 `capability_id`（见第 11 节）；工作流引擎按项目所属能力的声明驱动 DAG——引擎本身不含阶段知识。
- **新增能力的路径**：注册新能力声明 + 对应阶段工具与技能文件夹，无需改引擎与 UI 框架；本期不做能力的可视化注册/编排界面（见 2.3）。
- **命名边界**：UI、API、数据库对外统一使用"项目（project）"；"工作区"仅指项目的落盘目录与隔离边界，属内部技术概念（见 1.3）。

---

## 4. 仓库结构与接口契约

### 4.1 重建后的仓库结构

```
videoforge/
├── apps/
│   ├── web/          # Vue3 工作台（仅按 4.2-4.4 契约接入，交互另立专题）
│   ├── server/       # Fastify 单进程：http + domain + agent + workflow + trace
│   └── cli/          # 改造：运维入口（doctor / status / 运维小工具），不再暴露流水线命令
├── packages/
│   ├── shared/       # 领域类型、VideoForgeError 错误码、契约
│   ├── pipeline/     # 迁自 apps/server/src/pipeline（见第 10 节）
│   ├── renderer/     # 迁自 apps/server/src/renderer
│   └── template-sdk/ # 迁自 apps/server/src/template-sdk
├── config/           # default.yaml / system.local.yaml / profiles/ / prompts/
├── .pi/
│   └── settings.json # {"skills": ["../.trae/skills"]}
├── .trae/skills/     # 五个 SKILL.md 原地保留
├── docs/
└── tests/
```

**依赖方向**：`apps/cli` 与 `apps/server` 通过 `packages/*` 复用内核，替代现在 `@videoforge/server/src/...` 子路径导入，避免实现漂移。跨包依赖使用 `workspace:*`。

### 4.2 server 对用户 API

| 方法       | 路径                          | 说明                                                                     |
| ---------- | ----------------------------- | ------------------------------------------------------------------------ |
| POST       | `/api/auth/register`          | 注册（受 `server.allow_registration` 控制）                              |
| POST       | `/api/auth/login`             | 登录，返回 JWT                                                           |
| POST       | `/api/auth/logout`            | 登出                                                                     |
| GET        | `/api/auth/me`                | 当前用户信息（含 `role` 与 `mustChangePassword` 标志，见 8.1）           |
| POST       | `/api/auth/password`          | 修改密码                                                                 |
| GET        | `/api/capabilities`           | 能力列表（能力注册表只读视图，见 3.6）                                   |
| GET / POST | `/api/projects`               | 列出 / 新建项目（新建必须指定 `capabilityId`，自动建会话并创建首个 run） |
| GET        | `/api/projects/:id`           | 项目详情（状态、分镜、产物索引）                                         |
| GET / POST | `/api/projects/:id/sessions`  | 列出 / 新建会话                                                          |
| POST       | `/api/sessions/:id/messages`  | 发送用户消息（自由对话；审核点讨论也走这里）                             |
| GET        | `/api/sessions/:id/events`    | SSE 事件流（事件类型见 4.4）                                             |
| POST       | `/api/sessions/:id/abort`     | 中断当前自由对话轮                                                       |
| POST       | `/api/projects/:id/runs`      | 发起 run（从断点续跑；已有活跃 run 时返回 `PROJECT_BUSY`）               |
| GET        | `/api/projects/:id/runs`      | 项目的 run 列表                                                          |
| GET        | `/api/runs/:id`               | run 详情（含各阶段状态与耗时）                                           |
| POST       | `/api/runs/:id/resume`        | 审核点确认 / 失败续跑；`{action: "approve" \| "retry", feedback?}`       |
| POST       | `/api/runs/:id/cancel`        | 取消运行中的 run                                                         |
| GET        | `/api/runs/:id/trace`         | run 的完整 trace（stages + tool_calls + llm_calls，分页）                |
| GET        | `/api/projects/:id/artifacts` | 产物清单：分镜/图片/音频/时间轴/成片                                     |
| GET        | `/api/media/*`                | 媒体读取（校验路径归属后返回）                                           |

### 4.3 管理 API（仅 `role=admin`）

| 方法 | 路径                                  | 说明                                                              |
| ---- | ------------------------------------- | ----------------------------------------------------------------- |
| GET  | `/api/admin/users`                    | 用户列表（不含密码哈希）                                          |
| POST | `/api/admin/users/:id/reset-password` | 重置他人密码（等价 `db:user --reset-password` 的在线版）          |
| GET  | `/api/admin/projects`                 | 全站项目列表（只读）                                              |
| GET  | `/api/admin/runs`                     | 全站 run 列表（只读，可按 `status` / `errorCode` 过滤，面向监控） |
| GET  | `/api/admin/runs/:id/trace`           | 任意 run 的完整 trace（只读，面向自进化分析）                     |

非 admin 访问一律返回 `AUTH_FORBIDDEN`。admin 无写入他人项目、代发消息等能力；管理页面不做，Web 侧先以只读视图消费（见 8.2）。

**约定**：API 与 SSE 客户端使用相对路径，不在前端硬编码主机名或端口；`VITE_API_BASE` 仅作部署覆盖。

### 4.4 SSE 事件契约

| 事件          | 载荷                                                       | 用途                                                                                                     |
| ------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `text_delta`  | `{text}`                                                   | agent 流式文本                                                                                           |
| `tool_start`  | `{toolCallId, tool, args}`                                 | 渲染工具调用卡片                                                                                         |
| `tool_end`    | `{toolCallId, ok, errorCode?, artifactPaths?, durationMs}` | 卡片收尾、刷新产物                                                                                       |
| `turn_end`    | `{message}`                                                | 一轮对话结束                                                                                             |
| `run_start`   | `{runId, trigger, fromStage}`                              | run 开始及断点位置                                                                                       |
| `run_stage`   | `{runId, stage, status, attempt, errorCode?}`              | 阶段状态流转（pending/running/done/failed/skipped；`waiting_review` 是 run 状态，由 `review_gate` 表达） |
| `review_gate` | `{runId, stage, summary}`                                  | 到达审核点，等待用户确认                                                                                 |
| `run_end`     | `{runId, status, errorCode?}`                              | run 结局（done/failed/canceled）                                                                         |
| `resync`      | `{reason}`                                                 | 重连时缺失事件超出 server 缓冲，提示前端全量重载                                                         |
| `error`       | `{code, message}`                                          | 透传 `VideoForgeError`                                                                                   |

事件均带 SSE `id`（等于落库后的主键 id），供 `EventSource` 重连时以 `Last-Event-ID` 续传；server 为每个会话保留最近 200 条已落库事件的内存环形缓冲，超出缓冲则先发 `resync`。

### 4.5 错误码约定

统一形制 `VideoForgeError(code, message)`：HTTP 错误响应体为 `{error: {code, message}}`，SSE 经 `error` 事件透传，CLI 原样输出到 stdout JSON，阶段工具透传为 `tool_end.errorCode`（见 5.4）。本方案涉及的错误码：

| 错误码                                                             | HTTP | 含义                                                                  |
| ------------------------------------------------------------------ | ---- | --------------------------------------------------------------------- |
| `AUTH_INVALID`                                                     | 401  | 令牌缺失 / 过期 / 签名不符（见 8.1）                                  |
| `AUTH_FORBIDDEN`                                                   | 403  | 无权限、越权访问、注册关闭、保留用户名（见 8.3）                      |
| `PROJECT_BUSY`                                                     | 409  | 项目已有活跃 run，租约冲突（见 8.4）                                  |
| `RUN_STATE_INVALID`                                                | 409  | 非法 run 状态流转，如对 `done` 的 run 调 `resume`（见 6.2）           |
| `CONFIG_INVALID`                                                   | 400  | 配置或参数非法；启动期校验失败则拒绝启动，无 HTTP 语义（见 8.1、5.4） |
| `TOOL_UNAVAILABLE` / `ADAPTER_FAILED` / `ADAPTER_PROTOCOL_INVALID` | 500  | 内核外部进程 / 网络 / 协议失败，由阶段工具原样透传（见 5.4）          |

- `INTERRUPTED` 不是 API 错误码，仅作为 `runs.error_code` 值标记进程重启导致的中断（见 6.5）。
- 原双进程方案的 `HARNESS_UNAVAILABLE` 随单进程化移除，不再存在（见 3.1）。

---

## 5. Agent 运行时设计

### 5.1 运行时与并发

- **进程内常驻**：`Map<sessionId, { session: AgentSession, userId, projectId, projectDir }>`。
- **会话内串行**：由 Pi 的消息队列保证（`steer` / `followUp` 语义沿用）。
- **会话间并行**：不同会话可同时运行；**同一项目同一时刻只允许一个活跃 run**（租约见 8.4）。
- **阶段工具内部限并发**：全局信号量，上限由 `runtime.max_concurrent_stage` 控制（默认 1，避免 ffmpeg / Chromium 争抢资源）。
- **单进程防护**：工具 handler 全部 `try/catch` 兜底为 `tool_end.ok=false`（异常不冒泡拖垮进程）；渲染/合成阶段设超时（代码常量，不进配置），超时按 `TOOL_UNAVAILABLE` 收尾。

### 5.2 会话生命周期

- **创建**：随项目创建或用户显式新建会话时建立，注入 `projectDir`、`modelId` 与历史消息。
- **恢复**：进程重启导致运行时丢失时，用已落库的历史消息重建 `session.agent.state.messages`（含 role=system 的引擎指令消息，脉络完整）。若该方式不足以还原上下文，退化为"落 Pi session 文件 + 重启时回读"（见 14.3，需在实施首日验证）。
- **销毁**：会话空闲超时或显式删除；产物文件不随会话销毁。

### 5.3 模型接入

- 用 Pi 的 `AuthStorage` / `ModelRegistry` 注册一个指向 Ark Agent Plan 端点的 provider：
  - `base_url`：`https://ark.cn-beijing.volces.com/api/plan/v3`（**必须**，改为 `/api/v3` 会产生额外费用）。
  - API 类型：OpenAI 兼容（`openai-completions`）。
  - 模型 ID：取 `engines.endpoints.ark.chat_model`。
  - API Key：只从环境变量 `ARK_API_KEY` 读取。
- **该 provider 由我们自实现**（不依赖 Pi 内置 Ark 适配），因此请求/响应天然经过自有代码——LLM 全文留痕在 provider 层统一埋点（见 7.2），无需 Pi 暴露钩子。
- **风险提示**：Pi 的 provider 注册机制与 Ark Agent Plan 端点的兼容性需在实施首日核对；若不兼容，改用 `ModelRegistry.find` + 自定义 provider 实现（见 14.1）。

### 5.4 工具集

**Pi 内置工具**：`read`、`grep`、`find`、`ls`，以及 **默认放开的** `bash`、`write`、`edit`。会话的 `cwd` 设为该项目目录，因此 agent 可以直接 `read copy.json` 自查进度，也能用 `bash` 做诊断（如 `ffprobe`、`ls` 中间产物）。

放开策略由 `agent.allow_shell_write_edit` 控制（默认 `true`）；设为 `false` 时只保留只读内置工具与 7 个阶段工具。

**7 个自定义阶段工具**（TypeBox schema 定义，handler 直接调用内核，不 spawn 子进程）：

| 工具                  | 参数                           | 产出                             |
| --------------------- | ------------------------------ | -------------------------------- |
| `copy_generate`       | `topic`, `style`, `promptSet?` | `copy.json`                      |
| `image_generate`      | `{}`                           | `images/<sceneId>.png`           |
| `scene_generate`      | `{}`                           | `scenes/<sceneId>.html`          |
| `tts_generate`        | `speaker?`                     | `audio/<sceneId>.mp3`            |
| `storyboard_generate` | `{}`                           | `timeline.json`                  |
| `render_frames`       | `profile`                      | `build/render/<profile>/frames/` |
| `compose_video`       | `profile`                      | `final.mp4`                      |

`profile` 取值限定为 `config/profiles/` 下已存在的输出 Profile 名（当前为 `landscape-1080p` 与 `portrait-1080p`），非法值一律返回 `CONFIG_INVALID`。工作流引擎下发指令时从 `projects.profile` 注入该参数（见 6.3）。

**路径与安全边界**：

- 7 个阶段工具的参数中**不含任何路径**，项目目录由运行时从会话上下文注入，落盘路径统一走 `packages/pipeline/path-safety.ts` → 阶段工具本身无法越界。
- `bash` / `write` / `edit` 默认放开后，agent 具备任意读写能力，**越界防护不再由工具签名保证**。当前缓解手段：进程 `cwd` 固定为项目目录、服务仅监听 `127.0.0.1`、用户数据按 `userId` 分目录、必要时用 `agent.allow_shell_write_edit: false` 一键收紧。
- **所有工具调用（含 `bash` / `write` / `edit`）都写入 `tool_calls`**，命令原文、退出码与耗时一并留痕，保证审计链完整（见 7.3）。

**错误映射**：内核抛出的 `VideoForgeError(code, message)` 原样作为 `tool_end.errorCode` 回传，agent 可据此按 SKILL.md 的失败排查段落自救或转告用户。

### 5.5 技能注入

- `.pi/settings.json` 中声明 `{"skills": ["../.trae/skills"]}`，SKILL.md **原地保留**。
- 这样 Trae（外部 harness）与自带运行时**共用同一套 skill**，不存在两份维护。
- 唯一改动：SKILL.md 中的命令示例从 `pnpm --filter @videoforge/cli start xxx --...` 改为"调用 `xxx` 阶段工具"；其余（前置条件、契约说明、失败排查、产物位置、下一步）保持不变。
- 采用 Pi 的渐进式披露：系统提示中只常驻每个 skill 的 `name` + `description`，agent 按需 `read` 完整 SKILL.md。
- **skill 扩展**：在 `.trae/skills/` 新增"文件夹 + SKILL.md"即被运行时自动发现，无需改代码；这是保留的核心扩展点。

### 5.6 系统提示

用 `DefaultResourceLoader({ systemPromptOverride })` 注入：

1. 角色：视频流水线操作员，面向科普/历史短视频。
2. 工作目录约定：产物布局、`final.mp4` 命名要求。
3. **引擎纪律**：阶段顺序与推进由工作流引擎决定；收到阶段指令时只执行该阶段、只调用对应阶段工具；不自行跳阶段、不盲跑全链路。
4. 输出纪律：不向用户复述密钥；失败时给出错误码与下一步建议。
5. **行为边界**：只在当前项目内写入；不修改仓库源码与配置文件；不读取或回显 `.env.local` 内容；不删除项目以外的任何文件。

---

## 6. 工作流引擎

### 6.1 七阶段 DAG

阶段为线性链（无分支），由能力声明定义（见 3.6，含是否审核点、对应阶段工具、产物判据）：

```
copy → image → scene → tts → storyboard → render → compose
 │       │
 └───────┴── 审核点（waiting_review）：文案确认、配图确认
```

- 每阶段的"完成判据"是**产物文件存在且通过契约校验**（如 `copy.json` 通过 copy-contract 校验），与 `project:verify` 的判据一致，不靠 agent 口述。
- `render` / `compose` 的 `profile` 参数取自 `projects.profile`（创建项目时选定，默认 `landscape-1080p`）。

### 6.2 run 与阶段状态机

**run 状态机**：

| 状态             | 进入条件                                                                      | 退出条件                                                                                             |
| ---------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `queued`         | 创建后等待引擎调度（阶段并发信号量）                                          | 获得执行位 → `running`                                                                               |
| `running`        | 有阶段在执行                                                                  | 到达审核点 / 全部完成 / 失败 / 取消                                                                  |
| `waiting_review` | 审核点阶段 `done`                                                             | 用户 `resume(approve)` → `running`；`resume(retry)` → `running`（重跑该阶段）；`cancel` → `canceled` |
| `done`           | 七阶段全 `done` 且 `final.mp4` 存在                                           | 终态                                                                                                 |
| `failed`         | 阶段失败且达重试上限，或用户 `resume` 前主动放弃                              | 用户 `resume(retry)` → `running`（从失败阶段续跑）                                                   |
| `canceled`       | 用户 `cancel` 或进程重启时处于 `running`（标记 `error_code = 'INTERRUPTED'`） | 用户重新发起 run（从断点续跑）                                                                       |

**阶段（run_stages）状态机**：`pending → running → done | failed | skipped`；审核点阶段 `done` 后触发 run 进入 `waiting_review`。`skipped` 用于断点续跑时跳过产物已存在的阶段。

- 非法状态流转（如对 `done` 的 run 调 `resume`）返回 `RUN_STATE_INVALID`。
- run 是项目租约的载体：`queued` / `running` / `waiting_review` 均为活跃态，持有项目租约（见 8.4）。

### 6.3 引擎与 agent 的分工

| 方           | 负责                                                                                 | 不负责                       |
| ------------ | ------------------------------------------------------------------------------------ | ---------------------------- |
| 引擎（代码） | 阶段顺序、断点选择、状态推进、审核点暂停、重试上限、租约与并发                       | 不直接调内核、不生成内容     |
| agent（LLM） | 接收阶段指令并调用对应阶段工具、按 SKILL.md 失败自救、面向用户的进度叙述与审核点讨论 | 不决定阶段顺序、不跳过审核点 |

- **阶段指令**：引擎向会话注入 role=system 消息（落库，如"执行 copy 阶段：调用 `copy_generate`，topic=… style=… promptSet=…"），agent 以 `steer` 语义接收。指令落库使历史重建（5.2）与 trace 回放（7.5）都能看到完整脉络。
- **软约束**：阶段期靠系统提示纪律约束 agent 只调对应工具；不做工具白名单硬约束——乱调的代价仅是重跑覆盖产物，且全部留痕可审计。若实际运行中发现互踩，再评估加白名单（见 14.6）。
- **自由对话**：无活跃运行中阶段时（如 `waiting_review`、`failed`、`done`），用户可随时发消息与 agent 讨论（改文案、问进度）；agent 的修改类请求通过重跑对应阶段落实。

### 6.4 审核点

- 审核点固定在 `copy`、`image` 两个阶段之后（与阶段定义表同行配置，可调）。
- 到达审核点：run → `waiting_review`，SSE 发 `review_gate`（含该阶段产物摘要），agent 同时在对话中给出确认请求。
- 用户确认路径：`POST /api/runs/:id/resume` —— `approve` 继续；`retry` 重跑该阶段（可带 `feedback` 文本，注入会话供 agent 参考，如"文案再口语化一点"）。
- 等待期间项目租约仍被持有（不可发起新 run），但自由对话畅通。

### 6.5 失败重试与断点续跑

- **阶段内自救**：工具返回 `errorCode` 后，agent 按对应 SKILL.md 的失败排查段落自动重试，上限 `workflow.max_stage_retry`（默认 2）；超限则阶段 `failed`、run `failed`。
- **断点判据**：重新发起或 `resume(retry)` 时，引擎按阶段顺序扫描产物文件存在性，从第一个未达标阶段开始；产物已存在的阶段标记 `skipped`。**以文件为唯一断点依据**，与 `done` 判据（`final.mp4` 存在）哲学一致。
- **进程重启**：server 启动时把 `status = 'running'` 的 run 重置为 `canceled`（`error_code = 'INTERRUPTED'`），内存会话按 5.2 重建；用户一键续跑即可从断点继续。`waiting_review` 的 run 不受影响（本就活着，等用户确认）。

---

## 7. Trace 与日志

### 7.1 三级留痕模型

```
run（一次任务运行，见 runs 表）
└─ run_stage（阶段实例，见 run_stages 表）
   ├─ tool_calls（工具调用：阶段工具 + bash/write/edit/read 等全部内置工具）
   └─ llm_calls（LLM 请求：全文 prompt/response + token + 耗时）
```

- 自由对话（无 run）产生的 `tool_calls` / `llm_calls` 的 `run_id` / `stage_id` 为空，仅挂 `session_id`——对话与任务共用一套留痕体系。
- 字段命名向 OTel 靠拢（`trace` 以 `run_id` 串联、`stage_id` 相当于 parent span），但不引入 OTel SDK 与导出器；未来如需对接，写导出脚本读表即可。
- **双写**：三级记录落 SQLite 的同时，追加写入 `<项目>/trace.jsonl`（每行一条 JSON，字段与表一致），供外部工具与自进化离线分析直接消费，无需连库。**原 `<项目>/run-log.jsonl` 被 `trace.jsonl` 取代**（避免两处记录同一事实）。

### 7.2 LLM 调用全文留痕

- 埋点位置：自实现的 Ark provider 层（见 5.3），每次请求记录 `llm_calls` 一行：`model`、`request_json`（messages 全文）、`response_json`（含 finish_reason）、`prompt_tokens` / `completion_tokens`、`duration_ms`、`ok` / `error_code`。
- **全文默认开启、不提供开关**（本次确认决策）：自进化分析依赖完整语料；存储膨胀风险见 14.5。
- 请求/响应落库前过脱敏器（见 7.4），确保 `ARK_API_KEY` 等值不出现在语料中。

### 7.3 工具调用留痕

- 每次工具调用（含 Pi 内置工具）记录 `tool_calls` 一行：`tool`、`args_json`、`ok`、`error_code`、`duration_ms`、`artifact_paths`。
- `bash` 记录命令原文与退出码；`write` / `edit` 记录目标路径（相对项目目录）。
- 工具卡片 UI、审计链、自进化的"工具失败率/耗时分布"分析共用此表。

### 7.4 结构化日志与脱敏

- server 保持结构化日志（JSON 行），保留"stdout 机器可读、诊断走 stderr"的 CLI 约定。
- 统一脱敏器：对 `ARK_API_KEY`、`JWT_SECRET`、admin 初始密码等已知敏感值（含其常见环境变量名的赋值形态）做子串替换后输出；**日志、trace、数据库、manifest 中不得出现密钥与密码哈希**。
- trace 表与 `trace.jsonl` 同样过脱敏器。

### 7.5 面向自进化的数据契约

本设计刻意保证以下问题可直接用 SQL 或解析 `trace.jsonl` 回答，作为未来自进化的最小数据基础：

1. 哪个提示词集 / 风格 / 模型的失败率高（`llm_calls` × `run_stages.error_code`）。
2. 哪个阶段最耗时、重试最多（`run_stages.attempt` / `duration` 分布）。
3. 失败时 agent 的自救路径长什么样（`llm_calls.request_json` 全文 + `tool_calls` 序列回放）。
4. 用户干预点分布（`review_gate` 后 `retry` 比例、`feedback` 文本聚类）。
5. token 消耗与项目产出的关系（成本核算）。

实施时不得为满足短期需求删改上述字段；新增字段保持追加式。

---

## 8. 多用户与权限

本章回答三个问题：**谁是谁**（8.1 鉴权、8.2 角色）、**谁能看到什么**（8.3 数据隔离）、**同一份产物被并发写怎么办**（8.4 多项目与状态机）。

### 8.1 鉴权

**令牌**

- 登录成功返回 `{ token, user }`；由 `@fastify/jwt` 签发 HS256 access token，载荷只放 `{ sub: userId, username, role, iat, exp }`——角色随令牌下发以省一次查库，密钥绝不入载荷。
- 有效期由 `server.access_token_ttl` 控制（默认 `12h`）。**刻意不引入 refresh token**：本机单机部署，续期机制的成本高于收益，过期即重新登录。
- 前端 token 存 `localStorage`（键 `vf.token`），统一注入 `Authorization: Bearer <token>`；token 不得出现在 URL、cookie、日志或事件载荷中。
- 校验失败（缺失 / 过期 / 签名不符）统一返回 `AUTH_INVALID`（HTTP 401）；前端拦截 401：清 token → 跳登录页。
- **登出**：仅清前端 token，服务端不做黑名单（无状态 JWT 的已知取舍）。**改密后已签发令牌在过期前仍然有效**，该边界需在操作者文档中显式声明，不表述为"改密即踢出所有会话"。

**密码**

- 哈希：`node:crypto` 的 `scrypt`（零原生依赖，避免 Windows 上原生模块的构建问题）；参数 `N=16384, r=8, p=1`，salt 16 字节随机且逐用户独立。
- 存储格式：`scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>`，便于日后调整参数而不破坏旧记录。
- 校验用 `timingSafeEqual`，避免时序侧信道。
- 策略：长度 8..128，允许任意可打印字符；**不强制大小写/符号复杂度**（本机工具，复杂度策略只增加摩擦而无实际收益）。
- 登录节流：同一 `username` 连续失败 5 次后，60 秒内一律拒绝（进程内计数、不落库、重启清零）。阈值与窗口为代码常量，不进配置。

**内置管理员账号**

- **初始化时机与幂等**：server 每次启动、数据库迁移完成后执行幂等初始化——`users` 表不存在 `username='admin'` 时创建该账号（`role = 'admin'`）；已存在则**原样跳过**，不重置密码、不改写任何字段，避免重启把用户已改的密码冲掉。
- **初始密码来源**：读取环境变量（变量名由 `server.admin_password_env` 指定，默认 `VF_ADMIN_INITIAL_PASSWORD`）；变量未设置时回退到内置默认值 `mongoose-admin`。该变量**仅在首次创建 admin 时读取一次**，之后的改密与 `db:user --reset-password` 均不再读它；修改变量不影响已存在的账号。
- **存储与保密**：初始密码与其他密码一样经 scrypt 哈希后入库；明文只存在于环境变量与代码常量，不写入 YAML、日志、数据库明文、trace、manifest 或测试快照。默认值为弱口令，风险与缓解见 14.7。
- **首改引导**：admin 创建时 `must_change_password = 1`；`GET /api/auth/me` 返回该标志，由 Web 侧引导改密。**不强制拦截**——本机工具，强制改密只增加摩擦。
- admin 与普通账号同受登录节流约束（连续失败 5 次锁 60 秒），无例外。

**注册**

- `server.allow_registration` 默认 `true`；为 `false` 时 `/api/auth/register` 返回 `AUTH_FORBIDDEN`，注册入口显示"自助注册已关闭"。由于 admin 始终内置，关闭注册不再存在"无人能登录"的死局；此时新增普通用户改用 `apps/cli` 的 `db:user --create <username>`（见 3.5）。
- 用户名不区分大小写；`admin` 为保留名，注册时与"用户名已占用"一样返回 `AUTH_FORBIDDEN`，不通过错误码差异暴露"该名被保留"与"已被注册"的区别。
- 自助注册只能创建 `role = 'user'` 的账号；`role` 不可由注册/改密接口指定，仅 `db:user --create --role admin` 可创建额外管理员（本机操作者专属通道）。

**密钥**

- `JWT_SECRET` 只从环境变量读取（变量名由 `server.jwt_secret_env` 指定）；缺失或长度 < 32 时 server **启动即失败**并给出 `CONFIG_INVALID`。不现场生成随机密钥——否则每次重启令牌全部失效，行为不可预期。
- 密钥不得写入 YAML、日志、数据库、trace、manifest 与测试快照。

**内部信任边界**

- 单进程内不再有跨进程信任问题；`src/agent` / `src/workflow` 只接受 `src/http` 层完成鉴权后的 `actor`（`{userId, role}`）对象，模块间不传递令牌、不做二次鉴权。

### 8.2 角色（最简角色模型）

- `users.role ∈ 'admin' | 'user'`，默认 `'user'`；不引入权限矩阵、不做 RBAC 框架。
- **user**：完整使用自己的项目（对话、run、产物、trace），对他人资源一律不可见。
- **admin**：在 user 能力之上，额外开放 4.3 的只读管理 API（全站用户列表 / 项目 / run / trace）与"重置他人密码"——动机是任务监控与自进化分析需要全站视角，而不是赋予内容管理权。
- admin **不能**写入他人项目、代发消息、修改他人产物；数据隔离的四层规则对 admin 的写路径同样生效（见 8.3）。
- 管理页面不做（见 2.3）；Web 侧如需消费管理 API，仅做只读列表视图，归入 Web 专题。

### 8.3 数据隔离

**四层强制**（任一层的绕过都不足以越权）：

| 层     | 规则                                                                                                                                                                                                                                 | 失败返回                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| 查询层 | 仓储方法第一个参数固定为 `actor`（`{userId, role}`）；普通用户 SQL 一律写 `where id = ? and user_id = ?`，**禁止"先按 id 查、再在内存里判断归属"**；admin 只读跨越仅在 `/api/admin/*` 路由对应的专用仓储方法中放开，普通路由无此路径 | `AUTH_FORBIDDEN`              |
| 文件层 | 落盘路径只能由 `resolveUserProjectDir(storageRoot, userId, name)` 派生，禁止字符串拼接；写前由 `packages/pipeline/path-safety.ts` 复核仍在当前用户根内                                                                               | `PATH_OUTSIDE_STORAGE`        |
| 媒体层 | `/api/media/*` 只接受 `users/<当前 userId>/...` 形式相对路径，先校验归属再读文件（admin 也只读自己的媒体；全站分析走 trace 表，不走媒体层）                                                                                          | `PATH_OUTSIDE_STORAGE`（403） |
| 事件层 | `POST /api/sessions/:id/messages`、`GET /api/sessions/:id/events` 建立前先解析 `session → project → user`，不匹配直接拒绝，不建立 SSE 连接                                                                                           | `AUTH_FORBIDDEN`              |

- **越权语义**：跨用户访问一律返回 `AUTH_FORBIDDEN`，不区分"不存在"与"不属于你"，避免通过错误码差异枚举出他人资源 ID。
- **目录布局**：`storage/users/<userId>/projects/<项目名>/`；`userId` 用服务端生成的 UUID，**不用用户名做路径**（避免改名、重名与路径注入）。
- **项目名与路径安全**：名字由用户输入，server 校验为——去首尾空白与末尾点、长度 1..64、禁止路径分隔符（`/` `\`）、禁止 `..`、禁止 Windows 保留字符（`: * ? " < > |`）与控制字符、落盘前做 Unicode NFC 归一化；**允许中文与空格**（沿用现有路径兼容性要求）。同名冲突时服务端追加 `-2`、`-3`…，并以 `unique(user_id, name)` 约束用户范围内的唯一性。
- **测试要求**：用户 A 用 B 的 projectId / sessionId / runId / 媒体相对路径访问，必须全部失败；普通用户访问 `/api/admin/*` 必须全部失败（见 13.1）。

### 8.4 多项目

**基数与名额**

- 一个用户有 0..N 个项目；一个项目有 0..N 个会话与 0..N 个 run；单用户项目数量上限 `server.max_projects_per_user`（默认 50，防止误操作刷满磁盘），超限返回 `CONFIG_INVALID`。
- 项目间无共享状态、无跨目录读写；本期不做项目重命名（目录名即唯一标识）、不做删除与导入导出。

**并发写保护**

- **同一项目同一时刻只允许一个活跃 run**（`queued` / `running` / `waiting_review`，避免两个 agent 同时写 `copy.json` 造成产物互踩）；server 在创建 run 前检查，冲突返回 `PROJECT_BUSY`（HTTP 409），前端提示"该项目有任务正在运行"。
- 租约由 `runs.status` 落库表达（单进程，无需额外内存 Map）；`waiting_review` 同样持有租约——等待确认期间不允许发起新 run，但自由对话不受影响。
- **重启解锁**：server 启动时把 `status = 'running'`（及残留 `queued`）的 run 重置为 `canceled`（`error_code = 'INTERRUPTED'`），避免进程异常退出后项目被永久锁死；`waiting_review` 不重置（见 6.5）。

**项目状态机**

| 状态      | 进入条件                                                         | 退出条件                                |
| --------- | ---------------------------------------------------------------- | --------------------------------------- |
| `draft`   | 创建后尚无任何 run                                               | 首个 run 受理 → `running`               |
| `running` | 存在活跃 run（`queued` / `running`）                             | run 进入 `waiting_review` / 终态        |
| `review`  | 最近 run `waiting_review`，或 run 结束且项目内**无** `final.mp4` | 用户继续 → `running`；产物补齐 → `done` |
| `done`    | 项目内存在 `final.mp4`                                           | 仅当文件被运维清除 → 回到 `review`      |
| `failed`  | 最近 run 以 `failed` 收场且用户未重试                            | 用户重试 → `running`                    |

- 推导统一实现在 server 的 `project-status.ts`，输入为 `runs` + `run_stages` + 产物索引，输出状态；**前端只渲染、不推导**，避免两处规则漂移。
- `done` 以"文件存在"为唯一判据，不由 agent 文本或用户点击决定。

---

## 9. Web 界面（专题占位）

本文档不展开 Web 交互设计；工作台（布局、组件、交互、视觉、响应式）另立专题细化。本文档只约束**消费方契约**，Web 专题不得突破：

1. 仅消费 4.2-4.4 的 REST + SSE；相对路径，不硬编码主机端口，`VITE_API_BASE` 仅作部署覆盖。
2. token 存 `localStorage`（键 `vf.token`），401 → 清 token → 登录页；`mustChangePassword` 与 `role` 从 `GET /api/auth/me` 读取。
3. SSE 重连遵守 `Last-Event-ID` + `resync` 协议（见 4.4）。
4. 项目状态、run 进度、阶段卡片、trace 视图一律渲染服务端数据，不在前端推导状态机。
5. 沿用 Vue SFC、`global.css` 与可访问性约定（键盘可达、ARIA、`prefers-reduced-motion`）；不为单个控件引入新 UI 依赖。

---

## 10. 删除 / 保留 / 迁移清单

### 10.1 删除

- `apps/worker/` 全部（未接入调度循环）。
- `adapters-python/`（Edge TTS 声音目录适配器）。
- `apps/server/src/voice-service.ts`。
- Web：`views/{ProjectsView,BuildDetailView,ReviewView,TraceView,VoicesView}.vue`、`stores/builds.ts`（注：`TraceView` 为旧 Build 领域视图，删除；新 trace 视图随 Web 专题重建）。
- server：`db/repositories/{build,event,task,voice}-repository.ts`。
- `apps/server/src/pipeline/quality.ts`、`apps/server/src/pipeline/manifest.ts`（旧 Build 快照与质检领域）。
- `apps/server/src/pipeline/run-log.ts`（`run-log.jsonl` 被 `trace.jsonl` 取代，见 7.1）。
- 旧 schema 表：`projects`（旧 Build 领域的项目表；与新模型 `projects` 表同名但语义不同，重建 schema 时直接同名替换，迁移时勿沿用旧数据）、`content_versions`、`builds`、`tasks`、`artifacts`、`build_events`、`quality_results`、`reviews`、`metric_snapshots`、`tts_voices`、`tts_catalog_state`、`tts_preview_cache`。
- `apps/cli/src/video-commands.ts` 及其测试（7 个流水线命令交给阶段工具承载，见 3.5）。
- 上述模块对应的单测与集成测试文件，实施时以"被删模块是否仍被引用"为准逐一核对，不做一次性批量删除。

### 10.2 迁移到 `packages/`

**`packages/pipeline`**：`ark-client.ts`、`env.ts`、`config.ts`、`path-safety.ts`、`copy-contract.ts`、`media.ts`、`compose.ts`、`timeline.ts`、`artifact-store.ts`、`prompts.ts`。

**`packages/renderer`**：`render.ts`、`render-sequence.ts`、`stage.html`。

**`packages/template-sdk`**：`contracts.ts`、`scene-contract.ts`、`minimal-scene.ts`、`gsap-vendor.ts`、`index.ts`。

**`packages/shared`**：保留 `errors.ts`、`contracts.ts`，裁剪 `domain.ts`（去掉 Build/Task/Review 领域类型）。

### 10.3 保留并改造

- `apps/cli`：**改造为运维入口**。按 3.5 删除 7 个流水线命令与 `video-commands.ts`，保留并改造 `doctor`，新增 `status` 与运维小工具；import 路径由 `@videoforge/server/src/...` 改为 `@videoforge/*`。
- `.trae/skills/*/SKILL.md`：仅改命令示例为阶段工具调用。
- `config/default.yaml`、`config/profiles/*`、`config/prompts/*`。
- `docs/guides/*`（按新架构与状态同步修订）。

---

## 11. 数据模型

SQLite + Drizzle，schema 重建（旧的 Build 领域表全部删除）。

| 表           | 字段                                                                                                                                                | 说明                                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`      | `id, username, password_hash, display_name, role, must_change_password, created_at, last_login_at`                                                  | 用户；`username` 不区分大小写唯一；`role ∈ admin\|user`（见 8.2）；`admin` 为内置保留账号（见 8.1）；`must_change_password` 在初始化/重置密码后置 1、改密成功后置 0                       |
| `projects`   | `id, user_id, capability_id, name, topic, style, profile, status, created_at, updated_at`                                                           | 项目；`capability_id` 引用能力注册表（当前仅 `video-generation`，见 3.6）；`status ∈ draft\|running\|review\|done\|failed`；`profile` 为输出 Profile 名（默认 `landscape-1080p`，见 6.1） |
| `sessions`   | `id, project_id, title, created_at, updated_at`                                                                                                     | 会话（纯对话容器；租约语义由 `runs` 承担，见 8.4）                                                                                                                                        |
| `messages`   | `id, session_id, run_id?, role, payload, created_at`                                                                                                | `role ∈ user\|assistant\|tool\|system`；引擎阶段指令落 `system`（见 6.3）；`run_id` 便于按 run 过滤叙述                                                                                   |
| `runs`       | `id, project_id, session_id, status, trigger, current_stage, error_code, created_at, started_at, ended_at`                                          | 任务运行；`status ∈ queued\|running\|waiting_review\|done\|failed\|canceled`；`trigger ∈ user\|retry\|resume`                                                                             |
| `run_stages` | `id, run_id, stage, status, attempt, error_code, artifact_paths, started_at, ended_at`                                                              | 阶段实例；`stage ∈ copy\|image\|scene\|tts\|storyboard\|render\|compose`；`status ∈ pending\|running\|done\|failed\|skipped`                                                              |
| `tool_calls` | `id, session_id, run_id?, stage_id?, tool, args_json, ok, error_code, duration_ms, artifact_paths, created_at`                                      | 全部工具调用留痕（含 `bash`/`write`/`edit` 等内置工具）；自由对话时 `run_id`/`stage_id` 为空（见 7.3）                                                                                    |
| `llm_calls`  | `id, session_id, run_id?, stage_id?, model, request_json, response_json, prompt_tokens, completion_tokens, duration_ms, ok, error_code, created_at` | LLM 调用全文留痕（见 7.2），落库前过脱敏器                                                                                                                                                |

**刻意不建** `events` 表与通用 `spans` 表：UI 时间线由 `messages` + `tool_calls` 推导，trace 层级由 `run_id` / `stage_id` 外键表达，避免多处记录同一事实。

`payload` / `args_json` / `request_json` / `response_json` / `artifact_paths` 存 JSON 文本；写入保持追加式（不覆盖历史结论）。

---

## 12. 配置变更

### 12.1 新增

| 配置项                         | 默认值                      | 说明                                                                                                                              |
| ------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `server.jwt_secret_env`        | `JWT_SECRET`                | JWT 密钥所在的环境变量名；密钥不得写入 YAML                                                                                       |
| `server.access_token_ttl`      | `12h`                       | 令牌有效期                                                                                                                        |
| `server.allow_registration`    | `true`                      | 是否开放自助注册；关闭后仅能由 `cli db:user --create` 建号                                                                        |
| `server.admin_password_env`    | `VF_ADMIN_INITIAL_PASSWORD` | admin 初始密码所在的环境变量名；变量未设置时回退内置默认值 `mongoose-admin`；仅首次创建 admin 时读取一次；属敏感值，不得写入 YAML |
| `server.max_projects_per_user` | `50`                        | 单用户项目数量上限（1-1000）；超限返回 `CONFIG_INVALID`                                                                           |
| `agent.allow_shell_write_edit` | `true`                      | 是否向 agent 放开 `bash` / `write` / `edit`；默认放开，安全性依赖审计留痕与提示词约束，见 5.4 与 14.6                             |
| `workflow.max_stage_retry`     | `2`                         | 阶段失败后 agent 自救重试上限（0-5）；超限 run 置 `failed`                                                                        |
| `runtime.max_concurrent_stage` | `1`                         | 阶段工具全局并发上限；默认 1 避免 ffmpeg/Chromium 争抢                                                                            |

### 12.2 删除

`runtime.worker_concurrency`、`python.*`、`engines.tts_default`、`engines.tts_voice_default`、`engines.t2i_default`。

### 12.3 约定

YAML 每个叶子字段必须带用途注释，注明单位/范围、空值默认行为、路径或敏感值的安全边界。`engines.endpoints.ark.base_url` 保持 `https://ark.cn-beijing.volces.com/api/plan/v3` 不变。

---

## 13. 测试策略

### 13.1 单元测试

- 鉴权：注册、登录、令牌校验、密码修改、越权访问。
- 角色：`role` 默认 `user`、注册不可指定角色、非 admin 访问 `/api/admin/*` 被拒、admin 只读跨越不放开写路径、`db:user --create --role admin` 通道。
- 隔离：项目/会话/run/媒体按 `userId` 隔离，路径越界。
- 鉴权补充：登录节流（连续 5 次失败后拒绝）、`JWT_SECRET` 缺失时启动失败、scrypt 哈希格式与 `timingSafeEqual` 校验；admin 初始化幂等（全新库创建、重启不覆盖已改密码）、默认初始密码可登录、`must_change_password` 标志流转（初始化/重置置 1、改密置 0）、保留名 `admin` 注册被拒、admin 同受节流。
- 项目：状态推导（`draft`/`running`/`review`/`done`/`failed`）边界用例、`PROJECT_BUSY` 并发拒绝（含 `waiting_review` 持租约）、server 重启后运行中 run 标记 `INTERRUPTED`、项目名校验（中文/空格/非法字符/重名后缀）、创建项目必须指定有效 `capabilityId`。
- 能力注册表：`GET /api/capabilities` 返回内置能力声明（阶段 DAG、审核点、参数契约完整）。
- 工作流引擎：run/阶段状态机全部合法流转与非法流转（`RUN_STATE_INVALID`）、断点选择（产物存在性扫描与 `skipped` 标记）、重试上限（`workflow.max_stage_retry`）、审核点暂停与 `resume(approve/retry)`、取消。
- Trace：`tool_calls` / `llm_calls` 字段完整性与 `run_id`/`stage_id` 挂接、自由对话留痕（`run_id` 为空）、`trace.jsonl` 双写一致、脱敏器对密钥形态的替换。
- SSE 重连：`Last-Event-ID` 命中缓冲时补发、超出缓冲时下发 `resync`。
- 阶段工具：7 个工具的参数 → 内核调用映射（mock 内核），错误码透传。
- 事件：SSE 事件映射与落库（`messages` / `tool_calls` / `run_stages`）。
- 会话恢复：用落库历史（含 role=system 阶段指令）重建运行时（mock Pi SDK）。
- 配置：`.pi/settings.json` 的 skill 发现路径、新旧配置项校验。
- CLI（运维入口）：`status` 在 server 不可用时的降级输出、`project:verify` 的一致性判定（缺文件、时长偏差）、`doctor` 的配置占位与 `base_url` 误改校验、流水线命令已移除（未知命令报错）。
- 工具放开策略：`agent.allow_shell_write_edit` 取 `true` / `false` 时的工具集差异、工具调用留痕与密钥脱敏。

### 13.2 集成测试

- 保留真 Chromium 渲染段（`tests/integration`，`pnpm test:smoke`，找不到本机 Chrome 时跳过，不进全量单测）。
- 新增：登录 → 建项目 → 自动首个 run → 收到 SSE 阶段事件 → 审核点暂停 → resume → 产物落盘 的最小闭环（模型用 mock provider，内核可 mock）。

### 13.3 手工验收（不写成已验收）

真实 Ark 端到端仍需用户先在 `config/system.local.yaml` 填真实 `chat_model`、在 `.env.local` 填 `ARK_API_KEY`，再手动跑通全链路。文档中必须保留"端到端冒烟尚未自动执行"的声明。

---

## 14. 风险与待验证项

| 编号 | 风险                                                                                               | 应对                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 14.1 | Pi 的 provider 注册机制与 Ark Agent Plan 端点兼容性未知                                            | 实施首日先做最小连通性验证；不兼容则改用 `ModelRegistry.find` + 自定义 provider（自实现 provider 同时承担 7.2 的埋点）                                                               |
| 14.2 | 单进程后 agent 运行时异常可能拖垮 server                                                           | 工具 handler 全量 try/catch 兜底、渲染/合成阶段超时上限（5.1）；重启后 run 标记 `INTERRUPTED` 可断点续跑（6.5）                                                                      |
| 14.3 | Pi 的会话恢复是否仅靠下发历史消息即可还原上下文                                                    | 首日验证；不足则退化为落 Pi session 文件 + 重启回读                                                                                                                                  |
| 14.4 | Pi 版本 API 稳定性（部分能力在生态中被标注 beta）                                                  | 锁定 `package.json` 版本；对 Pi 的调用集中在 `src/agent/pi/` 适配层，便于替换                                                                                                        |
| 14.5 | `llm_calls` 全文留痕导致存储膨胀（单次请求可达数十 KB）                                            | 仅本机单机、量级可控；`db:trace` 清理命令列入后续（本期手工 SQL 清理）；不为此牺牲自进化语料完整性                                                                                   |
| 14.6 | `bash` / `write` / `edit` 默认放开后，agent 可越出项目读写，且阶段期为软约束、可能不按引擎指令行动 | 工具调用全量留痕 + 输出脱敏；5.6 的系统提示注入行为边界与引擎纪律；`cwd` 锁定项目；保留 `agent.allow_shell_write_edit: false` 一键收紧；若实际互踩再评估阶段工具白名单               |
| 14.7 | admin 初始密码 `mongoose-admin` 是写进设计文档的公开约定，任何能访问本机回环端口的人都可尝试登录   | 仅监听 `127.0.0.1`；`must_change_password` 引导首次登录后改密；部署前可用 `server.admin_password_env` 指定的环境变量改为随机初始口令；忘记密码用 `db:user --reset-password` 本机救援 |
| 14.8 | 大规模重构期间的测试覆盖真空（大量旧测试被删除）                                                   | 按模块推进：先 packages 迁移并保持旧测试通过，再删旧领域，最后加新测试                                                                                                               |
| 14.9 | Windows 路径（中文、空格、正斜杠）在新目录层级下仍易出错                                           | 统一走 `path-safety.ts`；新增测试覆盖越界、空格、中文、分隔符                                                                                                                        |

---

## 15. 验收标准

1. `pnpm install && pnpm run doctor && pnpm test` 通过（新增单测覆盖第 13.1 节）。
2. `pnpm run server:dev` 单进程启动（agent 运行时内嵌，启动日志可见模型 provider 与工作流引擎就绪）；`pnpm run web:dev` 可按契约接入。
3. 两个用户各自注册登录，互相看不到对方的项目、run 与产物；普通用户访问 `/api/admin/*` 被拒。
4. 全新数据库首次启动后可用 `admin` / `mongoose-admin` 登录；改密并重启 server 后，初始密码不再生效、新密码可用（admin 初始化幂等）；admin 可读取全站 run 列表与任意 run 的 trace。
5. `GET /api/capabilities` 返回内置"短视频生成"能力声明（七阶段 DAG、审核点、参数契约）；通过 API + SSE 完成一次"主题 → 成片"run：七阶段按序推进，审核点在 copy、image 后暂停并可 `resume`，产出 `copy.json`、`images/`、`audio/`、`timeline.json`、`final.mp4`，成片时长与语音总长一致（±1 秒）。
6. 该 run 的 trace 完整可查：`run_stages` 记录各阶段状态与耗时、`tool_calls` 记录全部工具调用、`llm_calls` 记录全文请求/响应与 token，`<项目>/trace.jsonl` 与库内记录一致，且全链路无密钥明文。
7. run 运行中重启 server：该 run 标记 `canceled`（`INTERRUPTED`），重新发起后从断点续跑且不重复已达标阶段。
8. 旧模块（worker、adapters-python、Build/Review 页面与领域表、`run-log.jsonl`）已彻底移除，仓库无残留引用。
9. `apps/cli` 只剩运维入口：`doctor` 与 `status` 可正常执行，原流水线命令已不可用；`project:verify` 能对已完成项目给出通过结论。

---

## 16. 后续动作

1. 本设计通过评审后，转 `writing-plans` 生成实施计划（分阶段任务 + 验证方式）。
2. Web 工作台交互专题：在本文档契约（4.2-4.4、第 9 节）基础上细化布局、组件与交互。
3. 实施完成后重写 [项目搭建方案](本地视频流水线搭建方案.md)，使其描述新的目标架构，并同步修订 `docs/guides/developer-guide.md` 与 `docs/guides/operator-guide.md`。
