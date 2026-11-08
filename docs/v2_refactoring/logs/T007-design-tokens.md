# T007 任务日志：设计令牌与深色主题映射

## 元信息
- 任务 ID：T007
- 状态：done
- 开始时间：2026-11-03 23:55
- 结束时间：2026-11-04 00:00
- 关联设计：方案 §8.2 令牌与 AntD 映射、SKILL §1
- 依赖任务：T001
- 后续任务：T301
- 变更文件：
  - `apps/web/src/styles/tokens.css`
  - `apps/web/src/styles/theme.ts`
  - `tests/unit/web-design-tokens.test.ts`

## 意图
先把 SKILL §1 的令牌与 AntD 深色映射固化成唯一来源，后续 T301 重写 App Shell 时直接引用，避免页面里散落颜色与尺寸魔法值。

## 改动
- 新增 `tokens.css`：界面令牌 22 个、字体/字号/字重、圆角、4px 间距、描边、单层阴影、壳尺寸、动效、遮罩；成片主题色以 `--film-` 前缀隔离。
- 新增 `theme.ts`：`darkAlgorithm` + AntD token/组件级映射（Button/Card/Modal/Input/Select/Table/Menu/Tooltip）。
- 新增 5 个测试：令牌齐全、禁止 rgba/渐变、film 前缀隔离、壳尺寸与 1440×900 一致、AntD 映射实际可加载。

明确没有做：
- 没有在 `main.ts` 引入 `tokens.css`（避免 T301 前改变现有浅色页面）；
- 没有改 `App.vue` 主题（留给 T301）；
- 没有新增任何 UI 依赖。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/web-design-tokens.test.ts` | pass | 5 tests passed |
| `pnpm --filter @videoforge/web build` | pass | 3263 modules，构建成功 |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm --filter @videoforge/web build`
- 恢复时第一步：进入 T008
- 已知风险：
  - `tokens.css` 与 `theme.ts` 存在少量颜色镜像（AntD 算法不接受 CSS 变量主色）；已在注释中约定"先改 tokens.css 再同步 theme.ts"。
  - 令牌文件尚未被页面引用，构建产物 CSS 无变化；T301 接入后才生效。

## 风险与后续
- 风险：T301 若不删除旧 `global.css` 的浅色变量，会出现两套令牌并存；届时必须一次性切换。
- 下一步任务：T008 契约版本写入 manifest/trace。
