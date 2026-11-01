import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { VideoForgeError } from "@videoforge/shared";

/**
 * 使用参数数组调用 ffmpeg 合成帧序列、音频和最终 MP4。
 * 传入 bgmPath 时：BGM 循环铺满全片（-stream_loop -1），先按 bgmVolume 压低音量，
 * 再与旁白经 amix 混音（时长以旁白为准，-shortest 兜底与画面对齐）。
 * 启动失败或退出码非 0 时抛 TOOL_UNAVAILABLE，完整 ffmpeg 输出写入 logPath。
 * @param options 合成参数
 * @returns 输出视频路径
 */
export async function composeVideo(options: {
  ffmpegPath: string;
  framesPattern: string;
  audioPath: string;
  outputPath: string;
  fps: number;
  logPath: string;
  bgmPath?: string;
  bgmVolume?: number;
}): Promise<string> {
  const volume = options.bgmVolume ?? 0.2;
  if (options.bgmPath && (!Number.isFinite(volume) || volume <= 0 || volume > 1)) {
    throw new VideoForgeError("CONFIG_INVALID", `bgmVolume 必须在 (0, 1] 区间内，收到：${volume}`);
  }
  const args = [
    "-y",
    "-framerate",
    String(options.fps),
    "-i",
    options.framesPattern,
    "-i",
    options.audioPath,
  ];
  if (options.bgmPath) {
    args.push("-stream_loop", "-1", "-i", options.bgmPath);
    args.push(
      "-filter_complex",
      `[2:a]volume=${volume}[bgm];[1:a][bgm]amix=inputs=2:duration=first[aout]`,
      "-map",
      "0:v",
      "-map",
      "[aout]",
    );
  }
  args.push(
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    options.outputPath,
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      reject(new VideoForgeError("TOOL_UNAVAILABLE", `ffmpeg 启动失败：${err.message}`));
    });
    child.on("close", async (code) => {
      await writeFile(options.logPath, stderr, "utf8");
      if (code === 0) resolve();
      else {
        reject(
          new VideoForgeError(
            "TOOL_UNAVAILABLE",
            `ffmpeg 合成退出码 ${code}，诊断详见 ${options.logPath}`,
          ),
        );
      }
    });
  });
  console.info(`[compose] generated video: ${options.outputPath}`);
  return options.outputPath;
}
