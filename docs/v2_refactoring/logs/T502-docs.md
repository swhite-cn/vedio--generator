# T502 任务日志：文档与 AGENTS 更新

## 元信息
- 任务 ID：T502
- 状态：done
- 开始时间：2026-11-08 11:10
- 结束时间：2026-11-08 11:35
- 关联设计：方案 §10（M5 出口「文档一致」）、§3.2（推倒清单）
- 依赖任务：T501（删除 legacy renderer/template-sdk）
- 后续任务：T503（全量验收）、T504（旧项目迁移提示 + CLI 校验）
- 变更文件：
  - `AGENTS.md`（包目录清单）
  - `docs/guides/developer-guide.md`（技术组成 / 目录清单 / FAQ）
  - `docs/guides/operator-guide.md`（常见错误 / 当前限制）
  - `README.md`（架构图 / 目录清单 / 前置要求 / 安全须知 / 已知限制 / 路线图 / 致谢）
  - `README.en.md`（同上英文对应项）
  - `config/default.yaml`、`config/system.local.example.yaml`（`tools.chromium_path` 注释）

## 意图
T501 删除 legacy 渲染通道后，仓库级说明与使用指南仍把 `packages/renderer`（Playwright）、
`template-sdk` 的「场景契约 / GSAP」、`VF_RENDERER=legacy` 开关描述为可用能力。
本任务让 AGENTS 与开发/操作指南、README 与 v2-only 实现一致，兑现 M5「文档一致」出口判据。

## 改动
**包目录与架构图**
- `AGENTS.md`：把 `packages/renderer`（Playwright 连续帧）与 `packages/template-sdk`（场景契约 / GSAP）
  两行替换为 `packages/remotion-engine`（Remotion 渲染底座）与 `packages/template-sdk`（Profile + 组件注册表）；
  补 `apps/player` 一行。
- `README.md` / `README.en.md`：mermaid 架构图节点 `Renderer[packages/renderer]` + `SDK[场景契约/GSAP]`
  改为 `Engine[packages/remotion-engine]` + `SDK[Profile / 组件注册表]`；目录清单同步替换，并补 `apps/player`。
- `docs/guides/developer-guide.md`：技术组成表「媒体渲染」由 `Playwright、Chromium、...` 改为
  `Remotion、Chromium、...`；主要目录清单同步。

**legacy 开关与浏览器获取方式**
- `docs/guides/operator-guide.md`：常见错误表原「旧项目渲染报 `CONFIG_INVALID`（VF_RENDERER）」一行改为
  说明 legacy 通道已移除、契约版本 1.0 项目不可续跑；「当前限制」中「legacy 渲染通道需显式开启」一条
  改为「旧项目（契约版本 1.0）不可续跑」。
- `docs/guides/developer-guide.md` FAQ「Playwright 启动浏览器失败（`pnpm --filter @videoforge/renderer
  exec playwright install chromium`）」改为「Remotion 启动浏览器失败（用 `tools.chromium_path` 指定本机
  Chrome，留空由 Remotion 自动解析或下载 `chrome-headless-shell`）」。
- `README.md` / `README.en.md`：前置要求「Chromium 由 Playwright 管理」改为 Remotion 解析或下载，
  并指向 `tools.chromium_path`。
- `config/default.yaml` / `config/system.local.example.yaml`：`tools.chromium_path` 注释由「空值表示由
  Playwright 管理浏览器」改为「空值由 Remotion 自动解析或下载」。

**v1 不可续跑的用户可见提示**
- `README.md` / `README.en.md`：已知限制新增一条「契约版本 1.0 的旧项目不可续跑，需新建项目」。
- 安全须知：删除「生成场景会把 `gsap.min.js` 复制到项目 `vendor/`」（该行为随 template-sdk 重写已不存在）。
- 路线图：「子进程级强制取消（ffmpeg / Playwright 中断）」改为 `ffmpeg / Remotion`。
- 致谢：移除 Playwright / GSAP，补 Remotion。

**明确没有做**
- 未改写历史设计文档（`docs/本地视频流水线Agent-v2.md`、`docs/本地视频流水线搭建方案.md`、
  `docs/VideoForge差距分析.md`、`docs/superpowers/plans/*`）——它们是 v2 重构前的设计记录，
  当前设计真相是 `docs/v2_refactoring/VideoForge重构方案.md`（见「风险与后续」）。
- 未改 `CHANGELOG.md` 第 49 行的历史发布记录（描述当时版本的包拆分，属历史事实）。
- 未改任何生产代码；未改能力注册表（8 阶段切换属 T004）；未创建 Git commit。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `Grep "packages/renderer\|VF_RENDERER\|Playwright\|GSAP" --glob *.md` | pass | 命中的仅剩历史设计文档、CHANGELOG 与 v2_refactoring 方案/日志（均为历史或设计真相） |
| 人工核对 | pass | AGENTS 目录清单、开发指南技术组成/目录/FAQ、操作指南错误表/限制、README 中英架构图与清单均与 v2-only 实现一致 |

## 断点 / 未完成
- 未完成项：无（T502 范围内）。
- 最后运行的命令：`Grep`（断言无残留 legacy 描述）。
- 恢复时第一步：无需恢复；进入 T504（旧项目迁移提示 + CLI 校验），再跑 T503。
- 已知风险：见下。

## 风险与后续
- **历史设计文档仍描述 v1 渲染通道**：`docs/本地视频流水线Agent-v2.md`（AGENTS 列为「主文档」）、
  `docs/本地视频流水线搭建方案.md`、`docs/VideoForge差距分析.md`、`docs/superpowers/plans/*` 中的
  `packages/renderer` / Playwright / GSAP 描述属重构前记录；是否加「已被 v2 方案取代」横幅留待裁决，
  本任务未改写以免篡改历史证据。
- **生产代码内的 v1 措辞**（超出文档范围，未在 T502 修改）：
  - `apps/server/src/agent/prompt.ts` 系统提示仍写「`scenes/`：逐场景 HTML+GSAP 动画页面」；
  - `apps/server/src/http/routes/media.ts` 场景 HTML 预览注入脚本仍引用 `vendor/gsap.min.js`；
  - `apps/web/src/components/ArtifactTabs.vue` 的「场景」Tab 仍按 v1 场景 HTML 渲染。
  以上与 T501 日志记录的 ArtifactTabs「时间轴」Tab 属同一类遗留，建议随能力注册表 8 阶段切换（T004）
  一并收敛或单独立项。
- 下一步任务：T504（旧项目迁移提示 + CLI `project:verify` 覆盖 v2）。
