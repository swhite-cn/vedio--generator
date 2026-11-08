import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { VideoForgeError } from "@videoforge/shared";

/**
 * 使用参数数组调用 ffmpeg 合成帧序列、音频和最终 MP4。
 * 传入 bgmPath 时：BGM 循环铺满全片（-stream_loop -1），先按 bgmVolume 压低音量，
 * 再与旁白经 amix 混音（时长以旁白为准，-shortest 兜底与画面对齐）。
 * 传入 loudnessTarget 时：混音前对旁白做 loudnorm（单遍，响度目标 LUFS，TP 固定 -1.5、
 * LRA 固定 11），混音后 aresample 回 48kHz；无 BGM 时同样对旁白 loudnorm。
 * 传入 assPath 时：以 -vf ass=<相对路径> 烧录字幕，路径必须相对 cwd（避免 Windows
 * 盘符冒号在 filter 字符串中的转义问题），因此需要配合 cwd 使用。
 * 音频链末尾固定 apad 补静音：旁白/混音时长短于视频（如尾停顿）时以静音补齐，
 * 再由 -shortest 以视频长度收口。
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
  /** 响度目标（LUFS，范围 [-70, -5]）；缺省不做 loudnorm。 */
  loudnessTarget?: number;
  /** 字幕 ASS 相对路径（相对 cwd）；缺省不烧录。 */
  assPath?: string;
  /** ffmpeg 工作目录（ASS 相对路径的基准）；缺省继承进程 cwd。 */
  cwd?: string;
}): Promise<string> {
  const volume = options.bgmVolume ?? 0.2;
  if (options.bgmPath && (!Number.isFinite(volume) || volume <= 0 || volume > 1)) {
    throw new VideoForgeError("CONFIG_INVALID", `bgmVolume 必须在 (0, 1] 区间内，收到：${volume}`);
  }
  if (
    options.loudnessTarget !== undefined &&
    (!Number.isFinite(options.loudnessTarget) ||
      options.loudnessTarget < -70 ||
      options.loudnessTarget > -5)
  ) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `loudnessTarget 必须在 [-70, -5] LUFS 区间内，收到：${options.loudnessTarget}`,
    );
  }

  const args: string[] = [
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
  }

  // 音频滤镜链：loudnorm（可选）→ aresample（loudnorm 内部 192k 需回落）→ BGM 混音（可选）→ apad
  const voiceChain = options.loudnessTarget !== undefined
    ? `[1:a]loudnorm=I=${options.loudnessTarget}:TP=-1.5:LRA=11,aresample=48000[voice]`
    : "[1:a]anull[voice]";
  const filters: string[] = [voiceChain];
  if (options.bgmPath) {
    filters.push(`[2:a]volume=${volume}[bgm]`);
    filters.push(`[voice][bgm]amix=inputs=2:duration=first,apad[aout]`);
  } else {
    filters.push(`[voice]apad[aout]`);
  }
  args.push("-filter_complex", filters.join(";"), "-map", "0:v", "-map", "[aout]");

  if (options.assPath) {
    args.push("-vf", `ass=${options.assPath}`);
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
    const child = spawn(options.ffmpegPath, args, {
      windowsHide: true,
      cwd: options.cwd,
    });
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
