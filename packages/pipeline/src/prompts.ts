import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VideoForgeError } from "@videoforge/shared";

/**
 * 提示词集加载：把 copy:gen / image:gen / scene:gen 的系统提示词从代码常量的单一来源，
 * 扩展为「config/prompts/<集名>/ 目录下的模板文件优先、内置默认回退」的可配置机制。
 * - copy-system.txt：文案生成系统提示词（支持 {style} 变量）
 * - image-suffix.txt：文生图提示词强制后缀（底图无文字约束，静态文本）
 * - scene-system.txt：动画场景生成系统提示词（支持 {width}/{height} 变量）
 * 内置回退保证：无配置文件的临时环境（如单元测试）与文件缺失场景下行为与旧版一致。
 */

/** 内置默认文案生成系统提示词（与 config/prompts/default/copy-system.txt 一致） */
const BUILTIN_COPY_SYSTEM = [
  "你是科普/历史短视频编剧。只输出严格 JSON，不要输出任何其他文字。结构：",
  '{"title":"视频标题","scenes":[{"sceneId":"s1","title":"场景标题","narration":"口播文案（60-120字）","imagePrompt":"文生图提示词"}]}',
  "要求：4-8 个场景；sceneId 依次为 s1、s2…；narration 为中文口播；imagePrompt 描述具体画面。",
  "imagePrompt 只描述纯视觉画面（场景、物体、光影、构图），画面中不要出现任何文字——所有文字由后续动画层渲染。",
].join("\n");

/** 内置默认文生图强制后缀（与 config/prompts/default/image-suffix.txt 一致） */
const BUILTIN_IMAGE_SUFFIX =
  "画面中绝对不要出现任何文字、字母、数字、书法、标志或水印，纯视觉背景图";

/** 内置默认动画场景生成系统提示词（与 config/prompts/default/scene-system.txt 一致） */
const BUILTIN_SCENE_SYSTEM = [
  "你是短视频信息动画工程师。只输出严格 JSON，不要输出任何其他文字。结构：",
  '{"html":"body 内场景元素","css":"场景样式","js":"动画编排代码"}',
  "js 只能使用传入的 tl（已暂停的 GSAP 时间轴）编排动画，例如 tl.from / tl.to / tl.fromTo；时间轴总时长 8-12 秒。",
  "硬性约束（违反将被拒绝并降级）：",
  "- 禁止任何外部 URL 与网络请求（场景完全离线自包含）；",
  "- 禁止 setTimeout/setInterval/requestAnimationFrame/Date.now/new Date/Math.random（渲染按帧确定性寻址）；",
  "- 禁止出现 </script> 与 </style>。",
  "视觉要求：中文大标题（不小于 64px）、高对比、底部字幕条呈现口播要点、元素有入场与强调动画、四周留 8% 安全区。",
  "底图为纯视觉背景图（不含任何文字）；所有文字元素必须由你的 HTML/CSS 生成，不要假设底图上有文字。",
].join("\n");

/** 一套提示词：三个命令的系统提示词/后缀，以及实际生效来源 */
export interface PromptSet {
  /** 集名（config/prompts/<集名>/ 目录名；default 为默认集） */
  name: string;
  copySystem: string;
  imageSuffix: string;
  sceneSystem: string;
  /** file：至少一个文件来自 config/prompts 目录；builtin：全部回退内置默认 */
  source: "file" | "builtin";
}

/**
 * 模板变量替换：仅替换 {已知变量名} 精确占位符，其余花括号（如 JSON 示例）原样保留。
 * @param text 模板文本
 * @param vars 变量表（如 { style: "科普" } 或 { width: 1920, height: 1080 }）
 */
export function renderTemplate(text: string, vars: Record<string, string | number>): string {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(String(value));
  }
  return out;
}

/**
 * 加载提示词集：逐文件读取 config/prompts/<集名>/ 下的模板，缺失文件回退内置默认。
 * @param options.rootDir 仓库根目录
 * @param options.setName 显式指定的集名（CLI --prompt-set 或配置 prompts.default_set）；缺省 default。
 *                        显式指定了不存在的集时报 CONFIG_INVALID（防止笔误静默落到默认提示词）。
 */
export function loadPromptSet(options: { rootDir: string; setName?: string }): PromptSet {
  const explicit = options.setName?.trim();
  const name = explicit || "default";
  const dir = join(options.rootDir, "config", "prompts", name);
  if (!existsSync(dir)) {
    if (explicit && explicit !== "default") {
      throw new VideoForgeError(
        "CONFIG_INVALID",
        `提示词集不存在：${dir}（请在 config/prompts/${name}/ 下提供 copy-system.txt 等模板文件）`,
      );
    }
    return {
      name,
      copySystem: BUILTIN_COPY_SYSTEM,
      imageSuffix: BUILTIN_IMAGE_SUFFIX,
      sceneSystem: BUILTIN_SCENE_SYSTEM,
      source: "builtin",
    };
  }
  /** 读取单个模板文件；缺失返回 undefined 由调用方回退内置默认 */
  const read = (file: string): string | undefined => {
    const path = join(dir, file);
    return existsSync(path) ? readFileSync(path, "utf-8").trim() : undefined;
  };
  const copySystem = read("copy-system.txt");
  const imageSuffix = read("image-suffix.txt");
  const sceneSystem = read("scene-system.txt");
  return {
    name,
    copySystem: copySystem ?? BUILTIN_COPY_SYSTEM,
    imageSuffix: imageSuffix ?? BUILTIN_IMAGE_SUFFIX,
    sceneSystem: sceneSystem ?? BUILTIN_SCENE_SYSTEM,
    source:
      copySystem !== undefined || imageSuffix !== undefined || sceneSystem !== undefined
        ? "file"
        : "builtin",
  };
}
