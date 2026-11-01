# VideoForge 操作者使用说明

本文面向希望在本机启动 VideoForge、通过工作台跑"主题 → 成片"或检查运行留痕的操作者。安装与开发细节见[开发者使用说明](developer-guide.md)。

> **重要：真实 Ark 服务的端到端冒烟尚未验收。** 服务、工作台与七阶段工作流已可用，但需要在 `config/system.local.yaml` 填真实 `chat_model`、在 `.env.local` 或环境变量中配置 `ARK_API_KEY` 与 `JWT_SECRET` 后人工验证一次完整链路。

## 1. 当前可以做什么

| 功能                                                 | 当前状态                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 环境与配置体检                                       | 可用：`pnpm run doctor`                                                                   |
| 启动单进程服务 + Web 工作台                          | 可用（需 `JWT_SECRET`）                                                                   |
| 注册 / 登录 / 首次强制改密                           | 可用                                                                                      |
| 能力中心查看平台能力                                 | 可用（当前仅内置「短视频生成」）                                                          |
| 按能力新建项目并自动触发 run                         | 可用                                                                                      |
| 在工作台看阶段进度、对话流、产物面板                 | 可用                                                                                      |
| 审核点通过 / 重跑该阶段                              | 可用                                                                                      |
| 取消 run                                             | 可用，但**不终止已在执行的阶段**（见第 8 节限制）                                         |
| 查看 run trace（阶段 / 工具调用 / LLM 调用）         | 可用；「事件」Tab 暂无后端查询接口，显示空态                                              |
| 管理员查看用户 / 项目 / Runs、重置口令、看任意 trace | 可用                                                                                      |
| 修改自己的口令                                       | 可用                                                                                      |
| CLI 运维命令                                         | 可用：`doctor` / `status` / `db:migrate` / `db:user` / `storage:prune` / `project:verify` |
| 独立 Worker 进程 / Python Edge TTS                   | 已移除（P12）                                                                             |

## 2. 启动前检查

在仓库根目录执行：

```powershell
pnpm run doctor
```

`doctor` 以 JSON 摘要输出各项检查结果。出现 `chat_model` 占位、`ARK_API_KEY` 缺失、`base_url` 被误改或 `storage_root` 为空时，先按提示修正配置（见开发者说明第 3 节），否则文案阶段会拒绝执行。

## 3. 启动服务与工作台

### 3.1 启动 API

第一个 PowerShell 窗口：

```powershell
$env:JWT_SECRET = "videoforge-local-dev-secret-key-0123456789"
pnpm run server:dev
```

服务监听 `http://127.0.0.1:3000`（端口取自 `server.port`，仅本机回环）。可在另一窗口检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

预期返回 `{"status":"ok","service":"videoforge-server"}`。

### 3.2 启动 Web 工作台

第二个 PowerShell 窗口：

```powershell
pnpm run web:dev
```

浏览器访问 `http://localhost:5173`。两个进程需分别运行，当前没有一键启动命令；结束时在各自终端按 `Ctrl+C`。

## 4. 初次登录

1. 用户名 `admin`，口令为内置初始口令或 `VF_ADMIN_INITIAL_PASSWORD` 指定的值。
2. 首次登录会被强制跳到「设置」页并提示"首次登录请先修改初始密码 / 修改成功前，其他页面暂不可访问"。
3. 修改成功后自动进入项目列表。此后初始口令不再可用。
4. 忘记口令时，在仓库根目录执行本机救援：

```powershell
pnpm --filter @videoforge/cli start db:user --reset-password admin
```

新口令只在终端输出一次，不会以明文入库；重置后下次登录会再次要求改密。

## 5. 跑一条视频

### 5.1 新建项目

1. 打开「项目」页 → 新建项目。
2. 第一步选择能力（当前仅「短视频生成」）。
3. 第二步填写项目名称、主题、风格，并选择输出 Profile（横屏 1080p / 竖屏 1080p）。

> 输出 Profile 当前由前端固定提供两项：服务端尚未提供 Profile 列表接口，界面不会虚构其他选项。

创建后服务端会同步创建会话、首个 run 并异步启动工作流，页面直接进入该项目工作台，run 状态通常立即显示为「运行中」。

### 5.2 工作台

- **页头**：项目名、能力、项目状态、run 状态，以及「发起 run」「取消 run」「查看 Trace」。
- **对话**：agent 的流式输出与工具调用卡片。
- **进度**：七阶段竖排步骤条（`文案 → 配图 → 场景 → 音频 → 时间轴 → 渲染 → 合成`），显示每次尝试与耗时。
- **产物**：六个 Tab（文案 / 图片 / 场景 / 音频 / 时间轴 / 成片）；未生成的产物显示空态。

窄屏（约 390px）下侧边栏收起为抽屉，工作台的左右分栏改为顶部 Tab（对话 / 进度 / 产物）。

### 5.3 审核点

`copy`（文案）与 `image`（配图）阶段结束后会停在审核卡片：

- 「通过，继续」：接受当前产物，工作流继续下一阶段。
- 「重跑此阶段」：填写反馈后重跑该阶段。

审核决定由服务端追加记录，不会覆盖历史结论。

### 5.4 查看 trace

点击工作台「查看 Trace」进入 `/runs/:id/trace`：

- 左侧为七阶段步骤条（同一阶段多次重试会折叠为一行，并显示尝试次数与耗时）。
- 右侧为选中阶段的工具调用 / LLM 调用明细，分页直达后端分页参数。
- admin 从「管理」页进入时数据来源为 admin 接口，返回链接回到「管理」。

### 5.5 管理视图（仅 admin）

`/admin` 提供三个只读 Tab：

- **用户**：列出账号与角色，每行可「重置密码」（新口令不回显明文）。
- **项目**：列出全站项目。
- **Runs**：列出运行记录，可跳转任意 run 的 trace。

## 6. 运维命令

```powershell
pnpm --filter @videoforge/cli start status           # 服务探活、端口、磁盘、DB 体积、活跃 run/会话
pnpm --filter @videoforge/cli start db:user          # 列出账号
pnpm --filter @videoforge/cli start db:user --create <用户名>
pnpm --filter @videoforge/cli start db:user --reset-password <用户名>
pnpm --filter @videoforge/cli start storage:prune    # 按保留策略清理工件
pnpm --filter @videoforge/cli start project:verify --project <项目 id>
```

所有命令 stdout 只输出一行 JSON；`status` 在服务未启动时给出降级提示但退出码仍为 0。

## 7. 常见错误

| 报错（错误码）                        | 处理方法                                              |
| ------------------------------------- | ----------------------------------------------------- |
| 启动失败 `CONFIG_INVALID`（JWT）      | 设置 `JWT_SECRET`，至少 32 字符                       |
| 缺少 `ARK_API_KEY`                    | 在仓库根目录 `.env.local` 写入，或设置同名环境变量    |
| `chat_model` 仍为占位值               | 在 `config/system.local.yaml` 填真实语言模型 ID       |
| `ADAPTER_PROTOCOL_INVALID`            | 模型输出不是合法 JSON；重试该阶段                     |
| `ADAPTER_FAILED` / `TOOL_UNAVAILABLE` | 检查网络、密钥权限、ffmpeg/ffprobe 与 Chrome 是否可用 |

## 8. 当前限制

- **真实 Ark 端到端尚未验收**：单元测试全部 mock，首次真实链路需要人工验证。
- **取消 run 不终止在途阶段**：取消后 run 立即变为「已取消」，但正在执行的阶段仍会跑完；该阶段结束后可能把 run 覆盖为「失败」，且工作台在阶段结束前仍显示该阶段「运行中」。此问题已登记，待工作流引擎后续修正。
- **trace「事件」Tab 无数据**：服务端暂未提供事件列表查询路由。
- **admin 项目列表状态恒为「草稿」**：该接口不做项目状态推导，属已知偏差。
- **产出位置**：流水线工件写在 `<storage_root>/projects/<项目 id>/` 下；服务端不对外提供任意路径下载，媒体经 `/api/media/*` 受控访问。
- 本机页面与接口仅用于本机使用，不应作为生产发布通道。

## 9. 遇到问题时

| 问题                  | 处理方法                                            |
| --------------------- | --------------------------------------------------- |
| 页面打不开            | 确认 Web 终端仍在运行，访问 `http://localhost:5173` |
| 接口 401              | token 失效或被清除，重新登录                        |
| 健康检查失败          | 确认 API 终端在运行，并使用 `server.port` 端口      |
| 新建项目报网络错误    | 先启动 API；确认 Vite 代理正常                      |
| `doctor` 提示工具缺失 | 检查 PATH 或在 `system.local.yaml` 写完整路径       |

## 10. 相关文档

- [开发者使用说明](developer-guide.md)
- [本地 harness 设计（主文档）](../../本地视频流水线Agent-v2.md)
- [Web 工作台设计（Web 专题）](../../本地视频流水线Agent-web-v2.md)
