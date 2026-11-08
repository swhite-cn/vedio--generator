import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AUDIO_CUES_RELATIVE_PATH,
  CAPTIONS_RELATIVE_PATH,
  buildAudioCuesDoc,
  buildAssSubtitle,
  countAssDialogueEvents,
  ensureThemeSnapshot,
  formatAssTime,
  generateCaptions,
  loadTheme,
  writeAudioCues,
} from "../../packages/pipeline/src/index";

/** 仓库根目录（真实主题与配置所在位置）。 */
const repoRoot = process.cwd();

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-captions-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/**
 * 写入一套两镜头的音频 cue 夹具：第一镜两句、第二镜一句。
 * @param projectDir 项目目录
 */
function seedCues(projectDir: string): void {
  const doc = buildAudioCuesDoc({
    timingSource: "estimated",
    shots: [
      {
        shotId: "sh-001",
        sceneId: "s1",
        audioPath: "audio/sh-001.mp3",
        durationMs: 4000,
        narration: "第一句。第二句。",
      },
      {
        shotId: "sh-002",
        sceneId: "s1",
        audioPath: "audio/sh-002.mp3",
        durationMs: 2500,
        narration: "第三句。",
      },
    ],
  });
  writeAudioCues(join(projectDir, AUDIO_CUES_RELATIVE_PATH), doc);
}

/** 写入内置主题的项目快照。 */
function seedTheme(projectDir: string): void {
  const theme = loadTheme({ rootDir: repoRoot, themeId: "documentary-dark" });
  ensureThemeSnapshot(projectDir, theme, "2026-11-07T00:00:00.000Z");
}

describe("ASS 时间与文本格式", () => {
  test("毫秒转 ASS 时间为厘秒精度", () => {
    expect(formatAssTime(0)).toBe("0:00:00.00");
    expect(formatAssTime(1234)).toBe("0:00:01.23");
    expect(formatAssTime(61_500)).toBe("0:01:01.50");
    expect(formatAssTime(3_600_000)).toBe("1:00:00.00");
  });

  test("花括号被替换、换行转为 \\N，避免破坏事件行", () => {
    const theme = loadTheme({ rootDir: repoRoot, themeId: "documentary-dark" });
    const ass = buildAssSubtitle(
      [
        {
          cueId: "sh-001-cue-01",
          shotId: "sh-001",
          kind: "narration",
          startMs: 0,
          endMs: 2000,
          text: "第一行\n第二行{重点}",
        },
      ],
      theme,
    );

    expect(ass).toContain("第一行\\N第二行（重点）");
    expect(ass).not.toContain("{重点}");
  });
});

describe("captions 阶段生成 subtitle.ass", () => {
  test("一条 cue 一条 Dialogue，时间与 cue 对齐", () => {
    seedCues(projectDir);
    seedTheme(projectDir);

    const result = generateCaptions({ projectDir });
    const content = readFileSync(result.outPath, "utf-8");

    expect(result.cueCount).toBe(3);
    expect(result.shotCount).toBe(2);
    expect(result.themeId).toBe("documentary-dark");
    expect(countAssDialogueEvents(content)).toBe(3);

    const dialogueLines = content.split(/\r?\n/).filter((line) => line.startsWith("Dialogue:"));
    // 第一镜第一句：0 → 2000ms
    expect(dialogueLines[0]).toContain("0:00:00.00,0:00:02.00");
    expect(dialogueLines[0]).toContain("第一句。");
    // 第一镜第二句：2000 → 4000ms
    expect(dialogueLines[1]).toContain("0:00:02.00,0:00:04.00");
    // 第二镜唯一一句：4000 → 6500ms
    expect(dialogueLines[2]).toContain("0:00:04.00,0:00:06.50");
    expect(dialogueLines[2]).toContain("第三句。");
  });

  test("样式来自主题 token：字号、描边、底部距离、字体与颜色", () => {
    seedCues(projectDir);
    seedTheme(projectDir);
    const result = generateCaptions({ projectDir });
    const content = readFileSync(result.outPath, "utf-8");

    expect(content).toContain("PlayResX: 1920");
    expect(content).toContain("PlayResY: 1080");
    expect(content).toContain("Style: Default,PingFang SC,44,");
    // 主色 #E5E0D5 → &H00D5E0E5；描边 4；底部 1080*0.06≈65
    expect(content).toContain("&H00D5E0E5");
    expect(content).toContain(",1,4,0,2,96,96,65,1");
  });

  test("主题覆盖入参优先于项目快照", () => {
    seedCues(projectDir);
    const theme = loadTheme({ rootDir: repoRoot, themeId: "documentary-dark" });

    const result = generateCaptions({ projectDir, theme });
    expect(result.themeId).toBe("documentary-dark");
    expect(readFileSync(result.outPath, "utf-8")).toContain("Style: Default");
  });

  test("缺少 audio/cues.json 时抛 CONFIG_INVALID", () => {
    expect(() => generateCaptions({ projectDir })).toThrowError(/CONFIG_INVALID/);
  });

  test("缺少主题快照且未传 theme 时抛 CONFIG_INVALID", () => {
    seedCues(projectDir);
    expect(() => generateCaptions({ projectDir })).toThrowError(/CONFIG_INVALID/);
  });

  test("产物固定为 captions/subtitle.ass", () => {
    seedCues(projectDir);
    seedTheme(projectDir);
    generateCaptions({ projectDir });
    expect(CAPTIONS_RELATIVE_PATH).toBe("captions/subtitle.ass");
    expect(() => readFileSync(join(projectDir, CAPTIONS_RELATIVE_PATH), "utf-8")).not.toThrow();
  });
});
