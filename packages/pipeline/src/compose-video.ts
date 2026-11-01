import { dirname, join } from "node:path";
import { VideoForgeError, type OutputProfile } from "@videoforge/shared";
import { getProfile } from "@videoforge/template-sdk";
import { composeVideo } from "./compose.js";
import { readCopyDoc } from "./copy-contract.js";
import { loadSystemConfig } from "./config.js";
import { concatAudioFiles } from "./media.js";

/**
 * compose 阶段能力：concat 拼接场景音频，再与帧序列合成最终 mp4。
 * 仅读取显式入参，不读写进程 argv/stdout。
 * @param options.rootDir 仓库根目录（用于加载配置获取 ffmpeg 路径）
 * @param options.copyPath 输入 copy.json 路径
 * @param options.outFile 最终 mp4 输出路径
 * @param options.profile 输出画幅（CLI 层已校验并填默认）
 * @param options.buildRoot 构建根目录；缺省用 copy.json 同级的 build 目录
 * @param options.bgm 背景音乐路径（--bgm）；缺省无 BGM
 * @param options.bgmVolume BGM 音量（--bgm-volume），取值 (0,1]；缺省由 composeVideo 兜底
 * @param options.runId 运行 ID（--run-id）；缺省用 copy.json 所在目录名
 * @returns 最终视频路径（供调用方拼装 stdout JSON）
 */
export async function composeVideoStep(options: {
  rootDir: string;
  copyPath: string;
  outFile: string;
  profile: OutputProfile;
  buildRoot?: string;
  bgm?: string;
  bgmVolume?: number;
  runId?: string;
}): Promise<string> {
  const out = options.outFile;
  const profile = options.profile;
  const profileDir = profile === "LANDSCAPE_1080P" ? "landscape" : "portrait";
  const doc = readCopyDoc(options.copyPath);
  const config = loadSystemConfig({ rootDir: options.rootDir });
  const buildRoot = options.buildRoot?.trim() || join(dirname(options.copyPath), "build");
  const composeDir = join(buildRoot, "compose", profileDir);
  const bgm = options.bgm?.trim() || undefined;
  const bgmVolume = options.bgmVolume;
  const inputs = doc.scenes.map((scene) => {
    if (!scene.audioPath) {
      throw new VideoForgeError(
        "CONFIG_INVALID",
        `场景 ${scene.sceneId} 缺少 audioPath，请先运行 tts:gen`,
      );
    }
    return scene.audioPath;
  });
  const audioAll = await concatAudioFiles({
    ffmpegPath: config.tools.ffmpeg_path,
    inputs,
    outputPath: join(composeDir, "voice-all.mp3"),
    workDir: composeDir,
  });
  return composeVideo({
    ffmpegPath: config.tools.ffmpeg_path,
    framesPattern: join(buildRoot, "render", profileDir, "frames", "%08d.jpg"),
    audioPath: audioAll,
    outputPath: out,
    fps: getProfile(profile).fps,
    logPath: join(composeDir, "ffmpeg.log"),
    bgmPath: bgm,
    bgmVolume,
  });
}
