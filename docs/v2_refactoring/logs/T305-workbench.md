# T305 任务日志：工作台（对话/阶段/产物）

## 元信息
- 任务 ID：T305
- 状态：done
- 开始时间：2026-11-08 07:10
- 结束时间：2026-11-08 07:11
- 关联设计：方案 §8.5 工作台；Web 专题 §5.2/§5.4
- 依赖任务：T301（AppShell/基元）、T119（SSE）
- 后续任务：T306
- 变更文件：
  - apps/web/src/views/WorkbenchView.vue
  - apps/web/src/components/FinalOutputCard.vue

## 意图
把旧工作台页替换为左对话流 + 右信息区的两栏工作台，并让 final.mp4 成为第一类可见产物，承载 SSE 实时状态。

## 改动
- `WorkbenchView.vue` 整页重写：
  - 页头展示项目名、能力 pill、项目状态 pill、run 状态 pill，以及「发起 Run」「查看 Run」操作。
  - 左栏对话流复用 `MessageBubble` / `ToolGroup`；输入区为原生 textarea（Enter 发送、Shift+Enter 换行）、资产引用下拉、上传与发送按钮。
  - 右侧 `WorkbenchTabs` 承载阶段进度/分镜/项目资产/产物四个 Tab。
  - 窄屏（<768）显示 5 项顶部导航（对话/阶段/分镜/资产/产物），`narrowTab` 控制当前面板。
  - 监听 `artifactRefreshToken` 重载资产；`finalReady` 变 true 时自动切到产物 Tab。
  - 单镜重生成预填对话内容，跳转由 `@regenerate` 事件处理。
- `FinalOutputCard.vue` 新增：
  - 从 compose 产物或 `finalVideoExists` 回退定位 `final.mp4`；用 `buildMediaUrl(project, path, mediaTicket)` 生成可播放 URL。
  - 播放/下载、真实宽高（`onVideoMetadata`）、时长（`formatMediaDuration(project.totalMs)`）、大小。
  - 缺失时显示「尚未合成」空态。
- 未做：不新增服务端接口；不在前端推导项目/run/阶段状态。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/web-m3-pages.test.ts` | pass | 7 例（含 WorkbenchTabs） |
| `pnpm run typecheck` | pass | — |
| 浏览器目检 1440×900 / 390×844 | pass | `t313-workbench-1440x900.png` / `t313-workbench-390x844.png`，无横向滚动 |

## 断点 / 未完成
- 未完成项：无。
- 已知风险：对话流滚动容器在超长消息下的性能未做专门优化（本地规模可接受）。

## 风险与后续
- 风险：final 产物路径回退依赖 `finalVideoExists` 字段，服务端变更时需同步。
- 下一步任务：T306。
