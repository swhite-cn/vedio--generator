# T401 任务日志：风格锚运营

## 元信息
- 任务 ID：T401
- 状态：done
- 开始时间：2026-11-08 08:40
- 结束时间：2026-11-08 08:55
- 关联设计：方案 §5.7 资产引用与风格锚 / §8.5 素材库 / §8.5 分镜 Inspector
- 依赖任务：T103（image 按 shot + 锚点复用）、T115（单镜重生成）
- 后续任务：T402（来源标签 + 文案结构）
- 变更文件：
  - apps/server/src/domain/style-anchor-edit.ts（新增）
  - apps/server/src/http/routes/style-anchors.ts（新增）
  - apps/server/src/http/index.ts
  - apps/server/src/db/repositories/asset-repository.ts
  - apps/web/src/components/StyleAnchorModal.vue（新增）
  - apps/web/src/views/AssetsView.vue
  - apps/web/src/stores/storyboard.ts
  - tests/unit/style-anchor-edit.test.ts（新增）
  - tests/integration/style-anchor-api.test.ts（新增）
  - tests/unit/web-m3-pages.test.ts
  - docs/v2_refactoring/screenshots/t401-anchor-modal-1440x900.png
  - docs/v2_refactoring/screenshots/t401-anchor-modal-390x844.png

## 意图
补齐方案 §5.7 中「一个符号一份资产 + 一个 seed」的运营入口：此前 image 阶段只会生成/复用锚点，没有 API 与 UI 去绑定已有资产、改 seed 或显式重建；T103 日志也明确把「显式重建锚点」留给了 T401。

## 改动
- 领域层 `style-anchor-edit.ts`：
  - `findStyleAnchor` / `anchorBoundShotIds`（按 copy 顺序实时计算引用镜头）；
  - `applyStyleAnchorPatch`：label/color/seed/assetId/assetPath 不可变补丁；seed 支持 null 清除、0–2147483646 校验；解绑同时清路径；
  - `applyStyleAnchorRebuild`：清空 assetId/assetPath（保留或覆盖 seed）；
  - `assertAnchorKeyPathSafe`：重建写文件前拒绝分隔符、上跳与非法字符，避免路径越界。
- 服务端路由 `style-anchors.ts`：
  - `PATCH /api/projects/:id/style-anchors/:key`：只能绑定本项目 `kind=image` 且 `image/*` 的资产；写回 copy v2；`agent_actions(reversible_edit)` + system 消息留痕；发布 `asset.bound`；返回 `{anchor, boundShotIds, action}`。
  - `POST /api/projects/:id/style-anchors/:key/rebuild`：先把 `images/anchors/<key>.png` 归档到 `images/history/`，再清空绑定；返回 `{anchor, boundShotIds, archived, nextStage:"image"}`；不删除用户上传资产。
- `asset-repository.ts` 新增 `updateProjectAssetMetadata`：合并写 `metadata_json`，绑定资产记录 `styleAnchorKey/anchorColor/generationSeed/boundShotIds`；换绑/解绑时清空旧资产对应字段。
- 前端 `StyleAnchorModal.vue` + 素材库入口：
  - 素材库「管理锚点」按钮从禁用占位改为真实入口；
  - 模态逐行展示锚点缩略/名称/key/色值，可编辑 seed、选择项目内图片资产、保存或显式重建；
  - 校验 seed 非负整数；成功后父页面重拉 assets + storyboard；窄屏（≤720px）单列堆叠。
- `storyboard` store 的锚点类型补 `color` 字段（服务端 copy v2 原样透传）。
- 明确没有做：不在 UI 生成新图片（重建只标记，下一次 image 阶段执行）；不改 `visual_category`（T118 的分类推断不在本任务）；不新增 SSE 事件类型，复用 `asset.bound`。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/style-anchor-edit.test.ts` | pass | 11 tests |
| `$env:VF_SMOKE='1'; pnpm exec vitest run tests/integration/style-anchor-api.test.ts` | pass | 4 tests（绑定/解绑/重建归档/403/非图片） |
| `pnpm exec vitest run tests/unit/web-m3-pages.test.ts` | pass | 8 tests（新增管理锚点 1 例） |
| `pnpm test` | pass | 92 files / 837 tests |
| `pnpm run typecheck` | pass | 8 个 tsconfig |
| `pnpm run web:build` | pass | 3306 modules |
| 浏览器目检 1440×900 / 390×844 | pass | 4 锚点渲染；绑定 `s1.png` + seed 21 保存成功（缩略图即时出现）；重建后 `assetId/assetPath` 清空、seed 保留；`scrollWidth == innerWidth` |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  - 真实 Ark 的 seed 是否严格可复现仍需 T503 端到端验证；当前以「同一资产复用 + 同一 seed」作为一致性保证。
  - 重建只归档缓存图，不会自动触发 image 阶段；需要用户随后发起 run 或单镜重生成。
  - `boundShotIds` 是 copy v2 实时计算的缓存，shot PATCH 改变 anchorKeys 后需下一次绑定/重建才刷新资产 metadata（展示口径仍以 copy 为准）。

## 风险与后续
- 风险：绑定资产被删除后锚点仍保留 `assetId/assetPath`，image 阶段会因路径缺失而重新生成；属可接受的降级。
- 目检说明：为验证满数据模态，临时替换了 `viedo-test` 项目的 `copy.json`（v2 fixture）并把 `timeline.json` 移出；目检结束后已原样恢复（备份文件已删除），未改动用户资产文件。
- 下一步任务：T402。
