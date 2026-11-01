import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { VideoForgeError, type OutputProfile } from "@videoforge/shared";
import { getProfile, type SceneData } from "@videoforge/template-sdk";
import { renderSceneFrames, sceneFrameCount } from "./render.js";

/**
 * 单浏览器复用地渲染全部场景，帧按全局连续编号直接写入统一帧目录。
 * 浏览器只启动一次；workers > 1 时开多个 page 并行——各场景帧号起点预先按顺序累加分配，
 * 与并行度无关，因此多 page 写入同一目录互不冲突，产物与串行完全一致。
 * @param options 渲染参数（workers 缺省 1 即单 page 串行）
 * @returns 统一帧目录与总帧数
 */
export async function renderSceneSequence(options: {
  buildRoot: string;
  profile: OutputProfile;
  scenes: Array<{ scene: SceneData; durationMs: number }>;
  chromiumPath?: string;
  workers?: number;
  /** 单场景渲染完成回调（在各并行分片内触发，供运行轨迹做场景级观测） */
  onSceneRendered?: (info: {
    sceneId: string;
    frames: number;
    firstFrame: number;
    durationMs: number;
  }) => void;
}): Promise<{ framesDir: string; frameCount: number }> {
  const spec = getProfile(options.profile);
  const profileDir = options.profile === "LANDSCAPE_1080P" ? "landscape" : "portrait";
  const framesDir = join(options.buildRoot, "render", profileDir, "frames");
  mkdirSync(framesDir, { recursive: true });

  const browser = await chromium
    .launch({ executablePath: options.chromiumPath || undefined })
    .catch((err: unknown) => {
      throw new VideoForgeError("TOOL_UNAVAILABLE", `Chromium 启动失败：${(err as Error).message}`);
    });
  try {
    // 预计算各场景帧号起点（前缀和）：先定编号再并行，保证帧号全局连续
    const firstFrames: number[] = [];
    let frameCount = 0;
    for (const { durationMs } of options.scenes) {
      firstFrames.push(frameCount + 1);
      frameCount += sceneFrameCount(durationMs, spec.fps);
    }
    const workerCount = Math.max(1, Math.min(options.workers ?? 1, options.scenes.length));
    // round-robin 分片：各 page 拿到的场景总帧数更均衡（连续分段易受长短场景不均影响）
    const shards = Array.from({ length: workerCount }, () => [] as number[]);
    options.scenes.forEach((_, index) => shards[index % workerCount].push(index));
    await Promise.all(
      shards.map(async (shard) => {
        const page = await browser.newPage({
          viewport: { width: spec.width, height: spec.height },
          deviceScaleFactor: 1,
        });
        try {
          for (const index of shard) {
            const { scene, durationMs } = options.scenes[index];
            const sceneStartedAt = Date.now();
            const frames = await renderSceneFrames({
              page,
              scene,
              durationMs,
              spec,
              framesDir,
              firstFrame: firstFrames[index],
            });
            options.onSceneRendered?.({
              sceneId: scene.sceneId,
              frames,
              firstFrame: firstFrames[index],
              durationMs: Date.now() - sceneStartedAt,
            });
          }
        } finally {
          await page.close();
        }
      }),
    );
    return { framesDir, frameCount };
  } finally {
    await browser.close();
  }
}
