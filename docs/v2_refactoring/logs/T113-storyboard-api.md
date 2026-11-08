# T113 任务日志：storyboard 聚合读取 API

## 元信息
- 任务 ID：T113
- 状态：done
- 开始时间：2026-11-07 09:15
- 结束时间：2026-11-07 09:17
- 关联设计：方案 §8.4、§8 分镜编辑器；Web 专题 §8.3
- 依赖任务：T107（timeline v2）、T005（DB 列）、T109/T111（组件与主题）
- 后续任务：T114（镜头 PATCH）、T116（派生指标）、T301（前端路由）
- 变更文件：
  - `apps/server/src/http/routes/storyboard.ts`（新增）
  - `apps/server/src/http/index.ts`（注册路由）
  - `tests/integration/project-run-api.test.ts`（+2 例）

## 意图
给分镜编辑器与工作台提供一个一次性聚合读取入口，避免前端为 shots/cues/theme/assets/quality 发多轮请求。
只读、actor-first、缺产物返回 null/空数组，不在服务端推导状态或伪造数据。

## 改动
- 新增 `GET /api/projects/:id/storyboard`：
  - `project`：id/name/contractVersion/themeId/profile；
  - `copy`：v2 文档（v1 项目为 null）；`contractVersion` 由 copy 版本推导（v2 固定 `2.0`）；
  - `scenes`：章节分组（sceneId/chapterNo/title/shotIds）；
  - `shots`：copy v2 镜头扁平列表，附 `sceneId/chapterNo/sceneTitle`；
  - `cues`：`audio/cues.json` 的旁白 cue（缺失为空数组）；
  - `timeline`：timeline v2（缺失为 null）；
  - `theme`：`theme.resolved.json` 快照（缺失为 null）；
  - `spec`：`scenes/spec.json`（缺失为 null）；
  - `components`：内置组件注册表（只读视图数据）；
  - `assets`：actor 范围内该项目的资产列表；
  - `quality`：`quality/report.json`（缺失为 null）；
  - `subtitles`：字幕轨存在时返回相对路径。
- 未鉴权/非本人项目统一 `AUTH_FORBIDDEN`（不区分不存在与越权）。
- 明确没有做：镜头编辑（T114）、重生成（T115）、派生指标（T116）、组件/主题独立 API（T117）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `$env:VF_SMOKE="1"; pnpm exec vitest run tests/integration/project-run-api.test.ts` | pass | 18 tests（含新增 2 例） |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过 |
| `pnpm test` | pass | 75 files / 632 tests |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  1. 聚合接口一次读取多份产物，项目较大时响应体较大（shots + cues + timeline）；后续可按 `?sections=` 裁剪。
  2. copy v1 项目返回 `copy: null`、`shots: []`，前端需按 `contractVersion` 走旧的只读展示。
  3. 产物内容损坏会抛 `ADAPTER_PROTOCOL_INVALID`（500），这是有意暴露损坏而非静默返回空。
  4. `assets` 依赖 DB 同步结果，未调用 `syncGeneratedProjectAssets`（与 `/assets` 路由不同），因此刚生成的产物可能未出现在列表；T118 统一同步策略。
- 恢复时第一步：进入 T114，设计镜头 PATCH 与 `agent_actions` 可逆编辑。

## 风险与后续
- 风险：响应字段较多，前端接入时应以 `contractVersion` 与 `spec` 是否存在做分支，而不是根据字段推断阶段。
- 下一步任务：`T114` 镜头 PATCH API（依赖 T113）。
