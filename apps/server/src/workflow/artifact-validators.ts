import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VideoForgeError, type CopyDocV2 } from "@videoforge/shared";
import {
  CAPTIONS_RELATIVE_PATH,
  AUDIO_CUES_RELATIVE_PATH,
  readAudioCues,
  readCopyDocument,
  readSceneSpec,
  readTimelineV2,
  countAssDialogueEvents,
} from "@videoforge/pipeline";
import { componentRegistry } from "@videoforge/template-sdk";

/**
 * v2 阶段产物结构校验器（T112）。
 * 断点判据从「文件存在」升级为「结构可校验」：copy 必须 v2、cue 必须覆盖口播、
 * 字幕必须与 cue 一一对应、SceneSpec 必须覆盖全部镜头且组件参数合法、timeline 必须结构合法。
 * 全部失败抛 `VideoForgeError`，由 `verifyStageArtifact` 统一捕获为「未达标」。
 */

/** 读取并断言 copy.json 为 v2。 */
function requireCopyV2(projectDir: string): CopyDocV2 {
  const document = readCopyDocument(join(projectDir, "copy.json"));
  if (document.version !== "2") {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      "copy.json 不是契约 v2（缺少 shots，无法做结构判据）",
    );
  }
  return document.doc;
}

/** 去掉空白，便于比较口播与 cue 文本的字符覆盖。 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * 断言 copy.json 是合法 v2（shots 结构由 schema 校验）。
 * @param copyPath copy.json 路径
 */
export function assertCopyContractV2(copyPath: string): void {
  const document = readCopyDocument(copyPath);
  if (document.version !== "2") {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `copy.json 不是契约 v2：${copyPath}`,
    );
  }
}

/**
 * 断言 audio/cues.json 的旁白 cue 100% 覆盖每个镜头的口播文本。
 * @param projectDir 项目工作目录
 */
export function assertAudioCueCoverage(projectDir: string): void {
  const copy = requireCopyV2(projectDir);
  const cues = readAudioCues(join(projectDir, AUDIO_CUES_RELATIVE_PATH));
  const cueTextByShot = new Map<string, string>();
  for (const cue of cues.cues) {
    cueTextByShot.set(cue.shotId, (cueTextByShot.get(cue.shotId) ?? "") + cue.text);
  }

  for (const scene of copy.scenes) {
    for (const shot of scene.shots) {
      const covered = normalizeText(cueTextByShot.get(shot.shotId) ?? "");
      const expected = normalizeText(shot.narration);
      if (covered !== expected) {
        throw new VideoForgeError(
          "ADAPTER_PROTOCOL_INVALID",
          `镜头 ${shot.shotId} 的 cue 未覆盖全部口播（期望 ${expected.length} 字，实际 ${covered.length} 字）`,
        );
      }
    }
  }
}

/**
 * 断言字幕轨与 cue 一一对应：Dialogue 条数等于 cue 条数且非空。
 * @param projectDir 项目工作目录
 */
export function assertCaptionsCoverage(projectDir: string): void {
  const cues = readAudioCues(join(projectDir, AUDIO_CUES_RELATIVE_PATH));
  let content: string;
  try {
    content = readFileSync(join(projectDir, CAPTIONS_RELATIVE_PATH), "utf-8");
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `字幕轨不可读：${CAPTIONS_RELATIVE_PATH}（${(err as Error).message}）`,
    );
  }
  const dialogueCount = countAssDialogueEvents(content);
  if (dialogueCount === 0) {
    throw new VideoForgeError("ADAPTER_PROTOCOL_INVALID", "字幕轨没有任何 Dialogue");
  }
  if (dialogueCount !== cues.cues.length) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `字幕条数与 cue 不一致：字幕 ${dialogueCount} 条，cue ${cues.cues.length} 条`,
    );
  }
}

/**
 * 断言 SceneSpec 覆盖 copy 的全部镜头，且组件镜头参数合法、主题一致。
 * @param projectDir 项目工作目录
 */
export function assertSceneSpecCoverage(projectDir: string): void {
  const copy = requireCopyV2(projectDir);
  const spec = readSceneSpec(projectDir);
  if (!spec) {
    throw new VideoForgeError("ADAPTER_PROTOCOL_INVALID", "缺少 scenes/spec.json");
  }
  if (spec.themeId !== copy.theme.id) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `SceneSpec 主题与 copy 不一致：spec ${spec.themeId}，copy ${copy.theme.id}`,
    );
  }

  const expectedShotIds = copy.scenes.flatMap((scene) => scene.shots.map((shot) => shot.shotId));
  const actualShotIds = spec.shots.map((shot) => shot.shotId);
  if (expectedShotIds.length !== actualShotIds.length) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `SceneSpec 镜头数与 copy 不一致：spec ${actualShotIds.length}，copy ${expectedShotIds.length}`,
    );
  }
  const actualSet = new Set(actualShotIds);
  const missing = expectedShotIds.filter((shotId) => !actualSet.has(shotId));
  if (missing.length > 0) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `SceneSpec 缺少镜头：${missing.join(", ")}`,
    );
  }

  for (const shot of spec.shots) {
    if (shot.visualType !== "component") continue;
    if (!shot.componentId) {
      throw new VideoForgeError(
        "ADAPTER_PROTOCOL_INVALID",
        `镜头 ${shot.shotId} 是 component 但缺少 componentId`,
      );
    }
    componentRegistry.assertProps(shot.componentId, shot.props);
  }
}

/**
 * 断言 timeline.json 是合法 v2（切点连续、cue 不越镜、动效时长等由 schema 校验）。
 * @param timelinePath timeline.json 路径
 */
export function assertTimelineContractV2(timelinePath: string): void {
  readTimelineV2(timelinePath);
}
