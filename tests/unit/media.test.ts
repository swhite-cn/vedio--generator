import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { probeDurationMs } from "../../packages/pipeline/src/media";

/** 构造一个可按脚本输出 stdout 并以指定退出码结束的假子进程 */
function fakeProcess(stdout: string, code: number) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    proc.emit("close", code);
  });
  return proc;
}

describe("媒体工具", () => {
  afterEach(() => vi.mocked(spawn).mockReset());

  it("probeDurationMs 解析 ffprobe JSON 输出为毫秒", async () => {
    vi.mocked(spawn).mockReturnValue(fakeProcess('{"format":{"duration":"3.520000"}}', 0) as never);
    const dir = mkdtempSync(join(tmpdir(), "vf-media-"));
    try {
      const ms = await probeDurationMs("ffprobe", join(dir, "中文 音频.mp3"));
      expect(ms).toBe(3520);
      const args = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
      expect(args[0]).toBe("ffprobe");
      expect(args[1]).toContain("-show_entries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probeDurationMs 在输出非法时抛 ADAPTER_FAILED", async () => {
    vi.mocked(spawn).mockReturnValue(fakeProcess("{}", 0) as never);
    await expect(probeDurationMs("ffprobe", "a.mp3")).rejects.toThrowError(/ADAPTER_FAILED/);
  });

  it("probeDurationMs 在非 0 退出码时抛 TOOL_UNAVAILABLE", async () => {
    vi.mocked(spawn).mockReturnValue(fakeProcess("", 1) as never);
    await expect(probeDurationMs("ffprobe", "a.mp3")).rejects.toThrowError(/TOOL_UNAVAILABLE/);
  });
});
