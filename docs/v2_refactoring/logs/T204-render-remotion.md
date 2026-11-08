# T204 任务日志：render 阶段切 Remotion

## 元信息
- 任务 ID：T204
- 状态：done
- 开始时间：2026-11-07 12:30
- 结束时间：2026-11-07 12:50
- 关联设计：方案 §4.2（渲染层职责）、§7.2（asset.bound/preview.ready）、§7.3（镜头级重渲：render 只渲染该 shot 帧区间）、M2 出口判据
- 依赖任务：T201（renderShots/renderShotStill）、T112（v2 结构判据）、T119（SSE 事件类型表）
- 后续任务：T205（compose 消费 shots/ 帧目录）、T209（legacy 开关）、T210（性能基线）
- 变更文件：
  - `packages/remotion-engine/src/render.ts`（publicDir + imageByShot 输入，bundle 透传）
  - `packages/remotion-engine/src/composition.tsx`（ShotsCompositionProps.imageByShot；image 视觉层真实路径优先、assetId 占位回退）
  - `packages/remotion-engine/src/entry.tsx`（schema + imageByShot，占位 props 补 null）
  - `apps/server/src/domain/render-input.ts`（新增：项目产物 → 渲染输入装配）
  - `apps/server/src/agent/tools/stage-tools.ts`（render_frames v2 分支 + image_generate 的 asset.bound + render 的 preview.ready）
  - `apps/server/src/agent/session-registry.ts`（onProjectEvent 出口 + stage 上下文注入 sessionId/publishEvent）
  - `apps/server/src/agent/runtime.ts`、`apps/server/src/app.ts`（事件出口接 eventBus）
  - `apps/server/package.json`（+ @videoforge/remotion-engine）、`apps/server/tsconfig.json`（+jsx，随包源被引入）
  - `vitest.config.ts`（+ @videoforge/remotion-engine alias）
  - 测试：`tests/unit/render-input.test.ts`（新增 7 例）、`tests/unit/agent-stage-tools.test.ts`（+6 例）、`tests/unit/remotion-engine.test.ts`（+1 例）、`tests/unit/remotion-components.test.tsx`（+2 例）

## 意图
render_frames 在 `contractVersion=2.0` 时从 legacy Playwright 截屏切到 `renderShots()`：
镜头级渲染输出 `build/render/<landscape|portrait>/shots/<shotId>/element-N.jpeg`（与 v1 的
`frames/` 互不覆盖，T205 compose 按 v2 布局消费）；`shotIds` 天然支持镜头级重渲（方案 §7.3）；
资产映射经 publicDir 挂载；SSE 新增两个发布点。v1 项目继续走 legacy（T209 再做显式开关）。

## 设计决策
1. **切换口径按 `ctx.contractVersion`**，不引入新环境变量（T209 才做 `VF_RENDERER=legacy`）。
2. **publicDir 用 `images/` 子目录**而非整个项目目录——Windows 下 bundle 恒复制 publicDir，
   复制整个项目（含 build/ 帧序列、audio）不可接受；images/ 量级几十 MB 可接受。
3. **imageByShot 按 shotId 键控**：copy v2 的 `imagePath` 恒为 `images/<shotId>.png`（T103 回填），
   无需查 project_assets 表；SceneSpec 的 `assetRefs[].assetId` 是数据库 ID，渲染层不解析
   （symbol 类资产留 T401 风格锚）。image 视觉层无映射时回退 assetId 占位，缺资产可定位不白屏。
4. **SSE 通道**：StageToolContext 增加可选 `sessionId` + `publishEvent`；会话注册表经
   `onProjectEvent` 回调把发布转交 app 层 eventBus（agent 层只依赖 event-bus 的类型，
   不 import 实现）；发布失败只告警，不阻塞工具结果。
5. **渲染并发**沿用 `runtime.max_concurrent_stage`（remotion 的 concurrency=page 数）；
   浏览器路径复用 `tools.chromium_path`（空值由 remotion 自解析或下载）。
6. **路径安全**：imagePath 经 `resolveArtifactPath` 拒绝逃逸项目目录（PATH_OUTSIDE_STORAGE）；
   逃出 images/ 但在项目内的（如 audio/）跳过该映射，兼容历史脏数据。

## Checkpoint
- 2026-11-07 12:30 任务开始：读 T201/T112 日志与方案 §7.2/§7.3；确认 bundle() 支持
  publicDir（@remotion/bundler 4.0.541，Windows 恒复制）；设计定稿。
- 2026-11-07 12:40 remotion-engine 三文件 + render-input + stage-tools + 接线完成；
  typecheck 通过（apps/server 需补 jsx 选项——引入 .tsx 源后 tsc 传导检查）。
- 2026-11-07 12:45 单测修复两处：v2 夹具需真实存在 images/sh-001.png（existsSync 边界）；
  SSR 测试需把 remotion Sequence mock 为透传（其内部读 video config，不受 useVideoConfig mock 控制）。
- 2026-11-07 12:48 `pnpm run typecheck` + `pnpm test` 全过（81 files / 693 tests）；
  `VF_SMOKE=1` 冒烟 3 例过（真 Chrome 出帧，含 renderShots/renderShotStill）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm run typecheck` | pass | 7 个 tsconfig 全通过 |
| `pnpm test` | pass | 81 files / 693 tests（较 T203 的 677 净增 16） |
| `pnpm vitest run tests/unit/render-input.test.ts` | pass | 7 例（齐备/缺文件/逃出 images/逃出项目/v1/缺快照/缺 spec） |
| `pnpm vitest run tests/unit/agent-stage-tools.test.ts` | pass | 33 例（+6：v2 渲染参数与 preview.ready、缺快照、事件失败不阻塞、v1 不触 Remotion、asset.bound 发布与 v1 抑制） |
| `$env:VF_SMOKE="1"; pnpm vitest run tests/integration/remotion-smoke.test.ts` | pass | 3 tests（真 Chrome：单帧 PNG + 3 帧序列 + 7 组件 21 帧） |

## 断点 / 未完成
- 未完成项：本任务范围内无遗留。
- 已知边界与风险：
  1. `renderShotStill`（单帧预览）已具备 publicDir/imageByShot 能力，但尚无 HTTP 入口消费；
     镜头预览 API 留 T208（Player）/T308（分镜编辑器）。
  2. v2 渲染的 `preview.ready`/`asset.bound` 只在「阶段工具经会话注册表装配」的链路上发布
     （CLI/单测装配未传 publishEvent 时不发布），符合事件语义但意味着直接调内核不发事件。
  3. Windows 下每次 renderShots 复制 images/ 进 bundle tmp 目录（几秒内）；T210 性能基线需记录，
     不在此承诺优化。
  4. symbol/video 视觉类型仍渲染占位层（方案未给实现规格，组件齐备性以 7 类 component 为准）。
- 恢复时第一步：进入 T205（compose：ASS + BGM + loudnorm，消费 shots/ 帧目录）。

## 风险与后续
- 风险：v1/v2 渲染产物目录已分离（frames/ vs shots/<shotId>/），compose_video 当前只认 v1 布局；
  v2 项目在 T205 落地前 compose 会失败——属预期中间态（render 已 v2、compose 未跟进）。
- 下一步任务：`T205` compose：ASS 字幕烧录 + BGM + loudnorm（依赖 T105/T204，均已就绪）。
