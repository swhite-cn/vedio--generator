# 更新日志

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- 在途阶段的协作式取消
- trace「事件」时间线查询接口
- Profile 列表接口与更多输出画幅
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
