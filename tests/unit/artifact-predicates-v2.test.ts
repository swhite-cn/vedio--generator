import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ArtifactPredicate } from "@videoforge/shared";
import {
  AUDIO_CUES_RELATIVE_PATH,
  CAPTIONS_RELATIVE_PATH,
  buildAudioCuesDoc,
  buildShotSpecs,
  buildTimelineV2,
  ensureThemeSnapshot,
  generateCaptions,
  loadTheme,
  mergeSceneSpecShots,
  parseCopyV2Json,
  writeAudioCues,
  writeCopyDoc,
  writeCopyDocV2,
  writeSceneSpec,
  writeTimelineV2,
} from "../../packages/pipeline/src/index";
import { verifyStageArtifact } from "../../apps/server/src/workflow/breakpoint";

/** 仓库根目录（真实主题所在位置）。 */
const repoRoot = process.cwd();

/** v2 copy：2 个镜头（component + image）。 */
const COPY_OUTPUT = {
  title: "水银变黄金",
  styleAnchors: [{ key: "mercury", label: "水银", color: "#C9CED6" }],
  scenes: [
    {
      sceneId: "s1",
      chapterNo: 1,
      title: "开场",
      shots: [
        {
          shotId: "sh-001",
          narration: "第一句。第二句。",
          onScreenText: "水银 → 黄金",
          visualType: "component",
          anchorKeys: ["mercury"],
        },
        {
          shotId: "sh-002",
          narration: "第三句。",
          onScreenText: "不是炼金术",
          visualType: "image",
        },
      ],
    },
  ],
};

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-predicates-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** copy v2 文档（带主题）。 */
function buildCopy() {
  return parseCopyV2Json(JSON.stringify(COPY_OUTPUT), {
    topic: "水银变黄金",
    style: "硬核科普",
    themeId: "documentary-dark",
  });
}

/** 造一个 v2 项目：copy + cues + ass + spec + timeline 全部合法。 */
function seedCompleteV2Project(): void {
  const copy = buildCopy();
  writeCopyDocV2(join(projectDir, "copy.json"), copy);

  const cues = buildAudioCuesDoc({
    timingSource: "estimated",
    shots: [
      {
        shotId: "sh-001",
        sceneId: "s1",
        audioPath: "audio/sh-001.mp3",
        durationMs: 4000,
        narration: copy.scenes[0].shots[0].narration,
      },
      {
        shotId: "sh-002",
        sceneId: "s1",
        audioPath: "audio/sh-002.mp3",
        durationMs: 2500,
        narration: copy.scenes[0].shots[1].narration,
      },
    ],
  });
  writeAudioCues(join(projectDir, AUDIO_CUES_RELATIVE_PATH), cues);

  const theme = loadTheme({ rootDir: repoRoot, themeId: "documentary-dark" });
  ensureThemeSnapshot(projectDir, theme);
  generateCaptions({ projectDir });

  const spec = mergeSceneSpecShots(
    null,
    buildShotSpecs({ copy, selections: [] }).shots,
    copy.theme.id,
  );
  writeSceneSpec(projectDir, spec);

  const timeline = buildTimelineV2({ audio: cues, fps: 30, tailPauseMs: 500 });
  writeTimelineV2(join(projectDir, "timeline.json"), timeline);
}

/** 文件判据构造。 */
function filePredicate(
  relativePath: string,
  validator: Extract<ArtifactPredicate, { kind: "file" }>["validator"],
): ArtifactPredicate {
  return { kind: "file", relativePath, validator };
}

/** 断言判据通过。 */
function passes(predicate: ArtifactPredicate): boolean {
  return verifyStageArtifact(projectDir, predicate, "landscape-1080p");
}

describe("v2 结构判据", () => {
  test("完整 v2 项目：copy/cue/字幕/spec/timeline 全部达标", () => {
    seedCompleteV2Project();
    expect(passes(filePredicate("copy.json", "copy-contract-v2"))).toBe(true);
    expect(passes(filePredicate(AUDIO_CUES_RELATIVE_PATH, "audio-cues"))).toBe(true);
    expect(passes(filePredicate(CAPTIONS_RELATIVE_PATH, "captions-ass"))).toBe(true);
    expect(passes(filePredicate("scenes/spec.json", "scene-spec"))).toBe(true);
    expect(passes(filePredicate("timeline.json", "timeline-contract-v2"))).toBe(true);
  });

  test("copy 为 v1 时 copy-contract-v2 不达标", () => {
    writeCopyDoc(join(projectDir, "copy.json"), {
      topic: "黑洞",
      style: "科普",
      title: "黑洞不是洞",
      scenes: [
        { sceneId: "s1", title: "引入", narration: "黑洞不是洞。", imagePrompt: "深空插画" },
      ],
    });
    expect(passes(filePredicate("copy.json", "copy-contract-v2"))).toBe(false);
  });

  test("口播被改写导致 cue 未全覆盖时 audio-cues 不达标", () => {
    seedCompleteV2Project();
    const tampered = { ...buildCopy() };
    tampered.scenes[0].shots[0].narration = "第一句。第二句。补充一句。";
    writeCopyDocV2(join(projectDir, "copy.json"), tampered);

    expect(passes(filePredicate(AUDIO_CUES_RELATIVE_PATH, "audio-cues"))).toBe(false);
  });

  test("字幕条数与 cue 不一致时 captions-ass 不达标", () => {
    seedCompleteV2Project();
    const assPath = join(projectDir, CAPTIONS_RELATIVE_PATH);
    const lines = readFileSync(assPath, "utf-8").split(/\r?\n/);
    const lastDialogue = lines.map((line) => line.startsWith("Dialogue:")).lastIndexOf(true);
    lines.splice(lastDialogue, 1);
    writeFileSync(assPath, lines.join("\n"), "utf-8");

    expect(passes(filePredicate(CAPTIONS_RELATIVE_PATH, "captions-ass"))).toBe(false);
  });

  test("SceneSpec 缺少镜头或组件参数非法时不达标", () => {
    seedCompleteV2Project();
    const copy = buildCopy();
    const partial = mergeSceneSpecShots(
      null,
      buildShotSpecs({ copy, selections: [], shotIds: ["sh-001"] }).shots,
      copy.theme.id,
    );
    writeSceneSpec(projectDir, partial);
    expect(passes(filePredicate("scenes/spec.json", "scene-spec"))).toBe(false);

    seedCompleteV2Project();
    const spec = mergeSceneSpecShots(
      null,
      buildShotSpecs({ copy, selections: [] }).shots,
      copy.theme.id,
    );
    // 绕过装配期校验，直接写入缺必填参数的组件镜头，验证判据能拦住
    spec.shots[0] = { ...spec.shots[0], props: {} };
    writeSceneSpec(projectDir, spec);
    expect(passes(filePredicate("scenes/spec.json", "scene-spec"))).toBe(false);
  });

  test("timeline v2 结构非法时不达标", () => {
    seedCompleteV2Project();
    writeFileSync(
      join(projectDir, "timeline.json"),
      JSON.stringify({ contractVersion: "2.0", fps: 30, tailPauseMs: 0, timingSource: "estimated", totalMs: 1, shots: [], cues: [] }),
      "utf-8",
    );
    expect(passes(filePredicate("timeline.json", "timeline-contract-v2"))).toBe(false);
  });

  test("产物文件缺失时所有判据均不达标", () => {
    expect(passes(filePredicate("copy.json", "copy-contract-v2"))).toBe(false);
    expect(passes(filePredicate(AUDIO_CUES_RELATIVE_PATH, "audio-cues"))).toBe(false);
    expect(passes(filePredicate(CAPTIONS_RELATIVE_PATH, "captions-ass"))).toBe(false);
    expect(passes(filePredicate("scenes/spec.json", "scene-spec"))).toBe(false);
    expect(passes(filePredicate("timeline.json", "timeline-contract-v2"))).toBe(false);
  });
});
