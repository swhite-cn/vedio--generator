# T117 任务日志：组件/主题读取 API

## 元信息
- 任务 ID：T117
- 状态：done
- 开始时间：2026-11-07 10:46
- 结束时间：2026-11-07 10:50
- 关联设计：方案 §7.1（`GET /api/components`、`GET /api/components/:id/preview`、`GET /api/themes`、`GET /api/themes/:id`）、§8.4 组件库/新建项目
- 依赖任务：T108（组件注册表）、T111（主题加载器）
- 后续任务：T310（组件库页面）、T304（新建项目模态主题选择）、T311 之外的主题一致性验收 T403
- 变更文件：
  - `apps/server/src/http/routes/catalog.ts`（新增）
  - `apps/server/src/http/index.ts`（注册路由）
  - `packages/pipeline/src/theme.ts`（新增 `listThemes`）
  - `tests/integration/project-run-api.test.ts`（+1 例）

## 意图
组件库与新建项目需要只读目录数据：组件声明（含参数 schema、覆盖率说明、动效清单）、
组件预览 fixture、主题 token 列表。数据在运行期不变（随服务重启生效），响应带短缓存头，
前端可放心缓存。

## 改动
- 新增 `catalog.ts`（组件 + 主题四端点，均需鉴权）：
  - `GET /api/components` → `{ items: registry.list() }`（按注册顺序，含 `paramsSchema`/`coverageNote`/`animations`）；
  - `GET /api/components/:id/preview` → `{ fixture }`，复用 `readComponentPreviewFixture`
    （未登记 fixture / 文件缺失 / ID 不一致 / 参数非法分别报 `CONFIG_INVALID` 或 `ADAPTER_PROTOCOL_INVALID`）；
  - `GET /api/themes` → `{ items: listThemes(rootDir) }`；
  - `GET /api/themes/:id` → `{ theme }`，复用 `loadTheme`，未知主题报 `CONFIG_INVALID`（与项目创建同口径）；
  - 四端点统一 `Cache-Control: private, max-age=300`。
- `packages/pipeline/src/theme.ts` 新增 `listThemes(rootDir)`：扫描 `config/themes/<id>/theme.yaml`，
  逐个 `loadTheme`；单个主题非法时跳过并告警（坏主题不拖垮新建项目入口），按 ID 字典序返回。
- 明确没有做：组件预览静态帧（PNG 渲染，T208 播放器/Remotion 就绪后再补）、
  主题写入/切换端点（主题在创建时冻结，切换语义见 T111）、未登录访问（目录数据仍需鉴权）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `$env:VF_SMOKE="1"; pnpm vitest run tests/integration/project-run-api.test.ts` | pass | 27 tests（含新增目录 1 例：组件列表/预览/未知组件 400、主题列表/单读/未知主题 400、缓存头） |
| `pnpm run typecheck` | pass | 6 个 tsconfig 全通过 |
| `pnpm test` | pass | 78 files / 659 tests |

## 断点 / 未完成
- 未完成项：无（本任务范围内）。
- 已知风险：
  1. `listThemes` 对非法主题静默跳过，操作者需要看服务日志才能发现坏主题；CLI `doctor` 可在后续接入校验。
  2. 缓存头为提示性（本地 Fetch 客户端未必遵守）；前端 Pinia store 自行决定缓存时长（T310 处理）。
  3. 组件预览只回 fixture JSON，无视觉预览图；组件库页面的"所见即所得"依赖 T201/T208。

## 风险与后续
- 下一步任务：`T119` SSE 新事件（`shot.updated`/`quality.updated`/`asset.bound`/`preview.ready`），
  完成后 M1 数据面闭环收口（T004 能力切换单独立项）。
