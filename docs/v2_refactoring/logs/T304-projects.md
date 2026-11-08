# T304 任务日志：项目列表 + 新建项目模态

## 元信息
- 任务 ID：T304
- 状态：done
- 开始时间：2026-11-07 22:10
- 结束时间：2026-11-07 22:52
- 关联设计：方案 §8.5 第 3/4 页、§8.6（ProjectCard / NewProjectModal）、§8.4 路由表；Web 专题 §5.2
- 依赖任务：T303（能力中心与默认首页）
- 后续任务：T305（工作台）
- 变更文件：
  - `apps/web/src/components/project-filter.ts`（新增：筛选/排序/计数纯函数）
  - `apps/web/src/components/ProjectCard.vue`（新增：项目卡片）
  - `apps/web/src/views/ProjectsView.vue`（重写：筛选 + 卡片网格 + 空态/错误态 + 重试）
  - `apps/web/src/components/NewProjectModal.vue`（重写：Vf 基元两步模态 + 风格锚上传）
  - `tests/unit/web-projects.test.ts`（新增 20 例）
  - `docs/v2_refactoring/tasks.md`（状态与变更记录）
  - `docs/v2_refactoring/screenshots/t304-*.png`（5 张目检截图）

## 意图
按方案 §8.5 第 4 页重写项目列表，并把新建项目入口统一为第 3 页的两步模态：
项目卡片展示服务端状态/进度/镜头与时长，失败项目可直接从断点重试；
新建项目支持选择能力、填写参数，并可选择风格锚参考图（创建后作为项目资产上传）。

## 改动
- **项目筛选纯函数**：新增 `project-filter.ts`，提供 `matchesProjectFilter` / `filterProjects` /
  `sortProjectsByUpdatedAt` / `countProjectFilters`；「进行中」= `running` + `review`，`draft` 只在「全部」。
- **ProjectCard**：名称、主题摘要（两行截断 + title 全文）、能力名、创建时间、镜头数 · 总时长、
  状态 pill；`running/review` 且有服务端进度时显示进度条与百分比；`done` 显示「成片就绪」；
  `failed` 显示最新 run 错误码 + 「重试」按钮（`stopPropagation`，不触发卡片跳转）。
  卡片整体 `role=button` + Enter/Space 等价打开。
- **ProjectsView**：页头（总数 + 新建项目）、4 档筛选胶囊（计数 + `aria-pressed`）、
  按 `updated_at` 倒序的卡片网格；列表失败/空列表/筛选无结果三种状态；
  重试调用 `POST /api/projects/:id/runs` 后刷新列表，失败在页面顶部行内提示。
- **NewProjectModal**：`VfModal + VfButton + VfInput` 两步向导。
  第一步原生按钮卡片选择能力（`aria-pressed`，预选能力直接进入第二步）；
  第二步名称*（必填/≤50/非法字符）、主题*（必填）、风格、输出 Profile（`GET /api/profiles`）、
  风格锚参考图（`accept=image/*`，前置校验类型与 50MB 上限，可移除）；
  校验错误全部行内（`role=alert`）。创建成功后若选了参考图，再调用
  `POST /api/projects/:id/assets/upload`；上传失败只告警，不阻断已创建项目。
- **明确没有做**：没有新增/修改服务端接口；没有把 `themeId` 放进模态（方案 §8.5 字段未列，
  Web 专题 §5.2 的「主题」= 项目 topic）；未做全局搜索、SSE 列表刷新、素材库绑定（后续任务）。

## 设计决策
1. **状态与进度不推导**：筛选只按服务端 `status` 分组；进度直接用 `project.progress`（0..1）取整，
   没有 `progress` 时不显示进度条，不用前端时间回推 ETA。
2. **重试复用既有断点续跑**：不再造重试接口，`POST /api/projects/:id/runs` 即「从断点建新 run」；
   重试按钮只出现在 `failed` 卡片，且阻止冒泡避免误跳工作台。
3. **「最终产物」用状态表达**：列表接口没有 `finalVideoExists` 字段，`done` 即服务端判定的成片就绪，
   卡片显示「成片就绪」而非再请求产物接口。
4. **风格锚在两段式提交**：上传接口需要项目 id，只能在项目创建后调用；创建接口本身会立即触发首个 run，
   因此参考图不保证被首个 run 的 copy/image 阶段消费——这是当前接口顺序的已知竞态，转交 T401
   （风格锚运营）处理，模态内提示「项目创建后作为项目资产上传」。
5. **错误分层**：能力/Profile 加载失败分别降级（能力失败禁止下一步，Profile 失败保留本地两项），
   项目创建失败行内提示；上传失败不阻断项目已创建的事实。
6. **窄屏**：375px 级宽度下卡片单列、筛选自动换行；AntD 模态自带 `max-width: calc(100vw - 32px)`，
   390×844 实测模态宽 358px、页面无横向滚动。

## Checkpoint
- 2026-11-07 22:10 读方案 §8.5/§8.6、Web 专题 §5.2 与现有 ProjectsView/NewProjectModal；
  确认 `/api/projects` 已带 `status/progress/shotCount/totalMs/latestRun`，无需新增接口。
- 2026-11-07 22:22 `project-filter.ts` + `ProjectCard.vue` + `ProjectsView.vue` 完成。
- 2026-11-07 22:30 `NewProjectModal.vue` 重写完成（含风格锚上传与行内校验）。
- 2026-11-07 22:33 新增 `tests/unit/web-projects.test.ts` 20 例；首轮因异步初始化竞态失败 5 例，
  在测试挂载后等待「默认选中能力」再交互，全部通过。
- 2026-11-07 22:37 `pnpm run typecheck` / `pnpm run web:build` / `pnpm test` 全绿。
- 2026-11-07 22:52 启动 API（:3000）与 Web（:5173）目检：桌面 1440×900 与窄屏 390×844，
  两步模态、行内校验、无横向滚动；停止服务并归档截图。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/web-projects.test.ts` | pass | 20 passed（最终代码复跑 22:53） |
| `pnpm test` | pass | 90 files / 815 tests（较 T303 净增 1 file / 20 tests） |
| `pnpm run typecheck` | pass | 8 个 tsconfig |
| `pnpm run web:build` | pass | 5.16s（最终代码复跑 22:53） |
| 目检 1440×900 项目列表 | pass | [项目列表桌面](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/screenshots/t304-projects-1440x900.png) |
| 目检 390×844 项目列表 | pass | [项目列表窄屏](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/screenshots/t304-projects-390x844.png)（`scrollWidth=390`） |
| 目检新建项目第一步 | pass | [能力选择](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/screenshots/t304-new-project-step1-1440x900.png) |
| 目检新建项目第二步 | pass | [参数表单](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/screenshots/t304-new-project-step2-1440x900.png) |
| 目检 390×844 模态 | pass | [窄屏模态](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/screenshots/t304-new-project-390x844.png)（宽 358px） |

## 断点 / 未完成
- 未完成项：本任务范围内无遗留。
- 已知边界与风险：
  1. **风格锚文件共性竞态**：创建即触发首个 run，参考图后置上传可能晚于 copy/image；
     T401 需要评估「创建时上传/创建后重绑」；当前上传失败只告警不回滚项目。
  2. **重试入口只看项目状态**：`failed` 但成片实际存在时，服务端 `deriveProjectStatus` 会回写 `done`
     （视图校正），列表接口已按校正后状态返回；若数据库状态与产物再次分叉，以服务端列表为准。
  3. **筛选计数来自当前列表**：未做服务端分页/聚合；项目量增长后需要服务端计数。
  4. **目检账号副作用**：为目检执行了
     `pnpm --filter @videoforge/cli start db:user --reset-password layoutcheck`
     并完成强制改密，口令未写入任何文件；如需复用请再次重置。
- 最后运行的命令：`Move-Item` 归档截图（服务已停止）。
- 恢复时第一步：进入 T305（工作台：对话/8 阶段/产物 + SSE）。

## 风险与后续
- 风险：新建项目模态改为自绘表单后，服务端错误仅靠 `formatApiError` 文案；若参数契约新增字段，
  需要同步模态（当前 `params` 声明未驱动表单渲染）。
- 下一步任务：`T305` 工作台（依赖 T301/T119，已置 ready）。
