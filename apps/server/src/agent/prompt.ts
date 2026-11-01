import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { resolveSkillDirs } from "./skills.js";

/**
 * 系统提示注入与资源加载器构造（见设计文档 §5.6）。
 *
 * 注入方式说明（SPIKE §7.1）：
 * - 文档写的是 `DefaultResourceLoader({ systemPromptOverride })`，但该字段实际类型是
 *   `(base: string | undefined) => string | undefined`（**是函数不是字符串**）；
 *   注入一段固定提示最简写法是 `systemPrompt: "..."`（完整字符串直给），因此这里用 `systemPrompt`。
 * - 技能注入用 `additionalSkillPaths` 传**绝对路径**（受控偏差见 `skills.ts`）。
 */

/** 系统提示正文（中文字符串常量）：角色、工作目录约定、引擎纪律、输出纪律、行为边界。 */
const SYSTEM_PROMPT = [
  "你是 VideoForge 的视频流水线操作员，服务面向科普与历史类中文短视频。",
  "",
  "## 工作目录约定",
  "你被锁定在**当前项目目录**内工作，所有产物都写入这个目录，布局固定为：",
  "- `copy.json`：分镜文案（口播、画面描述、时长）",
  "- `images/`：逐场景配图",
  "- `scenes/`：逐场景 HTML+GSAP 动画页面",
  "- `audio/`：逐场景语音",
  "- `timeline.json`：按语音实测时长生成的时间轴",
  "- `build/render/<profile>/frames/`：逐帧渲染的 JPEG 帧序列",
  "- `final.mp4`：最终成片，**成片必须命名为 `final.mp4`**，不要改成其它名字。",
  "",
  "## 引擎纪律",
  "阶段顺序由工作流引擎决定：`copy → image → scene → tts → storyboard → render → compose`。",
  "- 收到某阶段的指令时，**只执行该阶段、只调用对应的那一个阶段工具**；",
  "- 不要自行跳阶段、不要越权推进后续阶段、不要未经指令就盲目跑完整条链路；",
  "- 推进与重试节奏由引擎掌握，你的职责是把当前这一阶段做好并如实汇报结果。",
  "",
  "## 输出纪律",
  "- 绝不向用户复述任何密钥、令牌或密码（包括环境变量名对应的取值）；",
  "- 失败时给出稳定的错误码与可执行的下一步建议，而不是笼统地说“出错了”。",
  "",
  "## 行为边界",
  "- 只在当前项目目录内写入文件；",
  "- 不修改仓库源码与配置文件；",
  "- 不读取或回显 `.env.local` 的内容；",
  "- 不删除项目以外的任何文件。",
].join("\n");

/**
 * 构造面向本项目的系统提示（见设计文档 §5.6 的 5 条要求）。
 * 固定文本、不含运行时路径细节，便于测试与稳定复用。
 * @returns 系统提示全文
 */
export function buildSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

/** `createAgentResourceLoader` 的入参。 */
export interface AgentResourceLoaderOptions {
  /** 仓库根目录（用于定位 `.trae/skills`）。 */
  rootDir: string;
  /** 会话 cwd（项目目录）：内置工具与资源发现的默认基准。 */
  projectDir: string;
  /** Pi 全局配置目录（本机应指向仓库内受控目录，不要污染用户主目录）。 */
  agentDir: string;
}

/**
 * 构造 Pi 的资源加载器：注入系统提示与技能目录。
 * - `systemPrompt` 用**完整字符串直给**（SPIKE §7.1：`systemPromptOverride` 是函数，直给字符串更简）；
 * - `additionalSkillPaths` 用**绝对路径**（受控偏差见 `skills.ts`）。
 *
 * 注意：`DefaultResourceLoader` 在构造时不会自动加载资源，`getSystemPrompt()` 需在 `reload()` 后才可见。
 * @param options 依赖项（rootDir / projectDir / agentDir）
 * @returns 已配置好的 `DefaultResourceLoader` 实例
 */
export function createAgentResourceLoader(
  options: AgentResourceLoaderOptions,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: options.projectDir,
    agentDir: options.agentDir,
    systemPrompt: buildSystemPrompt(),
    additionalSkillPaths: resolveSkillDirs(options.rootDir),
  });
}

/**
 * 解析 Pi 的全局配置目录：本地化为 `<rootDir>/.pi/agent`，避免写到用户主目录 `~/.pi/agent`。
 * 只返回路径字符串，不在此创建目录或读写配置。
 * @param rootDir 仓库根目录
 * @returns `<rootDir>/.pi/agent` 绝对路径
 */
export function resolveAgentDir(rootDir: string): string {
  return join(rootDir, ".pi", "agent");
}
