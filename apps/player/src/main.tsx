import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Player, type PlayerRef } from "@remotion/player";
import { VideoForgeError } from "@videoforge/shared";
// 只导入浏览器安全的子路径（composition/slice/theme），
// 不经由 index（render/entry 引 node 依赖与 @remotion/bundler，不能进浏览器 bundle）
import { ShotsComposition } from "@videoforge/remotion-engine/composition";
import { calculateShotsMetadata } from "@videoforge/remotion-engine/composition";
import { sliceTimelineForShot } from "@videoforge/remotion-engine/slice";
import { createPlayerMessageHandler, createReadyMessage } from "./protocol.js";

/**
 * Player 应用入口（T208，方案 §8.9）。
 * - 渲染数据由服务端 HTML 入口内联到 `window.__PLAYER_DATA__`（同源，免二次鉴权）；
 * - 整片预览用全量 timeline；单镜头预览用 `sliceTimelineForShot` 平移切片；
 * - postMessage 协议：ready 握手 + seek/play/pause/shot 四类命令；
 * - 任何异常都收敛到错误态（错误码 + 诊断提示），不白屏。
 */

/** 服务端内联的渲染数据（`GET /api/player/:projectId/:shotId?` 写入）。 */
export interface PlayerData {
  /** 项目 ID。 */
  projectId: string;
  /** 初始预览镜头；缺省整片预览。 */
  shotId: string | null;
  /** 渲染输入（与 renderShots 同构）。 */
  timeline: Parameters<typeof sliceTimelineForShot>[0];
  theme: Parameters<typeof ShotsComposition>[0]["theme"];
  specShots: Parameters<typeof ShotsComposition>[0]["specShots"];
  imageByShot: Record<string, string> | null;
  /** 数据注入失败时的错误（服务端已尽量给出稳定错误码）。 */
  error?: { code: string; message: string };
}

/** 读取服务端内联数据；缺失或畸形返回 null（由调用方进入错误态）。 */
function readPlayerData(): PlayerData | null {
  const raw = (window as { __PLAYER_DATA__?: unknown }).__PLAYER_DATA__;
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as PlayerData;
  if (!data.timeline || !data.theme) return null;
  return data;
}

/** 错误态展示：错误码 + 诊断入口，保证 iframe 内永远有可见内容。 */
function PlayerError({ code, message }: { code: string; message: string }) {
  return (
    <div
      role="alert"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        fontFamily: "system-ui, sans-serif",
        color: "#EAECEF",
        backgroundColor: "#101216",
        padding: 24,
        boxSizing: "border-box",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 700 }}>预览加载失败</div>
      <div style={{ fontSize: 14, opacity: 0.8 }}>
        <code>{code}</code>: {message}
      </div>
      <div style={{ fontSize: 12, opacity: 0.6 }}>
        可在项目 run 详情页查看阶段日志，或运行 CLI 诊断命令定位。
      </div>
    </div>
  );
}

/** 错误边界：渲染异常收敛到错误态（不白屏）。 */
class PlayerBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <PlayerError code="PLAYER_RENDER_FAILED" message={this.state.error.message} />;
    }
    return this.props.children;
  }
}

/** 播放器主体：切片 + Remotion Player + postMessage 协议。 */
function PlayerApp({ data }: { data: PlayerData }) {
  const [shotId, setShotId] = useState<string | null>(data.shotId);
  const playerRef = useRef<PlayerRef>(null);

  // 单镜头模式：timeline 切片；镜头不存在时进入错误态（不白屏）
  const slice = useMemo(() => {
    try {
      return shotId
        ? sliceTimelineForShot(data.timeline, shotId, data.specShots ?? null)
        : null;
    } catch (error) {
      return { invalidShot: error as Error } as { invalidShot: Error };
    }
  }, [shotId, data.timeline, data.specShots]);

  // 非法镜头：错误态
  if (slice && "invalidShot" in slice) {
    const error = slice.invalidShot as VideoForgeError;
    return <PlayerError code={error.code ?? "CONFIG_INVALID"} message={error.message} />;
  }

  const timeline = slice ? slice.timeline : data.timeline;
  const specShots = slice
    ? slice.specShot
      ? [slice.specShot]
      : null
    : (data.specShots ?? null);
  const imageByShot = slice ? null : data.imageByShot;

  // postMessage：ready 握手 + 宿主命令
  useEffect(() => {
    window.parent.postMessage(createReadyMessage(shotId), "*");
    const handler = createPlayerMessageHandler({
      seek: (timeMs: number) => {
        const fps = timeline.fps;
        playerRef.current?.seekTo(Math.max(0, Math.floor((timeMs * fps) / 1000)));
      },
      play: () => playerRef.current?.play(),
      pause: () => playerRef.current?.pause(),
      setShot: (next: string) => setShotId(next),
    });
    const listener = (event: MessageEvent) => handler(event.data);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [shotId, timeline.fps]);

  const metadata = calculateShotsMetadata({
    fps: timeline.fps,
    theme: data.theme,
    timeline,
    specShots,
    shotIds: null,
    imageByShot,
  });

  return (
    <Player
      ref={playerRef}
      component={ShotsComposition}
      inputProps={{
        fps: timeline.fps,
        theme: data.theme,
        timeline,
        specShots,
        shotIds: null,
        imageByShot,
      }}
      durationInFrames={metadata.durationInFrames}
      compositionWidth={metadata.width}
      compositionHeight={metadata.height}
      fps={timeline.fps}
      style={{ width: "100%", height: "100%" }}
      controls
      acknowledgeRemotionLicense
    />
  );
}

/** 挂载入口：数据缺失/畸形/渲染异常全部收敛到错误态。 */
export function mountPlayer(container: HTMLElement): void {
  const data = readPlayerData();
  createRoot(container).render(
    <PlayerBoundary>
      {data ? (
        data.error ? (
          <PlayerError code={data.error.code} message={data.error.message} />
        ) : (
          <PlayerApp data={data} />
        )
      ) : (
        <PlayerError code="PLAYER_DATA_MISSING" message="页面缺少渲染数据（__PLAYER_DATA__）" />
      )}
    </PlayerBoundary>,
  );
}

// 浏览器入口：服务端 HTML 引用本 bundle 后自动挂载
const container = document.getElementById("root");
if (container) {
  mountPlayer(container);
}
