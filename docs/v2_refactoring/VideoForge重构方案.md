# VideoForge v2 重构方案（界面 × 架构联合方案）

> 输入依据：
> - UI 定稿：[SKILL.md](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/SKILL.md) 与 `docs/v2_refactoring/1.png` ~ `10.png`（10 个页面）
> - 架构清单：[VideoForge架构改造工作清单.md](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/VideoForge架构改造工作清单.md)（W1–W20）
> - 差距分析：[VideoForge差距分析.md](file:///d:/07_ai-workspace/01_vedio_generator/docs/VideoForge差距分析.md)
> - 现状基线：以当前仓库代码为准（不是设计文档描述的目标态）
> 本文性质：**重构决策文档 + 实施蓝图**。给出推倒边界、目标契约、目录/接口、批次顺序与验收判据。

---

## 0. 一页结论

### 0.1 三句话

1. **UI 稿与架构清单不是两套方案，而是同一目标态的两面**：UI 稿是"结果长什么样"的验收面，架构清单是"怎么做到"的实现路径。两者在 shot 粒度、cue 时间轴、组件库、主题、风格锚、字幕轨、质检门禁上高度一致。
2. **差距不是参数级，而是范式级**：现状的隐含假设是"一场景=一镜、视觉=LLM 现编 HTML、节奏=音频时长"。目标态要求"一句一镜、视觉=组件选型、节奏=cue 驱动"。这三条假设同时贯穿契约、工具、时间轴、渲染、审核、前端，属于**结构性替换**，不是修补。
3. **推荐"限定范围的推倒重来"**：
   - **推倒重写**：`apps/web` 全部界面（10 页 + 新外壳 + 新设计令牌）；`packages/pipeline` 的 copy / tts 时序 / storyboard；`packages/template-sdk` 全部；`packages/renderer` 由 Remotion 引擎取代。
   - **保留演进**：Fastify HTTP、鉴权、SQLite/Drizzle、工作流引擎/租约/断点续跑、三级 trace、SSE、artifacts/media、项目资产图谱。
   - **不重写**：monorepo 工程、测试框架、CLI、配置加载。

### 0.2 为什么不是"整仓推倒"

整仓重写会把与粒度无关、且已经过测试的资产一起清零，收益极低：

| 子系统 | 现状 | 与"镜头粒度"的关系 | 结论 |
|---|---|---|---|
| 认证/会话/权限 | JWT、actor-first 仓储、throttle、管理员重置密码 | 无关 | 保留 |
| 工作流引擎 | 阶段状态机、租约、断点续跑、取消、审核点 | 只扩展阶段与产物判据 | 保留 |
| 三级 trace | `run_stages` / `tool_calls` / `llm_calls` + `trace.jsonl` | 只需增加 shot/cue 定位 | 保留 |
| SSE 与事件 | 总线 + 票据 + Last-Event-ID/resync | 只增加事件类型 | 保留 |
| 资产图谱 | `project_assets` / `message_asset_refs` / `agent_actions` + 上传校验 | 只需增加画质分类与镜头绑定 | 保留 |
| 前端 | 浅色 AntD 7 个视图、3 项导航 | 信息架构与视觉全面变更 | **推倒** |
| 视觉/时序链路 | scene HTML + 比例拉伸 + 场景级时间轴 | 正是差距所在 | **推倒** |

### 0.3 为什么不"在现有页面上改"

- 导航从 3 项变 5 项，页面从 7 个变 10 个，且新增分镜编辑器、素材库、组件库、项目内 Run 详情；
- 现有主题是浅色 `#f5f7fa + #1677ff`，新规范是唯一深色主题 + `#7B6CFF`；
- 现有阶段是 7 个，Run 详情设计稿是 8 个（新增字幕轨）；
- 现有工作台展示"场景/文件"，新工作台展示"镜头/cue/质检/风格锚"。

改造这些页面的成本高于按新规范重写，且会持续背着旧结构。

---

## 1. 两份输入的逐项比对

### 1.1 一致点（可以直接合并执行）

| 维度 | UI 稿 / SKILL | 架构清单 | 判断 |
|---|---|---|---|
| 最小单位 | 全站按 shot 组织，项目统计用"78 镜头" | W1 契约新增 `scenes[].shots[]` | 完全一致，契约先做 |
| 时间 | 98 cues、逐句字幕、动效 0.3–0.8s | W2 cue、W9 固定动效、W11 ASS | 完全一致 |
| 视觉 | 7 类组件、LLM 只选型填参 | W3 SceneSpec、W4 组件注册表 | 完全一致 |
| 一致性 | 风格锚 + 主题 token + seed 复用 | W5 主题、W8 风格锚 | 一致，UI 额外要求读取 API |
| 质量 | 5 项门禁、失败定位镜头号 | W14 质检门禁 | UI 更具体，可直接作为验收口径 |
| 音频 | BGM 独立轨、响度 | W12 音频链 | 一致 |
| 审核 | 镜头级重生成、失败阶段重跑 | W16 审核与可观测性 | UI 要求"可执行"，不只是"可看" |
| 渲染 | 逐帧预览、镜头级预览 | W10 镜头级渲染、Remotion | 一致 |

### 1.2 冲突与缺口（必须在开工前拍板）

| # | 冲突/缺口 | UI 稿事实 | 架构清单事实 | 建议裁决 |
|---|---|---|---|---|
| C1 | **阶段数量** | Run 详情（`9.png`）是 8 阶段：文案·分镜 / 配图 / 场景模板 / 配音·时间戳 / 字幕轨 / 时间轴 / 渲染 / 合成 | 4.1 明确"继续保留七阶段"；D3 把"是否新增阶段"列为待定 | **改为 8 阶段**，字幕独立成阶段；理由：字幕是独立产物 `subtitle.ass`，独立可重跑、可审计，塞进 storyboard 会让产物判据与断点续跑语义混乱 |
| C2 | SKILL 内部矛盾 | §4 第 5 页写"阶段 7 项含字幕轨"，第 9 页写"左 8 阶段列表" | — | 以 Run 详情 8 阶段为准，回写 SKILL |
| C3 | 质检项数量 | 3.10 列 5 项；5.9 写"四项硬指标" | W14 列 5 类检查 | 以 5 项为准（静帧/字幕溢出/来源标签/对比度/动效时长），对比度阈值 7.2:1 |
| C4 | 素材库作用域 | `/assets` 顶部是"当前项目符号系统" | W6 资产引用属于项目 | **项目作用域**：`/assets?projectId=...`，默认最近项目；组件库是全局只读 |
| C5 | 主题持久化 | Inspector 显示主题 token 色板 | D5 把主题持久化列为待定 | **项目创建时快照**：`projects.theme_id` + `theme.resolved.json`，保证历史可重建 |
| C6 | 预览技术栈 | 分镜编辑器有 16:9 预览画布与镜头预览 | C.4 提"React island 或 iframe" | **iframe 播放器**，独立 React 构建，Vue 侧只发 postMessage，避免 React-in-Vue |
| C7 | 质检是否阻断 | 失败 banner 直接给"从失败阶段重跑" | W14 要求区分警告/阻断 | 来源缺失、字幕溢出为**阻断**；静帧、对比度、动效时长为**警告**（首版） |
| C8 | 管理导航可见性 | 侧栏固定 5 项 | 现有实现仅 admin 可见 | 非 admin 隐藏"管理"，其余 4 项固定；在验收清单注明这是安全约束 |
| C9 | 镜头审核持久化 | 对话流有"已重新生成配图 + 改动 diff + 重生成此镜头" | D4 待定 | **不新增审核表**：复用 `agent_actions.plan_json` + `runs.scope_json` + trace；只有需要跨 run 汇总审核结论时才加表 |
| C10 | 搜索与管理 KPI | 顶栏全局搜索；管理页 4 个 KPI + 用户/项目/Runs 三 Tab + 登录日志 | 清单未覆盖 | 新增 W27/W28；登录日志需要新表，现有 schema 只有 `users.last_login_at` |

### 1.3 结论

**先冻结契约，再并行两条实现线**：

- 契约线（M0–M1）：CopyDoc v2 / TimelineDoc v2 / SceneSpec / QualityReport / Theme / Component registry；
- 界面线（M0 起可并行）：设计令牌、外壳、页面骨架，用**契约 fixture** 驱动，不等后端全部完成；
- 渲染线（M1 起）：Remotion 引擎 + 组件库，与契约线共用类型。

禁止的顺序：先做 10 个页面 → 再补数据。UI 稿里 60% 的字段（shots、cues、quality、theme、boundShots）当前后端没有，先做页面等于大面积假数据。

---

## 2. 现状基线（代码事实）

### 2.1 前端

- 路由只有 7 个：[router.ts](file:///d:/07_ai-workspace/01_vedio_generator/apps/web/src/router.ts#L19-L32)，没有 `/assets`、`/components`、`/projects/:id/storyboard`、`/projects/:id/runs/:runId`。
- 导航只有 3 项（能力中心/项目/管理）：[AppLayout.vue](file:///d:/07_ai-workspace/01_vedio_generator/apps/web/src/layouts/AppLayout.vue#L41-L50)。
- 浅色主题 + AntD 蓝：`--vf-canvas: #f5f7fa`、`colorPrimary: #1677ff`（[global.css](file:///d:/07_ai-workspace/01_vedio_generator/apps/web/src/styles/global.css#L10-L50)、[App.vue](file:///d:/07_ai-workspace/01_vedio_generator/apps/web/src/App.vue#L15-L28)）。
- 工作台是"对话流 + 阶段进度 + 产物面板"，围绕场景与文件组织（[WorkbenchView.vue](file:///d:/07_ai-workspace/01_vedio_generator/apps/web/src/views/WorkbenchView.vue#L1-L80)）。
- Trace 页是独立 `/runs/:id/trace`，按七阶段折叠（[RunTraceView.vue](file:///d:/07_ai-workspace/01_vedio_generator/apps/web/src/views/RunTraceView.vue#L1-L60)）。
- 资产后端已存在（表/仓储/上传/清单 API），工作台内已有资产面板与上传接入；但**没有独立素材库页、没有风格锚、没有绑定镜头计数**。

### 2.2 后端与流水线

| 事实 | 证据 |
|---|---|
| copy 最小单位是 scene，无 shot/来源/组件/资产引用 | [copy-contract.ts](file:///d:/07_ai-workspace/01_vedio_generator/packages/pipeline/src/copy-contract.ts#L6-L25) |
| 时间轴只有 scene 级 `startMs/endMs` | [timeline.ts](file:///d:/07_ai-workspace/01_vedio_generator/packages/pipeline/src/timeline.ts#L1-L29) |
| storyboard 用 ffprobe 实测整段音频时长 | [storyboard-generate.ts](file:///d:/07_ai-workspace/01_vedio_generator/packages/pipeline/src/storyboard-generate.ts#L18-L43) |
| 渲染把时间轴按进度拉伸：`progress × timelineDuration` | [render.ts](file:///d:/07_ai-workspace/01_vedio_generator/packages/renderer/src/render.ts#L77-L101) |
| 场景数据只有 sceneId/title/narration/imagePath/htmlPath | [contracts.ts](file:///d:/07_ai-workspace/01_vedio_generator/packages/template-sdk/src/contracts.ts#L1-L14) |
| 七阶段 + 判据只有"文件存在 / glob 数量" | [capabilities.ts](file:///d:/07_ai-workspace/01_vedio_generator/apps/server/src/workflow/capabilities.ts#L15-L66) |
| 阶段工具范围参数是 scene 级 | [stage-tools.ts](file:///d:/07_ai-workspace/01_vedio_generator/apps/server/src/agent/tools/stage-tools.ts#L1-L120) |
| 数据模型 8 张领域表 + 3 张资产表 | [schema.ts](file:///d:/07_ai-workspace/01_vedio_generator/apps/server/src/db/schema.ts#L1-L250) |
| 无质检实现、无登录日志表/API | 全仓检索 `quality/质检/quality_checks` 无命中；`login` 仅 `users.last_login_at` |

### 2.3 现状到目标的 12 个硬缺口

| # | 缺口 | 影响层 | 破坏性 |
|---|---|---|---|
| G1 | 无 shot 层 | 契约、工具、判据、前端 | 高（契约升版） |
| G2 | 无句级 cue | 时序、字幕、审核定位 | 高 |
| G3 | TTS 无时间戳 | 时序精度 | 中（可降级） |
| G4 | 视觉产物是代码 | scene、渲染、稳定性 | 高（范式替换） |
| G5 | 无组件库/注册表 | 模板、scene、预览 | 高 |
| G6 | 无主题 token | 视觉一致性、字幕 | 中 |
| G7 | 无资产引用/风格锚 | image、契约、素材库 | 中 |
| G8 | 动效被拉伸 | render | 高（寻帧模型替换） |
| G9 | 无独立字幕轨 | compose、质检 | 中 |
| G10 | 无质检门禁 | 能力判据、UI | 中 |
| G11 | 审核只到阶段级 | 工作台、trace | 中 |
| G12 | 前端信息架构与设计规范不符 | 全部页面 | 高（推倒） |

---

## 3. 重构策略：推倒边界

### 3.1 推荐方案：两条线推倒，一条线保留

```
┌───────────────────────────── 推倒重写 ─────────────────────────────┐
│ apps/web（全部 UI）                                                 │
│ packages/template-sdk（契约 + 组件库 + 主题解析）                    │
│ packages/renderer（由 packages/remotion-engine 取代）               │
│ pipeline 中的 copy / tts 时序 / storyboard / scene 生成              │
└───────────────────────────────────────────────────────────────────┘
┌───────────────────────────── 保留演进 ─────────────────────────────┐
│ Fastify / 鉴权 / SQLite+Drizzle / 工作流引擎 / 租约 / 断点续跑       │
│ 三级 trace / SSE / artifacts / media / 资产图谱 / CLI / 配置加载     │
└───────────────────────────────────────────────────────────────────┘
┌───────────────────────────── 明确不动 ─────────────────────────────┐
│ monorepo 结构、Vitest、pnpm、TypeScript 严格模式、127.0.0.1 边界     │
└───────────────────────────────────────────────────────────────────┘
```

### 3.2 推倒清单

| 对象 | 处理 | 原因 |
|---|---|---|
| `apps/web/src/views/*` 7 个视图 | 删除重写 | 信息架构、视觉、数据模型全变 |
| `AppLayout.vue`、`global.css`、`App.vue` 主题 | 删除重写 | 浅色 3 项导航 → 深色 5 项导航 |
| `StageSteps.vue`、`ArtifactTabs.vue`、`StateTag.vue` | 用新基元替换 | 阶段 7→8；状态 pill 4 态；产物卡结构不同 |
| `packages/template-sdk/*` | 重写 | `SceneData` 无法承载 shot/组件/主题 |
| `packages/renderer/*` | 冻结后删除 | 比例拉伸模型与固定动效不兼容 |
| `packages/pipeline/src/scene-generate.ts` | 重写 | 从"生成 HTML"改为"选型 + 填参" |
| `packages/pipeline/src/copy-contract.ts` | 升版重写 | 增加 shots/styleAnchors/source/component |
| `packages/pipeline/src/timeline.ts` + `storyboard-generate.ts` | 重写 | scene 级 → shot/cue 级 |
| `config/prompts/default/scene-system.txt` | 重写 | 从"写 HTML"改为"选组件填参数" |
| 旧 `/runs/:id/trace` 页面 | 路由重定向 | 新路由 `/projects/:id/runs/:runId` |

### 3.3 保留清单（为什么不能一起推倒）

- **工作流引擎与断点续跑**：`engine.ts` / `lease.ts` / `breakpoint.ts` 的语义与粒度无关，只改阶段声明与产物判据即可复用。
- **trace**：新增 shot/cue 字段即可，重写会丢失历史留痕能力。
- **SSE 与事件总线**：新增事件类型即可。
- **资产图谱**：表、仓储、上传校验、`agent_actions` 已落地，只需扩分类与绑定计数。
- **鉴权**：与产品形态无关。

### 3.4 旧资产的兼容边界

- 旧 `copy.json`（v1）与旧 `scenes/*.html`：**只读兼容**，允许旧项目继续 storyboard→compose 续跑；
- 旧项目**不允许**在 v2 界面中做镜头级编辑；
- 旧 Playwright 渲染通道保留一个版本周期，用环境变量 `VF_RENDERER=legacy` 显式开启，M5 删除；
- 新项目一律 v2，不再产生 HTML 场景。

---

## 4. 目标架构

### 4.1 全景

```
┌──────────────────────────── apps/web（Vue 3，重写）───────────────────────────┐
│ 深色设计系统 · 5 项导航 · 10 页 · 镜头级工作台 · 分镜编辑器 · 素材/组件库        │
└───────────────▲───────────────────────────────────────────────▲──────────────┘
                │ REST + SSE                                    │ iframe + postMessage
┌───────────────┴───────────────────────────────────────────────┴──────────────┐
│ apps/server（Fastify，保留）                                                  │
│ 路由扩展：storyboard / shots / components / themes / quality / player          │
│ 工作流引擎：8 阶段 + shot scope + 质检钩子 + 断点判据 v2                        │
└───────────────▲───────────────────────────────────────────────▲──────────────┘
                │ 契约对象                                       │ 渲染指令
┌───────────────┴──────────────────────────────┐  ┌─────────────┴──────────────┐
│ packages/pipeline（演进）                     │  │ packages/remotion-engine    │
│ copy v2 / image / tts+cues / captions /       │  │ 组件库 · 主题 · Composition  │
│ storyboard v2 / compose                       │  │ renderShots / renderStill    │
└───────────────▲──────────────────────────────┘  └─────────────▲──────────────┘
                │                                               │
┌───────────────┴───────────────────────────────────────────────┴──────────────┐
│ packages/shared（契约类型 / 状态 / 错误码） + config/themes + config/prompts    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 分层职责

| 层 | 位置 | 职责 | 不负责 |
|---|---|---|---|
| 契约层 | `packages/shared` + `packages/pipeline/contracts` | CopyDoc v2 / TimelineDoc v2 / SceneSpec / QualityReport | 渲染细节、组件实现 |
| 编排层 | `apps/server/workflow` | 8 阶段、shot scope、租约、断点、质检钩子 | 像素、字幕排版 |
| 内容层 | `packages/pipeline/copy` | shot 拆分、口播、屏上文字、来源、风格锚 | 视觉样式 |
| 音频层 | `packages/pipeline/tts` | 逐镜配音、cue 时间戳、时间戳来源标记 | 字幕样式 |
| 字幕层 | `packages/pipeline/captions` | ASS 生成、样式 token、溢出预检 | 烧录 |
| 模板层 | `packages/remotion-engine` | 组件注册表、参数校验、主题解析、Composition | LLM、内容决策 |
| 渲染层 | `packages/remotion-engine/render` | 镜头级渲染、固定动效、帧区间 | 语义解析 |
| 合成层 | `packages/pipeline/compose` | 画面+旁白+BGM+ASS 烧录+loudnorm | 内容生成 |
| 质量层 | `packages/pipeline/quality` | 5 项可判定检查、定位到 shot | 主观审美 |
| 展示层 | `apps/web` | 只渲染服务端字段 | 推导状态机 |

### 4.3 目录变更

```
apps/
  web/                         # 重写
    src/
      styles/tokens.css        # 唯一令牌源
      styles/theme.ts          # AntD 深色映射
      layouts/AppShell.vue
      components/ui/           # 基元：Button/Pill/Card/Input/Modal/JsonBlock...
      components/storyboard/    # ShotTimeline/ShotInspector/PreviewCanvas
      components/quality/       # QualityGateList
      views/                   # 10 页
      stores/
  player/                      # 新增：React + Remotion Player（iframe 宿主）
packages/
  shared/src/contracts/        # 新增：v2 契约与 zod schema
  pipeline/src/copy/           # 拆分
  pipeline/src/captions/       # 新增
  pipeline/src/quality/        # 新增
  remotion-engine/             # 新增
  renderer/                    # 冻结，M5 删除
config/
  themes/<id>/theme.yaml       # 新增
  components/registry.json?    # 由代码注册表导出，不手改
```

### 4.4 八阶段定义

| # | 阶段 | 展示名 | 输入 | 产物 | 审核点 |
|---|---|---|---|---|---|
| 1 | `copy` | 文案 · 分镜 | topic/style/profile | `copy.json`（v2，scenes+shots+styleAnchors） | ✅ |
| 2 | `image` | 配图 | shots、风格锚 | `images/*.png`（按 shot/资产） | ✅ |
| 3 | `scene` | 场景模板 | shots、组件注册表 | `scenes/spec.json`（SceneSpec） | 本轮不做 |
| 4 | `tts` | 配音 · 时间戳 | shots | `audio/*.mp3` + `audio/cues.json` | — |
| 5 | `captions` | 字幕轨 | cues、主题 | `captions/subtitle.ass` | — |
| 6 | `storyboard` | 时间轴 | shot 切点、cue、动效 | `timeline.json`（v2） | — |
| 7 | `render` | 渲染 | SceneSpec、timeline、assets | `build/render/<profile>/frames/*.jpg` | — |
| 8 | `compose` | 合成 | 帧、旁白、BGM、ASS | `final.mp4` | — |

阶段顺序以 `9.png` 为准。字幕在时间轴之前，因为字幕只依赖 cue；时间轴需要合并 cue 与镜头切点。

> **审核点登记（2026-11-08）**：`scene` 阶段的人工审核点**本轮不做**。实际审核点固定为 `copy`、`image` 之后（`REVIEW_GATE_STAGES = ["copy","image"]`），与 `AGENTS.md` 一致；M4 批次不含 `scene` 审核点相关任务。

**质检不占阶段位**：由引擎在阶段完成钩子里执行，结论作为 `quality/report.json` 产物 + `tool_calls` 留痕。

### 4.5 渲染运行时

- 视觉与时间轴运行时：**Remotion**（`Sequence + 绝对 from`，`useCurrentFrame + interpolate/spring`）；
- 字幕：生成 ASS，由 **ffmpeg 烧录**（保留 `subtitle.ass` 产物，便于审计与关闭字幕）；
- 音频：旁白/BGM 多轨由 Remotion `<Audio>` 混音，`loudnorm` 与复杂封装由 ffmpeg 兜底；
- 旧 Playwright 通道只服务 v1 项目。

必须遵守 PoC 约束：

1. 只渲染 production bundle，开发模式会出白帧；
2. 提供 `REMOTION_BROWSER_EXECUTABLE` 配置，复用本机 Chrome，下载失败时给可操作错误；
3. 引擎包加"组件 undefined"守卫，避免只剩 React #130；
4. 锁 React 19.3.x + Remotion 4.0.5xx；
5. 预览用 Player iframe，不用 Studio 作为产品界面。

---

## 5. 数据契约 v2（最先落地）

### 5.1 CopyDoc v2

```json
{
  "contractVersion": "2.0",
  "topic": "水银如何变成黄金",
  "style": "硬核科普、冷峻、数据驱动",
  "title": "把水银原子核里的质子敲掉一个",
  "theme": { "id": "documentary-dark" },
  "styleAnchors": [
    { "key": "proton", "label": "质子", "color": "#B33630", "assetId": "ast-anchor-proton" },
    { "key": "neutron", "label": "中子", "color": "#6E7480", "assetId": "ast-anchor-neutron" },
    { "key": "mercury", "label": "水银", "color": "#C9CED6", "assetId": "ast-anchor-mercury" },
    { "key": "gold", "label": "黄金", "color": "#E2B53E", "assetId": "ast-anchor-gold" }
  ],
  "scenes": [
    {
      "sceneId": "s1",
      "chapterNo": 1,
      "title": "开场钩子",
      "shots": [
        {
          "shotId": "sh-001",
          "narration": "把水银原子核里的质子敲掉一个，它就变成了黄金。",
          "onScreenText": "水银 → 黄金",
          "emphasis": ["水银", "黄金"],
          "visualType": "component",
          "component": {
            "id": "keyword-block",
            "params": {
              "title": "水银 → 黄金",
              "subtitle": "原子核里只少一个质子",
              "underline": "sweep"
            }
          },
          "assetRefs": [{ "assetId": "ast-anchor-mercury", "role": "symbol" }],
          "transitionIn": "hard-cut",
          "transitionOut": "hard-cut",
          "sourceRef": { "label": "CERN 公开资料", "url": "https://home.cern/" }
        },
        {
          "shotId": "sh-002",
          "narration": "这不是炼金术，是核物理。",
          "onScreenText": "不是炼金术，是核物理",
          "emphasis": ["核物理"],
          "visualType": "image",
          "assetRefs": [
            { "assetId": "ast-lab-hq", "role": "background" },
            { "assetId": "ast-anchor-mercury", "role": "symbol" }
          ],
          "transitionIn": "fade-120",
          "transitionOut": "hard-cut",
          "sourceRef": null
        }
      ]
    }
  ]
}
```

字段约束：

| 字段 | 规则 |
|---|---|
| `shotId` | 全片唯一，`sh-###`；稳定，不因编辑改变 |
| `narration` | 必填；一句或短句；建议 2–4 秒 |
| `onScreenText` | ≤ 18 字，超出触发字幕/版式质检 |
| `visualType` | `component` / `image` / `video` / `symbol` |
| `component` | `visualType=component` 时必填；`id` 必须在注册表内 |
| `assetRefs` | 引用 `project_assets`，缺失时定位到 shot |
| `transitionIn/Out` | 枚举：`hard-cut` / `title-card` / `fade-120` |
| `sourceRef` | `visualType=component` 且含数据参数时必填 |
| 时长 | **不在 CopyDoc 中写死**，由 cue 推导；可写 `targetDurationMs` 作为建议值 |

### 5.2 TimelineDoc v2

```json
{
  "contractVersion": "2.0",
  "fps": 30,
  "tailPauseMs": 500,
  "timingSource": "tts-native",
  "totalMs": 291000,
  "shots": [
    { "shotId": "sh-001", "sceneId": "s1", "startMs": 0, "endMs": 3120, "durationMs": 3120 },
    { "shotId": "sh-002", "sceneId": "s1", "startMs": 3120, "endMs": 6280, "durationMs": 3160 }
  ],
  "cues": [
    {
      "cueId": "cue-0001",
      "shotId": "sh-001",
      "kind": "narration",
      "startMs": 120,
      "endMs": 2960,
      "text": "把水银原子核里的质子敲掉一个，它就变成了黄金。"
    },
    {
      "cueId": "cue-0002",
      "shotId": "sh-001",
      "kind": "animation",
      "atMs": 480,
      "durationMs": 480,
      "effect": "underline-sweep"
    }
  ]
}
```

`timingSource` 枚举：`tts-native` / `asr-aligned` / `estimated`。降级必须可见，并由质检标记为 warning。

### 5.3 SceneSpec（scene 阶段产物）

```json
{
  "contractVersion": "2.0",
  "themeId": "documentary-dark",
  "shots": [
    {
      "shotId": "sh-001",
      "componentId": "keyword-block",
      "props": {
        "title": "水银 → 黄金",
        "subtitle": "原子核里只少一个质子",
        "underline": "sweep"
      },
      "assetRefs": [{ "assetId": "ast-anchor-mercury", "role": "symbol" }],
      "transition": { "in": "hard-cut", "out": "hard-cut" },
      "animations": [
        { "effect": "title-in", "atMs": 0, "durationMs": 520 },
        { "effect": "underline-sweep", "atMs": 480, "durationMs": 480 }
      ],
      "source": { "label": "CERN 公开资料" }
    }
  ]
}
```

HTML 不再是产物，而是模板层装配结果；装配失败必须走显式兜底（降级为 `image + title` 组件）并记录告警。

### 5.4 QualityReport

```json
{
  "version": "1",
  "runId": "run-...",
  "generatedAt": "2026-11-03T10:00:00.000Z",
  "checks": [
    {
      "id": "freeze",
      "status": "pass",
      "label": "静帧检测",
      "violations": []
    },
    {
      "id": "subtitle-overflow",
      "status": "fail",
      "label": "字幕溢出",
      "violations": [
        { "shotId": "sh-034", "detail": "超 18 字：24 字" },
        { "shotId": "sh-057", "detail": "超 18 字：21 字" }
      ]
    },
    {
      "id": "source-label",
      "status": "fail",
      "label": "来源标签",
      "violations": [{ "shotId": "sh-041", "detail": "数据类镜头缺少来源" }]
    },
    { "id": "contrast", "status": "pass", "label": "画面对比度", "violations": [] },
    { "id": "animation-duration", "status": "pass", "label": "动效时长", "violations": [] }
  ]
}
```

### 5.5 Theme

```yaml
# config/themes/documentary-dark/theme.yaml
id: documentary-dark
name: 硬核科普深色
frame:
  width: 1920
  height: 1080
  safe_area: 0.9
tokens:
  text: "#E5E0D5"
  background: "#111310"
  accent: "#F1E21D"
  secondary: ["#B33630", "#3BD5B0", "#4904F5"]
  font_family: "PingFang SC, Microsoft YaHei, system-ui"
  title_size: 96
  body_size: 40
  caption:
    size: 44
    stroke: 4
    bottom_ratio: 0.06
    max_chars_per_line: 18
motion:
  min_duration_ms: 300
  max_duration_ms: 800
```

主题与 Profile 解耦：Profile 管分辨率/安全区比例，主题管视觉语言。项目创建时把主题解析结果写入 `theme.resolved.json`。

### 5.6 组件注册表

```json
{
  "id": "keyword-block",
  "name": "关键词块",
  "category": "text",
  "coverageNote": "参考片占比 28%",
  "paramsSchema": {
    "title": { "type": "string", "required": true, "maxLength": 18 },
    "subtitle": { "type": "string", "required": false, "maxLength": 28 },
    "underline": { "enum": ["none", "sweep", "grow"] }
  },
  "animations": ["title-in", "underline-sweep"],
  "previewFixture": "fixtures/keyword-block.json"
}
```

7 类组件：关键词块 / 数据卡 / 引语卡 / 对比条 / 进度环 / 章节角标 / 来源标签。LLM 只能选 ID + 填参数，不得输出 HTML。

### 5.7 资产引用与风格锚

- `assetRefs[]` 只存 `assetId + role`，不存裸路径；
- 风格锚是 `styleAnchors[]`，一个符号一份资产 + 一个 seed；
- 镜头重生成时沿用 `assetId` 与 seed，只替换该镜头新增资产；
- `project_assets.metadata_json` 记录 `styleAnchorKey`、`generationSeed`、`boundShotIds`（缓存）；
- 素材库"已绑定 N 镜头"由 copy v2 实时计算，不手工维护。

### 5.8 契约版本与不变量

- `contractVersion` 写入 `copy.json`、`timeline.json`、`scenes/spec.json`、`manifest.json` 与 trace；
- 读取器必须同时支持 v1/v2，v1 只读；
- 不变量（质检/判据共用）：
  1. shot 全片唯一，scene 至少 1 个 shot；
  2. `onScreenText` 超 18 字 → 阻断；
  3. 每个 shot 的 narration 被 cue 完整覆盖（字符覆盖率 100%）；
  4. shot 切点单调、连续，尾停顿来自配置；
  5. 动效时长 ∈ [300, 800]ms；
  6. 数据类组件必须有 `sourceRef`；
  7. 组件 ID 与参数必须通过注册表校验；
  8. 资产引用必须可解析到当前项目资产。

---

## 6. 数据库与存储

### 6.1 表变更

| 表 | 变更 | 目的 |
|---|---|---|
| `projects` | `+ theme_id TEXT`、`+ contract_version TEXT NOT NULL DEFAULT '1.0'` | 主题快照、契约识别 |
| `runs` | `+ scope_json TEXT`、`+ contract_version TEXT NOT NULL DEFAULT '1.0'` | 镜头级重生成范围、旧项目续跑 |
| `run_stages` | 无结构变更，新增阶段值 `captions` | 8 阶段 |
| `project_assets` | `+ visual_category TEXT`（可空） | 素材库 6 类筛选 |
| `login_events` | **新增**：id / user_id / username / ok / reason / ip / user_agent / created_at | 管理页登录日志 |
| `quality_reports` | M4 视需要新增；首版用 `quality/report.json` + trace | 避免过早扩表 |
| `shot_reviews` | 暂不新增；复用 `agent_actions` + `runs.scope_json` | 控制领域膨胀 |

原则：审核、质量、资产一律**追加式**，不覆盖历史结论。

### 6.2 工作区布局

```
projects/<user>/<project>/
  copy.json                    # v2
  theme.resolved.json          # 创建时快照
  images/
  audio/*.mp3
  audio/cues.json
  scenes/spec.json             # v2（不再有 scenes/*.html）
  captions/subtitle.ass
  timeline.json
  quality/report.json
  build/render/<profile>/frames/*.jpg
  final.mp4
  scenes/legacy/*.html         # 仅旧项目
```

### 6.3 迁移

1. 先加列、默认值、幂等迁移；
2. 旧项目 `contract_version='1.0'`，允许续跑，禁止镜头编辑；
3. 新项目一律 `2.0`；
4. 旧路由 `/runs/:id/trace` 301 到 `/projects/:id/runs/:runId`；
5. 旧 `htmlPath` 只读，M5 删除渲染通道时给出明确提示。

---

## 7. 服务端与 API

### 7.1 新增/扩展路由

| 方法 | 路径 | 用途 | 消费页面 |
|---|---|---|---|
| GET | `/api/projects` | 扩展：`shotCount`、`totalMs`、`progress`、`etaSeconds`、`latestRun` | 项目列表、能力中心 |
| GET | `/api/projects/:id/overview` | 项目头、主题、统计、最终产物（**偏差：本轮未按此路径实现**，见下方说明） | 工作台 |
| GET | `/api/projects/:id/storyboard` | scenes/shots/cues/theme/components/assets/quality 聚合 | 分镜编辑器、工作台 |
| PATCH | `/api/projects/:id/shots/:shotId` | 改组件/参数/转场/屏上文字（可逆编辑） | 分镜 Inspector |
| POST | `/api/projects/:id/shots/:shotId/regenerate` | 按阶段重生成单镜 | 工作台、Inspector |
| GET | `/api/components` | 组件注册表（含参数 schema、覆盖率说明） | 组件库 |
| GET | `/api/components/:id/preview` | 组件预览 fixture / 静态帧 | 组件库 |
| GET | `/api/themes`、`/api/themes/:id` | 主题 token | 新建项目、Inspector |
| GET | `/api/projects/:id/quality` | 最新质检报告 | 工作台、Run 详情 |
| GET | `/api/runs/:id` | run 详情（请求参数/响应/质检） | Run 详情 |
| GET | `/api/runs/:id/trace` | 保留 | Run 详情、管理 |
| GET | `/api/admin/overview` | 4 个 KPI | 管理 |
| GET | `/api/admin/login-events` | 登录日志 | 管理 |
| GET | `/api/search?q=` | 项目/素材/组件搜索 | 顶栏 |
| GET | `/api/player/:projectId/:shotId?` | iframe 播放器入口（HTML） | 分镜预览 |

> **偏差登记（2026-11-08）**：`GET /api/projects/:id/overview` 未实现。T116 已把方案所要求的项目头、主题、统计（`shotCount`/`totalMs`/`progress`/`etaSeconds`/`latestRun`）与最终产物平铺进既有的 `GET /api/projects/:id`，工作台消费该接口即可拿到等价数据；因此不新增 `overview` 别名路由，功能已由 `GET /api/projects/:id` 覆盖。

### 7.2 SSE 事件增量

| 事件 | 触发 | 前端动作 |
|---|---|---|
| `shot.updated` | 镜头参数/产物变更 | 局部刷新镜头条与 Inspector |
| `quality.updated` | 质检完成 | 刷新门禁卡 |
| `asset.bound` | 资产绑定变化 | 刷新素材库计数 |
| `preview.ready` | 预览帧/片段可用 | 播放器 postMessage 刷新 |

现有 run/stage/tool/message/review 事件保持不变；新增事件必须遵守 `Last-Event-ID + resync`。

### 7.3 镜头级重生成时序

```
UI  → POST /shots/:shotId/regenerate { stages:["image"], instruction:"改为真实摄影" }
server → 校验 shot 存在于 copy v2、项目无租约冲突
       → 建 agent_action(executing, plan_json={shotId,stages,instruction})
       → 建 run(scope_json={shotIds:[...], fromStage:"image"})
       → 引擎只跑受影响阶段；其余 shot 复用旧产物
       → captions/storyboard 全量重算（确定性、无 LLM）
       → render 只渲染该 shot 帧区间；compose 复用其余帧
       → quality 全量重跑；SSE shot.updated / quality.updated
UI  → 对话流插入"本次改动 diff"卡片，提示 seed 锚定、不影响其余镜头
```

关键约束：单镜重生成**不触发整片重跑**；重渲结果与整片对应区间逐帧一致。

### 7.4 质检执行点

| 检查 | 执行阶段 | 数据来源 | 级别 |
|---|---|---|---|
| 静帧检测 | render 后 | 帧序列（每 0.25s 采样 + 感知哈希） | 警告 |
| 字幕溢出 | captions 后 | cue 文本 + 主题 `max_chars_per_line` | 阻断 |
| 来源标签 | scene 后 | SceneSpec `source` | 阻断 |
| 画面对比度 | scene 后 | 主题前景色 + 资产平均亮度；阈值 7.2:1 | 警告 |
| 动效时长 | storyboard 后 | SceneSpec `animations[].durationMs` | 警告 |

### 7.5 服务端派生指标

前端不推导状态机，以下字段必须由服务端返回：

- `shotCount`：copy v2 的 shot 总数；
- `totalMs` / `averageShotMs`：timeline v2；
- `progress`：已完成阶段权重 + 当前阶段内进度（仅服务端计算）；
- `etaSeconds`：按阶段历史中位数估算，字段名与 UI 文案统一为"预计剩余"，允许 `null`；
- `boundShotCount`：按 copy v2 计算。

---

## 8. 前端重写方案

### 8.1 技术栈与依赖策略

- 保留 Vue 3 + Vite + Pinia + Vue Router + Ant Design Vue；
- 不引入新的 UI 库；Ant Design Vue 只作为行为层（表单、表格、弹窗、可访问性）；
- 视觉一律由 `tokens.css` + 自研基元组件承担；
- Remotion 播放器独立 React 应用，通过 iframe 嵌入，避免双栈互相污染。

### 8.2 令牌与 AntD 映射

`tokens.css` 直接落地 SKILL §1.1 的全部变量，并提供 AntD 映射：

```
colorPrimary            → --accent   #7B6CFF
colorBgBase             → --bg       #0B0E13
colorBgContainer        → --surface  #141821
colorBgElevated         → --surface-2
colorBorder / BorderSecondary → --border / --border-soft
colorText / Secondary / Tertiary → --text / --text-sec / --text-ter
algorithm               → darkAlgorithm
borderRadius            → 8
fontFamily              → 系统无衬线栈
```

约束：

- 禁止浅色主题、渐变、emoji、玻璃拟态；
- 禁止 rgba 叠色做遮罩/阴影，遮罩用 `--deep` + `opacity: .8`；
- 成片主题色（`#E5E0D5` / `#111310` / `#F1E21D`）只允许出现在预览画布、主题展示，不得用于界面控件；
- 技术文本（Run ID、时间码、文件名、JSON、镜头号、cue 计数）统一 JetBrains Mono。

### 8.3 App Shell

| 区域 | 规格 |
|---|---|
| 侧栏 | 196px，`--deep`；Logo 30×30 + VideoForge 16/600；5 项导航；底部用户卡 |
| 导航 | 能力中心 / 项目 / 素材库 / 组件库 / 管理；38px 行高，选中 `--surface-2` + 3×20 主色条 |
| 顶栏 | 56px；面包屑 12.5px；右侧搜索 240×34、通知、头像 32px |
| 内容 | padding 28px；不限最大宽；分镜编辑器可全宽 |

响应式：

- ≥1280px：完整布局；
- 960–1279px：侧栏收为 64px 图标栏，保留 tooltip；
- <768px：抽屉导航，顶栏显示菜单按钮；
- 分镜编辑器 <1280px：Inspector 移到画布下方；<768px：Inspector 改底部抽屉，时间轴横向滚动。

### 8.4 路由表

| # | 页面 | 路由 | 说明 |
|---|---|---|---|
| 1 | 登录 | `/login` | 独立 blank layout |
| 2 | 能力中心 | `/` | 默认首页；不再重定向到 `/projects` |
| 3 | 新建项目 | 模态 | 能力中心与项目列表共用 |
| 4 | 项目列表 | `/projects` | 卡片网格 + 筛选 |
| 5 | 项目详情 | `/projects/:id` | 对话流 + 4 Tab |
| 6 | 分镜时间轴 | `/projects/:id/storyboard` | 三轨编辑器 |
| 7 | 素材库 | `/assets?projectId=` | 项目作用域 |
| 8 | 组件库 | `/components` | 全局只读 |
| 9 | Run 详情 | `/projects/:id/runs/:runId` | 新路由 |
| 10 | 管理 | `/admin` | admin only |
| — | 设置 | `/settings` | 保留，入口在用户卡/头像菜单 |
| — | 旧 Trace | `/runs/:id/trace` | 301 到 Run 详情 |

### 8.5 逐页结构

**1 登录页**
左品牌区：Logo、slogan「把内容创作交给 Agent 流水线」、3 特性、七阶段 chips；右表单：用户名、密码、记住我、忘记密码、登录、"联系管理员创建"。
无公开注册（与现有 auth 一致）。错误用行内提示，不用弹窗。

**2 能力中心**
短视频能力卡：七阶段 chips（文案/配图/场景/配音/时间轴/渲染/合成，展示名与 8 阶段后端做映射或直接展示 8 个）、平均 3.7 秒/画面变化、已创建项目数、创建按钮、工作流说明入口；
即将上线区 3 张卡（抖音/小说/产品宣传）只做禁用态；
最近运行表：项目/Run/镜头数/状态/耗时/时间。

**3 新建项目模态**
两步：选择能力 → 填写参数；
字段：名称*、主题*、风格、输出 Profile（`GET /api/profiles`）、风格锚参考图（可选，上传后成为项目资产）。
创建后跳项目详情并自动触发首个 run（保持现有行为）。

**4 项目列表**
卡片：名称、主题摘要、创建时间、镜头数 · 总时长、状态 pill、最终产物/进度条/重试入口；
筛选：全部/进行中/已完成/失败；排序：按最近更新。
状态、进度、ETA 全部来自服务端字段。

**5 项目详情（工作台）**
左：对话流（消息、工具调用、思考、可逆改动 diff 卡、镜头重生成结果卡、引用资产）；
右 4 Tab：阶段进度（8 项 + 结果 meta）/ 分镜时间轴（缩略）/ 项目资产 / 流水线产物；
顶部：返回、项目名、能力、状态、查看 Trace、发起 Run；
最终产物卡：final.mp4、分辨率、时长、大小、播放、下载；
输入框：Enter 发送、Shift+Enter 换行、`@` 引用资产。

**6 分镜时间轴编辑器**
左场景栏（章节点 + shot 数 + 时长 + 缩略）；
中：16:9 预览画布（章节角标、屏上文字、强调下划线、来源标签）+ 播放头 + 镜头条；
下：三轨（画面/字幕/BGM），60s 窗口可缩放；
右 Inspector 292px：口播、cue 时间戳、屏幕文字、组件模板选择、素材绑定、风格锚 badge、转场三选一、主题 token 色板、重生成此镜头、预览动效。
所有编辑走 `PATCH /shots/:shotId`，返回 agent_action 与更新后的 storyboard。

**7 素材库**
顶部风格锚 banner（质子红/中子灰/水银银/黄金金）+ 管理锚点；
6 类筛选：全部 / AI 生成 / 实拍上传 / 档案照片 / 3D 渲染 / 视频片段；
卡片：缩略图、文件名、类型、已绑定 N 镜头；上传按钮。
项目选择器固定在页头；无项目时给空态 + 创建项目入口。

**8 组件库**
7 类组件预览卡：关键词块/数据卡/引语卡/对比条/进度环/章节角标/来源标签；
每卡展示预览、参考片占比、参数名；
底部说明"主题 token 驱动，切换主题不需改组件"；
"新增组件"卡只给开发指引，不做在线编辑器。

**9 Run 详情**
失败 banner（错误码 + 产物缺失说明 + 从失败阶段重跑 + 查看全部留痕）；
左 8 阶段列表（含 attempt、耗时、errorCode）；
右：工具调用 / LLM 调用 / 事件三 Tab；工具表含产物数列（`98 cues`）、错误日志块；
底部三卡：请求参数、响应/错误、质检门禁（5 项，失败定位 shot 号）。

**10 管理**
4 KPI（注册用户/项目总数/本周运行/运行成功率）；
Tab：用户 / 项目 / Runs；
用户表 + 重置密码；登录日志表（时间/用户/结果/IP/UA）。
需要新增 `GET /api/admin/overview` 与 `GET /api/admin/login-events`。

### 8.6 组件清单

基元（`components/ui/`，**已实现 6 个**）：

`VfButton`（accent/ghost/danger/success）、`VfPill`、`VfCard`、`VfInput`、`VfModal`、`VfJsonBlock`。

> **清单修订（2026-11-08）**：初版列举 12 个基元（另含 `VfSelect`/`VfTable`/`VfEmpty`/`VfErrorBanner`/`VfStepList`/`VfBreadcrumb`），实际只落地 6 个（T301）。未落地 6 个的承担方式：`VfSelect`/`VfTable`/`VfEmpty` 直接使用 Ant Design Vue 组件；`VfErrorBanner`/`VfStepList`/`VfBreadcrumb` 由页面内联结构承担（如 Run 详情的失败 banner、阶段步骤列表、AppShell 面包屑）。本轮不补齐这 6 个基元。

复合（按页复用）：

`AppShell`、`ShotTimeline`、`ShotInspector`、`PreviewCanvas`、`QualityGateList`、`AssetCard`、`StyleAnchorBar`、`ComponentPreviewCard`、`ChatTimeline`、`MentionInput`、`RunStageList`、`ToolCallTable`、`DiffTable`、`ProjectCard`、`CapabilityCard`、`NewProjectModal`。

### 8.7 状态与数据流

- 保留 `auth`、`capabilities` store 的结构；
- 重写 `projects`、`workbench`、`trace`；
- 新增 `storyboard`、`assets`（扩展）、`components`、`themes`、`quality`、`ui`；
- 服务端字段是唯一真相：前端不做状态推导、不做本地进度计算；
- SSE 统一走单一连接，事件 reducer 更新 store；断线用 `Last-Event-ID` + `resync`；
- 编辑类操作不乐观更新，等待服务端返回新快照。

### 8.8 可访问性与响应式

- 所有导航、时间轴、播放头可键盘操作（左右键 seek，Tab 聚焦镜头块）；
- 播放/暂停提供可访问名称；`prefers-reduced-motion` 下预览默认暂停；
- 状态 pill 不只靠颜色，附图标或文本；
- 模态焦点陷阱与 ESC 关闭；
- 桌面 1440×900 与窄屏 390×844 必须逐页验收。

### 8.9 预览器嵌入

- 新增 `apps/player`：React + Remotion Player，构建为静态资源，由 Fastify 在 `/player/*` 提供；
- Vue 侧 iframe 参数：`projectId`、`shotId`、`time`；
- postMessage 协议：`player:ready`、`player:seek`、`player:play`、`player:pause`、`player:shot`；
- 生产环境只加载 production bundle；
- 播放器失败时展示错误码与"打开 Remotion 诊断"入口，不白屏。

---

## 9. 工作项增补与映射

### 9.1 对原 W1–W20 的修订

| 原工作项 | 修订 |
|---|---|
| W3/W4/W9/W10 | 实现路径改为 Remotion（保持结论） |
| W5 主题 | 增加"创建时快照"与 `GET /api/themes` |
| W6 资产 | 增加 `visual_category` 与绑定镜头计数 |
| W11 字幕 | 增加独立阶段 `captions` 与 ASS 产物 |
| W14 质检 | 明确 5 项、阻断/警告边界 |
| W16 审核 | 首版不新增表，复用 agent_actions + runs.scope |
| W18 时间轴编辑器 | 从 P2 提前到 M3（UI 稿已定为正式页） |
| 4.1 "保留七阶段" | 改为 8 阶段（见 C1） |
| C.6 R5 | 预览由 Studio iframe 改为 Player iframe |

### 9.2 新增工作项

| # | 工作项 | 依赖 | 交付 |
|---|---|---|---|
| W21 | 8 阶段与能力声明升版（`captions`） | W11 | `PIPELINE_STAGES`、判据、UI 阶段列表 |
| W22 | Storyboard 读取与镜头级编辑 API | W1/W2 | `GET /storyboard`、`PATCH /shots/:id` |
| W23 | 组件库/主题读取 API | W4/W5 | `/api/components`、`/api/themes` |
| W24 | 资产分类、绑定计数、风格锚运营 | W6/W8 | 素材库页数据 |
| W25 | 服务端派生进度/ETA/统计 | W2/W15 | 项目卡片、能力中心 |
| W26 | 镜头预览播放器（React iframe） | W9/W10 | 分镜画布、镜头预览 |
| W27 | 全局搜索 | 全部查询 API | 顶栏搜索 |
| W28 | 管理 KPI + 登录日志 | 新表 | 管理页 |
| W29 | 设计系统与 App Shell 重写 | 无 | tokens、基元、外壳 |
| W30 | 10 页重写 | W21–W29 | 全部页面 |
| W31 | 旧页面/旧渲染通道退场与文档 | W30 | 删除 legacy、更新指南 |

### 9.3 页面 ↔ 工作项 ↔ API

| 页面 | 主要工作项 | 关键 API | 当前可用性 |
|---|---|---|---|
| 登录 | W29 | `/api/auth/*` | 已有 |
| 能力中心 | W25/W30 | `/api/capabilities`、`/api/projects`、`/api/admin/runs` | 部分 |
| 新建项目 | W5/W24/W30 | `/api/profiles`、`/api/projects`、上传 | 已有 |
| 项目列表 | W25/W30 | `/api/projects` | 需扩展字段 |
| 项目详情 | W16/W22/W30 | `/api/projects/:id`、`/storyboard`、`/quality`、SSE | 需新增 |
| 分镜编辑器 | W18/W22/W26/W30 | `/storyboard`、`/shots/:id`、`/components`、`/themes`、player | 全新 |
| 素材库 | W6/W8/W24/W30 | `/api/projects/:id/assets`、上传 | 后端已有，前端全新 |
| 组件库 | W4/W23/W30 | `/api/components` | 全新 |
| Run 详情 | W14/W16/W30 | `/api/runs/:id`、`/trace`、`/quality` | 部分 |
| 管理 | W28/W30 | `/api/admin/overview`、`/login-events`、现有 admin API | 部分 |

---

## 10. 实施批次

### M0 契约冻结与可回滚基线

- 落地 `contracts/` v2（zod schema + 类型 + golden fixtures）；
- `copy.json` / `timeline.json` / `spec.json` 版本识别与 v1 只读兼容；
- 设计令牌、App Shell、1–2 个代表页骨架（能力中心/项目列表）用 fixture 驱动；
- 输出：契约文档、fixture、可回滚开关。

**出口判据**：v1 旧项目能读；v2 fixture 能通过契约测试；UI 令牌可在页面中查到来源。

### M1 数据面闭环（无 Remotion 也能演示）

- W1 shot 层、W2 cue、W3 SceneSpec、W4 三类组件、W11 字幕、W15 判据、W21 8 阶段；
- copy 提示词改为"一句一镜"；TTS 时间戳与降级；storyboard v2；
- W22 storyboard/镜头编辑 API；W23 组件/主题 API；W25 派生指标。

**出口判据**：新项目产出"一句一镜、逐句字幕、动效固定"的契约与时间轴；按 shot 重生成不触发整片重跑；旧项目可续跑。

### M2 渲染闭环

- `packages/remotion-engine` 入仓：Composition、主题、3 类组件、`renderShots()`；
- render/compose 切换；ASS 烧录；BGM/loudnorm；
- 质检首版（5 项）；W26 播放器。

**出口判据**：同一 shots 输入，成片时长/切点/字幕与契约一致；单镜重渲与整片区间逐帧一致；失败能定位到镜头/组件/依赖。

### M3 前端重写

- 批次 A：Shell、登录、能力中心、项目列表、新建项目；
- 批次 B：项目详情（工作台）、Run 详情；
- 批次 C：分镜编辑器、素材库、组件库、管理；
- 旧路由重定向，旧页面删除。

**出口判据**：10 页结构与 SKILL §4 一一对应；1440×900 与 390×844 通过；键盘路径可用。

### M4 质感与一致性

- 主题快照、风格锚、7 类组件、来源标签、文案结构提示词；
- 质检 5 项全量、失败定位到 shot；
- 素材库 6 类分类与绑定计数；管理 KPI/登录日志；全局搜索。

**出口判据**：同主题系列片版式与色板一致；数据类画面带来源；质检能拦住字幕溢出与来源缺失。

### M5 收口

- 删除旧 Playwright 渲染通道、旧组件、旧视图；
- 更新开发者/操作者指南与 AGENTS.md；
- 性能度量和渲染成本记录；
- 完整验收清单。

**出口判据**：仓库无 legacy 代码路径；文档与实现一致；验收清单全绿。

---

## 11. 测试与验收

### 11.1 自动化

| 类型 | 覆盖 |
|---|---|
| 契约单测 | v2 正向/反向、v1 兼容、golden fixture、字段不变量 |
| 时序单测 | cue 单调、覆盖率 100%、尾停顿、降级标记 |
| 组件注册表 | 参数校验、未知组件、非法枚举、装配兜底 |
| 质量单测 | 静帧/溢出/来源/对比度/动效时长，正反样例 |
| 引擎单测 | 8 阶段、shot scope 断点、取消、租约 |
| 渲染 | Remotion fixture（单镜/多镜/中文/音频/单帧/帧区间），不进默认 CI 的 Chrome 段 |
| API 集成 | storyboard、shot PATCH/regenerate、assets、admin |
| 前端 | reducer、SSE 回放、路由守卫、关键弹窗表单 |
| 浏览器验收 | 10 页逐页截图对比；键盘；窄屏 |

### 11.2 验收清单（DoD）

- [ ] 所有颜色/圆角/字号可在 `tokens.css` 找到来源；
- [ ] 5 项导航与顶栏在所有登录后页面一致；
- [ ] 10 页与 SKILL §4 一一对应；
- [ ] 镜头数、cues、ASS、质检门禁、风格锚文案正确出现；
- [ ] 状态体系（4 pill + 4 阶段态）无自造变体；
- [ ] 8 阶段在 Run 详情、工作台、Trace 一致；
- [ ] 单镜重生成不改变其余镜头，且 UI 有 seed 锚定提示；
- [ ] 旧项目可续跑或有明确可执行提示；
- [ ] 无密钥、无越界写盘、无外网监听。

### 11.3 性能基线

- 记录 78 shot / 4:51 成片的渲染耗时、帧数、并发配置；
- 对比旧链路，给出帧复用与并发收益；
- 不承诺"更快"，以实测为准。

---

## 12. 决策与风险

### 12.1 需要拍板的决策（含建议）

| # | 决策 | 建议 |
|---|---|---|
| D1 | 时间戳来源 | TTS 原生优先；缺失走 whisper.cpp；再降级为估算并标记 |
| D2 | 是否允许 LLM 写 HTML | 新项目彻底禁止；旧 `htmlPath` 只读兼容 |
| D3 | 阶段数量 | **8 阶段**（新增 captions） |
| D4 | 镜头审核持久化 | 首版不新增表，用 `agent_actions` + `runs.scope_json` + trace |
| D5 | 主题持久化 | 项目创建时快照 + `projects.theme_id` |
| D6 | 字幕实现 | 独立 ASS，compose 烧录；画面渲染不含字幕 |
| D7 | 转场实现 | 渲染层（Remotion transitions） |
| D8 | 帧复用 | 仅静止段复用，确定性优先 |
| D9 | 前端是否重写 | **是**，全量重写 UI，保留 store 思路与 api client |
| D10 | 预览嵌入 | React Player iframe + postMessage |
| D11 | 素材库作用域 | 项目作用域 + 项目选择器；组件库全局 |
| D12 | 质检持久化 | 首版 `quality/report.json`；需要历史对比时再加表 |
| D13 | 搜索 | M4 做最小实现（项目/资产/组件三类） |
| D14 | 管理导航 | 仅 admin 可见，写进验收说明 |

### 12.2 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 契约破坏性变更 | copy/timeline 被 7 个阶段与前端共同依赖 | 版本化 + v1 只读 + 禁止一次性硬切 |
| TTS 无时间戳 | 精度不达标会连锁影响字幕/切点 | 双路降级 + 契约标记 + 质检告警 |
| Remotion 许可与网络 | Chrome Headless 下载失败；商用许可 | 本机 Chrome 配置 + 立项确认许可 |
| 组件表达力 | 参数化牺牲自由排版 | 受控扩展位；参考片覆盖率基线 |
| 8 阶段迁移 | 现有测试与 UI 均按 7 阶段写死 | 能力声明版本化；旧 run 按实际 stages 渲染 |
| 前端重写回归 | 交互与 SSE 回放容易退化 | 先写 store/reducer 测试，再接页面 |
| 审核成本 | 镜头级操作点变多 | 质检前置 + 抽样审核 + 合并预览 |
| 播放器双栈 | React iframe 通信与白屏 | production bundle + ready 握手 + 错误兜底 |

---

## 13. 边界与不做

- 不做云端渲染、不做多人协作、不做公网监听；
- 不做 AE 工程化、不做完整 NLE 时间轴 GUI；
- 不做自由 HTML 输入、不做第 8 类布局组件、不做第 4 种转场；
- 不在本轮做 2.5D 视差与渲染成本自动调优；
- 不引入新的 UI 组件库；不保留浅色主题；
- 不承诺未验证能力：真实 Ark 端到端验收仍需真实密钥与模型 ID。

---

## 附录 A：数据字段 → 页面映射

| 页面元素 | 服务端字段 | 来源 |
|---|---|---|
| 78 镜头 / 平均 3.75 秒 / 04:51 | `shotCount`、`averageShotMs`、`totalMs` | copy v2 + timeline v2 |
| 98 cues | `cues.length` | timeline v2 |
| 已完成 · 78 shots | `run_stages.artifact_paths` + shot 统计 | 引擎 |
| 字幕轨 | `captions/subtitle.ass` | captions 阶段 |
| 风格锚 | `styleAnchors[]` + `project_assets` | copy v2 + 资产 |
| 已绑定 N 镜头 | `boundShotCount` | copy v2 计算 |
| 预计剩余 12 分钟 · 62% | `etaSeconds`、`progress` | 服务端派生 |
| 质检 5 项 | `quality/report.json` | 质检钩子 |
| 主题 token 色板 | `theme.resolved.json` | 创建时快照 |

## 附录 B：文件级影响清单（增量）

| 文件/目录 | 动作 | 说明 |
|---|---|---|
| `packages/shared/src/contracts/*` | 新增 | v2 契约与 schema |
| `packages/shared/src/domain.ts` | 修改 | 8 阶段、run scope、登录事件类型 |
| `packages/pipeline/src/copy-contract.ts` | 重写 | v2 + v1 兼容读取 |
| `packages/pipeline/src/copy-generate.ts` | 重写 | 一句一镜、风格锚、来源 |
| `packages/pipeline/src/tts-generate.ts` | 修改 | 逐镜 + 时间戳 + cues |
| `packages/pipeline/src/captions/*` | 新增 | ASS 生成与校验 |
| `packages/pipeline/src/storyboard-generate.ts` | 重写 | shot 切点 + cue |
| `packages/pipeline/src/timeline.ts` | 重写 | TimelineDoc v2 |
| `packages/pipeline/src/scene-generate.ts` | 重写 | 选型填参 |
| `packages/pipeline/src/compose*.ts` | 修改 | ASS 烧录、BGM、loudnorm |
| `packages/pipeline/src/quality/*` | 新增 | 5 项检查 |
| `packages/template-sdk/*` | 重写/退役 | 由 remotion-engine 承担 |
| `packages/remotion-engine/*` | 新增 | 组件、主题、Composition、render |
| `packages/renderer/*` | 冻结 | M5 删除 |
| `apps/player/*` | 新增 | React Player |
| `apps/server/src/workflow/capabilities.ts` | 修改 | 8 阶段、判据 v2 |
| `apps/server/src/workflow/breakpoint.ts` | 修改 | 新产物类型 |
| `apps/server/src/agent/tools/stage-tools.ts` | 修改 | shotIds、主题、BGM、字幕 |
| `apps/server/src/http/routes/*` | 修改/新增 | storyboard、shots、components、themes、quality、player、admin |
| `apps/server/src/db/schema.ts`、`migrate.ts` | 修改 | 列与登录表 |
| `apps/web/*` | 重写 | 10 页 + 设计系统 |
| `config/themes/*` | 新增 | 主题 |
| `config/prompts/default/*` | 重写 | copy/scene 提示词 |
| `tests/*` | 增补 | 契约、时序、质量、渲染、前端 |

## 附录 C：术语

| 术语 | 含义 |
|---|---|
| shot | 最小视觉单位，一句或短句口播，2–4 秒 |
| scene | 叙事段落/章节，包含多个 shot，不再是渲染单位 |
| cue | 时间轴上的句级/事件级定位 |
| SceneSpec | 组件 ID + 参数 + 主题 + 资产引用的结构化视觉规格 |
| 风格锚 | 跨镜头复用的符号资产 + seed |
| 组件注册表 | 组件 ID、参数 schema、动效契约、预览 fixture |
| 主题 token | 色板、字体、安全区、字幕样式 |
| 质量门禁 | 5 项可判定检查，结论可定位到 shot |

## 附录 D：对原架构清单的修订摘要

1. 4.1 的"继续保留七阶段"改为 **8 阶段**（新增 `captions`）；
2. 4.2 编排层不再承担字幕，字幕独立成层/阶段；
3. W16 的镜头审核首版不新增表；
4. W18 从 P2 提前到 M3；
5. C.6 R5 的预览方式改为 Player iframe；
6. 新增 W21–W31，覆盖阶段、API、素材分类、派生指标、播放器、搜索、管理、设计系统与旧代码退场；
7. 补充登录日志表与管理 KPI，原清单未覆盖 UI 稿第 10 页。
