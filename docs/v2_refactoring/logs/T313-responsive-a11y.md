# T313 任务日志：响应式与键盘验收

## 元信息
- 任务 ID：T313
- 状态：done
- 开始时间：2026-11-08 07:19
- 结束时间：2026-11-08 07:21
- 关联设计：Web 专题 §5.2 响应式 / §5.6 键盘；M3 出口判据
- 依赖任务：T302–T312
- 后续任务：T314
- 变更文件：
  - docs/v2_refactoring/screenshots/t313-projects-1440x900.png
  - docs/v2_refactoring/screenshots/t313-projects-390x844.png
  - docs/v2_refactoring/screenshots/t313-workbench-1440x900.png
  - docs/v2_refactoring/screenshots/t313-workbench-390x844.png
  - docs/v2_refactoring/screenshots/t313-run-detail-1440x900.png
  - docs/v2_refactoring/screenshots/t313-run-detail-390x844.png
  - docs/v2_refactoring/screenshots/t313-storyboard-1440x900.png
  - docs/v2_refactoring/screenshots/t313-storyboard-390x844.png
  - docs/v2_refactoring/screenshots/t313-assets-1440x900.png
  - docs/v2_refactoring/screenshots/t313-assets-390x844.png
  - docs/v2_refactoring/screenshots/t313-components-1440x900.png
  - docs/v2_refactoring/screenshots/t313-components-390x844.png
  - docs/v2_refactoring/screenshots/t313-admin-1440x900.png
  - docs/v2_refactoring/screenshots/t313-admin-logins-1440x900.png
  - docs/v2_refactoring/screenshots/t313-admin-390x844.png
  - docs/v2_refactoring/screenshots/t313-search-panel-1440x900.png

## 意图
用真实浏览器在桌面与窄屏两档宽度逐页确认布局、溢出与键盘路径，给 M3 批次提供可复核的目检证据。

## 改动
- 仅新增截图证据，不修改产品代码。
- 目检账号：`layoutcheck`（成员）与 `admin`（管理员）；管理员首次登录走强制改密流程后进入 `/admin`。

## 验证
| 命令 / 路径 | 结果 | 证据 |
|---|---|---|
| `/projects` 1440×900 / 390×844 | pass | 卡片网格、筛选、空态正常；`scrollWidth == innerWidth` |
| `/projects/:id` 工作台 | pass | 8 阶段（含字幕）、对话输入、4 Tab；窄屏 5 项导航 |
| `/projects/:id/runs/:runId` | pass | Run 详情 8 阶段、工具/LLM/事件 Tab |
| `/projects/:id/storyboard` | pass | 三栏/空态与键盘提示 |
| `/assets` | pass | 风格锚 banner、6 类筛选换行 |
| `/components` | pass | 8 张预览卡，窄屏单列 |
| `/admin`（管理员） | pass | 4 KPI、用户/项目/Runs/登录日志；成员访问被守卫重定向到 `/` |
| 顶栏搜索 | pass | 输入「数据」出现组件命中，Enter 跳 `/components`，面板关闭 |
| 横向溢出检测 | pass | 7 页 × 2 档均 `scrollWidth == innerWidth`（390/390、1440/1440） |

## 断点 / 未完成
- 未完成项：无。
- 已知风险：当前样例项目无 v2 分镜/资产，分镜编辑器与素材库仅覆盖空态；满数据目检待 T401/T404 补齐。
- 备注：目检期间把 `admin` 初始口令改为本地开发口令，并重置了 `layoutcheck` 口令（均未写入文档）。

## 风险与后续
- 风险：截图只证明结构可用，未做像素级视觉回归对比（留 T503）。
- 下一步任务：T314。
