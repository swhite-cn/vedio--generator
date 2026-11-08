# T505 任务日志：产物面板收敛到 v2（收口后审计 L1）

## 元信息
- 任务 ID：T505
- 状态：done
- 开始时间：2026-11-08 13:10
- 结束时间：2026-11-08 13:40
- 关联设计：方案 §8.5、Web 专题 §5.4.4
- 依赖任务：T503（收口后审计发现 L1）
- 后续任务：无（M5 出口已达成）
- 变更文件：
  - `apps/web/src/components/ArtifactTabs.vue`
  - `apps/web/src/components/WorkbenchTabs.vue`
  - `apps/web/src/views/WorkbenchView.vue`
  - `tests/unit/web-artifact-tabs-v2.test.ts`（新增）

## 意图
收口后审计（2026-11-08）在任务板「十二、待裁决与遗留项」登记 L1：工作台「产物」Tab 下的「时间轴」「场景」子 Tab 仍按 v1 形状解析。T501 删除 legacy 渲染通道后，v2 项目已不再产出 v1 的 `timeline.entries` 与场景 HTML，这两个子 Tab 对任何 v2 项目都永远显示空表/空预览，属死 Tab。本任务把产物面板整体收敛到契约 v2，消除死 Tab。

## 改动
- `ArtifactTabs.vue`（重写数据层与模板）：
  - 接口由 v1 改为 v2——`CopyDoc`（`scenes[].shots[]` 嵌套）、`TimelineDoc`（`shots`/`cues`）、`SceneSpecDoc`（`shots[]` 规格）、`AudioCuesDoc`（`shots[]` 音频切点）。
  - 文案 Tab：章节 → 镜头嵌套列表（`scene.shots`），展示 `shotId` + 口播。
  - 场景 Tab：由 iframe 预览改为 `a-table` 规格表（视觉类型/组件/转场 入→出/动效数 + 重生成按钮）；v2 无 HTML 场景产物，无处可预览。
  - 音频 Tab：以 `audio/cues.json` 的镜头切点为索引（`shotId` + 音频地址 + 实测时长）。
  - 时间轴 Tab：按 v2 `timeline.json` 渲染 `shots` 表格 + 概要行（总时长/帧率/时间戳来源/旁白 cue 数）。
  - 新增中文枚举映射（`timingSource`/`visualType`/`transition`）与通用 `labelOf()`。
  - `emit("regenerate")` 载荷由 `{stage, sceneId}` 改为 `{stage, shotId}`（v2 产物按镜头粒度归属）。
  - 新增 `fetchDoc()` 辅助与 `copyDoc`/`sceneDoc`/`audioDoc`/`timelineDoc` 四个 ref，`loadDocs()` 统一拉取。
  - 删除：iframe 场景预览弹窗及其缩放/观察者逻辑、`onAudioMetadata`、`.scene-list`/`.scene-preview*` 样式、`PlayCircleOutlined` 等不再使用的导入。
- `WorkbenchTabs.vue`：`regenerate` emit 载荷类型 `sceneId` → `shotId`。
- `WorkbenchView.vue`：`prefillRegeneration` 参数类型与草稿文案改为按 `shotId`。
- 明确没有做：不改变服务端接口；不新增基元；未处理 `image` Tab 的生成信息弹层逻辑（保持原状）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/web-artifact-tabs-v2.test.ts` | pass | 4 passed（文案嵌套 / 场景规格表 / 时间轴概要 / 音频镜头级重生成） |
| `pnpm test` | pass | 90 files / 822 tests |
| `pnpm run typecheck` | pass | 7 个 tsconfig 全过 |
| `pnpm build` | pass | 8 个 workspace 项目全过 |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm test` / `pnpm run typecheck` / `pnpm build`
- 恢复时第一步：无需恢复
- 已知风险：jsdom 下 AntD Table 触发 `window.getComputedStyle` 未实现告警（测试仍在测试内注入 `matchMedia` 替身，断言通过；该告警为 jsdom 能力缺口，不影响结果）。

## 风险与后续
- 风险：产物面板不再提供场景 HTML 预览（v2 已无该产物）；如需可视化预览，走分镜编辑器 / Player iframe。
- 下一步任务：无。任务板「十二、待裁决与遗留项」L1–L4 全部关闭。
