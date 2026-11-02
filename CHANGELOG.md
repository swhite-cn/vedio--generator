# 更新日志

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 对话流「思考过程」：解析 Ark `reasoning_content`，经 `thinking` 事件推送，工作台以折叠块展示并随消息持久化（SSE 事件类型增至 11 类，新增 `thinking_delta`）。
- 工具调用可视化对齐 Claude Code：同一轮内连续的内置工具折叠为「工具组」摘要，展开后逐行查看参数与输出；工具卡片补充输出预览与退出码。
- 工具输出留痕：`tool_calls` 新增 `output_preview` / `output_truncated`（默认 8KB 上限，全文不落库），trace 工具表支持行内查看输出。
- Trace 视图：新增「阶段」列与 `?stage=` 服务端过滤；「事件」Tab 改为 `buildRunEvents` 由 `runs` / `run_stages` / `tool_calls` / `llm_calls` 合成的时间线（非原始 SSE 流）。
- 消息持久化与历史回放：新增 `GET /api/sessions/:id/messages` 游标分页查询，前端把 `messages` 表的 assistant 块（text / thinking / toolCall）与 toolResult 合并回放，刷新后对话完整恢复。
- `GET /api/profiles`：新建项目 Modal 的输出 Profile 改为读取 `config/profiles/*.yaml`；接口失败时回退前端默认项。
- 视觉基线：`global.css` 收敛为设计令牌 + 极简 reset，`ConfigProvider` 统一主题 token，侧边栏固定 208px 宽。
- 前端可调开关：`agent.show_thinking`（默认 `true`，控制思考过程推送与持久化）与 `agent.tool_output_preview_chars`（默认 `8192`，范围 256-65536）；工作台支持「加载更早的消息」分页回放。
- 新增配置项 `runtime.scene_concurrency`（默认 `3`，范围 1-8）：场景生成（scene 阶段）内部并发度独立于 `runtime.max_concurrent_stage`，把逐场景生成从串行改为限并发，缩短 scene 阶段耗时。
- 新增配置项 `agent.tool_failure_circuit_breaker`（默认 `3`，范围 0-20，`0` 关闭）：相同「工具 + 参数」连续失败达阈值后硬熔断，后续完全相同调用直接返回 `TOOL_CIRCUIT_OPEN`，强制模型换参数或换思路；成功一次即清零。
- 新增配置项 `agent.command_guardrails`（bash 命令预检规则列表）：规则是配置数据而非代码黑名单，`reject` 拒绝执行（`TOOL_COMMAND_BLOCKED`）、`rewrite` 改写后继续执行；新增一类命令防护只需追加一条规则。

### 修复

- 迁移脚本不再在每次启动时 `DROP TABLE projects`；仅在检测到旧 Build 领域 schema（缺 `user_id`）时一次性清理，避免清空用户项目数据。
- `tts_generate` 不再接受 `speaker` 入参，音色固定取配置 `engines.endpoints.ark.tts_speaker`；`tts-generate` 对空串与占位串（`default` / `auto`）回退配置默认值，避免模型传入无效音色触发 `ADAPTER_FAILED` 后盲目重试。
- Ark TTS 客户端解析 openspeech 响应行内的 `code` / `message`：失败时（HTTP 状态仍为 200）抛出真实错误码与信息，不再退化为笼统的「TTS 响应不含音频数据」。
- run 取消改为协作式中止：置 `canceled` 并中断在途 agent 轮次（LLM 请求 abort，引擎在阶段边界检查取消标记）；已进入子进程的工具调用仍可能跑完，属已知限制。
- admin 项目状态不再恒为库内 `draft`，改由 `deriveProjectStatus` + 成品存在性推导真实状态。
- 防「命令方言脏文件」：系统提示（L0）声明 Windows + bash 运行环境与惯用法（不用 `where`、不用 `2>nul`）；`path-safety`（L2）统一拒绝 Windows 保留设备名（`CON` / `PRN` / `AUX` / `NUL` / `COM1-9` / `LPT1-9`，含带扩展名与大小写变体）作为工件名或项目名，返回 `PATH_OUTSIDE_STORAGE`；`agent.command_guardrails`（L1）默认把 cmd 风格 `2>nul` 改写为 `2>/dev/null`。三者叠加避免模型在 Windows 上落盘名为 `nul` 的文件而拖垮后续 `grep` / `find`（历史事故：单次自检循环浪费约 4 分钟）。
- 工具重复失败熔断：`agent.tool_failure_circuit_breaker` 默认 3 次，杜绝同一「工具 + 参数」在坏状态下无限重试刷屏。

### 计划中

- ESLint 规则集与 CI 质量门槛

## [0.1.0] - 2026-10-27

首个公开版本。

### 新增

- 能力注册表驱动的七阶段确定性工作流：`copy → image → scene → tts → storyboard → render → compose`。
- 审核点（`copy`、`image` 之后）、断点续跑、阶段失败自救重试与全局阶段并发控制。
- 内嵌 Pi agent 运行时：会话注册表、Ark provider、七个阶段工具与内置工具、系统提示与技能加载。
- 三级留痕：`run_stages` / `tool_calls` / `llm_calls` 双写 SQLite 与项目目录 `trace.jsonl`，含密钥脱敏。
- 阶段执行期间通过 SSE 转发 agent 事件，工作台可实时看到文本流、工具卡片与阶段耗时。
- Vue 3 + Ant Design Vue 工作台：登录、能力中心、项目列表、工作台、run Trace、设置、管理视图。
- CLI 运维入口：`doctor` / `status` / `db:migrate` / `db:user` / `storage:prune` / `project:verify`。
- 拆分 `packages/shared`、`packages/pipeline`、`packages/renderer`、`packages/template-sdk` 子包。

### 已知限制

- 真实 Ark 端到端验收需自备账号与模型；冒烟测试仅覆盖真 Chromium 渲染段。
- `POST /api/runs/:id/cancel` 不终止在途阶段。
- trace 页「事件」Tab 暂无后端查询路由；admin 项目状态恒为库内 `draft`。
