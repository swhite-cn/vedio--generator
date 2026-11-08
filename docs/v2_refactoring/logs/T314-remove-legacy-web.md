# T314 任务日志：删除旧视图与旧组件

## 元信息
- 任务 ID：T314
- 状态：done
- 开始时间：2026-11-08 07:21
- 结束时间：2026-11-08 07:24
- 关联设计：M3 出口判据（10 页与 SKILL §4 对应）
- 依赖任务：T313
- 后续任务：T401（M4）
- 变更文件：
  - apps/web/src/views/PlaceholderView.vue（删除）
  - apps/web/src/layouts/AppLayout.vue（删除）
  - apps/web/src/router.ts
  - apps/web/src/styles/global.css
  - tests/unit/web-ui-primitives.test.ts

## 意图
清掉 M3 重写后不再被引用的占位页与旧布局，避免两套壳/两套页面并存造成路由与样式歧义。

## 改动
- 删除 `PlaceholderView.vue`（T301 时期的 `/assets`、`/components` 占位页已被真实页面替换）。
- 删除 `AppLayout.vue`（旧布局壳；`AppShell.vue` 成为唯一布局）。
- `router.ts`：移除 `PlaceholderView` 导入与占位路由配置，10 个真实页面路由收敛。
- `global.css`：`color-scheme: dark`；`--vf-*` 变量全部映射到 `tokens.css`（canvas/surface/border/text/primary/success/warning/danger/radius/header/sider/mono）；body 使用 `--bg/--text`、13px/1.5；`:focus-visible` 使用 `--accent`。用于让尚未重写的小组件（`ArtifactTabs`/`ToolCallCard`/`MessageBubble` 等）统一进入暗色壳。
- `tests/unit/web-ui-primitives.test.ts`：删除 `PlaceholderView` 测试与 import。
- 说明：旧 7 个页面文件（Login/Capabilities/Projects/Workbench/RunTrace/Settings/Admin）在 T302–T312 已原位重写，不存在「旧页面文件」可删；本任务只清除不再引用的占位与旧布局。
- 未做：不删除仍被新页面引用的 `ArtifactTabs`/`MessageBubble`/`ToolGroup`/`ToolCallCard` 等组件。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/web-m3-pages.test.ts tests/unit/web-workbench-reducer.test.ts tests/unit/web-state-map.test.ts tests/unit/web-projects.test.ts tests/unit/web-ui-primitives.test.ts` | pass | 5 files / 94 tests |
| `pnpm test` | pass | 91 files / 825 tests |
| `pnpm run typecheck` | pass | 8 个 tsconfig |
| `pnpm run web:build` | pass | 3303 modules |

## 断点 / 未完成
- 未完成项：无。
- 已知风险：`global.css` 与 `tokens.css` 的双层变量映射在后续新增 token 时需成对维护。

## 风险与后续
- 风险：若仍有页面直接引用旧布局类名，样式会静默失效；由 build+目检覆盖。
- 下一步任务：T401（M4 风格锚运营）。
