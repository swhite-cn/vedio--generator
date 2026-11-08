# T309 任务日志：素材库

## 元信息
- 任务 ID：T309
- 状态：done
- 开始时间：2026-11-08 07:14
- 结束时间：2026-11-08 07:15
- 关联设计：方案 §8.5 素材库；Web 专题 §5.5
- 依赖任务：T306、T118（资产分类与绑定计数）
- 后续任务：T401
- 变更文件：
  - apps/web/src/views/AssetsView.vue
  - apps/web/src/stores/assets.ts
  - apps/web/src/router.ts
  - tests/unit/web-m3-pages.test.ts

## 意图
把素材库做成项目作用域的资产工作区：风格锚提示、6 类筛选、绑定计数与上传入口合一。

## 改动
- `AssetsView.vue` 新增：
  - 项目选择器（`?projectId=` 优先，否则首个项目）；切换后并行重载 assets 与 storyboard。
  - 风格锚 banner：展示 `storyboard.styleAnchors`，为空时提示 copy v2 未定义锚点。
  - 6 类筛选（all/ai-generated/live-action/archive-photo/3d-render/video-clip/style-anchor），计数来自 `/assets` 的 `categories` 与资产 `visualCategory`，接口缺字段时回落内置 6 类。
  - 卡片网格：缩略图、绑定镜头数（`boundShots`）、打开入口；上传后 `refresh()`。
- `stores/assets.ts`：`ProjectAsset` 增加 `visual_category?/boundShots?/run_id?/stage?`；store 增加 `categories`。
- `router.ts` 接入 `/assets`。
- 未做：不实现风格锚编辑（T401）；不在前端计算绑定归属。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/web-m3-pages.test.ts` | pass | 6 类筛选/绑定/风格锚 1 例 |
| `pnpm run typecheck` | pass | — |
| 浏览器目检 1440×900 / 390×844 | pass | `t313-assets-1440x900.png` / `t313-assets-390x844.png`，筛选条换行无横向滚动 |

## 断点 / 未完成
- 未完成项：无。
- 已知风险：当前项目无资产，目检只覆盖空态与筛选空态。

## 风险与后续
- 风险：分类键值以服务端 `categories` 为准，前端硬编码仅作兜底；新增分类需同步标签表。
- 下一步任务：T310。
