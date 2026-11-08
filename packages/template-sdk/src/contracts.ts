import type { OutputProfile } from "@videoforge/shared";

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
