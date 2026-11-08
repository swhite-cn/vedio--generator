# T118 任务日志：资产分类与绑定计数

## 元信息
- 任务 ID：T118
- 状态：done
- 开始时间：2026-11-07 10:20（跨会话续跑收尾）
- 结束时间：2026-11-07 10:40
- 关联设计：方案 §8.4 素材库（6 类筛选、"已绑定 N 镜头"由服务端计算，前端不推导）
- 依赖任务：T103（image 按镜头 + 锚点）、T005（`project_assets.visual_category` 迁移）
- 后续任务：T309（素材库页面）、T116（派生指标 `boundShotCount`）
- 变更文件：
  - `apps/server/src/domain/asset-binding.ts`（新增，纯逻辑）
  - `apps/server/src/http/routes/assets.ts`（扩展列表响应与筛选）
  - `tests/unit/asset-binding.test.ts`（新增，6 例）
  - `tests/integration/project-run-api.test.ts`（+1 例）

## 意图
素材库需要展示「已绑定 N 镜头」与 6 类分类筛选。绑定数属于领域推导，必须由服务端从 copy v2 计算，
前端只渲染；分类筛选在 API 层校验，非法值显式报错而不是静默返回空列表。

## 改动
- 新增 `asset-binding.ts`：
  - `parseVisualCategory(value)`：空值（undefined/null/空串）归一化为 `undefined`（不过滤）；
    合法值必须属于 `PROJECT_VISUAL_CATEGORIES` 6 类，否则报 `ASSET_INVALID` 并列出可选值；
  - `assetBindingCounts(projectDir)`：读 `copy.json`（`readCopyDocument` 判别版本），
    v1 项目或文件缺失返回 `{}`；v2 按 `styleAnchors[].assetId` + `scenes[].shots[].assetRefs[].assetId`
    逐引用累计，返回 `Record<assetId, count>`。
- 扩展 `GET /api/projects/:id/assets`：
  - 响应改为 `{ categories: PROJECT_VISUAL_CATEGORIES, items: [{...asset, boundShots}] }`；
    `boundShots` 来自 `assetBindingCounts`，未引用的资产为 0；
  - 查询参数新增 `visualCategory`，经 `parseVisualCategory` 校验后透传给 `listProjectAssets`；
  - 现有 `kind` / `source` 筛选与上传流程不变。
- 明确没有做：锚点资产自动归类为 `style-anchor` 分类（需上传/生成时指定，T309 处理）、
  `asset.bound` SSE 事件（T119）、绑定关系反向写入（copy 是唯一真相源）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm vitest run tests/unit/asset-binding.test.ts` | pass | 6 tests（分类 3 + 计数 3） |
| `$env:VF_SMOKE="1"; pnpm vitest run tests/integration/project-run-api.test.ts` | pass | 25 tests（含新增 `/assets` 1 例：分类枚举、boundShots=3/1、分类筛选、非法分类 400） |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过 |
| `pnpm test` | pass | 77 files / 651 tests |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  1. 绑定计数每次列表请求都重读 copy.json；项目镜头量大时是 O(shots) 文件读取，本地单机规模可接受，
     若后续成为热点可在 T116 派生指标中合并一次读取。
  2. 锚点资产按「引用次数」计数（同一锚点资产被多镜头引用会累加），与"已绑定 N 镜头"的口径一致；
     同一镜头同一资产重复引用（assetRefs 去重由契约保证非重复 role）暂未去重。
  3. `boundShots` 与数据库资产记录通过 assetId 字符串关联；copy 中引用了不存在资产记录的 ID 时不报错
     （计数只对存在的记录可见），T309 需要悬空引用提示时再补。

## 风险与后续
- 下一步任务：`T116` 服务端派生指标（shotCount/totalMs/progress/eta/boundShotCount），依赖 T106/T118 均已 done。
