# T308 任务日志：分镜编辑器

## 元信息
- 任务 ID：T308
- 状态：done
- 开始时间：2026-11-08 07:13
- 结束时间：2026-11-08 07:14
- 关联设计：方案 §8.5 分镜编辑器；Web 专题 §5.5/§7.2
- 依赖任务：T306、T208（Player）、T114（PATCH）、T115（单镜重生成）
- 后续任务：T404
- 变更文件：
  - apps/web/src/views/StoryboardEditorView.vue
  - apps/web/src/stores/storyboard.ts
  - apps/web/src/router.ts
  - tests/unit/web-m3-pages.test.ts

## 意图
提供分镜级可视化编辑与单镜重生成入口，让「可逆编辑 + 只重跑目标镜头」在 UI 上可用。

## 改动
- `StoryboardEditorView.vue` 新增三栏布局：
  - 场景栏：按场景分组列出镜头；点击选中。
  - 画布 + 镜头条 + 三轨：画面轨（`storyboard.spans`）、字幕轨（`data.cues`，narration/animation 两类）、BGM 占位轨。
  - Inspector（292px）：口播只读、cue、屏上文字、强调词、组件、素材绑定、风格锚、转场、主题 token 色板、重生成阶段 checkbox、预览动效。
  - 键盘 ← → 切换镜头；`patchShot()` 走 `PATCH /api/projects/:id/shots/:shotId`（changes 体），成功后 `storyboard.refresh()`。
  - `regenerate()` 走 `POST /api/projects/:id/shots/:shotId/regenerate {stages}`，随后跳 `/projects/:id/runs/:runId`。
  - 响应式：<1280 Inspector 移到画布下方，<768 单列。
- `router.ts` 新增 `/projects/:id/storyboard`。
- 未做：不做拖拽时间轴；不内嵌 Player iframe 的完整交互（T208 的渲染能力按需后续接入）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/web-m3-pages.test.ts` | pass | 保存屏上文字 + 单镜重生成跳转 1 例 |
| `pnpm run typecheck` | pass | — |
| 浏览器目检 1440×900 / 390×844 | pass | `t313-storyboard-1440x900.png` / `t313-storyboard-390x844.png`（空态 + 键盘提示），无横向滚动 |

## 断点 / 未完成
- 未完成项：无。
- 已知风险：当前样例项目没有 v2 分镜，目检只覆盖空态；有分镜项目需在 T404/T401 时补一次满数据目检。

## 风险与后续
- 风险：Inspector 字段与 copy v2 契约强绑定，契约演进需同步表单。
- 下一步任务：T309。
