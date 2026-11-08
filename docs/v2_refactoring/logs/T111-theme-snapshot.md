# T111 任务日志：主题加载与项目快照

## 元信息
- 任务 ID：T111
- 状态：done
- 开始时间：2026-11-07 08:50
- 结束时间：2026-11-07 08:58
- 关联设计：方案 §5.5 Theme、§9.4 项目目录、D5（主题创建时快照）
- 依赖任务：T007（设计令牌）、T005（DB 迁移，`projects.theme_id`）
- 后续任务：T105（字幕样式取主题）、T117（`/api/themes`）、T201（渲染主题解析）、T403（一致性验收）
- 变更文件：
  - `config/themes/documentary-dark/theme.yaml`（新增）
  - `packages/pipeline/src/theme.ts`（新增）
  - `packages/pipeline/src/index.ts`（导出）
  - `apps/server/src/http/routes/projects.ts`（创建入口可选 `themeId` + 写快照）
  - `tests/unit/theme-loader.test.ts`（新增，11 例）
  - `tests/integration/project-run-api.test.ts`（+2 例：快照写入、未知主题拒绝）

## 意图
把主题从"设计稿色板"落成可加载、可追溯的运行时资源：主题源文件放 `config/themes/<id>/theme.yaml`，
项目创建时解析成 `theme.resolved.json` 写入项目目录。快照一旦写入即冻结，后续改主题文件或项目切换主题
都不会改写历史项目的视觉语言（也不会改变镜头组件选型），保证历史项目可重建。

## 改动
- 新增 `config/themes/documentary-dark/theme.yaml`：按 `themeSchema` 展开 frame / tokens（含 caption）/ motion，YAML 每个叶子字段带用途与范围注释。
- 新增 `packages/pipeline/src/theme.ts`：
  - `loadTheme({ rootDir, themeId })`：读 `config/themes/<id>/theme.yaml`，`themeSchema` 校验，目录名必须等于 `theme.id`；缺失/YAML 非法/结构非法/ID 不一致统一报 `CONFIG_INVALID`。
  - `resolveThemeSnapshot(theme, now?)`：生成 `{ version:"1", themeId, resolvedAt, theme }` 快照。
  - `readThemeSnapshot` / `writeThemeSnapshot`：项目根目录 `theme.resolved.json` 读写；非法 JSON 或结构报 `ADAPTER_PROTOCOL_INVALID`。
  - `ensureThemeSnapshot(projectDir, theme, now?)`：已存在直接返回，不覆盖（冻结语义）。
- `projects.ts` 创建入口：`body.themeId` 可选；先 `loadTheme` 校验（未知主题 400 `CONFIG_INVALID`），再写 `projects.theme_id`；项目创建后写主题快照，失败仅告警不阻断创建（与 manifest 同策略）。
- 明确没有做：`GET /api/themes`（T117）、主题切换 API、组件选型逻辑（T110/T403）、像素级渲染主题注入（T201）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/theme-loader.test.ts tests/unit/project-manifest.test.ts` | pass | 2 files / 17 tests |
| `$env:VF_SMOKE="1"; pnpm exec vitest run tests/integration/project-run-api.test.ts` | pass | 16 tests（含新增 2 例） |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过 |
| `pnpm test` | pass | 71 files / 583 tests |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  1. 新项目默认 `contract_version=1.0` 且默认不设主题；`themeId` 目前只在创建请求体可选传入，尚未进入能力参数声明（待 T112 一并暴露给前端与默认 v2 项目）。
  2. 项目创建时若快照写入失败只告警，不会回滚项目；恢复方式是按 manifest 的 `themeId` 重新 `ensureThemeSnapshot`（T117/T401 可提供重建入口）。
  3. 主题切换语义当前为"冻结快照、需新项目或显式重建"，尚无 UI 表达，T403 验收时需确认该口径。
- 恢复时第一步：若需继续，从 T105（captions ASS 样式取主题）读 `theme.resolved.json` 开始。

## 风险与后续
- 风险：后续新增主题时容易忘记"目录名 = id"约定；已在加载器做硬校验并给明确报错。
- 下一步任务：`T105` captions ASS 生成（依赖 T104/T111），或 `T108` 组件注册表基础设施（与 T111 无依赖冲突，两条主线可并行推进）。
