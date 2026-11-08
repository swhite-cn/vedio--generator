import { z } from "zod";
import { Composition, registerRoot } from "remotion";
import {
  shotSpecSchema,
  themeSchema,
  timelineDocV2Schema,
} from "@videoforge/shared";
import {
  calculateShotsMetadata,
  ShotsComposition,
  type ShotsCompositionProps,
} from "./composition.js";

/** Remotion bundle 入口（registerRoot 约定）。Composition id 固定，渲染层按 id 选择。 */
export const SHOTS_COMPOSITION_ID = "shots-main";

/** inputProps schema：bundle 期即可校验渲染输入（Remotion schema 驱动约定）。 */
export const shotsCompositionPropsSchema = z.object({
  // 输出 Profile 帧率（timeline.fps 的冗余快照，供 calculateMetadata 快速读取）
  fps: z.number().positive(),
  // 主题（建议传项目快照内的冻结主题）
  theme: themeSchema,
  // timeline v2
  timeline: timelineDocV2Schema,
  // SceneSpec 镜头规格；scene 未跑时为 null
  specShots: z.array(shotSpecSchema).nullable(),
  // 限定渲染的镜头 ID；null 表示全部
  shotIds: z.array(z.string().min(1)).nullable(),
  // 镜头 ID → publicDir 内图片相对路径（image 视觉层真实图片）；null 表示无映射
  imageByShot: z.record(z.string(), z.string()).nullable(),
});

/** defaultProps：仅作 Remotion 静态声明，真实渲染一律由 calculateMetadata 按输入计算。
 * 经 schema.parse 得到输出型（default() 字段补齐），满足 Composition 泛型约束。 */
const PLACEHOLDER_PROPS = shotsCompositionPropsSchema.parse({
  fps: 30,
  theme: {
    id: "placeholder",
    name: "placeholder",
    frame: { width: 1920, height: 1080, safe_area: 0.06 },
    tokens: {
      text: "#EAECEF",
      background: "#101216",
      accent: "#E4B95B",
      font_family: "Noto Sans SC",
      title_size: 72,
      body_size: 40,
      caption: { size: 36, stroke: 0, bottom_ratio: 0.08, max_chars_per_line: 18 },
    },
    motion: { min_duration_ms: 300, max_duration_ms: 800 },
  },
  timeline: {
    contractVersion: "2.0",
    fps: 30,
    tailPauseMs: 0,
    timingSource: "estimated",
    totalMs: 100,
    // 契约要求 shots 非空：defaultProps 只作静态声明，占位 100ms 镜头
    shots: [
      { shotId: "placeholder", sceneId: "s0", startMs: 0, endMs: 100, durationMs: 100 },
    ],
    cues: [],
  },
  specShots: null,
  shotIds: null,
  imageByShot: null,
});

/** Remotion 根组件：声明唯一的镜头主 Composition，元数据由 inputProps 动态计算。 */
const RemotionRoot: React.FC = () => (
  <Composition<typeof shotsCompositionPropsSchema, ShotsCompositionProps>
    id={SHOTS_COMPOSITION_ID}
    component={ShotsComposition}
    schema={shotsCompositionPropsSchema}
    calculateMetadata={({ props }) => calculateShotsMetadata(props)}
    defaultProps={PLACEHOLDER_PROPS}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={1}
  />
);

registerRoot(RemotionRoot);
