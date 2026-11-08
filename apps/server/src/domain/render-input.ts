import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  readCopyDocument,
  readSceneSpec,
  readThemeSnapshot,
  readTimelineV2,
  resolveArtifactPath,
} from "@videoforge/pipeline";
import { VideoForgeError, type ShotSpec, type ThemeV2, type TimelineDocV2 } from "@videoforge/shared";

/**
 * render 阶段（v2）的渲染输入装配（T204）。
 * 把项目内的既有产物（copy v2 / timeline v2 / 主题快照 / SceneSpec / images/）
 * 组装为 `renderShots()` 的输入：读取、校验与路径安全边界集中在这里，
 * 保持阶段工具层薄、可单测。
 */

/** 镜头图片静态目录：项目内 `images/`（copy v2 的 imagePath 恒指向该目录内）。 */
export const RENDER_IMAGES_DIR = "images";

/** v2 渲染输入：renderShots() 除 entryPoint/outputDir 外的全部参数。 */
export interface ShotRenderInput {
  /** timeline v2（切点与帧率权威来源）。 */
  timeline: TimelineDocV2;
  /** 主题（项目快照冻结版本）。 */
  theme: ThemeV2;
  /** SceneSpec 镜头规格；scene 未跑时为空数组。 */
  specShots: ShotSpec[];
  /** 镜头 ID → images/ 内图片相对路径（POSIX）；缺失图片的镜头不在映射内。 */
  imageByShot: Record<string, string>;
  /** 镜头图片静态目录绝对路径（作为 Remotion publicDir）。 */
  imagesDir: string;
}

/**
 * 把 toPosix 之外的路径分隔符统一为 POSIX `/`（publicDir 相对路径必须是 `/`）。
 * @param value 相对路径
 * @returns POSIX 形式路径
 */
function toPosix(value: string): string {
  return value.split(sep).join("/");
}

/**
 * 装配 v2 渲染输入。
 * @param projectDir 项目工作目录
 * @returns 渲染输入（timeline/theme/spec/imageByShot/imagesDir）
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) copy 非 v2 或 timeline v2 结构非法
 * @throws VideoForgeError(`CONFIG_INVALID`) 缺主题快照
 * @throws VideoForgeError(`PATH_OUTSIDE_STORAGE`) imagePath 逃逸项目目录
 */
export function prepareShotRenderInput(projectDir: string): ShotRenderInput {
  // 1) copy 必须是 v2：v1 走 legacy 渲染，到这里说明调用方分派错误
  const document = readCopyDocument(join(projectDir, "copy.json"));
  if (document.version !== "2") {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `render v2 需要 copy.json v2，当前项目是 v1：${projectDir}`,
    );
  }

  // 2) timeline v2：结构校验由 readTimelineV2 负责（切点连续、cue 单调等）
  const timeline = readTimelineV2(join(projectDir, "timeline.json"));

  // 3) 主题快照：创建项目时写入（T111），缺失说明项目数据不完整
  const snapshot = readThemeSnapshot(projectDir);
  if (!snapshot) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `项目缺少主题快照 theme.resolved.json，无法渲染：${projectDir}`,
    );
  }

  // 4) SceneSpec 可缺省（scene 未跑时 image 镜头仍可渲染背景图）
  const specShots = readSceneSpec(projectDir)?.shots ?? [];

  // 5) 图片映射：copy v2 的 imagePath（images/<shotId>.png）→ publicDir 内相对路径；
  //    逃出项目目录的路径直接拒绝（数据被篡改的信号），逃出 images/ 的跳过（历史脏数据兼容）
  const imagesDir = join(projectDir, RENDER_IMAGES_DIR);
  const imageByShot: Record<string, string> = {};
  for (const shot of document.doc.scenes.flatMap((scene) => scene.shots)) {
    const imagePath = shot.imagePath?.trim();
    if (!imagePath) continue;
    // 路径安全：先解析回项目目录内（拒绝 ../ 逃逸），再确认位于 images/ 下
    const absolute = resolveArtifactPath(projectDir, imagePath);
    if (!existsSync(absolute)) continue;
    const insideImages = toPosix(relative(imagesDir, absolute));
    if (insideImages.startsWith("..") || insideImages.includes(":")) continue;
    imageByShot[shot.shotId] = insideImages;
  }

  return { timeline, theme: snapshot.theme, specShots, imageByShot, imagesDir };
}
