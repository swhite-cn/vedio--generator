# T208 任务日志：Player 应用 + iframe 协议

## 元信息
- 任务 ID：T208
- 状态：done
- 开始时间：2026-11-07 15:15
- 结束时间：2026-11-07 15:30
- 关联设计：方案 §8.9（预览器嵌入）、§7.1（GET /api/player/:projectId/:shotId?）、C6（iframe 播放器，避免 React-in-Vue）
- 依赖任务：T201（ShotsComposition）、T204（render-input 装配复用）
- 后续任务：T308（分镜编辑器消费 iframe）、T313（键盘/响应式验收）
- 变更文件：
  - `packages/remotion-engine/src/slice.ts`（新增：单镜头预览切片）+ `package.json`（子路径导出 composition/slice/theme）
  - `apps/player/`（新增：package.json / tsconfig / vite.config / index.html / src/protocol.ts / src/main.tsx）
  - `apps/server/src/http/routes/player.ts`（新增 HTML 入口）、`http/index.ts`（注册）
  - `apps/server/src/app.ts`（@fastify/static 挂 /player/，dist 缺失时跳过并告警）、`apps/server/package.json`（+@fastify/static）
  - `package.json`（typecheck + apps/player；player:build 脚本）、`.gitignore`（apps/player/dist/）
  - 测试：`tests/unit/player-protocol.test.ts`（新增 6 例）、`tests/integration/project-run-api.test.ts`（+1 例）

## 意图
按方案 §8.9 交付预览播放器：`apps/player`（React + @remotion/player）构建为单入口 IIFE
bundle，由 Fastify 在 `/player/` 提供静态服务；`GET /api/player/:projectId/:shotId?`
动态渲染 HTML 并内联渲染数据（同源免二次鉴权）；postMessage 协议 5 条；失败不白屏。

## 设计决策
1. **单镜头预览 = 输入切片而非 composition 平移**：`sliceTimelineForShot` 把目标镜头平移到
   0ms（cue 同步平移过滤），composition 不改动——renderShots 的绝对帧号语义不受预览影响。
2. **数据内联而非 Player 内 fetch**：HTML 入口鉴权后复用 `prepareShotRenderInput` 组装
   `window.__PLAYER_DATA__`（`<`/U+2028/U+2029 转义），iframe 内无需携带 token。
3. **浏览器安全导入边界**：remotion-engine 新增子路径导出（./composition、./slice、./theme），
   Player 只经由子路径导入——index 再导出 render.ts（node:fs）与 entry.tsx（@remotion/bundler），
   不能进浏览器 bundle；vite 依赖 exports 解析，不做字符串 alias（前缀匹配会破坏 `pkg/sub`）。
4. **协议收口为纯函数**：`createPlayerMessageHandler`（seek/play/pause/shot 分发 + 畸形载荷/
   未知类型静默忽略）可脱离 DOM 单测；ready 消息 `{ type:"player:ready", shotId }`。
5. **失败不白屏（三层）**：服务端数据组装失败 → 内联 `error` 字段（Player 显示错误码）；
   bundle 加载失败 → HTML noscript/空背景兜底；React 渲染异常 → ErrorBoundary 错误态
   （PLAYER_RENDER_FAILED）。
6. **静态服务条件注册**：`apps/player/dist/player.js` 不存在时跳过 `/player/` 注册并告警
   （HTML 入口仍可用，脚本 404 由错误态兜底）；构建命令 `pnpm run player:build`。

## Checkpoint
- 2026-11-07 15:15 任务开始：读方案 §8.9/§7.1；设计定稿（切片 + 内联数据 + 子路径导出）。
- 2026-11-07 15:22 slice.ts / apps/player / player 路由 / 静态服务 / 构建接线完成；
  typecheck 过（NodeNext 相对导入补 .js 后缀）。
- 2026-11-07 15:25 vite build 两处修复：index 裸导入把 node 依赖卷进 bundle → 子路径导出；
  alias 前缀匹配破坏 `pkg/sub` 解析 → 删除 alias 依赖 exports。构建 ✓ 1.74s。
- 2026-11-07 15:28 单测 6 例 + 集成（HTML 入口/错误态/403）通过。
- 2026-11-07 15:30 全量 typecheck + `pnpm test` 84 files / 739 tests 通过。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm run typecheck` | pass | 8 个 tsconfig 全通过（含 apps/player） |
| `pnpm run player:build` | pass | `apps/player/dist/player.js`（IIFE 单文件） |
| `pnpm test` | pass | 84 files / 739 tests（较 T207 的 733 净增 6） |
| `pnpm vitest run tests/unit/player-protocol.test.ts` | pass | 6 例（协议分发/畸形忽略/ready/切片平移/规格切出/越界报错） |
| `$env:VF_SMOKE="1"; pnpm vitest run tests/integration/project-run-api.test.ts` | pass | 29 例（+1：HTML 入口内联数据/错误态/403） |

## 断点 / 未完成
- 未完成项：本任务范围内无遗留。
- 已知边界与风险：
  1. Player UI 的视觉细节（控件样式、播放头、键盘 seek）留 M3 前端重写（T308 消费 iframe 时
     按方案 §8.8 验收）；本任务交付协议与可播放内核。
  2. postMessage 目标 origin 为 `*`（本地同源 harness）；若未来对外开放监听需收紧 origin。
  3. `player:shot` 切换在 Player 内重切片（重挂 Player）；宿主侧的镜头列表联动 UI 留 T308。
  4. bundle 约 1 个文件包含 react/remotion（~几百 KB），未做分包——本地 iframe 加载可接受，
     体积优化留 T210 之后的按需评估。
- 恢复时第一步：进入 T209（legacy 渲染开关）。

## 风险与后续
- 风险：`/api/player` HTML 引用固定路径 `/player/player.js`；dist 未构建时 iframe 显示
  脚本 404 的浏览器默认错误——已在 createApp 启动日志告警，操作者需先跑 `player:build`。
- 下一步任务：`T209` legacy 渲染开关（`VF_RENDERER=legacy`，依赖 T204 已就绪）。
