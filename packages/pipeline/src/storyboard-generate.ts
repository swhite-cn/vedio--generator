import { dirname, join } from "node:path";
import { VideoForgeError, type OutputProfile } from "@videoforge/shared";
import { getProfile } from "@videoforge/template-sdk";
import { AUDIO_CUES_RELATIVE_PATH, readAudioCues } from "./audio-cues.js";
import { readCopyDocument } from "./copy-contract.js";
import { buildTimelineV2, writeTimelineV2 } from "./timeline-v2.js";

/** 片尾停顿毫秒；v2 暂用该常量，后续进配置。 */
const TAIL_PAUSE_MS = 500;

/**
 * storyboard:gen 阶段能力（v2）：消费 `audio/cues.json`，生成镜头级 timeline.json
 * （含 fps / 尾停顿 / cue）。
 * T501 起 legacy v1 场景级时间轴（ffprobe 实测场景时长）已随渲染通道移除。
 * 仅读取显式入参，不读写进程 argv/stdout。
 * @param options.rootDir 仓库根目录（保留入参兼容；v2 不再需要 ffprobe）
 * @param options.copyPath 输入 copy.json 路径（必须是 v2）
 * @param options.outFile timeline.json 输出路径
 * @param options.runId 运行 ID（--run-id）；缺省用 copy.json 所在目录名
 * @param options.profile 输出 Profile；用于取 fps，缺省横屏 1080p
 * @returns 输出路径与时间轴总时长（供调用方拼装 stdout JSON）
 * @throws VideoForgeError(`CONFIG_INVALID`) 项目仍是 v1（legacy 路径已移除）
 */
export async function generateStoryboard(options: {
  rootDir: string;
  copyPath: string;
  outFile: string;
  runId?: string;
  profile?: OutputProfile;
}): Promise<{ out: string; totalMs: number }> {
  const document = readCopyDocument(options.copyPath);
  // T501：legacy v1 时间轴路径已移除，仅支持 v2 项目
  if (document.version !== "2") {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "旧项目（copy.json 契约版本 1.0）不再支持时间轴生成：legacy 场景级时间轴与 Playwright 渲染通道已在 v2 重构中移除，请用当前版本新建项目重新生成。",
    );
  }
  const projectDir = dirname(options.copyPath);
  const audioPath = join(projectDir, AUDIO_CUES_RELATIVE_PATH);
  const audio = readAudioCues(audioPath);
  const shotIds = document.doc.scenes.flatMap((scene) => scene.shots.map((shot) => shot.shotId));
  const audioShotIds = audio.shots.map((shot) => shot.shotId);
  if (JSON.stringify(shotIds) !== JSON.stringify(audioShotIds)) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "audio/cues.json 的镜头与 copy.json 不一致；请重跑 tts_generate 生成最新 cue",
    );
  }

  const fps = getProfile(options.profile ?? "LANDSCAPE_1080P").fps;
  const timeline = buildTimelineV2({
    audio,
    fps,
    tailPauseMs: TAIL_PAUSE_MS,
  });
  writeTimelineV2(options.outFile, timeline);
  return { out: options.outFile, totalMs: timeline.totalMs };
}
