import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VideoForgeError, sceneSpecSchema, type SceneSpecV2 } from "@videoforge/shared";

/**
 * SceneSpec v2 的落盘读写：`scenes/spec.json`。
 * 结构校验与写盘集中在这里，供 scene 阶段、断点判据与 storyboard 聚合 API 复用。
 */

/** SceneSpec 相对项目目录的路径（POSIX `/`）。 */
export const SCENE_SPEC_RELATIVE_PATH = "scenes/spec.json";

/**
 * 校验任意值为 SceneSpec。
 * @param raw 待校验值
 * @param path 错误信息中的文件路径
 * @returns 合法 SceneSpec
 */
function parseSceneSpec(raw: unknown, path: string): SceneSpecV2 {
  const result = sceneSpecSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `SceneSpec 结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  return result.data;
}

/**
 * 读取项目 SceneSpec；文件不存在返回 null。
 * @param projectDir 项目工作目录
 * @returns SceneSpec 或 null
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) 非 JSON 或结构非法时
 */
export function readSceneSpec(projectDir: string): SceneSpecV2 | null {
  const path = join(projectDir, SCENE_SPEC_RELATIVE_PATH);
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `SceneSpec 解析失败：${path}（${(err as Error).message}）`,
    );
  }
  return parseSceneSpec(raw, path);
}

/**
 * 校验后写入项目 SceneSpec（自动创建 scenes/ 目录）。
 * @param projectDir 项目工作目录
 * @param spec SceneSpec
 */
export function writeSceneSpec(projectDir: string, spec: SceneSpecV2): void {
  const path = join(projectDir, SCENE_SPEC_RELATIVE_PATH);
  const valid = parseSceneSpec(spec, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(valid, null, 2), "utf-8");
}
