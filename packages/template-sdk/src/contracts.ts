import type { OutputProfile } from "@videoforge/shared";

/** 最小场景输入契约。 */
export interface SceneData {
  sceneId: string;
  title: string;
  narration: string;
  /** 可选：场景图片的绝对路径；存在时模板将其渲染为全屏底图 */
  imagePath?: string;
  /** 可选：LLM 动画场景 HTML 的绝对路径（scene:gen 产物）；存在时渲染器走 GSAP 寻帧 */
  htmlPath?: string;
  /** 可选：底图的 data: URL（由渲染器从 imagePath 读入，避免 about:blank 拦截 file:// 子资源） */
  imageDataUrl?: string;
}

/** 模板渲染上下文。 */
export interface SceneContext {
  scene: SceneData;
  profile: OutputProfile;
  timeMs: number;
}

/** 输出 Profile 尺寸和安全区。 */
export interface ProfileSpec {
  profile: OutputProfile;
  width: number;
  height: number;
  fps: number;
  safeAreaRatio: number;
}

/**
 * 获取固定的横版或竖版输出规格。
 * @param profile 输出 Profile
 * @returns Profile 规格
 */
export function getProfile(profile: OutputProfile): ProfileSpec {
  return profile === "LANDSCAPE_1080P"
    ? { profile, width: 1920, height: 1080, fps: 30, safeAreaRatio: 0.9 }
    : { profile, width: 1080, height: 1920, fps: 30, safeAreaRatio: 0.9 };
}
