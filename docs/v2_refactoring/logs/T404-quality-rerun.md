# T404 任务日志：质检失败定位与重跑

## 元信息
- 任务 ID：T404
- 状态：done
- 开始时间：2026-11-08 09:40
- 结束时间：2026-11-08 10:40
- 关联设计：方案 §7.4 质检 5 项与级别 / §8.6 Run 详情页
- 依赖任务：T207（质检门禁落盘 + `GET /api/projects/:id/quality`）、T307（Run 详情页）
- 后续任务：T405（管理 KPI 完善）
- 变更文件：
  - apps/web/src/views/RunDetailView.vue
  - tests/unit/web-m3-pages.test.ts

## 意图
T207 已把质检结论落盘并在 Run 详情页展示，但失败项与镜头脱节：用户看到「字幕溢出」却不知道是哪一镜、也无法只重跑那一镜。T115 已提供 `POST /api/projects/:id/shots/:shotId/regenerate`（stages ⊆ image/scene/tts/storyboard/render/compose）。本任务把「违规项 → 镜头 → 从可修复阶段重跑」串起来，复用既有接口，不新增 API。

## 改动
- `RunDetailView.vue`：
  - 新增 `RERUN_STAGES_BY_CHECK`：每个质检项固定一组可重跑阶段——`freeze → [render, compose]`；`subtitle-overflow → [tts, storyboard, render, compose]`；`source-label / animation-duration → [scene, render, compose]`；
  - `rerunStages(checkId)` 返回只读阶段数组，未知检查项返回空数组（不渲染按钮）；
  - `rerunShot(checkId, shotId)`：校验 `projectId` 与并发（`rerunningShot` 非空直接返回），POST 单镜重生成后 `message.success` 并跳转到新 run（`/projects/:id/runs/:runId`）；
  - 违规项行 `li.run-quality__violation` 改为 flex 两端布局，右侧渲染 `VfButton.run-quality__rerun`（`v-if="violation.shotId && rerunStages(check.id).length > 0"`），文案「重跑该镜 / 提交中…」；按钮 `min-height: 28px`、caption 字号，保证窄屏点击区域。
  - **对比度不提供单镜重跑**：`contrast` 是全局主题级问题（不落到具体 shot，其 violation 也无 `shotId`），继续只展示建议。
- `tests/unit/web-m3-pages.test.ts` 新增 `describe("RunDetailView（T404）")`：mock trace（stages 为空）+ quality（`subtitle-overflow` fail 带 `sh-002`、`contrast` warn 无 `shotId`），断言：
  - 仅渲染 1 个 `.run-quality__rerun`（无 `shotId` 的对比度不渲染按钮）；
  - 点击后 POST `/api/projects/p-1/shots/sh-002/regenerate` 且 body 为 `{ stages: ["tts","storyboard","render","compose"] }`；
  - 路由跳转到 `/projects/p-1/runs/run-9`。
- 明确没有做：不新增后端接口；不改质检门禁的拦截语义（T207 裁决「质检不拦 run」保持不变）；不做「批量重跑全部失败镜头」；不把 warning 级（freeze/contrast/animation-duration）升级为阻断。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/web-m3-pages.test.ts` | pass | 9 tests（新增 T404 1 例） |
| `pnpm test` | pass | 94 files / 848 tests |
| `pnpm run typecheck` | pass | 8 个 tsconfig |
| `pnpm run web:build` | pass | 3306 modules |
| 浏览器目检 1440×900 | pass | 4 条违规项；`rerunBtns=3`（对比度无 shotId 故无按钮）；行内文案「#sh-002 字幕长 22 字… 重跑该镜」 |
| 浏览器目检 390×844 | pass | `scrollWidth - innerWidth = 0`（无横向溢出）；按钮 `min-height: 28px`、实测 67×28 |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  - 阶段映射是**经验性最小集合**（如 freeze 只重跑 render/compose），若某类失败实际根因在更早阶段，重跑仍会再次失败；用户可改用页面顶部「从失败阶段重跑」整片重跑兜底。
  - 单镜重跑生成的是**新 run**，不覆盖原 run 的质检报告；对比新旧需人工看两次报告。
  - 目检使用临时 `quality/report.json` fixture 注入 `viedo-test` 项目以触发满数据展示；目检结束已删除该文件与空 `quality/` 目录，未留下伪造质检记录。

## 风险与后续
- 风险：若后续质检新增检查项，需同步维护 `RERUN_STAGES_BY_CHECK`；未登记项会安全降级为“不显示重跑按钮”（不会报错）。
- 下一步任务：T405。
