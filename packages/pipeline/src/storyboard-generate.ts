import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { VideoForgeError } from "@videoforge/shared";
import { readCopyDoc } from "./copy-contract.js";
import { loadSystemConfig } from "./config.js";
import { probeDurationMs } from "./media.js";
import { buildTimeline } from "./timeline.js";

/**
 * storyboard:gen 阶段能力：用 ffprobe 实测各场景音频时长，生成 timeline.json（尾部停顿 500ms）。
 * 仅读取显式入参，不读写进程 argv/stdout。
 * @param options.rootDir 仓库根目录（用于加载配置获取 ffprobe 路径）
 * @param options.copyPath 输入 copy.json 路径
 * @param options.outFile timeline.json 输出路径
 * @param options.runId 运行 ID（--run-id）；缺省用 copy.json 所在目录名
 * @returns 输出路径与时间轴总时长（供调用方拼装 stdout JSON）
 */
export async function generateStoryboard(options: {
  rootDir: string;
  copyPath: string;
  outFile: string;
  runId?: string;
}): Promise<{ out: string; totalMs: number }> {
  const doc = readCopyDoc(options.copyPath);
  const config = loadSystemConfig({ rootDir: options.rootDir });
  const durations: Array<{ sceneId: string; durationMs: number }> = [];
  for (const scene of doc.scenes) {
    if (!scene.audioPath) {
      throw new VideoForgeError(
        "CONFIG_INVALID",
        `场景 ${scene.sceneId} 缺少 audioPath，请先运行 tts:gen`,
      );
    }
    durations.push({
      sceneId: scene.sceneId,
      durationMs: await probeDurationMs(config.tools.ffprobe_path, scene.audioPath),
    });
  }
  const timeline = buildTimeline(durations, 500);
  mkdirSync(dirname(options.outFile), { recursive: true });
  writeFileSync(options.outFile, JSON.stringify(timeline, null, 2), "utf-8");
  return { out: options.outFile, totalMs: timeline.totalMs };
}
