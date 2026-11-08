# T306 任务日志：工作台 4 Tab + 项目资产

## 元信息
- 任务 ID：T306
- 状态：done
- 开始时间：2026-11-08 07:11
- 结束时间：2026-11-08 07:12
- 关联设计：方案 §8.5 工作台；Web 专题 §5.4/§5.5
- 依赖任务：T305、T113（storyboard 聚合 API）
- 后续任务：T308、T309
- 变更文件：
  - apps/web/src/components/WorkbenchTabs.vue
  - apps/web/src/stores/storyboard.ts
  - tests/unit/web-m3-pages.test.ts

## 意图
把工作台右栏拆成「阶段进度 / 分镜 / 项目资产 / 产物」四个可独立加载的 Tab，并用统一的 storyboard store 聚合分镜数据，避免各页面重复请求与解包。

## 改动
- `WorkbenchTabs.vue` 新增：
  - 四 Tab 切换；阶段 Tab 展示 8 阶段时间线与质检门禁（`refreshQuality`、`qualityTone`）。
  - 分镜 Tab 展示镜头缩略、cue 数与「打开分镜编辑器」入口。
  - 资产 Tab 展示项目资产并支持「引用资产」回填对话输入。
  - 产物 Tab 内嵌 `FinalOutputCard` 与 `ArtifactTabs`，并把 `regenerate` 事件透传给工作台。
  - 以 `storyboardRefreshToken` / `qualityRefreshToken` 触发强制重载（由 reducer 在 SSE 增量事件时自增）。
- `stores/storyboard.ts` 新增：`data/loading/error/projectId`、`shotsByScene/cuesByShot/themeTokens/styleAnchors/spans`、`load(id, force)`、`refresh()`、`reset()`。
- 未做：不把分镜编辑详情逻辑放进 Tab（留 T308）；不在前端合并/推导质量结论。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/web-m3-pages.test.ts` | pass | WorkbenchTabs 四 Tab/质检定位 2 例 |
| `pnpm run web:build` | pass | 3303 modules |
| 浏览器目检 1440×900 | pass | `t313-workbench-1440x900.png`（阶段 Tab 8 条 + 质检门禁） |

## 断点 / 未完成
- 未完成项：无。
- 已知风险：资产 Tab 与素材库页共用 `/assets` 数据，字段口径若变化需同步两处。

## 风险与后续
- 风险：刷新令牌机制依赖 reducer 事件分支，新增 SSE 类型时需同步补分支。
- 下一步任务：T308。
