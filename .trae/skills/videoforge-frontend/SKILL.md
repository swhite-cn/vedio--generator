---
name: videoforge-frontend
description: 指导 VideoForge 工作台（apps/web）的前端设计与实现，覆盖设计令牌、应用外壳、基元组件、状态色映射与页面结构。当需要新建或重构 Vue 页面、组件、样式，或核对令牌与状态时使用。不适用于 server、pipeline 或 CLI 改动。
---

# VideoForge 工作台前端规范（apps/web）

## 0. 适用范围与权威来源

用于 `apps/web`（Vue 3 + Vite + Vue Router + Pinia + Ant Design Vue 4 全量注册 + `ConfigProvider` zhCN）的新建与重构。**先读代码再动手**。

权威顺序（冲突时从高到低）：**当前代码 > 本 skill > `docs/v2_refactoring/SKILL.md`**。后者是重构前的设计稿，已部分偏离落地结果（UI 基元由 12 收敛为 6；审核点固定 `copy`/`image`，`scene` 审核点不做；页面路由已调整）。不要按设计稿还原未落地的能力。

必读文件：

| 文件 | 作用 |
| --- | --- |
| `apps/web/src/styles/tokens.css` | 设计令牌唯一来源（颜色/字号/圆角/间距/壳尺寸/动效） |
| `apps/web/src/styles/theme.ts` | Ant Design Vue 深色主题映射（只镜像少量基础色） |
| `apps/web/src/styles/global.css` | reset、焦点环、滚动条、`prefers-reduced-motion` |
| `apps/web/src/layouts/AppShell.vue` | 应用外壳、导航、面包屑、全局搜索 |
| `apps/web/src/components/state-mapping.ts` | 状态色/文案唯一映射 + 时间格式化 helper |
| `apps/web/src/components/ui/*.vue` | 6 个基元组件 |
| `apps/web/src/router.ts` | 路由表（页面清单的权威） |

## 1. 硬性规则

- **只用深色主题**：禁止浅色、渐变背景、玻璃拟态、emoji、彩色投影。
- **数值只引用令牌**：颜色、圆角、字号、间距一律用 `tokens.css` 变量，禁止魔法值。
- **禁止半透明叠色**：不用 `rgba` 叠层做遮罩/阴影；遮罩用 `var(--overlay-color)` + `opacity: var(--overlay-opacity)`，阴影只用 `--shadow-modal`。
- **成片令牌隔离**：`--film-*` 只用于预览画布与主题色板展示，禁止出现在界面控件。
- **AntD 配色双写**：新增/修改语义色时先改 `tokens.css`，再同步 `theme.ts`（AntD 算法不能接受 CSS 变量作主色）。
- **不加 UI 依赖**：现有仅 `ant-design-vue` 与 `@ant-design/icons-vue`；不为单个控件引入新库。
- **样式作用域**：组件视觉写在 SFC 的 scoped 样式；不要用全局选择器覆盖 AntD 组件。
- 界面文案用中文；新增函数加中文函数级注释。

## 2. 设计令牌

值以 `tokens.css` 为准，这里只规定「用哪一组」：

| 组 | 变量 | 用途 |
| --- | --- | --- |
| 背景层级 | `--bg` < `--deep` < `--surface` < `--surface-2` / `--inset` | 页面 < 侧栏 < 卡片 < 悬停·表头 / 代码·内嵌 |
| 描边 | `--border`（常规）、`--border-soft`（分隔线） | 统一 1px |
| 文本三级 | `--text`、`--text-sec`、`--text-ter` | 正文 / 次级 / 辅助标注 |
| 主色 | `--accent`、`--accent-soft` | 唯一强调色及其软底 |
| 语义色 | `--success`、`--danger`、`--warning`、`--info`、`--teal` 及各自 `-soft` | 前景与软底成对使用 |
| 字体 | `--font-sans`、`--font-mono` | 界面 / 技术文本 |
| 字号 | `--font-size-caption`(10.5) → `--font-size-page-title`(20) | 严格遵守阶梯 |
| 圆角 | `--radius-card`(12)、`--radius-control`(8)、`--radius-pill` | 卡片 / 控件 / pill·头像 |
| 间距 | `--space-1..8`（4px 栅格） | 内边距与间距 |
| 壳尺寸 | `--shell-sider-width`(196)、`--shell-header-height`(56)、`--shell-content-padding`(28)、`--shell-inspector-width`(292) | 外壳与检查器 |
| 动效 | `--motion-fast`(120ms)、`--motion-base`(200ms) | 过渡与加载 |

`--font-mono` 仅用于技术性内容：Run ID、时间码、文件名、JSON、镜头号（如 `#21`）、cue 计数、组件 `id`/`category`。

## 3. 基元组件（只有 6 个）

| 组件 | 关键 props | 用途 |
| --- | --- | --- |
| `VfButton` | `variant`(accent/ghost/danger/success)、`type` | 所有按钮；主操作 accent、次操作 ghost、破坏性 danger、确认 success |
| `VfPill` | `tone`(neutral/accent/success/danger/warning/info/teal)、`dot` | 状态与标签；软底 + 语义前景 |
| `VfCard` | `title`、`#header` 插槽 | 内容卡片 |
| `VfInput` | `v-model`、`type`、`ariaLabel`、`id`、`autocomplete` | 原生 input 统一视觉；带前后缀/校验的复杂输入用 `a-input` |
| `VfModal` | `v-model:open`、`title`、`width`、`#footer` 插槽 | 包装 `a-modal`，行为（ESC、焦点陷阱）交给 AntD |
| `VfJsonBlock` | `value`、`copyable`、`maxHeight` | JSON/请求响应展示，内置复制 |

其余 UI 需求直接用 AntD（`a-table`/`a-select`/`a-tag`/`a-empty`/`a-drawer` 等），**不要新增第 7 个基元**，除非用户明确要求。

## 4. 状态、文案与格式化

全站状态一律经 `state-mapping.ts`，禁止在组件内自写映射：

- `mapProjectStatus`（5 态：草稿/运行中/待审核/已完成/失败）、`mapRunStatus`（6 态，`canceled` 按 `errorCode` 区分「已取消」/「已中断」）、`mapStageStatus`（5 态）。
- 颜色只走 `statusTone(color)` → `VfPill` 的 tone，不再用 `a-tag` 颜色字符串。
- `statusTooltip` 提供中断/跳过提示；`STAGE_LABELS` 为八阶段中文名（文案/配图/场景/配音/字幕/时间轴/渲染/合成）；工具中文名用 `toolDisplayName`。
- 时间与时长格式化用 `state-mapping.ts` / `format.ts` 的 helper，不要手写拼接。

## 5. 外壳与响应式

- 布局：196px 侧栏（`--deep`）+ 56px 顶栏 + 内容区 padding 28px。
- 导航固定 5 项：能力中心 / 项目 / 素材库 / 组件库 / 管理（管理仅 `role === "admin"` 可见）；38px 行高，选中态 = `--surface-2` 底 + 左侧 3×20 主色条。
- 顶栏：面包屑（`route.meta.breadcrumb`）+ 全局搜索（240×34）+ 通知 + 头像；搜索支持 ↑↓/Enter/Esc 键盘导航。
- 响应式：`<1280px` 侧栏收为 64px 图标栏；`<768px` 改抽屉导航并在顶栏显示菜单按钮；新页面必须同时适配桌面与约 390px 窄屏。
- 可访问性：`:focus-visible` 焦点环 2px `--accent`；交互同时覆盖指针与键盘；表单需要有可访问名称与 `<label>` 关联。

## 6. 页面清单与路由

| 页面 | 路由 | 关键内容 |
| --- | --- | --- |
| 登录 | `/login` | 品牌区 + 登录表单（公开，无外壳） |
| 能力中心 | `/`（`/capabilities` 重定向） | 能力卡片、即将上线、最近运行 |
| 项目列表 | `/projects` | 卡片网格，meta 形如「N 镜头 · m:ss」+ 状态 pill |
| 工作台 | `/projects/:id` | 左对话流 + 右 4 Tab（阶段进度 / 分镜时间轴 / 项目资产 / 流水线产物） |
| 分镜编辑器 | `/projects/:id/storyboard` | 场景栏 + 预览画布 + 镜头条 + 时间轴 + 镜头 Inspector |
| Run 详情 | `/projects/:id/runs/:runId` | 失败 banner、8 阶段列表、工具调用表、请求/响应/质检三卡 |
| 旧 Trace 入口 | `/runs/:id/trace` | 301 到 Run 详情，勿再作为独立页扩展 |
| 素材库 | `/assets` | 风格锚说明 + 类型筛选 + 卡片网格 |
| 组件库 | `/components` | 7 类版式组件预览卡 |
| 设置 | `/settings` | 账户与偏好 |
| 管理 | `/admin` | 用户表 + 登录日志（`requiresAdmin`） |

新建项目是模态（`NewProjectModal`），不是路由。

## 7. 数据模型 → UI 映射（v2，不可违背）

1. **镜头级优先**：统计一律用「N 镜头」（来自 `scenes[].shots[]`），禁止用「场景数」概括。
2. **cues 是时间真相**：配音产物为逐句时间戳；工具调用产物数显示 `N cues`。
3. **字幕是独立 ASS 轨**：时间轴单列一轨；规范白字黑边、底部 6%、单行 ≤18 字，超限触发质检「字幕溢出」。
4. **组件 7 类固定**：`text`/`data`/`quote`/`compare`/`progress`/`chapter`/`source`；LLM 只选模板填参数，UI 不提供自由 HTML 输入。
5. **动效固定 0.3–0.8s**：不做时间轴拉伸。
6. **转场 3 型**：硬切 / 标题卡 / 120ms 淡入，Inspector 用枚举选择。
7. **风格锚**：同符号跨镜头复用同一资产 + seed；镜头重生成要提示「seed 锚定、不影响其余镜头」。
8. **质检 5 项固定**（顺序即展示顺序）：`freeze` 静帧、`subtitle-overflow` 字幕溢出、`source-label` 来源标签、`contrast` 对比度、`animation-duration` 动效时长；失败项须定位到镜头号。
9. **前端只渲染服务端字段，不推导状态机**：项目 5 态 / run 6 态 / 阶段 5 态以服务端为准；SSE 接入遵守 `Last-Event-ID` + `resync`。

## 8. 交付与验证

- 行为变更先补/更新 Vitest（`tests/unit/`），再跑 `pnpm test`、`pnpm run typecheck`、`pnpm build`。
- 涉及交互/样式时在浏览器检查关键交互，并覆盖桌面与约 390px 窄屏。
- jsdom 下挂载含 `a-table` 的组件需注入 `window.matchMedia` 替身（见 `tests/unit/web-artifact-tabs-v2.test.ts`）。
- 用户可见行为变化同步维护 `docs/guides/developer-guide.md` 或 `operator-guide.md`。

## 9. Do / Don't

**Do**：所有取值引用令牌；技术文本用等宽；保持信息密度；状态一律走映射表；空态用一行说明 + 主操作按钮。

**Don't**：不用浅色/渐变/emoji/玻璃拟态；不自创第 8 类组件、第 4 种转场、第 7 个基元；不把 `--film-*` 用于界面控件；不用半透明叠色做遮罩；不在组件内重写状态映射；不硬编码 API 主机名或端口。
