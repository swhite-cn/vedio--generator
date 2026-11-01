import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStatusReport } from "../../apps/cli/src/status";

/** 仓库根目录（测试从仓库根运行，`config/default.yaml` 在此可见）。 */
const ROOT_DIR = resolve(process.cwd());

describe("status.buildStatusReport（§3.5 服务状态，纯注入不打真网络/磁盘）", () => {
  it("server 在线且统计正常时 hints 为空", async () => {
    const report = await buildStatusReport(ROOT_DIR, {
      probeHealth: async () => true,
      probePort: async () => true,
      freeDiskGb: () => 128.5,
      collectActivity: () => ({ activeRuns: 2, sessions: 5 }),
    });
    expect(report.serverOnline).toBe(true);
    expect(report.activity).toEqual({ activeRuns: 2, sessions: 5 });
    expect(report.freeDiskGb).toBe(128.5);
    expect(report.hints).toEqual([]);
  });

  it("server 离线时降级提示且不抛错", async () => {
    const report = await buildStatusReport(ROOT_DIR, {
      probeHealth: async () => false,
      probePort: async () => false,
      freeDiskGb: () => 64,
      collectActivity: () => ({ activeRuns: 0, sessions: 1 }),
    });
    expect(report.serverOnline).toBe(false);
    expect(report.hints.some((hint) => hint.includes("/health"))).toBe(true);
  });

  it("DB 未初始化（activity 为 null）时提示 db:migrate", async () => {
    const report = await buildStatusReport(ROOT_DIR, {
      probeHealth: async () => true,
      probePort: async () => true,
      freeDiskGb: () => 64,
      collectActivity: () => null,
    });
    expect(report.activity).toBeNull();
    expect(report.hints.some((hint) => hint.includes("db:migrate"))).toBe(true);
  });

  it("端口被占用且 server 离线时提示端口占用", async () => {
    const report = await buildStatusReport(ROOT_DIR, {
      probeHealth: async () => false,
      probePort: async () => true,
      freeDiskGb: () => 64,
      collectActivity: () => ({ activeRuns: 0, sessions: 0 }),
    });
    expect(report.portInUse).toBe(true);
    expect(report.hints.some((hint) => hint.includes(`端口 ${report.port} 被其它进程占用`))).toBe(
      true,
    );
  });
});
