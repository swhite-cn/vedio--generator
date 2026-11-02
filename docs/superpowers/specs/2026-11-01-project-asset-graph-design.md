# 项目资产图谱与对话式素材协作设计

## 1. 目标与范围

本设计为 VideoForge 工作台增加“项目资产图谱”，让用户能在对话中引用项目既有产物，并把手工上传的文档、图片和背景音乐作为项目级长期资产使用。Agent 根据操作影响分级执行：只读与可逆局部改动可直接执行；会重新生成、渲染或合成的操作必须先由用户确认。

首期范围：

- 项目内持久化资产：流水线产物和用户上传文件统一建模；
- 对话输入的 `@` 引用与上传入口；
- 文档、图片、背景音乐上传、预览与引用；
- 将引用资产以结构化上下文传给 Agent；
- 提议 / 确认 / 执行的分级动作；
- 版本追加、执行留痕和项目隔离；
- 工作台右栏升级为项目资产视图。

首期不包含：

- 跨项目共享素材库、多人协作和资产权限委派；
- 在线编辑图片、音频、场景 HTML；
- 自动解析 Office 或 PDF 的全部复杂格式；
- 基于真实 Ark 的端到端多模态验收；该项仍需用户配置真实 Ark 模型后手动验证。

## 2. 现状与设计原则

当前系统已有“项目 → 会话 → run”的边界：`messages` 承载会话历史，`runs` / `run_stages` 描述确定性流水线，`tool_calls` / `llm_calls` / `trace.jsonl` 提供三级留痕。项目产物通过实际项目目录扫描组成 `ArtifactIndex`，但产物没有稳定资产 ID，也无法承接用户上传文件或一条消息对多个素材的引用。

本次设计遵循以下原则：

1. 资产记录追加式保存，重生成产生新版本，不覆盖旧资产；
2. 所有资产、引用、执行动作均限定在同一项目和当前 actor 的授权范围内；
3. Agent 只接收可解析、可审计的资产描述及受控路径，不接收用户拼接的本地绝对路径或命令；
4. 前端只渲染服务端给出的资产、执行计划与状态，不推导状态机；
5. 继续使用已有 Vue、Ant Design Vue、Fastify、SQLite、Drizzle 与 Pi Agent，不为该功能引入新的 UI 或存储依赖。

## 3. 领域模型

### 3.1 项目资产

新增 `project_assets` 表，项目级资产为一等领域对象，而不是复用 `run_stages.artifact_paths`。

| 字段 | 含义 |
| --- | --- |
| `id` | UUID，稳定资产标识 |
| `project_id` | 所属项目 |
| `source` | `generated` 或 `uploaded` |
| `kind` | `document`、`image`、`audio`、`copy`、`scene`、`timeline`、`video`、`frames` |
| `label` | 用户可见标题，上传时取安全化文件名，生成时取阶段与文件名 |
| `relative_path` | 相对项目目录的 POSIX 路径，唯一文件定位方式 |
| `mime_type` | 服务器识别或白名单映射出的 MIME 类型 |
| `size_bytes` | 文件大小，单位字节 |
| `run_id` | 生成资产关联的 run；用户上传为空 |
| `stage` | 生成资产对应流水线阶段；上传为空 |
| `supersedes_asset_id` | 新版本替代的旧资产，可为空，不删除旧版本 |
| `metadata_json` | 可选可展示元数据，例如图片尺寸、音频时长、文档摘要状态 |
| `created_at` | 创建时间 |

索引：`idx_project_assets_project_created(project_id, created_at)`、`idx_project_assets_run(run_id)`、`idx_project_assets_path(project_id, relative_path)` 唯一。

### 3.2 消息引用

新增 `message_asset_refs` 表，记录一条用户消息引用了哪些资产。

| 字段 | 含义 |
| --- | --- |
| `id` | UUID |
| `message_id` | 用户消息 |
| `asset_id` | 项目资产 |
| `ordinal` | 引用在消息中的顺序 |
| `created_at` | 创建时间 |

消息 payload 保持 Pi 兼容格式；引用关系由独立表承载，避免把资产路径散落在自由文本或不可查询的 JSON 中。

### 3.3 Agent 动作

新增 `agent_actions` 表，保存 Agent 对一次用户消息的结构化判定与结果。

| 字段 | 含义 |
| --- | --- |
| `id` | UUID |
| `project_id`、`session_id`、`message_id` | 归属链路 |
| `kind` | `analyze`、`reversible_edit`、`regenerate`、`render`、`compose` |
| `status` | `executing`、`waiting_confirmation`、`done`、`failed`、`canceled` |
| `plan_json` | 面向用户展示的影响说明、引用资产与预期输出 |
| `run_id` | 触发流水线时关联的 run，可为空 |
| `error_code` | 稳定错误码，可为空 |
| `created_at`、`updated_at` | 生命周期时间 |

确认动作不得直接改变既有 `runs` 状态；确认后由服务端创建新的 `run` 或受控局部动作记录，保持“项目 → 会话 → run”的边界。

## 4. 存储、上传与安全

用户上传仅写入当前项目目录下的受控 `assets/uploads/<asset-id>/`。生成资产继续保留在原有流水线目录；系统在阶段完成后增量登记或重新同步资产索引。

允许类型：

- 文档：`text/plain`、`text/markdown`、`application/pdf`；
- 图片：`image/png`、`image/jpeg`、`image/webp`；
- 音频：`audio/mpeg`、`audio/wav`、`audio/mp4`、`audio/ogg`。

上传服务端校验：

1. 必须通过 JWT actor 和项目归属校验；
2. 使用文件魔数或受控 MIME 识别，不仅信任文件扩展名；
3. 文件名经 `path-safety` 规范化，拒绝绝对路径、越界片段、Windows 保留设备名和可执行扩展名；
4. 以配置化单文件与单项目容量上限拒绝超限请求；配置叶子字段标注单位、范围、空值行为及路径安全边界；
5. 仅保存相对路径，媒体下载和预览继续使用既有媒体票据机制；
6. 日志仅记录资产 ID、类型、大小和项目 ID，不记录文件正文、令牌或密钥。

上传失败不产生资产记录；文件落盘和数据库登记使用可回滚的顺序，清理失败文件需记录结构化诊断但不泄露路径外信息。

## 5. HTTP 契约

新增资产路由，全部使用既有 `createAuthPreHandler`、actor-first 仓储与统一 `VideoForgeError`。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/projects/:id/assets` | 分页读取项目资产，支持 `kind`、`source` 查询筛选 |
| `POST` | `/api/projects/:id/assets/upload` | `multipart/form-data` 上传一个用户素材并返回资产 |
| `GET` | `/api/projects/:id/assets/:assetId` | 获取单条资产元数据，含归属校验 |
| `POST` | `/api/sessions/:id/messages` | 请求体扩展为 `{ text, assetIds?: string[] }`，写消息与引用关系后发送 |
| `GET` | `/api/sessions/:id/messages` | 每条用户消息额外返回 `asset_refs` 摘要，供历史回放渲染 |
| `POST` | `/api/agent-actions/:id/confirm` | 确认 `waiting_confirmation` 动作，创建关联 run 或启动局部动作 |
| `POST` | `/api/agent-actions/:id/cancel` | 取消尚未执行的待确认动作 |

`assetIds` 必须去重、上限受配置控制，并且所有资产必须属于会话所属项目；不存在或跨项目资产统一返回 `AUTH_FORBIDDEN`，不暴露他人资产是否存在。

新增错误码建议：

- `ASSET_TYPE_UNSUPPORTED`：文件类型不在白名单；
- `ASSET_TOO_LARGE`：单文件或项目总量超过限制；
- `ASSET_INVALID`：MIME、文件结构或路径安全校验失败；
- `ASSET_NOT_FOUND`：当前项目中找不到该资产；
- `ACTION_CONFIRMATION_REQUIRED`：尝试执行高影响动作但尚未确认；
- `ACTION_NOT_CONFIRMABLE`：动作已终结或不属于当前 actor。

## 6. Agent 架构

### 6.1 结构化上下文

消息接收端在落库后查询 `message_asset_refs`，把引用资产映射为受控上下文块，再交给 Pi 会话。每个资产块仅包含：

- 资产 ID、类型、展示名、相对路径、MIME、大小；
- 文档的已提取摘要或受限文本摘录；
- 图片、音频、场景和视频的可读取路径及基础元数据；
- 明确的权限声明：“仅可读取当前消息提供的资产和当前项目受控目录”。

Agent 不获得用户提交的绝对路径、shell 命令、上传原始文件名之外的文件系统范围，也不得读写仓库、配置或 `.env.local`。

### 6.2 动作分级

| 类别 | 典型动作 | 行为 |
| --- | --- | --- |
| 只读分析 | 总结文档、比较图片、分析配音或场景 | 直接执行并将结果作为 assistant 消息和 `agent_action` 留痕 |
| 可逆局部修改 | 保存新的提示、为资产标注用途、生成局部修改建议、创建新版本配置 | 直接执行；保留旧资产与变更记录 |
| 高影响动作 | 重生成文案、配图、场景、配音；更新时间轴；渲染、合成 | 先创建 `waiting_confirmation` 动作，在对话流展示确认卡 |

高影响确认卡必须呈现：动作摘要、引用资产、受影响阶段、是否新增或替代资产、预计将发起的 run。确认后才允许执行；拒绝或取消不会影响原资产与成片。

### 6.3 工具和工作流

新增资产工具必须由服务端显式注册并经过 `tool-trace` 包装，持续写入 `tool_calls` 与 `trace.jsonl`。工具分为：

- `list_project_assets`：只返回当前项目可引用资产；
- `inspect_project_asset`：读取受控资产并输出受限摘要；
- `prepare_asset_action`：产生分级计划和待确认动作；
- `apply_reversible_asset_action`：创建新版本或写入受控项目指令；
- `start_confirmed_asset_run`：只由确认路由调用，创建并触发现有工作流 run。

既有七阶段确定性工具不改变阶段顺序。高影响素材追问通过新的 run 触发点映射到受影响阶段及其后续阶段；具体“从哪一阶段断点续跑”应由工作流层的能力声明与产物有效性判定决定，而不是由前端或自由提示词决定。

## 7. 工作台交互与布局

### 7.1 桌面布局

保留顶栏和全局侧边栏。工作台采用紧凑的三块协同布局：

1. 左侧主区为对话流，保持历史消息、思考过程、工具组、审核卡与 SSE 更新；
2. 对话底部升级为“引用条 + 编辑器 + 工具栏”：已选择资产显示为可移除的芯片，`@` 唤起资产选择器，回形针按钮上传，发送按钮旁保留中断；
3. 右栏上方为阶段进度，右栏下方为“项目资产”面板，提供类型筛选、搜索、预览和“引用到对话”动作。

阶段进度不再与资产混淆；原 `ArtifactTabs` 的生成产物预览演化为项目资产面板中的筛选视图，并保持图片、音频、场景、时间轴、成片的既有预览能力。

### 7.2 资产引用

- 用户输入 `@` 后，弹出可键盘操作的选择器：按关键词搜索并按文档、图片、音频、场景、视频分组；
- 用户从右栏点击“引用”也可加入同一引用条；
- 上传成功后自动加入当前引用条，不自动发送；
- 芯片显示图标、标题、类型和移除按钮；删除芯片只取消当前草稿引用，不删除项目资产；
- 发送后，用户消息气泡显示资产摘要卡；历史回放继续通过服务端返回的 `asset_refs` 还原。

### 7.3 窄屏与可访问性

在小于 900px 的视口，保持“对话 / 进度 / 资产”顶部 Tab；输入区始终固定在对话 Tab 底部。选择器、上传触发器、预览和确认卡均具备可访问名称、键盘焦点、Enter / Escape 路径和适当 ARIA 状态。`prefers-reduced-motion` 下禁用非必要动画。

## 8. 版本与追溯

资产图谱中的所有关系均追加式写入：

- 生成资产以 `run_id`、`stage` 追溯到流水线；
- 用户上传资产以 `source=uploaded` 识别，保留上传时间和类型；
- 新版本通过 `supersedes_asset_id` 串联，旧版本保持可预览、可引用；
- 消息通过 `message_asset_refs` 追溯素材输入；
- Agent 通过 `agent_actions` 追溯决策、确认、run 和结果；
- 工具与模型调用继续通过既有三级 trace 留痕。

任何 UI 临时选中态、上传中的预览 URL 或尚未发送的草稿均不得被表述为已持久化资产或引用。

## 9. 测试与验收

### 9.1 服务端

- `project_assets`、`message_asset_refs`、`agent_actions` 的迁移、仓储、归属校验和版本链测试；
- 上传 MIME / 大小 / 文件名 / Windows 保留名 / 中文及空格路径 / 越界路径测试；
- 同一 actor 可读取所属项目资产，跨项目和跨用户访问均被拒绝；
- 发送消息时，资产 ID 校验、引用写入和 Pi 上下文拼装测试；
- 只读、可逆、高影响三类动作的状态转换、确认与取消测试；
- 新工具调用必须写入 `tool_calls` 和 `trace.jsonl`，且不写入敏感内容；
- 既有项目创建、run、审核和恢复测试全部保持通过。

### 9.2 前端

- 资产选择器搜索、键盘选中、移除芯片、右栏引用和上传成功自动引用测试；
- 上传中、失败、类型拒绝、容量超限和权限失败的可理解反馈；
- 历史消息引用资产卡回放；
- 高影响动作确认卡：确认、取消、执行中、失败和完成状态；
- 既有消息分组、思考过程、工具卡和审核卡不回归；
- 浏览器实测 1920px 桌面和约 390px 窄屏：侧边栏、Tab、输入区、上传、引用与确认路径均可用。

### 9.3 交付门禁

实现时先补相关 Vitest 测试，再运行相关测试、`pnpm test`、受影响应用构建和类型检查。需要真实 Ark 的多模态素材理解仅标注为手工验收项，不可将 mock 或 Chromium 冒烟表述为真实 Ark 端到端验证。

## 10. 文档同步

实现完成后更新：

- `docs/本地视频流水线Agent-v2.md`：数据模型、资产、Agent 动作和追溯边界；
- `docs/本地视频流水线Agent-web-v2.md`：工作台布局、资产交互和确认卡；
- `docs/guides/developer-guide.md`：上传限制、测试和配置；
- `docs/guides/operator-guide.md`：上传、引用、确认与版本回退的操作说明。
