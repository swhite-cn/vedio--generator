# T312 任务日志：全局搜索

## 元信息
- 任务 ID：T312
- 状态：done
- 开始时间：2026-11-08 07:18
- 结束时间：2026-11-08 07:19
- 关联设计：方案 §7.1（搜索）/ §8.5 顶栏；Web 专题 §5.2
- 依赖任务：T301（AppShell 顶栏）
- 后续任务：T313
- 变更文件：
  - apps/server/src/http/routes/search.ts
  - apps/server/src/http/index.ts
  - apps/web/src/layouts/AppShell.vue
  - tests/unit/web-m3-pages.test.ts
  - tests/integration/admin-api.test.ts

## 意图
把顶栏的搜索占位替换成真实可用的全局搜索，覆盖项目/素材/组件三类并支持键盘操作。

## 改动
- 服务端新增 `GET /api/search?q=`：
  - 空串直接返回 `{q:"",projects:[],assets:[],components:[]}`。
  - 项目按 name/topic 匹配；资产遍历当前 actor 项目再用 `listProjectAssets` 按 label 匹配；组件按 name/id 匹配。
  - 每类最多 8 条（`SEARCH_LIMIT`），只返回当前 actor 可见数据。
- `http/index.ts` 注册 search 路由（profile 之后、admin 之前）。
- `AppShell.vue`：
  - `searchText/searchResults/searchOpen/searchLoading/searchError/searchActiveIndex/searchBox`。
  - 250ms 去抖调用 `/api/search?q=`；结果扁平化为 `SearchHit`。
  - 键盘：Esc 关闭、↑/↓ 移动高亮、Enter 打开首条或高亮项；点击空白关闭（document click 监听，onMounted/onUnmounted 注册注销）。
  - 目标：projects → `/projects/:id`；assets → `/assets?projectId=`；components → `/components`。
- 未做：不建搜索索引；不做模糊排序（后端按命中顺序返回）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/web-m3-pages.test.ts` | pass | AppShell 搜索键盘 Enter 1 例 |
| `$env:VF_SMOKE='1'; pnpm exec vitest run tests/integration/admin-api.test.ts` | pass | 12 例（含搜索三类结果、空查询、跨用户隔离） |
| 浏览器目检 1440×900 | pass | `t313-search-panel-1440x900.png`；实测输入「数据」命中组件、Enter 跳 `/components` |

## 断点 / 未完成
- 未完成项：无。
- 已知风险：搜索触发请求频率由 250ms 去抖控制，无并发取消（旧请求可能先返回），当前用最后一次结果覆盖。

## 风险与后续
- 风险：资产搜索需遍历 actor 项目，项目量大时延迟上升（T503 可评估）。
- 下一步任务：T313。
