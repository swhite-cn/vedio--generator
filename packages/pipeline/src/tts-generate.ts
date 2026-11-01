import { dirname, join } from "node:path";
import { arkTtsToFile } from "./ark-client.js";
import { readCopyDoc, writeCopyDoc } from "./copy-contract.js";
import { loadSystemConfig } from "./config.js";
import { getArkApiKey } from "./env.js";

/** 加载系统配置与 Ark 凭据；配置非法或密钥缺失时由底层抛错（不记录密钥） */
function loadArk(rootDir: string) {
  const config = loadSystemConfig({ rootDir });
  const apiKey = getArkApiKey(rootDir);
  return { config, apiKey, ark: config.engines.endpoints.ark };
}

/**
 * tts:gen 阶段能力：逐场景调用 openspeech TTS，音频写入 <工作目录>/audio/ 并回填 copy.json 的 audioPath。
 * 仅读取显式入参，不读写进程 argv/stdout。
 * @param options.rootDir 仓库根目录（用于加载配置与密钥）
 * @param options.copyPath 输入 copy.json 路径
 * @param options.speaker 说话人（--speaker）；缺省回退配置 ark.tts_speaker
 * @param options.outFile 回填后的 copy.json 输出路径；缺省原地覆盖 copyPath
 * @param options.runId 运行 ID（--run-id）；缺省用 copy.json 所在目录名
 * @returns 各场景回填后的音频路径（供调用方拼装 stdout JSON）
 */
export async function generateSpeech(options: {
  rootDir: string;
  copyPath: string;
  speaker?: string;
  outFile?: string;
  runId?: string;
}): Promise<{ audios: Array<string | undefined> }> {
  const doc = readCopyDoc(options.copyPath);
  const { apiKey, ark } = loadArk(options.rootDir);
  const speaker = options.speaker?.trim() || ark.tts_speaker;
  const audioDir = join(dirname(options.copyPath), "audio");
  for (const scene of doc.scenes) {
    scene.audioPath = await arkTtsToFile({
      ttsBaseUrl: ark.tts_base_url,
      apiKey,
      resourceId: ark.tts_resource_id,
      text: scene.narration,
      speaker,
      outputPath: join(audioDir, `${scene.sceneId}.mp3`),
    });
  }
  writeCopyDoc(options.outFile ?? options.copyPath, doc);
  return { audios: doc.scenes.map((s) => s.audioPath) };
}
