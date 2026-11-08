# T501 任务日志：删除 legacy renderer/template-sdk

## 元信息
- 任务 ID：T501
- 状态：done
- 开始时间：2026-11-08 10:20
- 结束时间：2026-11-08 11:05
- 关联设计：方案 §3.2（推倒清单）、§3.4/§6.3（旧资产兼容与迁移）、§6.2（工作区布局）、§10（M5 出口）
- 依赖任务：T209（渲染通道决策表）、T314（M3 前端收口）
- 后续任务：T502（文档与 AGENTS 更新）、T504（旧项目迁移提示 + CLI 校验）
- 变更文件：
  - 删除：`packages/renderer/**`、`packages/template-sdk/src/{minimal-scene,scene-contract,gsap-vendor}.ts`、`packages/pipeline/src/timeline.ts`、`apps/server/src/domain/renderer-switch.ts`
  - 改写：`packages/template-sdk/src/{index.ts,contracts.ts}`（仅留 Profile + 组件注册表）
  - 改写为 v2-only：`packages/pipeline/src/{scene-generate.ts,compose-video.ts,storyboard-generate.ts,index.ts}`
  - 改写：`apps/server/src/agent/tools/stage-tools.ts`（删 legacy 分支与 import）
  - 元数据：`apps/server/package.json`、`packages/remotion-engine/package.json`、`package.json`、`vitest.config.ts`、`.prettierignore`、`pnpm-lock.yaml`
  - 路由：`apps/server/src/http/routes/projects.ts`（新项目固定 `contractVersion=2.0`）
  - 注释：`apps/web/src/components/ArtifactTabs.vue`（去掉对已删文件的引用）
  - 测试：删除 7 个 legacy 用例文件；改写 `render-baseline`/`agent-stage-tools`/`agent-builtin-tools`/`agent-session-registry`/`storyboard-v2`

## 意图
M5 出口要求「仓库无 legacy 代码路径」。删掉 Playwright + GSAP 的 v1 场景渲染通道（`packages/renderer`）
与其配套的 template-sdk 场景契约、pipeline 的 v1 分支、服务端渲染通道开关，使运行时只剩 v2（Remotion + SceneSpec）一条路径。

## 改动
**删除（legacy 代码路径）**
- `packages/renderer/**` 整包（`render.ts` / `render-sequence.ts` / `render-frames.ts` / `stage.html` / 包元数据）。
- `packages/template-sdk/src/`：`minimal-scene.ts`、`scene-contract.ts`、`gsap-vendor.ts`（v1 场景 HTML/GSAP 供应商）。
- `packages/pipeline/src/timeline.ts`（v1 `buildTimeline`）与 `index.ts` 中的导出。
- `apps/server/src/domain/renderer-switch.ts`（`resolveRendererKind` / `VF_RENDERER` 决策表）。

**改写为 v2-only（旧项目改为明确提示）**
- `pipeline/scene-generate.ts`：删 v1 HTML/降级模板分支，仅保留 `generateScenes`/`generateSceneSpecsV2`；
  `copy.json` 契约版本非 `2` 时抛 `CONFIG_INVALID`，文案含迁移指引。
- `pipeline/storyboard-generate.ts`：删 ffprobe 场景级时间轴分支，仅保留 `buildTimelineV2`；同上守卫。
- `pipeline/compose-video.ts`：删 v1 `composeVideoStep`，仅保留 `composeVideoStepV2`。
- `template-sdk`：`contracts.ts` 仅保留 `ProfileSpec`/`getProfile`；`index.ts` 只导出契约 + 组件注册表。
- `stage-tools.ts`：`render_frames` 固定走 `renderShots`（无 `VF_RENDERER` 分支）；`compose_video` 固定走
  `composeVideoStepV2`；同步工具 description（去掉 v1 措辞）。

**包元数据与脚本**
- `apps/server`：移除 `@videoforge/renderer`、`playwright`、`gsap` 依赖。
- `packages/remotion-engine`：移除悬空的 `@videoforge/template-sdk` 依赖（源码无 import）。
- 根 `package.json`：`typecheck` 去掉 renderer tsconfig；`test:smoke` 指向 v2 的 `remotion-smoke.test.ts`。
- `vitest.config.ts`：删除 `@videoforge/renderer` 与 `playwright` 别名。
- `.prettierignore`：删除 `packages/renderer/src/stage.html`。

**入口与测试**
- `projects.ts`：新建项目显式传 `contractVersion: CONTRACT_VERSION_V2`，落实「新项目一律 2.0」。
- 删除 legacy 用例：`renderer-switch`、`v1-baseline`、`minimal-scene`、`scene-contract`、`render-sequence`、
  `timeline`、`integration/smoke-pipeline`。
- 改写：`render-baseline`（去 legacy 对照段）、`agent-stage-tools`（去 v1 render/VF_RENDERER 用例）、
  `agent-builtin-tools`/`agent-session-registry`（去 renderer mock）、`storyboard-v2`（v1 改为断言 `CONFIG_INVALID`）。

**明确没有做**
- 未删除 copy/image/tts 的 v1 分支（它们不依赖 legacy 渲染通道，旧项目仍可产出前半段产物）。
- 未改能力注册表阶段定义（属 T004）。
- 未改前端 ArtifactTabs「时间轴」Tab 的 v1 `entries` 形状（见「风险」）。
- 未创建 Git commit。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm run typecheck` | pass | 7 个 tsconfig 全绿（renderer 已移出清单） |
| `pnpm test` | pass | 88 files / 814 tests（原 94/848，删掉 7 个 legacy 文件） |
| `pnpm run web:build` | pass | 3306 modules transformed，built in 5.28s |
| `pnpm install --no-frozen-lockfile` | pass | 9 workspace projects；lockfile 去除 renderer |

## 断点 / 未完成
- 未完成项：无（T501 范围内）。
- 最后运行的命令：`pnpm run web:build`。
- 恢复时第一步：无需恢复；进入 T502（文档与 AGENTS 更新）。
- 已知风险：见下。

## 风险与后续
- **旧项目续跑能力**：契约版本 `1.0` 的项目在 scene 阶段即报 `CONFIG_INVALID`（文案含迁移指引）；
  数据库中现存 2 条 `contract_version=1.0` 记录属预期，由 T504 承接「明确提示 + CLI 覆盖」。
- **前端时间轴 Tab**：`apps/web/src/components/ArtifactTabs.vue` 的「时间轴」Tab 仍按 v1 `entries` 形状渲染，
  v2 timeline 为 `shots`，该 Tab 会显示空表；v2 时间轴展示已由 `stores/storyboard.ts` + `WorkbenchTabs` 承担。
  本任务仅去掉对已删文件的注释引用，未改其数据形状（超出 T501 范围），建议后续单独立项收敛或移除该 Tab。
- 性能基线 JSON（`docs/v2_refactoring/baselines/render-baseline.json`）含 legacy 段，需在 T503 重跑 `pnpm test:bench` 覆盖。
