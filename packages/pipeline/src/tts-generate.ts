import { dirname, join } from "node:path";
import { VideoForgeError } from "@videoforge/shared";
import { arkTtsToFile } from "./ark-client.js";
import { readCopyDoc, writeCopyDoc } from "./copy-contract.js";
import { loadSystemConfig } from "./config.js";
import { getArkApiKey } from "./env.js";
import { appendGenerationRecord, resolveSceneScope } from "./manifest.js";

/** 加载系统配置与 Ark 凭据；配置非法或密钥缺失时由底层抛错（不记录密钥） */
function loadArk(rootDir: string) {
  const config = loadSystemConfig({ rootDir });
  const apiKey = getArkApiKey(rootDir);
  return { config, apiKey, ark: config.engines.endpoints.ark };
}

/**
 * tts:gen 阶段能力：逐场景调用 openspeech TTS，音频写入 <工作目录>/audio/ 并回填 copy.json 的 audioPath。
 * 支持定向重合成：`sceneIds` 只处理指定场景，其余音频原样保留；每次合成写入生成清单。
 * 仅读取显式入参，不读写进程 argv/stdout。
 * @param options.rootDir 仓库根目录（用于加载配置与密钥）
 * @param options.copyPath 输入 copy.json 路径
 * @param options.speaker 说话人（--speaker）；缺省或占位值（`default` / `auto`）回退配置 ark.tts_speaker
 * @param options.outFile 回填后的 copy.json 输出路径；缺省原地覆盖 copyPath
 * @param options.runId 运行 ID（--run-id）；缺省用 copy.json 所在目录名
 * @param options.sceneIds 只重合成这些场景；缺省为全部场景
 * @returns 各场景回填后的音频路径与本次实际合成的场景 ID
 */
export async function generateSpeech(options: {
  rootDir: string;
  copyPath: string;
  speaker?: string;
  outFile?: string;
  runId?: string;
  sceneIds?: string[];
}): Promise<{ audios: Array<string | undefined>; generated: string[] }> {
  const doc = readCopyDoc(options.copyPath);
  const { apiKey, ark } = loadArk(options.rootDir);
  // 仅接受真实音色值；空串与占位串（default / auto）一律回退配置默认音色，
  // 避免把占位串当成真实音色上报，触发 openspeech 的 resource mismatch（code=55000000）。
  const requested = options.speaker?.trim();
  const speaker =
    !requested || requested === "default" || requested === "auto" ? ark.tts_speaker : requested;
  const projectDir = dirname(options.copyPath);
  const audioDir = join(projectDir, "audio");
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
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }
  writeCopyDoc(options.outFile ?? options.copyPath, doc);
  return { audios: doc.scenes.map((s) => s.audioPath), generated };
}
