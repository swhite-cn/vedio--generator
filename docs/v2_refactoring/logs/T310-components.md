# T310 任务日志：组件库

## 元信息
- 任务 ID：T310
- 状态：done
- 开始时间：2026-11-08 07:15
- 结束时间：2026-11-08 07:16
- 关联设计：方案 §8.5 组件库；Web 专题 §5.5
- 依赖任务：T301、T117（组件/主题读取 API）
- 后续任务：T403
- 变更文件：
  - apps/web/src/views/ComponentsView.vue
  - apps/web/src/router.ts

## 意图
把「组件注册表」以只读目录形式暴露给使用者：能看 7 类组件的预览、参数与 fixture 状态，并知道新增组件的路径。

## 改动
- `ComponentsView.vue` 新增：
  - 先拉 `/api/components` 得到条目，再 `Promise.allSettled` 逐个拉取 preview 描述；失败的预览单独降级，不影响整页。
  - 卡片按类别固定顺序展示：预览区（成片令牌 `--film-*` 渲染）、名称/ID、`coverageNote`、fixture 状态、参数名（必填带 `*`）、动效名。
  - 末尾「新增组件」指引卡：说明在组件注册表追加条目、补 fixture 与预览，页面不提供在线编辑器。
- `router.ts` 接入 `/components`。
- 未做：不实现在线编辑/实时预览交互；预览静态帧由服务端目录提供。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/web-m3-pages.test.ts` | pass | 组件预览/参数/指引 1 例 |
| `pnpm run web:build` | pass | 3303 modules |
| 浏览器目检 1440×900 / 390×844 | pass | `t313-components-1440x900.png`（8 卡）/ `t313-components-390x844.png`（单列） |

## 断点 / 未完成
- 未完成项：无。
- 已知风险：预览请求逐条发（8 条），组件数量增长后需改批量接口。

## 风险与后续
- 风险：`coverageNote` 与组件注册表字段保持一致，缺失时卡片留白。
- 下一步任务：T311。
