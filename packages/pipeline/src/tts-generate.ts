import { dirname, join } from "node:path";
import { VideoForgeError, type CopyDocV2 } from "@videoforge/shared";
import { arkTtsToFile } from "./ark-client.js";
import {
  AUDIO_CUES_RELATIVE_PATH,
  buildAudioCuesDoc,
  writeAudioCues,
} from "./audio-cues.js";
import {
  readCopyDocument,
  writeCopyDoc,
  writeCopyDocV2,
  type CopyDoc,
} from "./copy-contract.js";
import { loadSystemConfig } from "./config.js";
import { getArkApiKey } from "./env.js";
import { appendGenerationRecord, resolveSceneScope } from "./manifest.js";
import { probeDurationMs } from "./media.js";

/** 加载系统配置与 Ark 凭据；配置非法或密钥缺失时由底层抛错（不记录密钥） */
function loadArk(rootDir: string) {
  const config = loadSystemConfig({ rootDir });
  const apiKey = getArkApiKey(rootDir);
  return { config, apiKey, ark: config.engines.endpoints.ark };
}

/** tts 阶段可选参数。 */
export interface GenerateSpeechOptions {
  rootDir: string;
  copyPath: string;
  speaker?: string;
  outFile?: string;
  runId?: string;
  /** v1：按场景定向。 */
  sceneIds?: string[];
  /** v2：按镜头定向。 */
  shotIds?: string[];
}

/** 解析实际使用的音色：空串与占位串一律回退配置默认音色。 */
function resolveSpeaker(requested: string | undefined, fallback: string): string {
  const trimmed = requested?.trim();
  return !trimmed || trimmed === "default" || trimmed === "auto" ? fallback : trimmed;
}

/**
 * v2 配音：逐镜头合成、实测时长并生成 audio/cues.json。
 * 时间戳当前使用逐镜实测 + 逐句字符分配（标记为 estimated）；
 * 原生时间戳与 ASR 对齐接入后，只需替换 `timingSource` 与切分来源。
 */
async function generateSpeechV2(options: {
  doc: CopyDocV2;
  input: GenerateSpeechOptions;
  projectDir: string;
  apiKey: string;
  ark: ReturnType<typeof loadArk>["ark"];
  config: ReturnType<typeof loadArk>["config"];
  speaker: string;
}): Promise<{ audios: Array<string | undefined>; generated: string[] }> {
  const { doc, input, projectDir, apiKey, ark, config, speaker } = options;
  const all = doc.scenes.flatMap((scene) =>
    scene.shots.map((shot) => ({ sceneId: scene.sceneId, shot })),
  );

  let scoped = all;
  if (input.shotIds && input.shotIds.length > 0) {
    const wanted = new Set(input.shotIds);
    const unknown = input.shotIds.filter((id) => !all.some((item) => item.shot.shotId === id));
    if (unknown.length > 0) {
      throw new VideoForgeError("CONFIG_INVALID", `未知的镜头 ID：${unknown.join(", ")}`);
    }
    scoped = all.filter((item) => wanted.has(item.shot.shotId));
  } else if (input.sceneIds && input.sceneIds.length > 0) {
    const sceneScope = new Set(
      resolveSceneScope(
        doc.scenes.map((scene) => scene.sceneId),
        input.sceneIds,
      ),
    );
    scoped = all.filter((item) => sceneScope.has(item.sceneId));
  }

  const generated: string[] = [];
  for (const { sceneId, shot } of scoped) {
    const relative = `audio/${shot.shotId}.mp3`;
    const absolute = join(projectDir, relative);
    const startedAt = Date.now();
    try {
      await arkTtsToFile({
        ttsBaseUrl: ark.tts_base_url,
        apiKey,
        resourceId: ark.tts_resource_id,
        text: shot.narration,
        speaker,
        outputPath: absolute,
      });
      const durationMs = await probeDurationMs(config.tools.ffprobe_path, absolute);
      shot.audioPath = relative;
      shot.audioDurationMs = durationMs;
      generated.push(shot.shotId);
      appendGenerationRecord(projectDir, {
        runId: input.runId,
        stage: "tts",
        sceneId,
        shotId: shot.shotId,
        assetPath: relative,
        model: ark.tts_resource_id,
        prompt: shot.narration,
        params: { speaker, durationMs, timingSource: "estimated" },
        ok: true,
        contractVersion: "2.0",
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      appendGenerationRecord(projectDir, {
        runId: input.runId,
        stage: "tts",
        sceneId,
        shotId: shot.shotId,
        assetPath: relative,
        model: ark.tts_resource_id,
        prompt: shot.narration,
        params: { speaker },
        ok: false,
        errorCode: error instanceof VideoForgeError ? error.code : "ADAPTER_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
        contractVersion: "2.0",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  const missingAudio = all.filter(
    (item) => !item.shot.audioPath || !item.shot.audioDurationMs,
  );
  if (missingAudio.length > 0) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `以下镜头尚无音频时长：${missingAudio.map((item) => item.shot.shotId).join(", ")}；请先全量运行 tts_generate`,
    );
  }

  writeAudioCues(
    join(projectDir, AUDIO_CUES_RELATIVE_PATH),
    buildAudioCuesDoc({
      timingSource: "estimated",
      shots: all.map(({ sceneId, shot }) => ({
        shotId: shot.shotId,
        sceneId,
        audioPath: shot.audioPath!,
        durationMs: shot.audioDurationMs!,
        narration: shot.narration,
      })),
    }),
  );

  writeCopyDocV2(input.outFile ?? input.copyPath, doc);
  return { audios: all.map((item) => item.shot.audioPath), generated };
}

/**
 * tts:gen 阶段能力：逐场景（v1）或逐镜头（v2）调用 openspeech TTS。
 * - v1：每场一段音频，回填 copy.json 的 audioPath；
 * - v2：每镜一段音频，回填 audioPath/audioDurationMs，并产出 audio/cues.json；
 * - 支持 sceneIds / shotIds 定向重合成；
 * - 每次合成写入生成清单。
 * @param options 运行参数
 * @returns 回填后的音频路径与本轮实际合成的场景/镜头 ID
 */
export async function generateSpeech(
  options: GenerateSpeechOptions,
): Promise<{ audios: Array<string | undefined>; generated: string[] }> {
  const document = readCopyDocument(options.copyPath);
  const { config, apiKey, ark } = loadArk(options.rootDir);
  const speaker = resolveSpeaker(options.speaker, ark.tts_speaker);
  const projectDir = dirname(options.copyPath);
  const audioDir = join(projectDir, "audio");

  if (document.version === "2") {
    return generateSpeechV2({
      doc: document.doc,
      input: options,
      projectDir,
      apiKey,
      ark,
      config,
      speaker,
    });
  }

  const doc: CopyDoc = document.doc;
  const scope = resolveSceneScope(
    doc.scenes.map((scene) => scene.sceneId),
    options.sceneIds,
  );

  const generated: string[] = [];
  for (const sceneId of scope) {
    const scene = doc.scenes.find((item) => item.sceneId === sceneId);
    if (!scene) continue;
    const startedAt = Date.now();
    try {
      scene.audioPath = await arkTtsToFile({
        ttsBaseUrl: ark.tts_base_url,
        apiKey,
        resourceId: ark.tts_resource_id,
        text: scene.narration,
        speaker,
        outputPath: join(audioDir, `${sceneId}.mp3`),
      });
      generated.push(sceneId);
      appendGenerationRecord(projectDir, {
        runId: options.runId,
        stage: "tts",
        sceneId,
        assetPath: `audio/${sceneId}.mp3`,
        model: ark.tts_resource_id,
        prompt: scene.narration,
        params: { speaker },
        ok: true,
        contractVersion: "1.0",
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      appendGenerationRecord(projectDir, {
        runId: options.runId,
        stage: "tts",
        sceneId,
        assetPath: `audio/${sceneId}.mp3`,
        model: ark.tts_resource_id,
        prompt: scene.narration,
        params: { speaker },
        ok: false,
        errorCode: error instanceof VideoForgeError ? error.code : "ADAPTER_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
        contractVersion: "1.0",
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }
  writeCopyDoc(options.outFile ?? options.copyPath, doc);
  return { audios: doc.scenes.map((s) => s.audioPath), generated };
}
