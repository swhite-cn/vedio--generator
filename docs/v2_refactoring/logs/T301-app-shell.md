# T301 任务日志：AppShell + 设计基元

## 元信息
- 任务 ID：T301
- 状态：done
- 开始时间：2026-11-07 16:20
- 结束时间：2026-11-07 16:45
- 关联设计：方案 §8.1–§8.4（依赖策略/令牌/App Shell/路由表）、§8.6（基元清单）、§8.8（可访问性）
- 依赖任务：T007（tokens.css + theme.ts，T301 为预告的接入切换点）
- 后续任务：T302（登录页，此后建立浏览器目检链路）
- 变更文件（13 个，超出"默认 ≤10"约束——壳 + 基元 + 令牌接入是 T007 预告的一次性切换，拆开会留下中间态）：
  - `apps/web/src/components/ui/`：`VfButton.vue`、`VfPill.vue`、`VfCard.vue`、`VfInput.vue`、`VfModal.vue`、`VfJsonBlock.vue`（新增 6 基元，任务板清单范围）
  - `apps/web/src/layouts/AppShell.vue`（新增：方案 §8.3 外壳）
  - `apps/web/src/views/PlaceholderView.vue`（新增：素材库/组件库占位空态）
  - `apps/web/src/main.ts`（+ `tokens.css` 全局引入）
  - `apps/web/src/App.vue`（浅色 token → `VF_THEME` 深色映射；AppLayout → AppShell）
  - `apps/web/src/router.ts`（+ `/assets`、`/components` 占位路由；全路由 `meta.breadcrumb`）
  - `vitest.config.ts`（+ vue/pinia/vue-router/ant-design-vue alias，见设计决策 8）
  - `tests/unit/web-ui-primitives.test.ts`（新增 19 例，仓库首个挂载型组件测试）

## 意图
按方案 §8.3/§8.6 落地新外壳与 6 个设计基元，并把 T007 冻结的深色令牌接入全局：
`tokens.css` 进 main.ts、AntD 切 `VF_THEME`（darkAlgorithm）、路由默认布局切 AppShell。
旧页面（T302–T312 逐页重写前）进入「暗壳 + 旧内容」过渡态。

## 设计决策
1. **一次性切换壳与主题**（T007 日志预告）：main.ts 引 tokens.css + App.vue 换 VF_THEME +
   布局切 AppShell 同任务完成；`global.css` 保留到 T314（旧页面仍引用 `--vf-*` 浅色变量，
   两套令牌并存是已知过渡态）。
2. **路由策略**：AppShell 直接成为默认布局；`/assets`、`/components` 按方案 §8.4 登记为
   占位页（PlaceholderView 产品文案空态），页面本体留 T309/T310；`/` 仍重定向 `/projects`
   （能力中心成为默认首页属 T303）。
3. **AppShell 规格**（方案 §8.3）：侧栏 196px `--deep` + Logo 30×30 + "VideoForge" 16/600；
   5 项导航（能力中心/项目/素材库/组件库/管理，管理仅 admin），38px 行高、选中 `--surface-2`
   + 左侧 3×20 accent 条；底部用户卡（名称+角色，下拉：个人设置/退出登录，沿用现有 auth 行为）；
   顶栏 56px + 面包屑 12.5px（`route.meta.breadcrumb` 优先，已知前缀兜底）+ 搜索 240×34 +
   通知入口 + 头像 32px；内容 padding 28px、`<main>` 语义标签。
4. **断点合并**：方案给 960–1279（64px 图标栏）与 <768（抽屉）两档，768–959 空档并入收栏档，
   即 `<1280` 收栏、`<768` 抽屉；`matchMedia` 双查询驱动。
5. **基元边界**：VfButton 用原生 button（视觉全自研，`focus-visible` accent 环）；
   VfPill 软底/前景成对 + 可选 dot（§8.8 不只靠颜色）；VfInput 原生受控 input；
   VfModal 包装 a-modal（焦点陷阱/ESC 由 AntD 行为层保证），**footer 默认 null、由 #footer
   插槽自绘**——按钮统一走 VfButton，不混 AntD 默认按钮；VfJsonBlock 用 `--font-mono`
   （技术文本约定 §8.2）+ 可选复制按钮（clipboard 不可用静默）。
6. **顶栏搜索/通知只做视觉结构**：搜索 VfInput 可输入无行为（T312 接全局搜索）、通知图标
   按钮 aria-label 标注「暂未开放」，避免假交互。
7. **测试基建**：仓库首个挂载型测试（`// @vitest-environment jsdom` + @vue/test-utils）；
   AppShell 用真实内存路由（createMemoryHistory + 全导航目标路由）而非 mock vue-router
   ——mock 因「测试文件与 SFC 对 vue-router 的解析路径不一致」不可靠；jsdom 缺 matchMedia
   以恒不命中替身补齐。
8. **vitest alias 扩展**：pnpm 严格隔离下根目录无 vue/pinia/vue-router/ant-design-vue
   （装在 apps/web），统一解析到 apps/web 实例（与 playwright/remotion 先例同口径）。

## Checkpoint
- 2026-11-07 16:20 任务开始：读 T007 日志与方案 §8.1–§8.6；确认 T301 为令牌接入切换点；
  设计定稿（壳+基元+接线一次性切换，13 文件）。
- 2026-11-07 16:30 6 基元 + AppShell + PlaceholderView + 三处接线完成。
- 2026-11-07 16:38 测试三轮修复：① 根目录无 vue（vitest alias 补 4 个包）；② vue-router
  mock 不生效（解析路径不一致，改真实内存路由）；③ jsdom 缺 matchMedia（stub）。
  19 例全过。
- 2026-11-07 16:41 `pnpm test` 87 files / 769 tests 全过；`pnpm run typecheck` 通过；
  `pnpm run web:build` 通过（5.08s；chunk >500kB 警告为 AntD 全量注册的既有现状）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm vitest run tests/unit/web-ui-primitives.test.ts` | pass | 19 例：VfButton 3（4 变体/默认与点击/disabled）、VfPill 3、VfCard 2、VfInput 2、VfJsonBlock 3、AppShell 5（4/5 项导航、选中态、面包屑、用户卡）、Placeholder 1 |
| `pnpm test` | pass | 87 files / 769 tests（较 T210 净增 1 file / 19 tests） |
| `pnpm run typecheck` | pass | 8 个 tsconfig 全通过 |
| `pnpm run web:build` | pass | 3263+ modules，构建成功 |

## 断点 / 未完成
- 未完成项：本任务范围内无遗留。
- 已知边界与风险：
  1. **浏览器目检推迟到 T302**：协议要求前端变更浏览器检查，但 AppShell 挂在受登录守卫
     保护的布局上，未登录只能见 blank 布局登录页；T302 重写登录页后立即建立「API + 登录 +
     截图」的目检链路，作为 M3 后续任务的持续验收面。壳规格暂由组件挂载测试 + tokens
     断言锁定。
  2. 旧 7 页进入「暗壳 + 旧内容」过渡态（global.css 浅色变量仍被旧页面引用），视觉退化
     为预期中间态，T302–T312 逐页消除、T314 删旧。
  3. 顶栏搜索/通知无行为（T312/T313 接入）；用户菜单行为与旧外壳一致（settings/logout）。
  4. VfModal footer 默认 null 是刻意选择，页面迁移时需自绘 footer（T302+ 逐页处理）。
- 恢复时第一步：进入 T302（登录页：左品牌 + 右表单，blank 布局重写）。

## 风险与后续
- 风险：AntD 深色主题与旧页面 scoped 样式混排的视觉割裂比预期重/轻，需 T302 浏览器目检确认。
- 下一步任务：`T302` 登录页（依赖 T301，已就绪）。
