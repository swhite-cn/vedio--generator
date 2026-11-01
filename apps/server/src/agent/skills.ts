import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 技能目录注入（见设计文档 §5.5）。
 *
 * 受控偏差（与文档 §5.5 的差异，理由见下）：
 * 文档写的是「`.pi/settings.json` 声明 `{"skills": ["../.trae/skills"]}`」——该相对路径从项目 `.pi` 目录解析。
 * 但本项目的**项目目录位于 `<storage_root>/users/<uid>/projects/<name>`，不在仓库根目录下**，
 * 相对路径无法稳定解析到仓库内的 `.trae/skills`。
 *
 * 因此改为：用 Pi 的 `DefaultResourceLoader({ additionalSkillPaths })` 注入
 * **仓库根目录下的绝对路径 `<rootDir>/.trae/skills`**（见 `prompt.ts`）。
 * 语义与文档等价（同一套 skill、SKILL.md 原地保留、单一来源不变），且无路径歧义。
 * 渐进式披露由 Pi 自己处理：系统提示只常驻每个 skill 的 name/description，模型按需 `read SKILL.md`。
 */

/** 运行时注入的技能目录（相对仓库根目录）：`.trae/skills` 是唯一的 skill 扩展点。 */
export const SKILLS_RELATIVE_DIR = ".trae/skills";

/**
 * 返回真实存在的技能目录绝对路径列表（不存在则返回空数组，不抛错）。
 * 用 `join` 逐段拼接（而非字符串拼接），兼容 Windows 分隔符。
 * @param rootDir 仓库根目录
 * @returns 存在的技能目录绝对路径列表（0 或 1 项）
 */
export function resolveSkillDirs(rootDir: string): string[] {
  const dir = join(rootDir, ".trae", "skills");
  return existsSync(dir) ? [dir] : [];
}
