import { join } from "node:path";
import type { CopyDocV2 } from "@videoforge/shared";
import {
  AUDIO_CUES_RELATIVE_PATH,
  buildAudioCuesDoc,
  buildShotSpecs,
  buildTimelineV2,
  generateCaptions,
  loadTheme,
  mergeSceneSpecShots,
  parseCopyV2Json,
  readAudioCues,
  writeAudioCues,
  writeCopyDocV2,
  writeSceneSpec,
  writeTimelineV2,
} from "@videoforge/pipeline";

/**
 * v2 项目测试夹具（T004 起断点判据与能力声明均为 v2，多个单测共用）。
 *
 * 夹具直接调用真实生成器（copy/spec/cues/字幕/timeline）产出一套结构合法的 v2 产物，
 * 既能通过 `artifact-validators` 的结构校验，也避免各测试手写易漂移的 JSON 文本。
 * 本文件不以 `.test.ts` 结尾，不会被 vitest 当作测试用例收集。
 */

/** 夹具使用的主题 ID（仓库 `config/themes` 下存在）。 */
export const FIXTURE_THEME_ID = "documentary-dark";

/** 夹具使用的仓库根目录（加载主题配置）。 */
export const FIXTURE_REPO_ROOT = process.cwd();

/** 夹具 copy v2 原始输出：两个镜头（component + image）。 */
const FIXTURE_COPY_OUTPUT = {
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

/**
 * 构造夹具 copy v2 文档（每次调用返回新对象，避免用例间互相串改）。
 * @returns 合法的 v2 copy 文档
 */
export function buildFixtureCopyV2(): CopyDocV2 {
  return parseCopyV2Json(JSON.stringify(FIXTURE_COPY_OUTPUT), {
    topic: "水银变黄金",
    style: "硬核科普",
    themeId: FIXTURE_THEME_ID,
  });
}

/**
 * 写出 copy.json 并返回文档，供后续 stage 复用同一份镜头集合。
 * @param projectDir 项目工作目录
 * @returns 写出的 v2 copy 文档
 */
export function writeFixtureCopyV2(projectDir: string): CopyDocV2 {
  const copy = buildFixtureCopyV2();
  writeCopyDocV2(join(projectDir, "copy.json"), copy);
  return copy;
}

/**
 * 按 copy 的镜头逐个写出 `audio/cues.json`（cue 文本与口播逐字一致，满足覆盖率判据）。
 * @param projectDir 项目工作目录
 * @param copy 已写出的 v2 copy 文档
 */
export function writeFixtureCues(projectDir: string, copy: CopyDocV2): void {
  const cues = buildAudioCuesDoc({
    timingSource: "estimated",
    shots: copy.scenes.flatMap((scene) =>
      scene.shots.map((shot) => ({
        shotId: shot.shotId,
        sceneId: scene.sceneId,
        audioPath: `audio/${shot.shotId}.mp3`,
        durationMs: 4000,
        narration: shot.narration,
      })),
    ),
  });
  writeAudioCues(join(projectDir, AUDIO_CUES_RELATIVE_PATH), cues);
}

/**
 * 写出覆盖 copy 全部镜头的 `scenes/spec.json`（主题与 copy 一致）。
 * @param projectDir 项目工作目录
 * @param copy 已写出的 v2 copy 文档
 */
export function writeFixtureSceneSpec(projectDir: string, copy: CopyDocV2): void {
  const spec = mergeSceneSpecShots(
    null,
    buildShotSpecs({ copy, selections: [] }).shots,
    copy.theme.id,
  );
  writeSceneSpec(projectDir, spec);
}

/**
 * 写出 `captions/subtitle.ass`（一条 cue 对应一条 Dialogue）。
 * @param projectDir 项目工作目录
 */
export function writeFixtureCaptions(projectDir: string): void {
  generateCaptions({
    projectDir,
    theme: loadTheme({ rootDir: FIXTURE_REPO_ROOT, themeId: FIXTURE_THEME_ID }),
  });
}

/**
 * 按已写出的 `audio/cues.json` 构建并写出合法 v2 `timeline.json`。
 * @param projectDir 项目工作目录
 */
export function writeFixtureTimeline(projectDir: string): void {
  const timeline = buildTimelineV2({
    audio: readAudioCues(join(projectDir, AUDIO_CUES_RELATIVE_PATH)),
    fps: 30,
    tailPauseMs: 500,
  });
  writeTimelineV2(join(projectDir, "timeline.json"), timeline);
}

/** `seedV2Project` 选项。 */
export interface SeedV2ProjectOptions {
  /** 是否写出 timeline.json（默认 true）；关闭后可验证 storyboard 阶段判据失败。 */
  withTimeline?: boolean;
}

/**
 * 一次性写出一套结构合法的 v2 产物（copy/cues/spec/captions/timeline）。
 * 注意：不含 `images/*.png`、渲染帧与 `final.mp4`，需要时由调用方自行补齐。
 * @param projectDir 项目工作目录
 * @param options.withTimeline 是否写 timeline.json（默认 true）
 */
export function seedV2Project(projectDir: string, options: SeedV2ProjectOptions = {}): void {
  const copy = writeFixtureCopyV2(projectDir);
  writeFixtureCues(projectDir, copy);
  writeFixtureSceneSpec(projectDir, copy);
  writeFixtureCaptions(projectDir);
  if (options.withTimeline !== false) writeFixtureTimeline(projectDir);
}
