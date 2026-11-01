import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VideoForgeError } from "@videoforge/shared";

/**
 * 以参数数组启动子进程并收集 stdout；非 0 退出码抛 TOOL_UNAVAILABLE（诊断含 stderr 截断，不含敏感信息）。
 */
function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      rejectPromise(new VideoForgeError("TOOL_UNAVAILABLE", `${command} 启动失败：${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else {
        rejectPromise(
          new VideoForgeError(
            "TOOL_UNAVAILABLE",
            `${command} 退出码 ${code}：${stderr.slice(0, 300)}`,
          ),
        );
      }
    });
  });
}

/**
 * 用 ffprobe 读取媒体文件时长并返回毫秒；输出非法时抛 ADAPTER_FAILED。
 */
export async function probeDurationMs(ffprobePath: string, mediaPath: string): Promise<number> {
  const { stdout } = await runProcess(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    mediaPath,
  ]);
  let duration = Number.NaN;
  try {
    duration = Number.parseFloat(
      (JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration ?? "",
    );
  } catch {
    duration = Number.NaN;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new VideoForgeError("ADAPTER_FAILED", `ffprobe 无法读取时长：${mediaPath}`);
  }
  return Math.round(duration * 1000);
}

/**
 * 转义 ffmpeg concat 列表中的路径（统一正斜杠，单引号按 ffmpeg 规则转义）。
 */
function escapeConcatPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

/**
 * 用 ffmpeg concat demuxer 顺序拼接多个同格式音频为单文件，返回输出路径。
 */
export async function concatAudioFiles(options: {
  ffmpegPath: string;
  inputs: string[];
  outputPath: string;
  workDir: string;
}): Promise<string> {
  if (options.inputs.length === 0) {
    throw new VideoForgeError("CONFIG_INVALID", "concatAudioFiles 需要至少一个输入音频");
  }
  mkdirSync(options.workDir, { recursive: true });
  const listPath = join(options.workDir, "concat-list.txt");
  const listContent = options.inputs.map((p) => `file '${escapeConcatPath(p)}'`).join("\n");
  writeFileSync(listPath, listContent, "utf-8");
  await runProcess(options.ffmpegPath, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    options.outputPath,
  ]);
  return options.outputPath;
}
