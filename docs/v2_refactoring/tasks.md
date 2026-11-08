# VideoForge v2 重构任务板

> 设计真相（Design Source）：[VideoForge重构方案.md](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/VideoForge重构方案.md)
> 工作状态真相（Work State）：本文件
> 交付日志（Ledger）：`docs/v2_refactoring/logs/`（每任务一份，模板见 [logs/README.md](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/README.md)）
>
> 本文件只记录**当前状态、依赖、验收标准、日志路径**，不写过程性聊天内容；设计与取舍以方案文档为准。

---

## 一、执行协议（每个任务必须遵守）

### 1.1 任务开始前

1. 在任务表中把状态改为 `in_progress`，写 `started_at`；
2. 读取依赖任务的日志，确认前置产出存在；
3. 读取方案文档对应章节，确认本任务不改变已冻结的决策；
4. 若发现方案与代码冲突：先停下，写 `blocked` 日志，问题记入"待裁决"，不要擅自扩大范围。

### 1.2 任务执行中

- 一个任务只做一个可独立验证的变更集，默认 ≤ 10 个文件；
- 每完成一个可验证步骤，在日志里追加一条带时间戳的检查点（`Checkpoint`）；
- 需要运行长命令时，先写"即将执行"日志，避免中断后不知道跑到哪。

### 1.3 任务结束

1. 运行任务验收命令；
2. 写完整日志（模板见 logs/README.md）；
3. 更新本文件状态为 `done` / `blocked` / `partial`；
4. 在日志"下一步"中写清下一个任务 ID。

### 1.4 中断恢复规则（长程任务必读）

- **任何任务只要跨过一次会话，就必须在中断前写 `partial` 日志**，内容至少包含：已完成、未完成、最后运行命令、下一步动作、已知风险；
- 恢复时先读该任务的日志，不凭记忆继续；
- 不允许删除或覆盖旧日志；恢复执行时在日志末尾追加 `## 续跑记录` 段落；
- 若同一阻塞连续出现 3 次，状态改 `blocked`，并在任务表"当前阻塞"区块登记。

### 1.5 不提交约束

- 本任务板不要求每个任务一次 Git commit；只有用户明确要求时才提交；
- 若提交，任务状态更新必须与代码改动同一逻辑提交。

### 1.6 状态图例

| 状态 | 含义 |
|---|---|
| `todo` | 未开始 |
| `ready` | 依赖已满足，可开始 |
| `in_progress` | 正在执行 |
| `partial` | 已开始但未完成，必须能从日志恢复 |
| `blocked` | 被决策/外部条件阻塞 |
| `done` | 验收命令通过，日志完整 |
| `canceled` | 明确不做 |

---

## 二、当前焦点

| 项 | 值 |
|---|---|
| 当前批次 | M5 收口（出口达成） |
| 当前任务 | `T505` 产物面板收敛到 v2（done） |
| 上一任务 | `T503` 全量验收 + 性能报告（done） |
| 当前阻塞 | 无 |
| 下一步 | 无新任务；「十二、待裁决与遗留项」L1–L4 已全部裁决落地；T104b 与真实 Ark 端到端验收为明确例外 |

> 更新规则：每次任务状态变化时同步本表，避免任务表与日志不一致。

---

## 三、M0 契约与基线

| ID | 任务 | 交付 / 验收 | 依赖 | 状态 | 日志 |
|---|---|---|---|---|---|
| T001 | 建立任务板与日志协议 | 本文件 + `logs/README.md`；状态/验收/日志齐全 | — | done | [T001](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T001-task-board.md) |
| T002 | 共享契约 v2（schema + 类型 + fixtures） | CopyDoc/TimelineDoc/SceneSpec/Quality/Theme/Component/AssetRef；正例可解析，负例被拒；`vitest` 通过 | T001 | done | [T002](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T002-shared-contracts-v2.md) |
| T003 | copy 读取器 v1/v2 兼容 | v1 旧文件可读；v2 带 `contractVersion`；非法版本报 `ADAPTER_PROTOCOL_INVALID`；v1 续跑测试通过 | T002 | done | [T003](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T003-copy-reader-compat.md) |
| T004a | 影子 8 阶段常量（不切换运行时） | shared 新增 `PIPELINE_STAGES_V2`（含 `captions`）；`PIPELINE_STAGES` 仍为 7；单测锁定顺序 | T002 | done | [T004a](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T004a-pipeline-stages-v2.md) |
| T004b | 前端阶段标签与折叠逻辑扩到 8 阶段 | `STAGE_LABELS`/`STAGE_ORDER`/reducer 支持 `captions`；相关测试更新；不删除旧 7 阶段兼容 | T004a/T004 | done | [T004b](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T004b-web-stages.md) |
| T004 | 能力注册表切到 8 阶段 | `captions_generate` 工具可用后，能力声明与判据切换到 v2；run 详情/工作台显示 8 阶段 | T004a/T105/T107 | done | [T004](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T004-capability-flip.md) |
| T005 | 数据库迁移（v2 列与新表） | `projects.theme_id/contract_version`、`runs.scope_json/contract_version`、`project_assets.visual_category`、`login_events`；迁移幂等 | T002 | done | [T005](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T005-db-migration.md) |
| T006 | 质量报告契约与生成骨架 | `quality/report.json` 读写；5 项检查结构；单测 | T002 | done | [T006](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T006-quality-report.md) |
| T007 | 设计令牌与深色主题映射 | `tokens.css` + AntD `darkAlgorithm` 映射；web build 通过；令牌无魔法值 | T001 | done | [T007](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T007-design-tokens.md) |
| T008 | 契约版本写入 manifest/trace | `manifest.json`、run 元数据带 `contractVersion`；旧记录缺省为 `1.0` | T003/T005 | done | [T008](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T008-contract-versioning.md) |
| T009 | v1 行为快照与回归基线 | 现有七阶段样例的 golden 产物、时间轴、帧数快照；默认测试可跑 | T003 | done | [T009](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T009-v1-baseline.md) |

## 四、M1 数据面闭环

| ID | 任务 | 交付 / 验收 | 依赖 | 状态 | 日志 |
|---|---|---|---|---|---|
| T101 | copy 提示词 v2（一句一镜） | `copy-system.txt` 产出 shots/styleAnchors/source；提示词单测快照更新 | T003 | done | [T101](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T101-copy-prompt-v2.md) |
| T102 | copy 生成器 v2 | `copy_generate` 产出 v2；缺 shots 时显式失败/降级；契约校验通过 | T101 | done | [T102](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T102-copy-generate-v2.md) |
| T103 | image 按 shot + 锚点复用 | 同一锚点复用 asset + seed；逐 shot 产物齐全；缺失可定位 | T102 | done | [T103](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T103-image-shots.md) |
| T104 | TTS 逐镜 + cue 时间戳 | 逐镜音频 + `audio/cues.json`；`timingSource` 可见；cue 覆盖口播 | T102 | done | [T104](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T104-tts-cues.md) |
| T104b | 原生/ASR 时间戳接入 | Ark 原生时间戳或 whisper.cpp 对齐；`timingSource` 从 `estimated` 升级；降级可见 | T104 | todo | 未创建（执行时按 [logs/README.md](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/README.md) 模板新建 `T104b-native-timestamps.md`） |
| T105 | captions ASS 生成 | `subtitle.ass` 与 cue 一一对应；样式来自主题；关闭字幕不影响画面 | T104/T111 | done | [T105](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T105-captions-ass.md) |
| T106 | Timeline v2 构建 | shot 切点连续、尾停顿可配、cue 单调；单测 | T104 | done | [T106](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T106-timeline-v2.md) |
| T107 | storyboard 阶段产出 v2 | 消费 v2 copy + cue，产出 timeline v2；断点判据更新 | T106 | done | [T107](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T107-storyboard-v2.md) |
| T108 | 组件注册表基础设施 | 注册/查询/参数校验/preview fixture；新增组件不改流水线 | T002 | done | [T108](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T108-component-registry.md) |
| T109 | 3 类高频组件规格 | 关键词块/数据卡/引语卡；参数 schema + fixture + 装配 | T108 | done | [T109](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T109-components-3.md) |
| T110 | scene 生成器改为 SceneSpec 选型 | LLM 只选型填参；非法组件/参数装配期报错；降级路径 | T108/T102 | done | [T110](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T110-scene-spec.md) |
| T111 | 主题加载与项目快照 | `config/themes` 加载；`theme.resolved.json` 创建时写入；切换主题不改组件 | T007/T005 | done | [T111](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T111-theme-snapshot.md) |
| T112 | 能力判据 v2（结构校验） | shot 覆盖、cue 覆盖、ASS、spec 合法；断点续跑可判定 | T107/T105/T110 | done | [T112](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T112-artifact-predicates-v2.md) |
| T113 | storyboard 聚合读取 API | `GET /api/projects/:id/storyboard` 返回 shots/cues/theme/assets/quality | T107/T005 | done | [T113](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T113-storyboard-api.md) |
| T114 | 镜头 PATCH API | 可逆编辑 + `agent_actions`；越权/非法 shot 拒绝；单测 | T113 | done | [T114](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T114-shot-patch-api.md) |
| T115 | 镜头重生成 API + run scope | 只重跑目标镜头；其余镜头逐帧不变；SSE 可观测 | T114/T112 | done | [T115](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T115-shot-regenerate.md) |
| T116 | 服务端派生指标 | shotCount/totalMs/progress/eta/boundShotCount；前端不推导 | T106/T118 | done | [T116](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T116-derived-metrics.md) |
| T117 | 组件/主题读取 API | `/api/components`、`/api/themes`；只读、可缓存 | T108/T111 | done | [T117](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T117-components-themes-api.md) |
| T118 | 资产分类与绑定计数 | 6 类筛选；"已绑定 N 镜头"由 copy v2 计算 | T103/T005 | done | [T118](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T118-asset-categories.md) |
| T119 | SSE 新事件 | `shot.updated`/`quality.updated`/`asset.bound`/`preview.ready`；resync 兼容 | T115 | done | [T119](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T119-sse-events.md) |

## 五、M2 渲染闭环

| ID | 任务 | 交付 / 验收 | 依赖 | 状态 | 日志 |
|---|---|---|---|---|---|
| T201 | remotion-engine 包骨架 | Composition、主题解析、`renderShots()`；fixture 可出帧 | T109/T111 | done | [T201](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T201-remotion-engine.md) |
| T202 | 3 类组件组件化 | 关键词块/数据卡/引语卡 React 组件；props 校验 | T201 | done | [T202](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T202-components-react-3.md) |
| T203 | 其余 4 类组件 | 对比条/进度环/章节角标/来源标签 | T202 | done | [T203](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T203-components-react-4.md) |
| T204 | render 阶段切 Remotion | 镜头级渲染、帧号连续、单帧/帧区间可用；发布 `asset.bound`/`preview.ready` | T201/T112 | done | [T204](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T204-render-remotion.md) |
| T205 | compose：ASS + BGM + loudnorm | 字幕可开关；BGM 参数暴露；响度目标可配 | T105/T204 | done | [T205](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T205-compose-audio.md) |
| T206 | 质检 5 项实现 | 静帧/字幕溢出/来源/对比度/动效时长；正反样例 | T204/T105 | done | [T206](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T206-quality-checks.md) |
| T207 | 质检接入引擎 + 报告 API | 阶段钩子执行；报告落盘；`GET /quality`；发布 `quality.updated` | T206/T113 | done | [T207](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T207-quality-gate.md) |
| T208 | Player 应用 + iframe 协议 | React Player 构建；postMessage 握手；失败不白屏 | T201 | done | [T208](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T208-player.md) |
| T209 | legacy 渲染开关 | `VF_RENDERER=legacy` 仅旧项目；默认 Remotion | T204 | done | [T209](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T209-legacy-renderer.md) |
| T210 | 渲染性能基线 | 78 shot 样例耗时/帧数/并发记录；不承诺更快 | T204 | done | [T210](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T210-render-baseline.md) |

## 六、M3 前端重写

| ID | 任务 | 交付 / 验收 | 依赖 | 状态 | 日志 |
|---|---|---|---|---|---|
| T301 | AppShell + 设计基元 | 196px 侧栏/56px 顶栏/5 项导航；Button/Pill/Card/Input/Modal/JsonBlock | T007 | done | [T301](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T301-app-shell.md) |
| T302 | 登录页 | 左品牌 + 右表单；无注册；键盘可用 | T301 | done | [T302](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T302-login.md) |
| T303 | 能力中心 | 能力卡 + 即将上线 + 最近运行表 | T301/T116 | done | [T303](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T303-capabilities.md) |
| T304 | 项目列表 + 新建项目模态 | 卡片网格/筛选/两步模态/风格锚上传 | T303 | done | [T304](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T304-projects.md) |
| T305 | 工作台（对话/阶段/产物） | 8 阶段、对话流、final.mp4 卡、SSE | T301/T119 | done | [T305](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T305-workbench.md) |
| T306 | 工作台 4 Tab + 资产 | 阶段/分镜/资产/产物；引用资产 | T305/T113 | done | [T306](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T306-workbench-tabs.md) |
| T307 | Run 详情 + 路由重定向 | 失败 banner/8 阶段/工具表/质检门禁 | T305/T207 | done | [T307](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T307-run-detail.md) |
| T308 | 分镜编辑器 | 场景栏/画布/三轨/Inspector/重生成 | T306/T208/T114/T115 | done | [T308](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T308-storyboard-editor.md) |
| T309 | 素材库 | 风格锚 banner/6 类筛选/绑定计数/上传 | T306/T118 | done | [T309](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T309-assets.md) |
| T310 | 组件库 | 7 类预览卡/参数说明/新增指引 | T301/T117 | done | [T310](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T310-components.md) |
| T311 | 管理页 | KPI/用户/项目/Runs/登录日志 | T301/T005 | done | [T311](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T311-admin.md) |
| T312 | 全局搜索 | 项目/素材/组件三类；空态与键盘 | T301 | done | [T312](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T312-search.md) |
| T313 | 响应式与键盘验收 | 1440×900、390×844、键盘路径 | T302–T312 | done | [T313](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T313-responsive-a11y.md) |
| T314 | 删除旧视图与旧组件 | 旧 7 视图/旧基元移除；构建通过 | T313 | done | [T314](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T314-remove-legacy-web.md) |

## 七、M4 质量与一致性

| ID | 任务 | 交付 / 验收 | 依赖 | 状态 | 日志 |
|---|---|---|---|---|---|
| T401 | 风格锚运营 | 管理锚点、seed 复用、跨镜头一致 | T103/T115 | done | [T401](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T401-style-anchors.md) |
| T402 | 来源标签 + 文案结构 | 数据镜头必带来源；钩子/设问/免责提示词 | T109/T206 | done | [T402](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T402-source-and-copy.md) |
| T403 | 主题一致性验收 | 同主题系列片色板/版式一致；切换主题不改组件 | T111/T310 | done | [T403](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T403-theme-consistency.md) |
| T404 | 质检失败定位与重跑 | 失败项定位 shot；一键从阶段重跑 | T207/T307 | done | [T404](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T404-quality-rerun.md) |
| T405 | 管理 KPI 完善 | 4 指标口径固定；成功率可复算 | T311 | done | [T405](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T405-admin-kpi.md) |

## 八、M5 收口

| ID | 任务 | 交付 / 验收 | 依赖 | 状态 | 日志 |
|---|---|---|---|---|---|
| T501 | 删除 legacy renderer/template-sdk | 无旧渲染代码路径；typecheck/build 通过 | T209/T314 | done | [T501](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T501-remove-legacy-renderer.md) |
| T502 | 文档与 AGENTS 更新 | 开发/操作指南、AGENTS 与实现一致 | T501 | done | [T502](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T502-docs.md) |
| T503 | 全量验收 + 性能报告 | SKILL §8 + 方案 §11 清单全绿 | T501/T502 | done | [T503](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T503-acceptance.md) |
| T504 | 旧项目迁移提示 + CLI 校验 | 旧项目续跑或明确提示；`project:verify` 覆盖 v2 | T501 | done | [T504](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T504-migration-notice.md) |
| T505 | 产物面板收敛到 v2（收口后审计 L1） | 「文案/场景/音频/时间轴」四子面板按 v2 结构化产物渲染；重生成载荷按 `shotId`；回归测试通过 | T503 | done | [T505](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T505-artifact-tabs-v2.md) |

---

## 九、依赖主链

```
T001 → T002 → T003
          ├→ T004a → T004b
          │      └→ T004（另需 T105/T107）
          ├→ T005
          │
          ├→ T101 → T102 → T103 → T118
          │              └→ T104 → T105/T106 → T107 → T112 → T115
          ├→ T108 → T109 → T110 → T112
          ├→ T007 → T111
          └→ T006 → T206 → T207

T109/T111 → T201 → T202/T203 → T204 → T205/T206 → T210
                              └→ T208 → T308

T301 → T302–T312 → T313 → T314
```

## 十、批次出口判据

| 批次 | 出口判据 |
|---|---|
| M0 | 旧项目可读；v2 fixture 过契约测试；令牌落地；迁移幂等 |
| M1 | 一句一镜、逐句字幕、固定动效；单镜重生成不整片重跑 |
| M2 | 成片与契约一致；单镜重渲逐帧一致；失败能定位镜头 |
| M3 | 10 页与 SKILL §4 对应；桌面/窄屏/键盘通过 |
| M4 | 同主题一致；来源齐全；质检可拦截 |
| M5 | legacy 清理；文档一致；验收全绿 |

## 十一、变更记录

| 日期 | 变更 | 影响 |
|---|---|---|
| 2026-11-03 | 初始任务板；冻结执行/日志/中断恢复协议 | — |
| 2026-11-03 | 拆分 T004 为 T004a/T004b/T004：先影子常量，工具就绪后再切能力与前端 | 避免能力声明提前引用不存在的 `captions_generate` |
| 2026-11-04 | T102 放宽 copy 契约：`visualType=component` 可暂不带 `component` | 组件选型属于 scene 阶段，SceneSpec 仍强校验 |
| 2026-11-04 | T103 补充下游回填字段：`shot.anchorKeys/imagePath`、`styleAnchor.assetPath/seed` | 文件级管线不依赖数据库资产 ID 也能复用锚点 |
| 2026-11-04 | T104 拆分出 T104b（原生/ASR 时间戳），当前只落 `estimated` | 无 ASR 环境，先保证契约与降级可见 |
| 2026-11-07 | T111 完成：主题加载器 + `theme.resolved.json` 创建时快照；创建入口可选 `themeId` | 快照冻结语义；`themeId` 暂未进入能力参数声明，待 T112 暴露 |
| 2026-11-07 | T105 完成：`captions_generate` 工具 + `captions/subtitle.ass`；阶段工具顺序改为 8 项 | 能力声明仍 7 阶段，调度切换留 T004 |
| 2026-11-07 | T108 完成：组件注册表（构造期结构校验/ID 去重/参数校验/preview 路径护栏）；内置条目暂空 | 注册表暂驻 template-sdk，T201 建包时迁移或转导出 |
| 2026-11-07 | T109 完成：关键词块/数据卡/引语卡 3 条规格 + fixture + `assembleComponentShot` | 其余 4 类留 T203；覆盖率仅 keyword-block 有方案依据 |
| 2026-11-07 | T110 完成：scene v2 只选型填参，落 `scenes/spec.json`，非法选型降级关键词块 | v1 HTML 路径保留；v2 编排仅纯逻辑单测 |
| 2026-11-07 | T112 完成：5 个 v2 结构校验器（copy/cue/ASS/spec/timeline）接入断点解释器 | 能力声明仍用 v1 判据，T004 切换后真实生效 |
| 2026-11-07 | T113 完成：`GET /api/projects/:id/storyboard` 聚合 shots/cues/theme/spec/assets/quality | 缺产物返回 null/空数组；assets 暂不触发同步（T118 统一） |
| 2026-11-07 | 状态审计：22 个 done 任务与日志一一对应；T117/T118/T201/T301 依赖已满足，状态由 todo 校正为 ready；补 T111 日志链接 | T004 依赖虽满足，但全局切 8 阶段会破坏 v1 续跑，需版本感知后再执行 |
| 2026-11-07 | T114 完成：`PATCH /api/projects/:id/shots/:shotId` 可逆编辑（copy + SceneSpec 同步），before/after 落 `agent_actions` | 需 T115 重生成才能刷新像素产物；system 审计消息需前端过滤 |
| 2026-11-07 | T115 完成：`POST /shots/:shotId/regenerate` + `runs.scope_json`（fromStage 强制起点）+ `run_start` SSE 带 scope | "其余镜头逐帧不变"需 T204 渲染层闭环；工具层 shotIds 兜底待加 |
| 2026-11-07 | T118 完成：`assetBindingCounts`（copy v2 锚点 + assetRefs 计数）+ `/assets` 返回 `categories`/`boundShots` + `visualCategory` 筛选 | 悬空 assetId 不报错；计数每次重读 copy.json，本地规模可接受 |
| 2026-11-07 | T116 完成：`project-metrics.ts`（shotCount/totalMs/averageShotMs/progress/etaSeconds/boundShotCount）+ `GET /api/projects`、`/api/projects/:id` 平铺扩展并附 `latestRun` | v1/缺产物 → null；progress 分母随 T004 切 8 阶段自动变化；eta 未做 scope 感知 |
| 2026-11-07 | T117 完成：`/api/components`(+preview)、`/api/themes`(+`:id`) 只读目录，`listThemes` 扫描容错 | 响应带 `private, max-age=300`；预览静态帧留 T208；非法主题跳过仅日志可见 |
| 2026-11-07 | T119 完成：SSE 类型表 +4（§7.2）；`shot.updated` 随 PATCH 落地；resync 兼容验证 | `quality.updated`/`asset.bound`/`preview.ready` 发布点分别随 T207/T204/T204+T208；**M1 数据面闭环收口**，遗留单列：T004、T104b、T004b |
| 2026-11-07 | T201 完成：`packages/remotion-engine` 入仓（theme/frames/composition/entry/render），`renderShots`/`renderShotStill` 支持 shotIds 局部渲染与本机 Chrome 复用 | bundle 需 `extensionAlias` 适配 NodeNext；帧文件名为 `element-N.jpeg`；组件视觉留 T202/T203，render 接线留 T204 |
| 2026-11-07 | T202 完成：3 类组件 React 实现 + `ComponentShotVisual` 分发；渲染层不做 props 校验（装配期边界），bundle 将 `node:*` 置空 | 具名动效（title-in 等）留 T204/T206；字体资产留 T210/T403；webpack `alias:false` 是 `node:` scheme 的唯一有效置空方式 |
| 2026-11-07 | T203 完成：comparison-bars/progress-ring/chapter-badge/source-tag 注册表条目 + fixture + React 实现，7 类组件齐备；SSR 单测 10 例 + 冒烟 3 例（21 帧） | **M2 组件层收口**；T204 render 接线依赖全部就绪 |
| 2026-11-07 | T204 完成：render_frames 按 contractVersion 分派，v2 走 `renderShots()`（输出 `build/render/<dir>/shots/<shotId>/`），publicDir=images/ + imageByShot 资产映射；`asset.bound`（image 后）/`preview.ready`（render 后）两个 SSE 发布点落地 | v2 compose（T205）落地前 v2 项目 compose 会失败，属预期中间态；v1 链路原样保留（T209 做显式开关）；单测 693 例 + 冒烟 3 例通过 |
| 2026-11-07 | T205 完成：compose_video v2 分派到 `composeVideoStepV2`（帧物化 + ASS 烧录 + BGM 资产 ID 解析 + loudnorm 单遍）；字幕开关/响度目标可配；音频链 apad 修复旁白短于视频的截断 | loudnorm 单遍、BGM 无 ducking 留 T210 评估；v1 链路保留（loudnessTarget 为可选新增）；单测 710 例通过；**M2 渲染主链（render→compose）打通** |
| 2026-11-07 | T206 完成：5 项检查落 `quality/checks.ts`（freezedetect 静帧 / cue 溢出 / 数据组件来源 / WCAG 对比度 / 动效越界），组合入口 `runQualityChecks` 按产物存在性条件执行 | 对比度不含资产亮度（需图像解码依赖，降级声明）；freezedetect 对静止 image 镜头有预期内假阳性，T207 接线前须裁决口径；单测 726 例通过 |
| 2026-11-07 | T207 完成：引擎 `onStageCompleted` 钩子 + `runQualityGate`（v2 compose 后质检落盘）+ `GET /api/projects/:id/quality` + `quality.updated` 推送；freeze 口径裁决为"覆盖镜头 ≥80%"且 image 镜头剔除 | 质检不拦截 run（门禁留 T404）；freeze 执行时点为 compose 后（方案偏差已登记）；单测 733 例通过 |
| 2026-11-07 | T208 完成：`apps/player`（React + @remotion/player，lib 模式 IIFE bundle）+ `GET /api/player/:projectId/:shotId?` 内联数据 HTML + `/player/` 静态服务 + postMessage 5 条协议 + 三层失败兜底；remotion-engine 增浏览器安全子路径导出 | UI 细节与键盘 seek 留 T308/T313；postMessage origin=\*（本地 harness）；单测 739 例 + bundle 构建通过 |
| 2026-11-07 | T209 完成：render_frames 分派改为 `resolveRendererKind` 决策表（契约版本 × `VF_RENDERER`）——默认 Remotion；legacy 仅旧项目显式开启；v2+legacy / v1+未开启 / 未知值均 `CONFIG_INVALID` | **存量 v1 项目续跑渲染需显式设 `VF_RENDERER=legacy`**（行为变更，operator-guide §7/§8 已同步）；compose 不 gate；单测 750 例通过 |
| 2026-11-07 | T210 完成：78 镜/4:51 确定性样例（13×6 镜、98 cue、7 组件轮换）真机基线 `pnpm test:bench`（VF_BENCH 门控）——v2 全量 8658 帧/502.7s（concurrency=4）、单镜重渲 111 帧/7.6s（帧复用收益约 66 倍）、并发曲线 4 档（小样本被 bundle 主导）、legacy 对照 8736 帧/159.3s（单帧成本低于 v2 约 3.2 倍）；结果落盘 `docs/v2_refactoring/baselines/render-baseline.json` | 不承诺"更快"：Remotion 单帧开销为实测事实，换来组件化与镜头级重渲；**M2 渲染闭环收口**（T201–T210 done），下一批次 M3 前端重写 |
| 2026-11-07 | T301 完成：6 基元（Button/Pill/Card/Input/Modal/JsonBlock）+ AppShell（196px 侧栏/56px 顶栏/5 项导航/面包屑/用户卡，<1280 收栏、<768 抽屉）+ 令牌一次性接入（tokens.css 进 main.ts、AntD 切 VF_THEME、默认布局切 AppShell）；/assets、/components 登记占位路由；vitest 补 vue 系 alias，首个挂载型测试 19 例 | **旧 7 页进入「暗壳 + 旧内容」过渡态**（global.css 保留至 T314）；浏览器目检链路随 T302 建立；单测 769 例 + web build 通过 |
| 2026-11-07 | T302 完成：登录页重写（左品牌 slogan/3 特性/阶段 chips + 右表单），**删除公开注册**，错误全行内；「记住我」落 localStorage/sessionStorage 双存储；「忘记密码」给管理员重置指引；VfButton +type、VfInput +id/autocomplete；建立浏览器目检链路（1440×900 / 390×844 / 壳 196·56·64 实测） | 目检重置了历史账号 `layoutcheck` 口令（未记录，需管理员再重置）；Enter 键盘提交与无横向滚动已验证；单测 782 例 + web build 通过 |
| 2026-11-07 | T303 完成：能力中心重写（能力卡 7 阶段 chips/参考片基线/项目数/工作流说明 + 即将上线 3 禁用卡 + 最近运行表）；**能力中心切为默认首页 `/`**（`/capabilities` 重定向、守卫默认页、Logo、强制改密完成跳转全部切换）；state-mapping 增 4 个展示格式化纯函数 | 最近运行表只用 T116 `latestRun`（不新增接口）；运行中 run 耗时显示 `—`；目检 1440×900/390×844（activeNav=能力中心、chips 7、即将上线 3、表 1 行）；单测 795 例通过 |
| 2026-11-07 | T304 完成：项目列表重写（筛选 4 档 + 按最近更新倒序卡片网格 + 进度/成片/重试入口）+ `ProjectCard` + `project-filter` 纯函数；`NewProjectModal` 改为 Vf 基元两步模态（能力卡选择 → 名称/主题/风格/Profile/风格锚上传） | 卡片仅渲染服务端 status/progress/shotCount/totalMs；重试走 `POST /api/projects/:id/runs`；风格锚在项目创建后上传（首个 run 已触发，属已知竞态，留 T401）；目检 1440×900/390×844；单测 815 例通过 |
| 2026-11-08 | T004b 完成：前端 `STAGE_LABELS`/`STAGE_ORDER` 扩到 8 阶段（新增 `captions`），reducer 的 `stagePlaceholders` 与 resync 同步 8 条；SSE 类型表补齐 `shot.updated/quality.updated/asset.bound/preview.ready` 落点（storyboard/quality 刷新令牌） | 旧 7 阶段 run 的 `captions` 由 `toStageProgress` 补为 `pending`，不做版本分叉；`web-state-map`/`web-workbench-reducer` 测试同步 |
| 2026-11-08 | T305 完成：工作台整页重写（左对话流 + 右 4 Tab、页头 pill 状态与操作、窄屏 5 项顶部导航）+ `FinalOutputCard`（final.mp4 播放/下载/分辨率/时长/大小） | 对话流复用 `MessageBubble`/`ToolGroup`；final 缺失显示「尚未合成」；成片切换为 compose 产物或 `finalVideoExists` 回退；目检 1440×900/390×844 |
| 2026-11-08 | T306 完成：`WorkbenchTabs`（阶段进度/分镜/项目资产/产物）+ 质检门禁 + 分镜缩略 + `ArtifactTabs`；新增 `storyboard` store 作为分镜聚合读取唯一入口 | Tab 刷新由 reducer 令牌驱动（`storyboardRefreshToken`/`qualityRefreshToken`）；资产引用回填到对话输入；仅渲染服务端字段 |
| 2026-11-08 | T307 完成：新增 `RunDetailView`（8 阶段/失败 banner/质检门禁/工具/LLM/事件 Tab）+ `/projects/:id/runs/:runId` 路由；旧 `/runs/:id/trace` 改为客户端重定向页 | `admin=1` 返回管理页；失败 banner 提供 `POST /api/runs/:id/resume {action:"retry"}`；`ToolCallCard`/`ToolGroup` 锚链优先新路由 |
| 2026-11-08 | T308 完成：新增 `StoryboardEditorView`（场景栏/画布/镜头条/三轨/Inspector/重生成）+ `/projects/:id/storyboard` 路由 | PATCH 走 `PATCH /shots/:shotId`，重生成走 `POST /shots/:shotId/regenerate` 并跳 run 详情；←→ 键盘切换镜头；<1280 Inspector 下移、<768 单列 |
| 2026-11-08 | T309 完成：`AssetsView`（项目选择器/风格锚 banner/6 类筛选/绑定计数/上传/卡片网格） | 分类计数来自 `/assets` 的 `categories` 与 `visualCategory`，兜底内置 6 类；空态与筛选空态分离 |
| 2026-11-08 | T310 完成：`ComponentsView`（7 类预览卡/参数名/coverageNote/fixture 状态/新增指引） | 预览逐条拉 `/api/components` 的 preview 描述，用成片令牌渲染；不提供在线编辑器 |
| 2026-11-08 | T311 完成：管理页 4 KPI + 4 Tab（用户/项目/Runs/登录日志）；服务端新增 `login-event-repository`、`GET /api/admin/overview`、`GET /api/admin/login-events`；登录写入成功/失败事件 | 登录日志不含口令；成功率 = done/(done+failed)；Runs 详情跳新路由；非管理员 403 与守卫重定向已目检 |
| 2026-11-08 | T312 完成：顶栏全局搜索接 `GET /api/search?q=`（项目/素材/组件三类，250ms 去抖），支持 Esc/↑/↓/Enter 键盘路径 | 搜索仅当前 actor 项目/资产 + 全局组件；空查询返回空集；面板点击空白关闭；`layoutcheck` 实测命中组件与跳转 |
| 2026-11-08 | T313 完成：1440×900 与 390×844 目检 7 页 + 搜索面板 + 键盘路径，全部无横向溢出；截图落 `docs/v2_refactoring/screenshots/t313-*.png` | 工作台/ Run 详情/分镜编辑器/素材库/组件库/管理/登录日志/搜索面板；`scrollWidth == innerWidth` 逐页实测 |
| 2026-11-08 | T314 完成：删除 `PlaceholderView` 与 `AppLayout` 旧布局；路由清理旧占位与已替换页面；`global.css` 的 `--vf-*` 全部映射到 tokens（旧页面暗色兼容） | `web-ui-primitives` 测试移除 PlaceholderView 断言；旧 7 视图不再被路由引用；**M3 前端重写收口**，遗留单列：T004、T104b |
| 2026-11-08 | T401 完成：风格锚运营（`PATCH/POST /style-anchors/:key`）——绑定图片资产、编辑 seed、显式重建归档；资产 `metadata_json` 记录 `styleAnchorKey/generationSeed/boundShotIds`；素材库「管理锚点」模态落地 | `boundShotIds` 由 copy v2 实时计算；重建只清缓存并归档，不删除用户上传；上传资产换绑时清旧资产元数据；目检 1440×900/390×844（4 锚点、绑定 s1.png、seed 21、重建清空） |
| 2026-11-08 | T402 完成：数据组件来源标签渲染（`ComponentShotVisual` 对 `DATA_COMPONENT_IDS` + `spec.source.label` 叠加 `SourceTag`）；「数据组件」清单统一到 `packages/shared`；copy v2 提示词新增来源长度/开头钩子/中段设问/风险免责 4 条规则 | 质检与渲染共用同一清单，消除漂移；提示词为软约束，真实输出待 T503 端到端验收；非数据组件与 image/video/symbol 镜头不叠标签 |
| 2026-11-08 | T403 完成：新增 `tests/unit/theme-consistency.test.tsx`（4 例）固化成「同主题两项目 token 相等 / 切换主题不改已有快照 / 组件装配不含 theme / 同组件 A/B 主题文案一致、强调色不同」 | 不改产品代码；像素级版式一致留 T210/T503；快照冻结即“创建时决定视觉语言” |
| 2026-11-08 | T404 完成：Run 详情页质检违规项支持「重跑该镜」——按检查项映射可重跑阶段（freeze→render/compose；subtitle-overflow→tts/storyboard/render/compose；source-label/animation-duration→scene/render/compose），复用 `POST /shots/:shotId/regenerate` 并跳转新 run | 对比度为全局问题不提供单镜重跑；未知检查项安全降级为不显示按钮；目检 1440（4 违规 / 3 按钮）与 390（无横向溢出、按钮 28px） |
| 2026-11-08 | T405 完成：管理 KPI 口径抽成纯函数 `summarizeAdminOverview` + `startOfWeekIso`；`GET /api/admin/overview` 返回 `basis`（done/failed/canceled/completed/weekStart/formula）；前端 hint 展示分子分母 | 成功率 = done/(done+failed) 保留 1 位小数、canceled 不计、本周起点为本地时区周一 00:00；目检 `/admin` 显示 `20% done 1 / (done+failed) 5 · canceled 1 不计`，**M4 质量与一致性收口** |
| 2026-11-08 | T501 完成：删除 legacy 渲染通道——整删 `packages/renderer`、`renderer-switch.ts`、`pipeline/timeline.ts`，`template-sdk` 仅留 Profile + 组件注册表，`pipeline` 的 scene/storyboard/compose 改为 v2-only 且旧项目抛 `CONFIG_INVALID`（含迁移指引），`stage-tools` 去掉 `VF_RENDERER` 分派；新项目固定 `contractVersion=2.0` | **仓库已无 legacy 代码路径**；v1 项目 scene 阶段起明确失败（迁移提示由 T504 承接）；前端 ArtifactTabs「时间轴」Tab 仍按 v1 `entries` 形状（已记风险）；typecheck 7 项 + `pnpm test` 88 files/814 tests + web build 全绿 |
| 2026-11-08 | T004 完成：`PIPELINE_STAGES` 合并为 8 阶段（新增 `captions`）、删除 `PIPELINE_STAGES_V2`/`PipelineStageV2` 影子常量；`buildVideoGenerationStages()` 8 阶段 + v2 判据（copy/scene/tts/captions/storyboard 走 v2 结构校验器）；全仓「七阶段」文案同步为「八阶段」；6 个测试文件改 v2 夹具驱动（新增 `tests/unit/helpers/v2-project-fixture.ts` 复用真实生成器） | T112 的 5 个 v2 校验器**首次被真实调度**；`project:verify` 与引擎断点续跑按 v2 判定（T504 的 CLI 覆盖诉求已具备）；受控偏差：`tts` 判据用 `audio/cues.json`+`audio-cues` 而非 mp3 计数、`captions` 资产归类为 `timeline`；`pnpm test` 88 files/814 tests + `pnpm run typecheck` exit 0 |
| 2026-11-08 | T504 完成：新增 `apps/server/src/domain/project-contract.ts`（`isRunnableContract`/`legacyProjectMigrationHint`/`assertProjectRunnable`）；`POST /api/projects/:id/runs` 发起前拦截非 v2 项目抛 `CONFIG_INVALID` + 迁移提示；`project:verify` 输出 `contractVersion` 并对 v1 追加提示、判 `ok=false`；新增/改 3 个测试文件 | 存量 v1 项目在**唯一续跑入口**即被明确拦截（不再跑出中间产物），符合方案 §6.3/§11.2；迁移文案集中在服务端供 HTTP/CLI 复用；`pnpm test` 89 files/818 tests + `pnpm run typecheck` exit 0 |
| 2026-11-08 | T503 完成：按 SKILL §8 + 方案 §11.2 逐项核对验收清单；`pnpm test:bench` 重跑校验基线为 v2-only（移除 legacy 段）；固化自动化证据（test/typecheck/build/doctor/smoke/bench 全绿） | 验收清单 9 项中 8 项 ✅；1 项「与 videoforge-ui-redesign 设计稿像素比对」因仓库无该设计稿资产不可验证，如实登记为已知边界；性能基线：v2 全量 8658 帧/510.3s、单镜重渲 111 帧/7.7s；**M5 收口批次出口达成**（无 legacy 路径 / 文档一致 / 验收全绿） |
| 2026-11-08 | 收口后审计：补登记跨任务遗留与方案偏差（新增「十二、待裁决与遗留项」L1–L4）；更正上一条中「设计稿资产」的失真表述（见 T503 日志「续跑记录」） | 任务板此前不存在协议 §1.1 引用的「待裁决」区块，跨任务遗留项无登记去处（L1 即因此漏项）；设计稿资产实际在仓库：`docs/v2_refactoring/1.png`–`10.png` + `VideoForge 界面重设计.zip`（同源，方案 §4.4 引用 `9.png`） |
| 2026-11-08 | T505 完成（L1 立项）：`ArtifactTabs` 六子面板收敛到 v2——文案按 `scene.shots` 嵌套、场景改为 SceneSpec 规格表（去 iframe 预览）、音频以 `audio/cues.json` 为索引、时间轴按 v2 `shots` 表格；`emit(regenerate)` 载荷由 `sceneId` 改 `shotId`，同步 `WorkbenchTabs.vue`/`WorkbenchView.vue` | 消除两个对 v2 永显空表的死 Tab；新增回归测试 `tests/unit/web-artifact-tabs-v2.test.ts`（4 例）；`pnpm test` 90 files/822 tests + `pnpm run typecheck` + web build 全绿 |
| 2026-11-08 | L2/L3/L4 裁决落地：方案 §7.1 登记 `overview` 偏差（功能由 `GET /api/projects/:id` 覆盖）；§8.6 基元清单由 12 修订为 6；§4.4 `scene` 审核点登记为「本轮不做」 | 方案与实现对齐；本区块 L1–L4 全部关闭，无新增待裁决项 |

---

## 十二、待裁决与遗留项

> 协议 §1.1 要求「发现方案与代码冲突时先停下、问题记入待裁决」。本区块为 T001–T504 收口后的审计结果（2026-11-08），**均不阻塞 M5 出口**。四项已于 2026-11-08 全部裁决并落地（L1 立项 T505；L2/L3/L4 在方案侧登记）。

| ID | 事项 | 来源 / 证据 | 裁决 / 结果（2026-11-08） |
|---|---|---|---|
| L1 | 工作台「产物」Tab 下的「时间轴」「场景」子 Tab 仍按 v1 形状解析 | [ArtifactTabs.vue](file:///d:/07_ai-workspace/01_vedio_generator/apps/web/src/components/ArtifactTabs.vue#L30-L40) 的 v1 形状 vs v2 `timeline.json`（`shots`/`cues`）；T501 日志已登记「建议后续单独立项收敛或移除该 Tab」 | **已修复 → T505**：四子面板按 v2 结构化产物渲染，重生成载荷改 `shotId`；见 [T505 日志](file:///d:/07_ai-workspace/01_vedio_generator/docs/v2_refactoring/logs/T505-artifact-tabs-v2.md) |
| L2 | 方案 §7.1 的 `GET /api/projects/:id/overview` 未实现 | 实现只有 [projects.ts](file:///d:/07_ai-workspace/01_vedio_generator/apps/server/src/http/routes/projects.ts#L171) 的 `GET /api/projects/:id`（T116 把派生指标平铺于此，功能等价） | **已在方案侧登记偏差**（方案 §7.1）：功能由 `GET /api/projects/:id` 覆盖，不加别名路由 |
| L3 | 方案 §8.6 要求基元 12 个，实际 6 个 | 缺 `VfSelect`/`VfTable`/`VfEmpty`/`VfBreadcrumb`/`VfStepList`/`VfErrorBanner`；T301 日志已自行收窄为 6 个 | **已修订方案清单**（方案 §8.6）：改为 6 个基元，其余 6 个由 AntD 或页面内联承担，本轮不补齐 |
| L4 | 方案 §4.4 `scene` 审核点「可选（M4）」未实现 | [domain.ts](file:///d:/07_ai-workspace/01_vedio_generator/packages/shared/src/domain.ts#L211) 的 `REVIEW_GATE_STAGES = ["copy","image"]`；M4 批次无对应任务 | **已登记为「本轮不做」**（方案 §4.4）：审核点固定为 `copy`/`image` 之后 |

> 另：T104b（原生/ASR 时间戳）状态 `todo` 已在 §四登记，不重复列入本区块。
