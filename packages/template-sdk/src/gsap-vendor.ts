import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { VideoForgeError } from "@videoforge/shared";

/**
 * 把 gsap.min.js 复制到目标目录（通常为 <工作目录>/vendor），供场景 HTML 以相对路径引用。
 * 已存在时直接复用；依赖缺失时抛 CONFIG_INVALID 提示重新安装依赖。
 * @param targetDir 目标目录
 * @returns 落盘后的 gsap.min.js 绝对路径
 */
export function vendorGsap(targetDir: string): string {
  const require = createRequire(import.meta.url);
  let source: string;
  try {
    source = require.resolve("gsap/dist/gsap.min.js");
  } catch {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      "未找到 gsap 依赖，请在仓库根目录执行 pnpm install",
    );
  }
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, "gsap.min.js");
  if (!existsSync(target)) {
    copyFileSync(source, target);
  }
  return target;
}
