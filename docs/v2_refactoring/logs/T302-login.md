# T302 任务日志：登录页

## 元信息
- 任务 ID：T302
- 状态：done
- 开始时间：2026-11-07 17:40
- 结束时间：2026-11-07 18:05
- 关联设计：方案 §8.5 第 1 页（登录：左品牌区 + 右表单，无公开注册，错误行内）、§8.8（键盘/可访问性）、SKILL §3.1（主按钮）、§4 #1
- 依赖任务：T301（AppShell + 基元）
- 后续任务：T303（能力中心）
- 变更文件：
  - `apps/web/src/views/LoginView.vue`（重写：左品牌 + 右表单，删除注册 Tab）
  - `apps/web/src/components/ui/VfButton.vue`（+`type` prop，支持表单 submit）
  - `apps/web/src/components/ui/VfInput.vue`（+`id`/`autocomplete` prop，支持 label 关联与密码管理器）
  - `apps/web/src/services/api.ts`（token 存储支持「记住我」：localStorage / sessionStorage）
  - `apps/web/src/stores/auth.ts`（`login(username, password, remember)`）
  - `tests/unit/web-login.test.ts`（新增 13 例）
  - `docs/guides/operator-guide.md`（§4 补登录页行为说明）

## 意图
按方案 §8.5 第 1 页重写登录页：左侧品牌叙事（slogan + 3 项真实能力 + 阶段 chips），
右侧极简表单（用户名/密码/记住我/忘记密码/登录 + 管理员建号说明）；**删除公开注册**；
错误一律行内提示（不用弹窗）；键盘 Enter 可直接提交。顺带建立 M3 的浏览器目检链路。

## 设计决策
1. **无公开注册**：删除注册 Tab 与 register 调用；底部固定说明「不开放自助注册；账号由管理员
   在「管理 → 用户」创建或重置」。与现有 auth 一致（服务端本就有 `allow_registration` 开关，
   前端不再暴露入口，避免「提交后才知道已关闭」的旧体验）。
2. **「记住我」落到实处**：`setToken(token, persist)` —— 勾选写 localStorage（旧行为），
   不勾选写 sessionStorage（关闭浏览器失效）；写入前两侧先清空，避免同一 token 残留两份。
   `getToken` 先持久后会话；`clearToken` 两侧都清。默认勾选，与旧行为等价、无感迁移。
3. **「忘记密码」不做假跳转**：本机无自助找回接口，管理员可在「管理 → 用户」或 CLI
   `db:user --reset-password` 重置，故点击只给行内指引（role=status），不提供死链。
4. **阶段 chips 与工作台同源**：直接取 `STAGE_LABELS` 的值（七阶段），避免登录页自造一套
   命名；T004b 前端扩到 8 阶段时自动跟随。
5. **3 项特性只写已落地能力**：一句一镜（单镜重生成）、逐句字幕（cue + ASS 轨）、
   质检门禁（5 项检查）——均已在 M1/M2 交付，不写「即将上线」的虚项。
6. **基元小步补齐**（必要而非扩张）：`VfButton` 增加 `type` prop（表单内主 CTA 需 submit，
   否则 Enter/表单语义失效）；`VfInput` 增加 `id` 与 `autocomplete`（`<label for>` 关联、
   密码管理器识别）。视觉零改动。
7. **错误处理统一行内**：AUTH_INVALID → 固定文案「用户名或密码错误」并清空密码；
   其它错误走 `formatApiError`；全部渲染为 `role="alert"` 的行内块，不使用 message 弹窗。
8. **响应式**：≥960 两栏（品牌 1fr + 表单 480px）；<960 单列（品牌在上）；
   <480 隐藏特性与副文案，保留 slogan、chips 与表单（390×844 验收档）。

## Checkpoint
- 2026-11-07 17:40 任务开始：读方案 §8.5 与 SKILL §4 #1；确认管理页具备重置密码能力
  （「忘记密码」指引可执行）；设计定稿。
- 2026-11-07 17:47 LoginView 重写 + 基元两处补齐 + token 存储改造完成；测试 13 例一次通过
  （结构 3 / 提交回跳 3 / token 语义 3 / 行内错误 4）。
- 2026-11-07 17:49 启动 API（:3000，JWT_SECRET 本机开发值）与 Web（:5173）建立目检链路。
- 2026-11-07 17:50 桌面 1440×900 登录页截图；MCP 浏览器视口参数不可靠（复用实例忽略
  width/height），改用临时 Playwright 脚本精确控制视口（脚本在系统 temp，用后删除）。
- 2026-11-07 17:52 390×844 截图：单列布局、chips 换行、`scrollWidth=390` 无横向滚动。
- 2026-11-07 17:56 登录链路：重置目检账号 `layoutcheck` 口令（CLI 输出一次性），
  脚本以 click 提交 → 进入 `/settings?force=1`；壳实测 `siderWidth=196`、`headerHeight=56`、
  `scrollWidth=1440`；1180×900 档收栏为 64px。
- 2026-11-07 18:00 键盘路径复验：改为在密码框 `press("Enter")` 提交，同样成功跳转。
- 2026-11-07 18:02 停止 API/Web 进程、删除临时脚本与 3 张错误视口截图。
- 2026-11-07 18:04 `pnpm run typecheck` / `pnpm run web:build` / `pnpm test` 全过。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm vitest run tests/unit/web-login.test.ts` | pass | 13 例：结构 3、提交回跳 3（含 remember=false、默认落地）、token 存储 3、行内错误/指引/禁用 4 |
| `pnpm test` | pass | 88 files / 782 tests（较 T301 净增 1 file / 13 tests） |
| `pnpm run typecheck` | pass | 8 个 tsconfig 全通过 |
| `pnpm run web:build` | pass | 构建成功（10.92s） |
| 浏览器目检 1440×900 | pass | [登录页桌面](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/screenshots/t302-login-desktop-1440x900.png) |
| 浏览器目检 390×844 | pass | [登录页窄屏](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/screenshots/t302-login-mobile-390x844.png)（无横向滚动） |
| 浏览器目检登录后壳 | pass | [壳 1440×900](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/screenshots/t302-shell-after-login-1440x900.png)（196px/56px）、[收栏 1180×900](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/screenshots/t302-shell-compact-1180x900.png)（64px） |

## 断点 / 未完成
- 未完成项：本任务范围内无遗留。
- 已知边界与风险：
  1. **本机数据副作用**：为验证登录链路，重置了目检账号 `layoutcheck` 的口令（CLI 一次性输出，
     未记录到任何文件），并被置为「下次登录需改密」。该账号属历史目检账号，如需继续使用，
     请由管理员再次重置。未改动 `admin` 账号。
  2. 登录后强制改密会跳 `/settings?force=1`（既有守卫逻辑），因此本次壳目检在设置页完成；
     设置页本体属 T311/T312 之外的旧页，视觉过渡态待后续逐页重写。
  3. AppShell 收栏模式仅靠原生 `title` tooltip（非 AntD Tooltip）；如后续要求悬浮气泡，
     在 T313 键盘/可访问性验收时统一升级。
  4. 「记住我」只影响 token 存储位置，不改变服务端无状态 JWT 的有效期。
- 恢复时第一步：进入 T303（能力中心：能力卡 + 即将上线 + 最近运行表）。

## 风险与后续
- 风险：删除注册 Tab 后，若用户仍习惯自助注册会看到「不开放」说明——属方案 §8.5 明确行为。
- 下一步任务：`T303` 能力中心（依赖 T301/T116，均已就绪）。
