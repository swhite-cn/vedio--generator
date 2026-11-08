import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VideoForgeError } from "@videoforge/shared";

/**
 * 提示词集加载：把 copy:gen / image:gen / scene:gen 的系统提示词从代码常量的单一来源，
 * 扩展为「config/prompts/<集名>/ 目录下的模板文件优先、内置默认回退」的可配置机制。
 * - copy-system.txt：v1 文案生成系统提示词（支持 {style} 变量）
 * - copy-v2-system.txt：v2 文案提示词（一句一镜、风格锚、来源）
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

/** 内置默认文案 v2 提示词（与 config/prompts/default/copy-v2-system.txt 一致） */
const BUILTIN_COPY_V2_SYSTEM = [
  "你是科普/历史短视频编剧。只输出严格 JSON，不要输出任何其他文字。结构：",
  '{"title":"视频标题","styleAnchors":[{"key":"mercury","label":"水银","color":"#C9CED6"}],"scenes":[{"sceneId":"s1","chapterNo":1,"title":"章节标题","shots":[{"shotId":"sh-001","narration":"一句口播","onScreenText":"屏幕文字","emphasis":["关键词"],"visualType":"component","assetRefs":[],"anchorKeys":["mercury"],"transitionIn":"hard-cut","transitionOut":"hard-cut","sourceRef":{"label":"来源名"}}]}]}',
  "要求：一句一镜，每镜口播 12-32 字、约 2-4 秒；全片 40-80 镜；每个 scene 是叙事章节，含 6-12 镜。",
  "shotId 全片唯一，依次为 sh-001、sh-002…；sceneId 依次为 s1、s2…；chapterNo 从 1 开始。",
  "onScreenText 不超过 18 字；emphasis 只放需要强调的 1-3 个词。",
  "visualType 只能是 component、image、video、symbol 之一；不要输出 component 字段，组件选型由后续场景模板阶段完成。",
  "涉及数据、事实或他人观点的镜头，必须提供 sourceRef.label；纯视觉镜头可为 null。",
  "sourceRef.label 不超过 20 字（来源标签单行展示），可选 note 不超过 40 字。",
  "开头 1-2 镜必须给出钩子：反常识结论、具体场景或悬念，禁止“今天我们来聊聊”这类空泛开场。",
  "中段可用设问推进（每 6-10 镜最多一次），问题放在本镜，答案留到下一镜，不要自问自答。",
  "涉及医疗、法律、金融投资等风险主题时，最后一个镜头的 narration 或 onScreenText 必须包含简短免责提示（如“具体请咨询专业人士”）；其他主题不强行添加。",
  "styleAnchors 给出 3-6 个全片复用的符号，key 用英文，label 为中文，color 为 #RRGGBB。",
  "transitionIn/transitionOut 只能是 hard-cut、title-card、fade-120；默认 hard-cut，仅在情绪转折处使用 fade-120。",
].join("\n");

/** 内置默认场景选型提示词（与 config/prompts/default/scene-v2-system.txt 一致） */
const BUILTIN_SCENE_V2_SYSTEM = [
  "你是短视频场景编排器。只输出严格 JSON，不要输出任何其他文字。",
  "任务：为 visualType=component 的镜头从组件注册表中选择组件并填写参数；禁止输出 HTML/CSS/JS。",
  "可用组件（ID / 类别 / 名称 / 参数）：",
  "{catalog}",
  "输出结构：",
  '{"shots":[{"shotId":"sh-001","componentId":"keyword-block","props":{"title":"一句屏上文字","underline":"sweep"}}]}',
  "要求：每个 component 镜头恰好一条；只使用清单中的组件 ID 与参数键；",
  "文本只能压缩镜头口播或屏上文字，不得新增事实；参数超长或非法枚举会被拒绝并降级。",
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
  /** 契约 v2 的文案提示词（一句一镜）；v1 项目不会使用。 */
  copyV2System: string;
  imageSuffix: string;
  sceneSystem: string;
  /** 契约 v2 的场景选型提示词（只选组件填参数）；v1 项目不会使用。 */
  sceneV2System: string;
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
      copyV2System: BUILTIN_COPY_V2_SYSTEM,
      imageSuffix: BUILTIN_IMAGE_SUFFIX,
      sceneSystem: BUILTIN_SCENE_SYSTEM,
      sceneV2System: BUILTIN_SCENE_V2_SYSTEM,
      source: "builtin",
    };
  }
  /** 读取单个模板文件；缺失返回 undefined 由调用方回退内置默认 */
  const read = (file: string): string | undefined => {
    const path = join(dir, file);
    return existsSync(path) ? readFileSync(path, "utf-8").trim() : undefined;
  };
  const copySystem = read("copy-system.txt");
  const copyV2System = read("copy-v2-system.txt");
  const imageSuffix = read("image-suffix.txt");
  const sceneSystem = read("scene-system.txt");
  const sceneV2System = read("scene-v2-system.txt");
  return {
    name,
    copySystem: copySystem ?? BUILTIN_COPY_SYSTEM,
    copyV2System: copyV2System ?? BUILTIN_COPY_V2_SYSTEM,
    imageSuffix: imageSuffix ?? BUILTIN_IMAGE_SUFFIX,
    sceneSystem: sceneSystem ?? BUILTIN_SCENE_SYSTEM,
    sceneV2System: sceneV2System ?? BUILTIN_SCENE_V2_SYSTEM,
    source:
      copySystem !== undefined ||
      copyV2System !== undefined ||
      imageSuffix !== undefined ||
      sceneSystem !== undefined ||
      sceneV2System !== undefined
        ? "file"
        : "builtin",
  };
}
