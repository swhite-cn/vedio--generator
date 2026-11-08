import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import type { TimelineDocV2, ShotSpec, ThemeV2 } from "@videoforge/shared";
import { resolveRemotionTheme, type RemotionTheme } from "./theme.js";
import { buildShotFramePlan, selectShotPlans } from "./frames.js";
import { ComponentShotVisual } from "./components/index.js";

/**
 * Remotion 主 Composition（T201 骨架）。
 * 设计约束（方案 §4.2 模板层）：
 * - 只消费契约对象（timeline v2 + 主题 + SceneSpec），不做内容决策；
 * - 组件实现留插槽：T202 填 3 类高频组件、T203 填其余 4 类；当前未知视觉类型渲染占位层，
 *   保证"契约可出帧"先于组件齐备；
 * - 字幕不在此渲染（ASS 烧录由 compose 层负责，见方案 §7.4/T205）。
 */

/** Composition 的可序列化输入 props（Remotion inputProps 约束：不能含函数；type alias 以满足泛型约束）。 */
export type ShotsCompositionProps = {
  /** 输出 Profile 帧率。 */
  fps: number;
  /** 主题（原样透传，组件内部 resolveRemotionTheme）。 */
  theme: ThemeV2;
  /** timeline v2（镜头切点与 fps 权威来源）。 */
  timeline: TimelineDocV2;
  /** SceneSpec 镜头规格（组件参数/资产引用）；scene 阶段未跑时为空。 */
  specShots?: ShotSpec[] | null;
  /** 限定渲染的镜头 ID（镜头级重渲）；缺省全部。 */
  shotIds?: string[] | null;
  /** 镜头 ID → publicDir 内图片相对路径（POSIX）；image 视觉层的真实图片映射（T204）。 */
  imageByShot?: Record<string, string> | null;
};

/** 根据 inputProps 动态计算 Composition 元数据（registerRoot 用）。 */
export function calculateShotsMetadata(props: ShotsCompositionProps) {
  const theme = resolveRemotionTheme(props.theme);
  const plan = buildShotFramePlan(props.timeline);
  const lastShot = plan[plan.length - 1];
  const tailPauseFrames = Math.floor((props.timeline.tailPauseMs * props.timeline.fps) / 1000);
  return {
    width: theme.width,
    height: theme.height,
    fps: props.timeline.fps,
    durationInFrames: lastShot ? lastShot.fromFrame + lastShot.durationInFrames + tailPauseFrames : 1,
  };
}

/** 单个镜头的视觉层：按 visualType 分发；组件走注册表 React 实现，image 消费 imageByShot 映射。 */
function ShotVisualLayer({
  spec,
  theme,
  imagePath,
}: {
  spec: ShotSpec | undefined;
  theme: RemotionTheme;
  /** 当前镜头的真实图片相对路径（publicDir 内）；缺省无映射。 */
  imagePath?: string;
}) {
  if (!spec) {
    // scene 阶段未跑：仅背景色，保证时间轴可出帧
    return <AbsoluteFill style={{ backgroundColor: theme.background }} />;
  }
  if (spec.visualType === "image") {
    // 真实路径优先（publicDir 由 bundle 挂载，相对路径解析为 serveUrl 根下的静态文件）；
    // 无映射时回退 assetId 占位，保证"缺资产可定位"而非渲染失败
    const src = imagePath ?? spec.assetRefs[0]?.assetId;
    return (
      <AbsoluteFill style={{ backgroundColor: theme.background }}>
        {src ? (
          <img
            src={src}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : null}
      </AbsoluteFill>
    );
  }
  if (spec.visualType === "component") {
    // 组件镜头：T202 起走注册表分发的 React 实现（数据组件来源标签由组件层叠加，T402）
    return <ComponentShotVisual spec={spec} theme={theme} />;
  }
  // symbol / video：T203 填真实实现，当前渲染占位层
  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.background,
        color: theme.color,
        fontFamily: theme.fontFamily,
        padding: theme.safePaddingPx,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: theme.bodySizePx * 0.5,
      }}
    >
      <div style={{ fontSize: theme.titleSizePx, fontWeight: 700 }}>{spec.visualType}</div>
      <div style={{ fontSize: theme.bodySizePx, opacity: 0.7 }}>
        {JSON.stringify(spec.props)}
      </div>
    </AbsoluteFill>
  );
}

/** 主 Composition：按 timeline 帧计划排布 Sequence。 */
export function ShotsComposition(props: ShotsCompositionProps) {
  const { fps } = useVideoConfig();
  const theme = resolveRemotionTheme(props.theme);
  const allPlans = buildShotFramePlan({ ...props.timeline, fps });
  const plans = selectShotPlans(allPlans, props.shotIds ?? undefined);
  const specByShot = new Map((props.specShots ?? []).map((shot) => [shot.shotId, shot]));

  return (
    <AbsoluteFill style={{ backgroundColor: theme.background }}>
      {plans.map((plan) => (
        <Sequence
          key={plan.shotId}
          from={plan.fromFrame}
          durationInFrames={plan.durationInFrames}
          name={`${plan.shotId}`}
        >
          <ShotVisualLayer
            spec={specByShot.get(plan.shotId)}
            theme={theme}
            imagePath={props.imageByShot?.[plan.shotId]}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
