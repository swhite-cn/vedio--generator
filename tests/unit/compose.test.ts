import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { composeVideo } from "../../packages/pipeline/src/compose";

/** 构造一个以指定退出码结束的假子进程；stderr 内容按脚本输出 */
function fakeProcessExit(stderr: string, code: number) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", code);
  });
  return proc;
}

/** 构造一个触发 error 事件（模拟启动失败）的假子进程 */
function fakeProcessError(message: string) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  queueMicrotask(() => {
    proc.emit("error", new Error(message));
  });
  return proc;
}

/** 在临时目录中构造 composeVideo 参数，便于真实写 ffmpeg 日志 */
function makeOptions(dir: string) {
  return {
    ffmpegPath: "ffmpeg",
    framesPattern: join(dir, "frames", "%08d.png"),
    audioPath: join(dir, "voice-all.mp3"),
    outputPath: join(dir, "final.mp4"),
    fps: 30,
    logPath: join(dir, "ffmpeg.log"),
  };
}

describe("视频合成", () => {
  afterEach(() => vi.mocked(spawn).mockReset());

  it("成功时返回输出路径并把 ffmpeg 输出写入日志", async () => {
    vi.mocked(spawn).mockReturnValue(fakeProcessExit("frame= 100", 0) as never);
    const dir = mkdtempSync(join(tmpdir(), "vf-compose-"));
    try {
      const options = makeOptions(dir);
      const output = await composeVideo(options);
      expect(output).toBe(options.outputPath);
      expect(existsSync(options.logPath)).toBe(true);
      expect(readFileSync(options.logPath, "utf-8")).toContain("frame= 100");
      const args = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
      expect(args[0]).toBe("ffmpeg");
      expect(args[1]).toContain("-shortest");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("非 0 退出码时抛 TOOL_UNAVAILABLE 且保留诊断日志", async () => {
    vi.mocked(spawn).mockReturnValue(fakeProcessExit("boom", 2) as never);
    const dir = mkdtempSync(join(tmpdir(), "vf-compose-"));
    try {
      const options = makeOptions(dir);
      await expect(composeVideo(options)).rejects.toThrowError(/TOOL_UNAVAILABLE/);
      expect(readFileSync(options.logPath, "utf-8")).toContain("boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ffmpeg 启动失败时抛 TOOL_UNAVAILABLE", async () => {
    vi.mocked(spawn).mockReturnValue(fakeProcessError("spawn ffmpeg ENOENT") as never);
    const dir = mkdtempSync(join(tmpdir(), "vf-compose-"));
    try {
      await expect(composeVideo(makeOptions(dir))).rejects.toThrowError(/TOOL_UNAVAILABLE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("传入 BGM 时循环铺满并以 amix 混音、按 bgmVolume 压低音量", async () => {
    vi.mocked(spawn).mockReturnValue(fakeProcessExit("ok", 0) as never);
    const dir = mkdtempSync(join(tmpdir(), "vf-compose-"));
    try {
      const options = { ...makeOptions(dir), bgmPath: join(dir, "bgm.mp3"), bgmVolume: 0.15 };
      await composeVideo(options);
      const args = (vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]])[1];
      expect(args).toContain("-stream_loop");
      expect(args).toContain("-filter_complex");
      const filter = args[args.indexOf("-filter_complex") + 1]!;
      expect(filter).toContain("volume=0.15");
      expect(filter).toContain("amix=inputs=2:duration=first");
      expect(args).toContain("[aout]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bgmVolume 越界时抛 CONFIG_INVALID 且不启动 ffmpeg", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-compose-"));
    try {
      await expect(
        composeVideo({ ...makeOptions(dir), bgmPath: join(dir, "bgm.mp3"), bgmVolume: 2 }),
      ).rejects.toThrowError(/CONFIG_INVALID/);
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
