# T103 任务日志：image 按 shot + 锚点复用

## 元信息
- 任务 ID：T103
- 状态：done
- 开始时间：2026-11-04 07:42
- 结束时间：2026-11-04 07:55
- 关联设计：方案 §5.7 资产引用与风格锚、§5.1 CopyDoc v2
- 依赖任务：T102
- 后续任务：T104
- 变更文件：
  - `packages/shared/src/contracts/common.ts`
  - `packages/shared/src/contracts/copy.ts`
  - `packages/pipeline/src/prompts.ts`
  - `config/prompts/default/copy-v2-system.txt`
  - `packages/pipeline/src/manifest.ts`
  - `packages/pipeline/src/ark-client.ts`
  - `packages/pipeline/src/image-generate.ts`
  - `apps/server/src/agent/tools/stage-tools.ts`
  - `tests/unit/image-generate-v2.test.ts`
  - `tests/unit/agent-stage-tools.test.ts`

## 意图
让 v2 的配图从"每场一张"下沉到"每镜一张"，并让同一风格锚在全片只生成一次、其余镜头直接复用同一资产与 seed，解决跨镜头风格漂移。

## 改动
- 契约补充（下游回填字段）：
  - shot：`anchorKeys[]`、`imagePath?`；
  - styleAnchor：`assetPath?`、`seed?`；
  - generation record：`shotId?`，版本链改为按 shot 建立。
- `arkGenerateImage` 支持可选 `seed`，并在请求体中透传。
- `generateImages` 双路径：
  - v1 原逻辑不变；
  - v2 逐 shot 生成，先生成被引用的风格锚（`images/anchors/<key>.png`），`symbol` 单锚镜头直接 `copyFile` 复用锚点，不再调用模型；
  - `shotIds` 定向重生成；`sceneIds` 仍按场景展开；
  - 每镜 seed 由 `shotId + anchorKeys` 稳定派生；
  - 生成记录写 `contractVersion=2.0`、`shotId`、`assetPath`。
- 新增纯函数 `stableSeed` / `buildShotImagePrompt`，便于单测。
- 阶段工具 `image_generate` 新增 `shotIds`，描述与摘要同时支持 v1/v2。

明确没有做：
- 没有做图像参考图（reference image）能力位，T103 只做 seed + 资产复用；
- 没有把锚点写入数据库资产表（T118）；
- 没有改 scene/tts 对 v2 的消费（后续任务）。

## 验证
| 命令 | 结果 | 证据 |
|---|---|---|
| `pnpm exec vitest run tests/unit/image-generate-v2.test.ts tests/unit/pipeline-image-scope.test.ts tests/unit/agent-stage-tools.test.ts tests/unit/pipeline-manifest.test.ts` | pass | 4 files / 50 tests passed |
| `pnpm run typecheck` | pass | 全仓通过 |

## 断点 / 未完成
- 未完成项：无
- 最后运行的命令：`pnpm run typecheck`
- 恢复时第一步：进入 T104
- 已知风险：
  - 风格锚在 `mode=all` 下也不会重新生成（只要文件存在）；这是为了保证全片一致，T401 需要提供"显式重建锚点"入口。
  - `symbol` 镜头直接复制锚点图，若该镜头需要额外背景，当前不会合成；渲染层需按 `anchorKeys` 叠加。
  - v2 的 `imagePath` 用项目内相对路径（v1 是绝对路径），下游渲染必须统一按项目目录解析。

## 风险与后续
- 风险：真实 Ark 对 `seed` 的支持需验证；不支持时会被忽略，一致性回退到资产复用。
- 下一步任务：T104 TTS 逐镜 + cue 时间戳。
