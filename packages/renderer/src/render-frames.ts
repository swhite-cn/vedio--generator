import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { VideoForgeError, type OutputProfile } from "@videoforge/shared";
import { renderSceneSequence } from "./render-sequence.js";
import { loadSystemConfig, readCopyDoc } from "@videoforge/pipeline";

/** timeline.json 的最小结构契约（storyboard:gen 产物） */
const timelineSchema = z.object({
  entries: z
    .array(
      z.object({
        sceneId: z.string().min(1),
        startMs: z.number().nonnegative(),
        endMs: z.number().nonnegative(),
      }),
    )
    .min(1),
});

/** 读取并校验 timeline.json；解析失败或结构非法抛 ADAPTER_PROTOCOL_INVALID */
function readTimeline(path: string): z.infer<typeof timelineSchema> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `timeline.json 解析失败：${path}（${(err as Error).message}）`,
    );
  }
  const result = timelineSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `timeline.json 结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  return result.data;
}

/**
 * render 阶段能力：按时间轴逐场景渲染连续编号 JPEG 帧（workers 多 page 并行），
 * 输出统一帧目录与总帧数。仅读取显式入参，不读写进程 argv/stdout。
 * @param options.rootDir 仓库根目录（用于加载配置获取 Chromium 路径）
 * @param options.copyPath 输入 copy.json 路径
 * @param options.timelinePath 输入 timeline.json 路径
 * @param options.profile 输出画幅（CLI 层已校验并填默认）
 * @param options.buildRoot 构建根目录；缺省用 copy.json 同级的 build 目录
 * @param options.workers 并行 page 数（CLI 层已取默认 3）
 * @param options.runId 运行 ID（--run-id）；缺省用 copy.json 所在目录名
 * @returns 统一帧目录与总帧数（供调用方拼装 stdout JSON）
 */
export async function renderFrames(options: {
  rootDir: string;
  copyPath: string;
  timelinePath: string;
  profile: OutputProfile;
  buildRoot?: string;
  workers: number;
  runId?: string;
}): Promise<{ framesDir: string; frameCount: number }> {
  const profile = options.profile;
  const doc = readCopyDoc(options.copyPath);
  const timeline = readTimeline(options.timelinePath);
  const config = loadSystemConfig({ rootDir: options.rootDir });
  const buildRoot = options.buildRoot?.trim() || join(dirname(options.copyPath), "build");
  const workers = options.workers;
  const scenes = timeline.entries.map((entry) => {
    const scene = doc.scenes.find((s) => s.sceneId === entry.sceneId);
    if (!scene) {
      throw new VideoForgeError(
        "ADAPTER_PROTOCOL_INVALID",
        `timeline 引用了未知场景 ${entry.sceneId}`,
      );
    }
    return {
      scene: {
        sceneId: scene.sceneId,
        title: scene.title,
        narration: scene.narration,
        imagePath: scene.imagePath,
        htmlPath: scene.htmlPath,
      },
      durationMs: entry.endMs - entry.startMs,
    };
  });
  return renderSceneSequence({
    buildRoot,
    profile,
    scenes,
    chromiumPath: config.tools.chromium_path || undefined,
    workers,
  });
}
