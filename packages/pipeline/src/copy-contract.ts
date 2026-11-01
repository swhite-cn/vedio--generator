import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { VideoForgeError } from "@videoforge/shared";

/** copy.json 中单个场景的契约；imagePath/audioPath/htmlPath 由 image:gen / tts:gen / scene:gen 回填 */
export const copySceneSchema = z.object({
  sceneId: z.string().min(1),
  title: z.string(),
  narration: z.string().min(1),
  imagePrompt: z.string().min(1),
  imagePath: z.string().optional(),
  audioPath: z.string().optional(),
  htmlPath: z.string().optional(),
});

/** copy.json 顶层契约：贯穿 copy:gen → image:gen → tts:gen → storyboard:gen → render/compose */
export const copyDocSchema = z.object({
  topic: z.string().min(1),
  style: z.string().min(1),
  title: z.string().min(1),
  scenes: z.array(copySceneSchema).min(1),
});

export type CopyDoc = z.infer<typeof copyDocSchema>;

/**
 * 读取并校验 copy.json；解析失败或结构非法时抛 ADAPTER_PROTOCOL_INVALID。
 */
export function readCopyDoc(path: string): CopyDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `copy.json 解析失败：${path}（${(err as Error).message}）`,
    );
  }
  const result = copyDocSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `copy.json 结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  return result.data;
}

/**
 * 以 UTF-8、2 空格缩进写 copy.json；自动创建缺失的父目录（工作区可能尚未建立）。
 */
export function writeCopyDoc(path: string, doc: CopyDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf-8");
}
