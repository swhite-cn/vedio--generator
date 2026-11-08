/**
 * Player postMessage 协议（T208，方案 §8.9）。
 * 消息类型（方案指定 5 条）：
 * - Player → 宿主：`player:ready`（bundle 加载并渲染成功）；
 * - 宿主 → Player：`player:seek`（timeMs 跳转）、`player:play`、`player:pause`、
 *   `player:shot`（切换预览镜头）。
 * 全部消息形如 `{ type: string, ...payload }`；未知类型静默忽略（协议向后兼容）。
 */

/** Player → 宿主：ready 握手。 */
export interface PlayerReadyMessage {
  type: "player:ready";
  /** 当前预览的镜头 ID；整片预览时为 null。 */
  shotId: string | null;
}

/** 宿主 → Player：跳转到指定毫秒。 */
export interface PlayerSeekMessage {
  type: "player:seek";
  timeMs: number;
}

/** 宿主 → Player：播放。 */
export interface PlayerPlayMessage {
  type: "player:play";
}

/** 宿主 → Player：暂停。 */
export interface PlayerPauseMessage {
  type: "player:pause";
}

/** 宿主 → Player：切换预览镜头。 */
export interface PlayerShotMessage {
  type: "player:shot";
  shotId: string;
}

/** 宿主 → Player 的全部命令。 */
export type PlayerCommand =
  | PlayerSeekMessage
  | PlayerPlayMessage
  | PlayerPauseMessage
  | PlayerShotMessage;

/** Player 控制器：把协议消息映射到播放器操作（便于单测，不依赖 DOM）。 */
export interface PlayerController {
  /** 跳转到指定毫秒。 */
  seek: (timeMs: number) => void;
  /** 开始播放。 */
  play: () => void;
  /** 暂停。 */
  pause: () => void;
  /** 切换预览镜头（返回新镜头 ID）。 */
  setShot: (shotId: string) => void;
}

/**
 * 构造协议消息处理器：校验类型与载荷，未知/畸形消息静默忽略。
 * @param controller 播放器操作集合
 * @returns 消息处理函数（直接接入 window message 监听）
 */
export function createPlayerMessageHandler(controller: PlayerController): (data: unknown) => void {
  return (data: unknown) => {
    if (typeof data !== "object" || data === null) return;
    const message = data as { type?: unknown };
    switch (message.type) {
      case "player:seek": {
        const timeMs = (data as { timeMs?: unknown }).timeMs;
        if (typeof timeMs === "number" && Number.isFinite(timeMs) && timeMs >= 0) {
          controller.seek(timeMs);
        }
        return;
      }
      case "player:play":
        controller.play();
        return;
      case "player:pause":
        controller.pause();
        return;
      case "player:shot": {
        const shotId = (data as { shotId?: unknown }).shotId;
        if (typeof shotId === "string" && shotId.trim().length > 0) {
          controller.setShot(shotId.trim());
        }
        return;
      }
      default:
        // 未知类型：协议向后兼容，静默忽略
        return;
    }
  };
}

/**
 * 构造 ready 握手消息。
 * @param shotId 当前预览镜头 ID；整片预览为 null
 * @returns ready 消息
 */
export function createReadyMessage(shotId: string | null): PlayerReadyMessage {
  return { type: "player:ready", shotId };
}
