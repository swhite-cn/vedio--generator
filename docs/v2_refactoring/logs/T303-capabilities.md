# T303 任务日志：能力中心

## 元信息
- 任务 ID：T303
- 状态：done
- 开始时间：2026-11-07 18:40
- 结束时间：2026-11-07 19:10
- 关联设计：方案 §8.4（路由表：能力中心 `/` 为默认首页）、§8.5 第 2 页（能力卡/即将上线/最近运行表）、SKILL §4 #2、§5.1（镜头数口径）
- 依赖任务：T301（基元 + 壳）、T116（服务端派生指标与 latestRun）
- 后续任务：T304（项目列表 + 新建项目模态）
- 变更文件：
  - `apps/web/src/views/CapabilitiesView.vue`（重写：可用能力 + 即将上线 + 最近运行表）
  - `apps/web/src/components/CapabilityCard.vue`（重写：阶段 chips / meta / 工作流说明）
  - `apps/web/src/components/state-mapping.ts`（+`statusTone`/`formatDateTime`/`formatElapsed`/`formatMediaDuration`）
  - `apps/web/src/stores/projects.ts`（Project 类型补 T116 派生指标与 `latestRun`）
  - `apps/web/src/router.ts`（`/` → 能力中心；`/capabilities` 重定向保留兼容）
  - `apps/web/src/router-guard.ts`（默认落地页 `/`）
  - `apps/web/src/layouts/AppShell.vue`（导航首项 `to: "/"`；根路径精确匹配；Logo 回能力中心）
  - `apps/web/src/views/SettingsView.vue`（强制改密完成后回 `/`）
  - `tests/unit/web-capabilities.test.ts`（新增 13 例）、`tests/unit/web-router-guard.test.ts`（默认页断言 3 处）、
    `tests/unit/web-ui-primitives.test.ts`（内存路由补 `/`）
  - `docs/guides/operator-guide.md`（默认首页与新建入口描述）

## 意图
按方案 §8.5 第 2 页重写能力中心，并把「能力中心」正式设为默认首页（`/`，§8.4）：
可用能力卡（阶段 chips + 参考片基线 + 项目数 + 创建）、即将上线 3 张禁用卡、最近运行表
（项目/Run/镜头数/状态/耗时/时间，全部来自服务端 T116 字段）。

## 设计决策
1. **默认首页切换为 `/`**：`/` 渲染能力中心，`/capabilities` 重定向到 `/`（兼容旧链接）；
   守卫默认落地页、Logo 点击、强制改密完成跳转全部改为 `/`。AppShell 的 `isActive("/")`
   改为精确匹配，避免根路径前缀匹配命中所有页面。
2. **最近运行表数据来源单一**：只用 `GET /api/projects` 的 `latestRun` 与派生指标（T116），
   不为本页新增「全站 run 列表」接口；按 `latestRun.created_at` 倒序取前 6，无 run 的项目
   不出现（空态文案说明）。
3. **前端只做展示格式化**：`shotCount` / `status` 等直接渲染服务端字段；新增 4 个纯函数
   （`statusTone` 映射 VfPill、`formatDateTime`、`formatElapsed`、`formatMediaDuration`），
   运行中 run（无 `ended_at`）耗时显示 `—`，不用当前时间回推（避免前端"推导"时长）。
4. **「平均 3.7 秒一次画面变化」标注为参考片基线**：这是设计方案给定的参考片统计，
   不是当前项目实测值；文案显式加「参考片基线」，防止被误读为本项目数据。
5. **即将上线固定 3 卡**：抖音短视频/小说推文/产品宣传，虚线描边 + 低透明度 + 「即将上线」
   pill，不可点击（只做禁用态，方案 §8.5）。
6. **工作流说明为展开区**：用 ghost 按钮切换，展示阶段序号/名称/工具标识/审核点 pill，
   不提供能力启停或编排（能力注册表是服务端只读真相）。
7. **错误分层**：能力接口失败显示错误 + 重试；项目接口失败只影响计数与最近运行表，
   能力卡照常展示（独立容错，`Promise.allSettled`）。
8. **窄屏**：<768 时最近运行表 `display:block + overflow-x:auto` 横向滚动，避免列挤压；
   能力卡与即将上线卡自然堆叠（390×844 已目检）。

## Checkpoint
- 2026-11-07 18:40 任务开始：读方案 §8.4/§8.5 与 SKILL #2；确认 T116 已提供
  `shotCount/latestRun`；确认无需新增服务端接口；设计定稿。
- 2026-11-07 18:52 能力卡 + 页面 + 路由/导航/守卫改造完成；更新 2 个既有测试文件。
- 2026-11-07 18:57 新增测试 13 例一次通过（格式化 4 / 能力卡 4 / 页面 5）；
  三文件合计 44 例通过。
- 2026-11-07 19:02 启动 API/Web，以 `layoutcheck` 登录并完成强制改密 → 落到 `/`；
  桌面 1440×900 与窄屏 390×844 截图，实测 `activeNav=["能力中心"]`、能力卡 1、
  阶段 chips 7、即将上线 3、最近运行 1 行、`scrollWidth` 分别为 1440/390。
- 2026-11-07 19:06 停止服务、删除临时脚本；`typecheck` / `web:build` / `pnpm test` 全过。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm vitest run tests/unit/web-capabilities.test.ts` | pass | 13 例 |
| `pnpm test` | pass | 89 files / 795 tests（较 T302 净增 1 file / 13 tests） |
| `pnpm run typecheck` | pass | 8 个 tsconfig |
| `pnpm run web:build` | pass | 5.06s |
| 目检 1440×900 | pass | [能力中心桌面](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/screenshots/t303-capabilities-1440x900.png) |
| 目检 390×844 | pass | [能力中心窄屏](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/screenshots/t303-capabilities-390x844.png)（无横向滚动，表格可横滑） |

## 断点 / 未完成
- 未完成项：本任务范围内无遗留。
- 已知边界与风险：
  1. **本机数据副作用**：目检完成 `layoutcheck` 的强制改密（口令已改为本轮临时口令，
     未写入任何文件）；`admin` 未改动。如需复用该账号，请执行
     `pnpm --filter @videoforge/cli start db:user --reset-password layoutcheck` 再重置。
  2. 新建项目 Modal（`NewProjectModal`）仍是旧样式（AntD 表单），T304 重写为两步模态
     + Vf 基元；本页只保留入口。
  3. 最近运行表只覆盖「每个项目最新一次 run」，不展示同项目历史 run（Run 详情留 T307）。
  4. 项目数来自前端数量统计（非独立聚合接口）；本机项目量级下可接受，若列表分页引入需
     改为服务端计数。
- 恢复时第一步：进入 T304（项目列表 + 新建项目模态）。

## 风险与后续
- 风险：默认页从 `/projects` 改为 `/`，若有外部书签依赖旧行为需注意；`/capabilities`
  已保留重定向。
- 下一步任务：`T304` 项目列表 + 新建项目模态（依赖 T303，已就绪）。
