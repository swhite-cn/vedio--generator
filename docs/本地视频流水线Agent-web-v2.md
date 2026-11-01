# 本地视频流水线Agent-web-v2：Web 工作台设计

> 本文是 [本地视频流水线Agent-v2](本地视频流水线Agent-v2.md)（下称"主文档"）的 Web 专题，细化其第 9 章留下的界面设计占位。
> 约束源：主文档 §4.2-4.5（REST / SSE / 错误码契约）、§6（工作流引擎与状态机）、§8（多用户与权限）、§9（消费方契约五条）。
> 本文档只描述设计与交互，不新增后端能力；凡后端契约未提供的数据，界面一律不展示。

---

## 1. 范围与约束

### 1.1 目标

为本机多用户提供平台能力的可视化工作台：在能力中心了解平台能做什么、按能力建项目、看 agent 跑七阶段、在审核点确认、查 trace、管账号。平台按"能力 → 项目 → 任务（run）"三层模型组织（主文档 §3.6），当前仅内置"短视频生成"一个能力，但信息架构已为后续新增能力预留，新增能力不改变页面结构。桌面浏览器优先，窄屏（约 390px）可用。

### 1.2 消费方契约（沿袭主文档 §9，不得突破）

1. 仅消费主文档 §4.2-4.4 的 REST + SSE；相对路径，不硬编码主机端口，`VITE_API_BASE` 仅作部署覆盖。
2. token 存 `localStorage`（键 `vf.token`）；401 → 清 token → 跳登录页；`mustChangePassword` 与 `role` 从 `GET /api/auth/me` 读取。
3. SSE 重连遵守 `Last-Event-ID` + `resync` 协议。
4. 项目状态、run 进度、阶段卡片、trace 视图一律渲染服务端数据，**不在前端推导状态机**。
5. 沿用 Vue SFC、可访问性约定（键盘可达、ARIA、`prefers-reduced-motion`）。

### 1.3 明确不做

- 项目/会话的删除、重命名之外的任何管理动作（本期无删除入口）。
- 能力的注册/编排界面（能力由后端注册表提供，界面只读展示，见主文档 §3.6）。
- 文件上传、素材库、模板市场、多 agent 配置界面。
- 暗色主题、国际化（界面文案仅简体中文）、移动端 App。
- 数据可视化图表（trace 视图用表格与时间轴，不引入图表库）。
- 任何写路径的管理操作（admin 仅有"重置密码"一个写操作，见主文档 §4.3）。

---

## 2. 技术选型与主题规范

### 2.1 组件库：Ant Design Vue 4.x

- 引入 `ant-design-vue@^4` + `@ant-design/icons-vue`，`ConfigProvider` 配 `zhCN` 语言包。
- 引入方式：全量注册（本机工具，包体积不敏感），不引按需加载插件，降低构建配置复杂度。
- 本需求由用户明确指定 Ant Design 风格，构成主文档 §9"不为单个控件引入新 UI 依赖"的例外；除组件库与图标外**不再引入其他 UI 依赖**。
- Markdown 渲染（assistant 消息）：用现有轻量方案或自实现受限渲染（段落/列表/代码块/加粗），不引入重型编辑器。

### 2.2 主题 token（ConfigProvider.theme）

| token          | 值        | 说明                            |
| -------------- | --------- | ------------------------------- |
| `colorPrimary` | `#1677ff` | Ant Design 默认蓝，不定制品牌色 |
| `borderRadius` | `6`       | 默认                            |
| `fontFamily`   | 系统栈    | 不引入 Web 字体                 |

布局尺度：顶栏高 48px；侧边栏宽 208px、可折叠到 48px；内容区最大宽 1440px、左右留白 24px；工作台页左右分栏 3:2（最小左栏 480px），窄屏转为 Tab 切换。

### 2.3 状态色映射（唯一权威表，全站统一用 Tag/Badge 渲染）

**项目状态**（主文档 §11 `projects.status`）：

| 状态      | 文案   | 颜色                         |
| --------- | ------ | ---------------------------- |
| `draft`   | 草稿   | default（灰）                |
| `running` | 运行中 | processing（蓝，带转动图标） |
| `review`  | 待审核 | warning（金）                |
| `done`    | 已完成 | success（绿）                |
| `failed`  | 失败   | error（红）                  |

**run 状态**（主文档 §6.2）：

| 状态             | 文案          | 颜色                                                                              |
| ---------------- | ------------- | --------------------------------------------------------------------------------- |
| `queued`         | 排队中        | default                                                                           |
| `running`        | 运行中        | processing                                                                        |
| `waiting_review` | 待审核        | warning                                                                           |
| `done`           | 已完成        | success                                                                           |
| `failed`         | 失败          | error                                                                             |
| `canceled`       | 已取消/已中断 | default（灰）；`error_code=INTERRUPTED` 时 Tooltip 注明"服务重启导致中断，可续跑" |

**阶段状态**（`run_stages.status`）：

| 状态      | 步骤条表现                                        |
| --------- | ------------------------------------------------- |
| `pending` | wait（灰）                                        |
| `running` | process（蓝，转动）                               |
| `done`    | finish（绿勾）                                    |
| `failed`  | error（红叉）                                     |
| `skipped` | finish + 虚线样式 + Tooltip"产物已存在，本次跳过" |

七阶段中文名固定：`copy 文案 / image 配图 / scene 场景 / tts 配音 / storyboard 时间轴 / render 渲染 / compose 合成`。

### 2.4 通用模式

- **空态**：`Empty` + 一句引导 + 主按钮（如"新建项目"）。
- **加载**：列表用 `Skeleton`，按钮操作用 `Button.loading`，SSE 流式区不遮罩。
- **失败**：整页失败用 `Result` + 重试按钮；操作失败用 `message.error`（内容含后端 `error.code`）。
- **危险/不可逆操作**：`Popconfirm` 二次确认（取消 run、重置密码）。
- **时间显示**：统一 `YYYY-MM-DD HH:mm:ss`，耗时显示 `mm:ss`。
- **文案语言**：全站简体中文；错误提示模板"操作失败：{message}（{code}）"。

---

## 3. 信息架构与路由

### 3.1 路由表

| 路径              | 页面                           | 可见性                           |
| ----------------- | ------------------------------ | -------------------------------- |
| `/login`          | 登录 / 注册                    | 未登录                           |
| `/capabilities`   | 能力中心（平台能力注册表视图） | 登录                             |
| `/projects`       | 项目列表                       | 登录                             |
| `/projects/:id`   | 工作台（项目详情）             | 登录，仅本人                     |
| `/runs/:id/trace` | run Trace 视图                 | 登录，仅本人；admin 可查任意 run |
| `/settings`       | 个人设置（修改密码）           | 登录                             |
| `/admin`          | 管理视图（三个只读 Tab）       | 仅 `role=admin`                  |

### 3.2 导航结构

- 顶栏：左侧产品名"VideoForge"（点击回 `/projects`）；右侧当前用户 `Dropdown`（个人设置 / 退出登录）。
- 侧边栏菜单：`能力中心`（`/capabilities`）、`项目`（`/projects`）、`管理`（`/admin`，**仅 admin 渲染**）。登录后默认落地 `/projects`。
- 未登录访问任意页 → 守卫跳 `/login`；登录后回跳原目标。
- 登录且 `mustChangePassword=true` → 所有路由守卫强制跳 `/settings?force=1`，该页只显示改密表单，改密成功前无法离开（主文档 §8.1 的首次登录改密引导）。
- 普通用户直接访问 `/admin` → 守卫拦截跳 `/projects`（不渲染菜单项是第一道，守卫是第二道）。

---

## 4. 全局布局

```
┌──────────────────────────────────────────────────────┐
│ 顶栏 48px：VideoForge            用户 Dropdown        │
├──────────┬───────────────────────────────────────────┤
│ 侧边栏    │  内容区（路由出口）                          │
│ 208px    │                                           │
└──────────┴───────────────────────────────────────────┘
```

- `/login` 无框架（独立全屏页）；`/projects/:id` 工作台页隐藏侧边栏（为对话流让出宽度），仅保留顶栏 + 返回链接。
- 响应式断点：< 768px 侧边栏折叠为抽屉；工作台左右分栏 < 900px 切换为顶部 Tab（对话 / 进度与产物）。
- 所有可交互元素键盘可达；`focus-visible` 有描边；动态区域（对话流、阶段状态）用 `aria-live="polite"`；`prefers-reduced-motion` 下关闭转动与过渡动画。

---

## 5. 页面详细设计

### 5.1 登录 / 注册（`/login`）

**目标**：账号密码登录；注册入口受 `server.allow_registration` 控制。

**布局**：全屏浅灰底，居中 360px 卡片（`Card`），顶部产品名与一句话说明，下方 `Tabs`：登录 / 注册。

**登录 Tab**：

- 字段：用户名、密码（`Input` / `Input.Password`，必填校验）。
- 提交 `POST /api/auth/login` → 存 `vf.token` → `GET /api/auth/me` 拉用户（含 `role`、`mustChangePassword`）→ 跳回目标页。
- 失败：`AUTH_INVALID` → 表单上方 `Alert`"用户名或密码错误"。

**注册 Tab**：

- 字段：用户名、显示名（可选）、密码、确认密码（二次一致校验、最小长度提示）。
- 提交 `POST /api/auth/register` 成功后自动登录。
- 注册被关闭（`AUTH_FORBIDDEN`）→ 隐藏注册 Tab，原位置显示"自助注册已关闭，请联系管理员创建账号"。
- 用户名为保留名或已占用时统一提示"该用户名不可用"（不区分原因，与主文档 §8.1 防枚举语义一致）。

**交互细节**：回车提交；提交中按钮 loading；连续失败不做前端计数（节流由服务端负责，收到 429/错误码时提示"尝试过于频繁，请稍后再试"）。

### 5.2 项目列表（`/projects`）

**目标**：我的项目总览 + 新建入口。项目是"能力 → 项目 → 任务（run）"三层模型的中间层：每个项目归属一个能力，项目内的每次执行是一个 run。

**布局**：页头（标题"项目" + 主按钮"新建项目"）+ 卡片栅格（`Row/Col`，每行 3 张，窄屏 1 张）。

**项目卡片**（`Card`）：

- 标题：项目名；副标题：主题（超长省略，Tooltip 全文）。
- **能力标签**：卡片右上角固定 `Tag`（蓝色）显示所属能力名（当前仅"短视频生成"）——让用户始终看到"项目是有类型的"，这是平台多能力扩展的可见锚点。
- 状态 `Tag`（按 §2.3 映射）+ 更新时间。
- 底栏：分镜数（来自详情接口的摘要字段，若列表接口不含则不显示）、成片就绪图标（`done` 时显示 ▶ 标记）。
- 整卡点击进 `/projects/:id`。

**新建项目**（`Modal`，两步）：

- 第一步**选择能力**：卡片式单选（`Radio.Group` 卡片样式），选项来自 `GET /api/capabilities`；当前仅"短视频生成"一项（默认选中），卡片展示能力说明与阶段预览（同 5.3 能力卡片的精简版）。能力列表加载失败时禁用"下一步"并提示。
- 第二步**填写参数**：名称（必填，校验中文/空格/非法字符规则与服务端一致）、主题（必填，`TextArea`）、风格（可选）、输出 Profile（`Select`，选项来自 `config/profiles/`——前端不硬编码，选项由项目详情/元数据接口提供；若契约未提供列表接口，则固定两项 `landscape-1080p` / `portrait-1080p` 并注明来源）。
- 提交 `POST /api/projects`（载荷含 `capabilityId`；服务端自动建会话 + 首个 run，主文档 §3.4）→ 直接跳转工作台页。
- 超限 `CONFIG_INVALID` → Modal 内 `Alert`"项目数量已达上限（50）"。

**其他**：列表为空 → `Empty` + 引导文案"从能力中心挑选一个能力开始，或直接新建项目" + "新建项目"按钮；`GET /api/projects` 失败 → `Result` + 重试。

### 5.3 能力中心（`/capabilities`）

**目标**：让"平台会不断扩展能力"可见——即使当前只有"短视频生成"一个能力，用户也能从这里看到平台的能力边界与每个能力的形态。

**布局**：页头（标题"能力中心" + 一句说明"每个能力是一条完整的工作流；选择能力，创建项目"）+ 能力卡片栅格（每行 2 张，窄屏 1 张）。

**能力卡片**（`Card`，数据全部来自 `GET /api/capabilities` 的能力声明）：

- 标题：能力名（如"短视频生成"）；下方一段能力说明（`description`）。
- **阶段 DAG 预览**：横向 `Steps`（迷你尺寸）展示阶段链（`copy → image → scene → tts → storyboard → render → compose`），审核点阶段带金色标记（图标 + Tooltip"该阶段后需人工确认"）；数据来自能力声明的 `stages` 与 `reviewGates`。
- **产物契约摘要**：一行文案列出最终产物（如"产出：横屏/竖屏 1080p mp4 成片"）。
- 底栏：主按钮"使用此能力"→ 打开新建项目 Modal（与 5.2 同一组件，预选该能力并直接进入第二步）。
- 卡片只读，不提供能力的启停/编排操作（能力注册是代码级行为，见主文档 §3.6）。

**其他**：`GET /api/capabilities` 失败 → `Result` + 重试；列表为空（异常场景）→ `Empty`"暂无可用能力，请联系管理员"。

### 5.4 工作台（`/projects/:id`，核心页）

**目标**：单项目的全部操作面——对话、阶段进度、审核、产物、run 控制。

**整体布局**（桌面）：

```
┌────────────────────────────────────────────────────────┐
│ ← 返回 │ 项目名 [能力Tag] [状态Tag] [run状态Tag] │ [发起run][取消][Trace] │
├───────────────────────────────┬────────────────────────┤
│ 对话流（消息 + 工具卡片 + 审核卡）│ 阶段进度 Steps（7 步）     │
│                               ├────────────────────────┤
│                               │ 产物面板 Tabs            │
│                               │ 文案/图片/场景/音频/      │
│                               │ 时间轴/成片              │
├───────────────────────────────┴────────────────────────┤
│ 输入框 [发送]（run 活跃时提示"可在下方与 agent 讨论"）      │
└────────────────────────────────────────────────────────┘
```

窄屏：右侧两块与对话流合并为顶部 `Tabs`（对话 / 进度 / 产物）。

#### 5.4.1 页头区

- 返回链接、项目名、所属能力 `Tag`（蓝色，如"短视频生成"）、项目状态 `Tag`、当前 run 状态 `Tag`（无 run 时不显示）。
- 操作按钮：
  - **发起 run**：`POST /api/projects/:id/runs`；存在活跃 run 时按钮禁用（Tooltip"已有任务在运行"）；点击后收到 `PROJECT_BUSY` 同样以 Tooltip/message 提示"该项目有任务正在运行"。
  - **取消 run**：仅 run 活跃态显示，`Popconfirm` 确认后 `POST /api/runs/:id/cancel`。
  - **查看 Trace**：跳 `/runs/:id/trace`（取最近一次 run）。
- 收到 `RUN_STATE_INVALID`（如对已完成 run 误操作）→ message 提示并重新拉取项目与 run 数据自愈合。

#### 5.4.2 对话流（左栏）

消息按 `created_at` 升序渲染，滚动锚定底部（用户上翻时不强跳）。消息类型：

| 类型                     | 渲染                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| `user`                   | 右侧气泡，蓝底白字                                                            |
| `assistant`              | 左侧气泡，Markdown 受限渲染；`text_delta` 流式追加到末尾气泡，`turn_end` 定稿 |
| `system`（引擎阶段指令） | 居中浅灰条："引擎指令：执行 copy 阶段…"，可折叠                               |
| 工具调用                 | 卡片（非气泡），见下                                                          |

**工具调用卡片**（`tool_start` 建卡 → `tool_end` 收尾）：

- 头部：工具图标 + 中文名（`copy_generate → 文案生成` 等映射表）+ 状态（进行中转动 / 成功绿 / 失败红）+ 耗时。
- 体部（默认折叠，`Collapse`）：参数摘要（`args_json` 裁剪展示）、产物链接（`artifactPaths` → 点击在产物面板定位或直接预览）、失败时 `errorCode` + 一句话说明。
- 内置工具（`read/grep/bash/write/edit`）同样建卡，`bash` 显示命令原文（等宽字体，长命令截断 + Tooltip）。
- 失败卡片提供"查看 trace"锚链，跳到 trace 页对应 `stage_id`。

**审核卡片**（`review_gate` 事件触发，插入对话流）：

- 内容：到达的审核点阶段（如"文案阶段待审核"）+ 该阶段产物摘要（copy.json 的分镜标题列表 / image 的缩略图墙）。
- 操作：`通过，继续`（主按钮）/ `重跑此阶段`（次按钮 + 可选 `feedback` 输入框，占位提示如"文案再口语化一点"）。
- 点击调用 `POST /api/runs/:id/resume` `{action, feedback?}`；卡片随后置灰显示已选结论。
- run 处于 `waiting_review` 时，右侧步骤条对应阶段显示金色"待审核"标记，两处入口等价（卡片按钮与步骤条旁的审核按钮都调 resume）。

**输入框**（底部固定）：

- `TextArea` 自适应高度（1-5 行），Enter 发送、Shift+Enter 换行。
- `POST /api/sessions/:id/messages`；发送中禁用。
- run 活跃时输入框不禁用（自由对话契约，主文档 §6.4"等待期间…自由对话畅通"），占位提示"任务运行中，可随时与 agent 讨论…"。
- agent 回复中（`text_delta` 进行中）显示"中断"按钮 → `POST /api/sessions/:id/abort`。

#### 5.4.3 阶段进度（右上）

- `Steps` 竖排七步，状态按 §2.3 阶段映射；当前步显示 attempt（"第 2 次尝试"）与已耗时。
- 数据来自 `GET /api/runs/:id`（进入页面时）+ SSE `run_start` / `run_stage` 增量更新；`skipped` 阶段标"已跳过"。
- 步骤条只做展示，点击某阶段展开该阶段已产生的工具卡片锚链（滚动定位到对话流对应卡片），**不提供"跳到该阶段"操作**（前端不推导状态机）。

#### 5.4.4 产物面板（右下）

`Tabs` 六页，数据来自 `GET /api/projects/:id/artifacts`，`tool_end` 携带产物路径时局部刷新对应 Tab：

| Tab    | 内容                                                                                      |
| ------ | ----------------------------------------------------------------------------------------- |
| 文案   | `copy.json` 结构化展示：主题、每分镜标题 + 口播全文（`Descriptions` + 列表），不裸显 JSON |
| 图片   | 缩略图墙（`Image.PreviewGroup`，点击大图预览），按 sceneId 排序                           |
| 场景   | 各 `scenes/*.html` 的链接列表（新标签页打开，经 `/api/media/*`）                          |
| 音频   | 每分镜 `Audio` 播放器 + 时长                                                              |
| 时间轴 | `timeline.json` 结构化展示（分镜 × 时长 × 起始时间表）                                    |
| 成片   | `final.mp4` HTML5 播放器；不存在时显示"尚未合成"                                          |

- 所有媒体经 `GET /api/media/*` 相对路径加载，`<img>/<video>` 带 `alt`/字幕轨道占位。
- 产物缺失（阶段未跑到）→ 对应 Tab 内 `Empty`"该产物尚未生成"。

#### 5.4.5 SSE 生命周期（本页）

- 进入页面：建连 `GET /api/sessions/:id/events`。**（已定夺，P9-B）** `EventSource` 不支持自定义请求头，故采用**短时票据**：先 `POST /api/sessions/:id/events-ticket`（Bearer 鉴权 + 会话归属校验）取回 `{ ticket, expiresInMs }`（TTL 60 秒），再以 `GET /api/sessions/:id/events?ticket=<票据>` 建连；**不使用** `?token=` 查询参数方案。票据载荷为 `{ scope:"sse", sid, uid, urole }` 且与会话 `sid` 绑定，与 access token 双向隔离（票据不能当 access token，反之亦然）。
  - **重连语义**：票据 TTL 为 60 秒，浏览器自动重连时**原票据可能已过期**，前端须在重连前重新调用 `events-ticket` 取新票据后再建连（即"重连 = 重新签票 + 重新建连"，不复用旧票据）。
  - fetch 路径（非 `EventSource`）也可直接用 `Authorization: Bearer <access token>` 访问同一路由。
- `Last-Event-ID` 由浏览器自动携带；收到 `resync` → 丢弃本地消息缓存，并行重拉消息列表 + run 详情。
- 断线：浏览器自动重连；连续失败 3 次在对话流顶部显示 `Alert`"实时连接已断开，正在重试…"，恢复后消失。
- 离开页面：关闭连接。

### 5.5 run Trace 视图（`/runs/:id/trace`）

**目标**：一次 run 的完整留痕可查（任务监控 + 自进化数据的人工入口）。

**布局**：页头（返回 + "Run #id" + run 状态 Tag + 触发方式 `trigger` + 起止时间 + 总耗时）→ 下方左右分栏（窄屏上下堆叠）：

- 左：`Steps` 竖排七阶段（含 attempt、耗时、`errorCode`；点击选中）。
- 右：选中阶段的明细 `Tabs`：
  - **工具调用**：`Table`（工具、状态、耗时、产物数），行展开显示 `args_json`（代码块 + 复制按钮）。
  - **LLM 调用**：`Table`（模型、prompt/completion tokens、耗时、状态），行展开显示 `request_json` / `response_json` 全文（代码块，默认折叠，` Typography.Paragraph` 可复制）。
  - **事件**：该阶段相关 SSE 已落库事件的时间序列（`Timeline`）。
- 数据：`GET /api/runs/:id` + `GET /api/runs/:id/trace`（分页，`Table` 分页器直达后端分页参数）。
- 只读：本页无任何操作按钮；admin 从 `/admin` 进入时界面相同，数据改走 `GET /api/admin/runs/:id/trace`，仅返回链接回 `/admin`。
- 长 JSON 展示截断（> 50KB 截断并注明"完整内容本期请用 SQL 查询，`db:trace` 清理/导出命令列入后续"，见主文档 §14.5）。

### 5.6 管理视图（`/admin`，仅 admin）

**目标**：全站只读监控 + 唯一的救援写操作（重置密码）。三 Tab：

**用户 Tab**：`Table`（用户名、显示名、角色、注册时间、最近登录）；行操作"重置密码" → `Popconfirm` → `POST /api/admin/users/:id/reset-password` → 成功 message 显示"已重置，该用户下次登录需改密"（**不回显新口令明文**，本机救援场景由 CLI `db:user` 承担，见主文档 §3.5）。

**项目 Tab**：`Table`（属主、名称、能力、主题、状态、更新时间），只读，无行操作；可按状态筛选（`Select`）。

**Runs Tab**：`Table`（run id、项目、属主、状态、errorCode、创建时间、耗时）；顶部筛选：状态 `Select`、errorCode `Input` 模糊；行点击"Trace"跳 `/runs/:id/trace`。

- 非 admin 访问被路由守卫拦截；若绕过守卫，`/api/admin/*` 返回 `AUTH_FORBIDDEN`，页面显示 `Result 403`。
- 三个 Tab 均为只读列表，不做批量操作、不做导出（自进化分析走 SQL/API，见主文档 §7.5）。

### 5.7 个人设置（`/settings`）

- 当前用户信息 `Descriptions`（用户名、显示名、角色）。
- 修改密码 `Form`：旧密码、新密码、确认新密码 → `POST /api/auth/password`；成功后 message 提示并重新拉取 `/api/auth/me`（`mustChangePassword` 归零，解除路由强制）。
- `?force=1`（首次登录强制改密）时：隐藏其余内容，顶部 `Alert`"首次登录请先修改初始密码"，改密成功前路由守卫不放行。

---

## 6. 组件清单（Ant Design Vue 映射）

| 用途       | 组件                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- |
| 框架       | `Layout` / `Menu` / `Dropdown` / `Avatar`                                             |
| 列表与数据 | `Table` / `Card` / `Row/Col` / `List` / `Descriptions` / `Empty` / `Skeleton`         |
| 进度与状态 | `Steps` / `Tag` / `Badge` / `Timeline` / `Progress`（可选，阶段内无百分比数据时不用） |
| 表单       | `Form` / `Input` / `Input.Password` / `TextArea` / `Select` / `Modal`                 |
| 反馈       | `message` / `Alert` / `Result` / `Popconfirm` / `Tooltip` / `Spin`                    |
| 媒体       | `Image.PreviewGroup` / 原生 `audio` `video`                                           |
| 其他       | `Collapse`（工具卡片）、`Tabs`、`Typography`（代码块复制）                            |

---

## 7. 数据流与 SSE 事件映射

### 7.1 Pinia store 划分

| Store          | 职责                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| `auth`         | token、`me`（role / mustChangePassword）、登录/登出/改密动作、路由守卫数据源   |
| `capabilities` | 能力列表（`GET /api/capabilities`，应用级缓存，能力中心与新建项目 Modal 共用） |
| `projects`     | 项目列表、新建                                                                 |
| `workbench`    | 当前项目 + 会话消息列表 + 当前 run + 产物索引；SSE 事件的落点                  |
| `trace`        | run 详情 + 分页 trace 数据                                                     |
| `admin`        | 三个只读列表                                                                   |

### 7.2 SSE 事件 → UI 映射（唯一权威表）

| 事件          | UI 反应                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| `text_delta`  | 追加到对话流末尾 assistant 气泡（无则新建）                                                 |
| `tool_start`  | 对话流新建工具卡片（loading 态）                                                            |
| `tool_end`    | 卡片收尾（状态/耗时/产物）；含 `artifactPaths` 时刷新产物面板对应 Tab                       |
| `turn_end`    | 气泡定稿；隐藏"中断"按钮；输入框解锁                                                        |
| `run_start`   | 页头 run Tag → 运行中；步骤条复位并从 `fromStage` 起算                                      |
| `run_stage`   | 更新步骤条对应阶段状态（含 `skipped`）                                                      |
| `review_gate` | 页头 run Tag → 待审核；对话流插入审核卡片；message 提示"已到审核点"                         |
| `run_end`     | 页头 run Tag → 终态；成功时产物面板自动切到"成片"Tab；失败时 `message.error` 带 `errorCode` |
| `resync`      | 丢弃本地消息/run 缓存，全量重拉                                                             |
| `error`       | 全局 `message.error`（`{code, message}`）                                                   |

### 7.3 状态归属原则

所有状态（项目/run/阶段）**只渲染服务端字段**；前端唯一允许的派生是"按钮是否禁用"这类纯展示逻辑，且必须以最近一次服务端数据为准，不做本地状态机推进。

---

## 8. 异常与边界场景

| 场景                     | 界面行为                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| 401（token 失效）        | axios 拦截器清 `vf.token` → 跳 `/login`，登录后回跳                                                     |
| 403 越权（访问他人资源） | `Result 403`"没有权限查看该内容"                                                                        |
| `PROJECT_BUSY`           | message"该项目有任务正在运行"，并刷新 run 数据                                                          |
| `RUN_STATE_INVALID`      | message 提示后重拉项目 + run，UI 自愈合到最新状态                                                       |
| 阶段失败达重试上限       | run Tag → 失败；对话流系统条说明失败阶段与 `errorCode`；页头出现"续跑"按钮（本质是 `resume(retry)`）    |
| 服务重启导致中断         | run Tag → 已取消（Tooltip 注明 INTERRUPTED）；页头"续跑"按钮 → `POST /api/projects/:id/runs` 从断点继续 |
| SSE 长断                 | 顶部常驻 `Alert`，期间数据可能滞后，恢复后 `resync`                                                     |
| 媒体 404                 | 图片/视频位显示"产物文件缺失"占位，不白屏                                                               |
| 网络错误（非业务码）     | message"网络异常，请检查服务是否在线"                                                                   |

---

## 9. UI 设计稿

以下设计稿由项目内 Ark 生图能力（doubao-seedream）按本文档布局描述生成，**仅作风格与布局示意**；图中文字可能存在乱码，一切文案、字段与状态以本文档及主文档契约为准。

| 页面           | 设计稿                                                              |
| -------------- | ------------------------------------------------------------------- |
| 登录 / 注册    | [01-login.png](design-mockups/01-login.png)                         |
| 项目列表       | [02-project-list.png](design-mockups/02-project-list.png)           |
| 能力中心       | [06-capability-center.png](design-mockups/06-capability-center.png) |
| 工作台（核心） | [03-workbench.png](design-mockups/03-workbench.png)                 |
| run Trace 视图 | [04-trace.png](design-mockups/04-trace.png)                         |
| 管理视图       | [05-admin.png](design-mockups/05-admin.png)                         |

---

## 10. 契约对照表（API/SSE → UI 消费点）

| 契约                                  | 消费位置                                    |
| ------------------------------------- | ------------------------------------------- |
| `POST /api/auth/register`             | 5.1 注册 Tab                                |
| `POST /api/auth/login` / `logout`     | 5.1 / 顶栏用户菜单                          |
| `GET /api/auth/me`                    | 登录后初始化、改密后刷新、路由守卫          |
| `POST /api/auth/password`             | 5.7                                         |
| `GET /api/capabilities`               | 5.3 能力中心、5.2 新建项目 Modal 第一步     |
| `GET/POST /api/projects`              | 5.2 列表 / 新建 Modal                       |
| `GET /api/projects/:id`               | 5.4 页头与产物摘要                          |
| `GET/POST /api/projects/:id/sessions` | 5.4 会话装载（本期单会话，取首个）          |
| `POST /api/sessions/:id/messages`     | 5.4 输入框                                  |
| `GET /api/sessions/:id/events`        | 5.4 SSE 生命周期                            |
| `POST /api/sessions/:id/abort`        | 5.4 "中断"按钮                              |
| `POST/GET /api/projects/:id/runs`     | 5.4 页头"发起 run" / run 列表（Trace 入口） |
| `GET /api/runs/:id`                   | 5.4 步骤条、5.5 页头                        |
| `POST /api/runs/:id/resume`           | 5.4 审核卡片 / 续跑按钮                     |
| `POST /api/runs/:id/cancel`           | 5.4 页头"取消"                              |
| `GET /api/runs/:id/trace`             | 5.5（用户）/ 5.6 Runs Tab（admin）          |
| `GET /api/projects/:id/artifacts`     | 5.4.4 产物面板                              |
| `GET /api/media/*`                    | 5.4.4 媒体加载、5.5 产物链接                |
| `/api/admin/*`（5 个）                | 5.6 三个 Tab                                |
| 错误码（§4.5）                        | §8 异常表逐条对应                           |

---

## 11. 实施备注

- `apps/web` 在现有 Vue3 + Vite + Pinia + Router 骨架上改造：移除旧 Build/Review 页面（主文档 §10.1），按第 3 章路由重建。
- 新增依赖仅 `ant-design-vue` 与 `@ant-design/icons-vue`；旧全局样式 `global.css` 保留为 reset/变量层，页面样式优先用组件库 token，scoped 样式只写布局。
- ~~SSE 鉴权方式（查询参数 vs 一次性 ticket）是本文档唯一未定项，实施首日与后端敲定并回写本文档 5.4.5。~~ **✅ 已定夺（P9-B，2026-10-25）**：采用**短时票据**方案——`POST /api/sessions/:id/events-ticket` 签发独立 JWT（`{scope:"sse", sid, uid, urole}`，TTL 60 秒，与会话 `sid` 绑定）；SSE 路由 `GET /api/sessions/:id/events` 接受 `?ticket=`（`EventSource` 路径）或 `Authorization: Bearer`（fetch 路径）；**不采用** `?token=` 查询参数退化方案。票据与 access token 双向隔离；重连需重新签票。详见 5.4.5 与主文档实施计划的「P9-B 执行记录」。
- 测试：组件级 Vitest（状态映射、审核卡片交互、SSE 事件 reducer）、关键流程 e2e（登录 → 能力中心 → 建项目 → 审核点通过）；桌面与 390px 窄屏各过一遍关键页。
