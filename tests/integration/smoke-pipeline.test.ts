import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadSystemConfig } from "../../packages/pipeline/src/config";
import { renderSceneSequence } from "../../packages/renderer/src/render-sequence";
import { getProfile, vendorGsap, wrapSceneDocument } from "../../packages/template-sdk/src/index";

/**
 * 真 Chromium 渲染冒烟测试（pnpm test:smoke）。
 * 背景：渲染曾出现"mock 单测全绿、真机 seek 永久挂起"的事故——
 * page.evaluate 隐式返回 GSAP timeline 实例导致 CDP 序列化挂起，只有真实浏览器能暴露。
 * 本测试不 mock playwright，用本机 Chrome 跑通"启动 → GSAP 寻帧 → JPEG 截图 → 多 page 并行"全路径；
 * 若挂起回归，用例会超时报错而非静默通过。找不到本机 Chrome 时整体跳过。
 */

/** 探测本机 Chromium 可执行文件：优先仓库配置，其次常见安装路径；找不到返回 undefined（测试跳过） */
function detectChromium(rootDir: string): string | undefined {
  try {
    const configured = loadSystemConfig({ rootDir }).tools.chromium_path;
    if (configured && existsSync(configured)) return configured;
  } catch {
    // 配置不可用时继续探测常见路径
  }
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ];
  return candidates.find((p) => existsSync(p));
}

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const chromiumPath = detectChromium(rootDir);

describe.skipIf(!chromiumPath)("真 Chromium 渲染冒烟", () => {
  let workDir = "";
  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it(
    "GSAP 场景在超时内逐帧渲染为连续编号 JPEG（防 seek 序列化挂起回归）",
    { timeout: 60_000 },
    async () => {
      workDir = mkdtempSync(join(tmpdir(), "vf-smoke-"));
      vendorGsap(join(workDir, "vendor"));
      const spec = getProfile("LANDSCAPE_1080P");
      const scenesDir = join(workDir, "scenes");
      mkdirSync(scenesDir, { recursive: true });
      /** 构造最小合法 GSAP 场景 HTML（离线自包含、注册全局时间轴） */
      const makeScene = (sceneId: string, title: string) => {
        const htmlPath = join(scenesDir, `${sceneId}.html`);
        writeFileSync(
          htmlPath,
          wrapSceneDocument(
            {
              html: `<h1 class="t">${title}</h1>`,
              css: ".t{font-size:96px;color:#fff}",
              js: 'tl.from(".t", { opacity: 0, y: 40, duration: 0.2 });',
            },
            { width: spec.width, height: spec.height },
          ),
          "utf-8",
        );
        return { scene: { sceneId, title, narration: "冒烟口播", htmlPath }, durationMs: 300 };
      };
      const startedAt = Date.now();
      const result = await renderSceneSequence({
        buildRoot: join(workDir, "build"),
        profile: "LANDSCAPE_1080P",
        scenes: [makeScene("s1", "冒烟一"), makeScene("s2", "冒烟二")],
        chromiumPath,
        workers: 2,
      });
      // 300ms @30fps = 9 帧/场景，两场景共 18 帧、全局连续编号
      expect(result.frameCount).toBe(18);
      const files = readdirSync(result.framesDir).sort();
      expect(files).toHaveLength(18);
      expect(files[0]).toBe("00000001.jpg");
      expect(files[17]).toBe("00000018.jpg");
      // 帧必须为真实 JPEG（magic bytes FF D8 FF），防止截图参数被改回 PNG
      const head = readFileSync(join(result.framesDir, files[0])).subarray(0, 3);
      expect([...head]).toEqual([0xff, 0xd8, 0xff]);
      console.info(`[smoke] 真 Chromium 渲染 18 帧耗时 ${Date.now() - startedAt}ms`);
    },
  );
});
