import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QUALITY_CHECK_IDS, qualityReportSchema } from "../../packages/shared/src/index";
import {
  QUALITY_CHECK_LABELS,
  QUALITY_REPORT_RELATIVE_PATH,
  buildQualityReport,
  createEmptyQualityReport,
  isBlockingFailure,
  readQualityReport,
  summarizeQualityReport,
  writeQualityReport,
} from "../../packages/pipeline/src/quality/index";

describe("质检报告骨架", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  /** 创建临时目录。 */
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "vf-quality-"));
    dirs.push(dir);
    return dir;
  }

  it("空报告包含 5 项且全部为 skipped", () => {
    const report = createEmptyQualityReport("run-1", "2026-11-03T10:00:00.000Z");
    expect(report.checks).toHaveLength(5);
    expect(report.checks.map((check) => check.id)).toEqual([...QUALITY_CHECK_IDS]);
    expect(report.checks.every((check) => check.status === "skipped")).toBe(true);
    expect(report.checks[0].label).toBe(QUALITY_CHECK_LABELS.freeze);
    expect(qualityReportSchema.safeParse(report).success).toBe(true);
    expect(summarizeQualityReport(report)).toEqual({
      failed: 0,
      warned: 0,
      skipped: 5,
      blocking: false,
    });
  });

  it("部分检查结果合并后，缺失项补 skipped 且顺序固定", () => {
    const report = buildQualityReport({
      runId: "run-2",
      generatedAt: "2026-11-03T10:00:00.000Z",
      checks: [
        {
          id: "freeze",
          label: "静帧检测",
          status: "pass",
          violations: [],
        },
        {
          id: "subtitle-overflow",
          label: "字幕溢出",
          status: "fail",
          violations: [{ shotId: "sh-034", detail: "超 18 字：24 字" }],
        },
      ],
    });

    expect(report.checks.map((check) => check.id)).toEqual([...QUALITY_CHECK_IDS]);
    expect(report.checks[0].status).toBe("pass");
    expect(report.checks[1].status).toBe("fail");
    expect(report.checks[2].status).toBe("skipped");
    expect(summarizeQualityReport(report)).toEqual({
      failed: 1,
      warned: 0,
      skipped: 3,
      blocking: true,
    });
    expect(isBlockingFailure("subtitle-overflow", "fail")).toBe(true);
    expect(isBlockingFailure("freeze", "fail")).toBe(false);
  });

  it("非阻断项失败只计入 failed，不触发 blocking", () => {
    const report = buildQualityReport({
      runId: "run-3",
      checks: [{ id: "contrast", label: "画面对比度", status: "warn", violations: [] }],
    });
    const summary = summarizeQualityReport(report);
    expect(summary).toEqual({ failed: 0, warned: 1, skipped: 4, blocking: false });
  });

  it("中文路径下可写回并读回", () => {
    const dir = tempDir();
    const path = join(dir, "项目 甲", QUALITY_REPORT_RELATIVE_PATH);
    const report = buildQualityReport({
      runId: "run-4",
      generatedAt: "2026-11-03T10:00:00.000Z",
      checks: [{ id: "freeze", label: "静帧检测", status: "pass", violations: [] }],
    });
    writeQualityReport(path, report);
    expect(readQualityReport(path)).toEqual(report);
  });

  it("非 JSON 文件抛 ADAPTER_PROTOCOL_INVALID", () => {
    const dir = tempDir();
    const path = join(dir, "report.json");
    writeFileSync(path, "不是 JSON", "utf-8");
    expect(() => readQualityReport(path)).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });

  it("缺少固定检查项的报告被拒绝", () => {
    const dir = tempDir();
    const path = join(dir, "report.json");
    const report = createEmptyQualityReport("run-5");
    writeFileSync(
      path,
      JSON.stringify({ ...report, checks: report.checks.slice(0, 4) }),
      "utf-8",
    );
    expect(() => readQualityReport(path)).toThrowError(/缺少检查项/);
  });

  it("写入结构非法的报告时抛错而不是落盘", () => {
    const dir = tempDir();
    const path = join(dir, "report.json");
    expect(() =>
      writeQualityReport(path, { version: "1", runId: "run-6" } as any),
    ).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });
});
