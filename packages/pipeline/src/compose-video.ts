import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { linkSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VideoForgeError, type OutputProfile, type TimelineDocV2 } from "@videoforge/shared";
import { CAPTIONS_RELATIVE_PATH } from "./captions-ass.js";
import { composeVideo } from "./compose.js";
import { readCopyDocument } from "./copy-contract.js";
import { loadSystemConfig } from "./config.js";
import { concatAudioFiles } from "./media.js";
import { readTimelineV2 } from "./timeline-v2.js";

/**
 * compose 阶段能力（v2，T205）：消费镜头级帧目录（T204 产物），物化连续帧序列后合成；
 * 可选烧录 ASS 字幕、混入 BGM、对混音音轨做 loudnorm（响度目标可配）。
 * T501 起 legacy v1 合成路径（场景音频 concat + 统一帧目录）已随渲染通道移除。
 * 仅读取显式入参，不读写进程 argv/stdout。
 */

/** 镜头帧文件的命名模式（Remotion renderFrames 的 `element-[frame].[ext]`）。 */
const SHOT_FRAME_PATTERN = /^element-(\d+)\.jpe?g$/;

/**
 * 把镜头级帧目录物化为连续编号的帧序列（T205）。
 * 按时间轴顺序遍历镜头，把 `shots/<shotId>/element-N.jpeg` 硬链接（跨卷/不支持时回退复制）
 * 为 `<outDir>/%08d.jpeg`；镜头帧数必须与时间轴帧数一致（缺帧视为渲染不完整）；
 * 片尾停顿通过重复最后一帧表达。输出目录先清空再重建，保证重跑幂等。
 * @param options.shotsDir 镜头帧根目录（`build/render/<dir>/shots`）
 * @param options.timeline timeline v2（镜头顺序与帧数权威）
 * @param options.outDir 连续帧输出目录
 * @returns 物化总帧数（含尾停顿帧）
 * @throws VideoForgeError(`CONFIG_INVALID`) 镜头目录缺失或帧数不足
 */
export function materializeShotFrames(options: {
  shotsDir: string;
  timeline: TimelineDocV2;
  outDir: string;
}): number {
  const fps = options.timeline.fps;
  const tailPauseFrames = Math.floor((options.timeline.tailPauseMs * fps) / 1000);

  // 幂等：清空旧物化产物再重建（重跑 compose 不得残留上一版帧）
  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(options.outDir, { recursive: true });

  let written = 0;
  for (const shot of options.timeline.shots) {
    const expectedFrames = Math.max(1, Math.floor((shot.durationMs * fps) / 1000));
    const shotDir = join(options.shotsDir, shot.shotId);
    if (!existsSync(shotDir)) {
      throw new VideoForgeError(
        "CONFIG_INVALID",
        `镜头 ${shot.shotId} 的帧目录不存在：${shotDir}（请先完成 render_frames）`,
      );
    }
    const frames = readdirSync(shotDir)
      .map((name) => {
        const match = SHOT_FRAME_PATTERN.exec(name);
        return match ? { name, frame: Number(match[1]) } : undefined;
      })
      .filter((item): item is { name: string; frame: number } => item !== undefined)
      .sort((left, right) => left.frame - right.frame);
    if (frames.length < expectedFrames) {
      throw new VideoForgeError(
        "CONFIG_INVALID",
        `镜头 ${shot.shotId} 帧数不足：期望 ${expectedFrames} 帧，实际 ${frames.length} 帧（${shotDir}）`,
      );
    }
    for (const item of frames.slice(0, expectedFrames)) {
      const source = join(shotDir, item.name);
      const target = join(options.outDir, `${String(written + 1).padStart(8, "0")}.jpeg`);
      try {
        linkSync(source, target);
      } catch {
        // 跨卷或文件系统不支持硬链接时回退复制
        copyFileSync(source, target);
      }
      written += 1;
    }
  }

  // 尾停顿：重复最后一帧（无镜头帧覆盖的区间冻结画面）
  if (tailPauseFrames > 0 && options.timeline.shots.length > 0) {
    const lastSource = join(options.shotsDir, options.timeline.shots[options.timeline.shots.length - 1]!.shotId);
    const lastInShot = readdirSync(lastSource)
      .map((name) => {
        const match = SHOT_FRAME_PATTERN.exec(name);
        return match ? { name, frame: Number(match[1]) } : undefined;
      })
      .filter((item): item is { name: string; frame: number } => item !== undefined)
      .sort((left, right) => right.frame - left.frame)[0];
    const source = join(lastSource, lastInShot!.name);
    for (let index = 0; index < tailPauseFrames; index += 1) {
      const target = join(options.outDir, `${String(written + 1).padStart(8, "0")}.jpeg`);
      try {
        linkSync(source, target);
      } catch {
        copyFileSync(source, target);
      }
      written += 1;
    }
  }
  return written;
}

/**
 * v2 compose 阶段能力（T205）：镜头级帧目录 → 物化连续帧 → 合成 final.mp4。
 * 字幕烧录默认开启（缺 `captions/subtitle.ass` 报 CONFIG_INVALID），可关；
 * BGM 路径由调用方解析（服务端负责把资产 ID 解析为项目内绝对路径）；
 * 响度目标透传给 loudnorm（缺省不做响度处理）。
 * @param options.rootDir 仓库根目录（用于加载配置获取 ffmpeg 路径）
 * @param options.copyPath 输入 copy.json 路径（v2）
 * @param options.outFile 最终 mp4 输出路径
 * @param options.profile 输出画幅（决定 build 下的目录名；帧率以 timeline v2 为准）
 * @param options.buildRoot 构建根目录；缺省用 copy.json 同级的 build 目录
 * @param options.bgmPath BGM 绝对路径；缺省无 BGM
 * @param options.bgmVolume BGM 音量，取值 (0,1]
 * @param options.loudnessTarget 响度目标（LUFS，[-70,-5]）；缺省不做 loudnorm
 * @param options.burnCaptions 是否烧录 ASS 字幕；缺省 true
 * @param options.runId 运行 ID（诊断定位用）
 * @returns 最终视频路径
 */
export async function composeVideoStepV2(options: {
  rootDir: string;
  copyPath: string;
  outFile: string;
  profile: OutputProfile;
  buildRoot?: string;
  bgmPath?: string;
  bgmVolume?: number;
  loudnessTarget?: number;
  burnCaptions?: boolean;
  runId?: string;
}): Promise<string> {
  const projectDir = dirname(options.copyPath);
  // v2 compose 只消费 v2 copy：v1 走 composeVideoStep
  const document = readCopyDocument(options.copyPath);
  if (document.version !== "2") {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `compose v2 需要 copy.json v2，当前项目是 v1：${options.copyPath}`,
    );
  }
  const timeline = readTimelineV2(join(projectDir, "timeline.json"));
  const config = loadSystemConfig({ rootDir: options.rootDir });
  const profileDir = options.profile === "LANDSCAPE_1080P" ? "landscape" : "portrait";
  const buildRoot = options.buildRoot?.trim() || join(projectDir, "build");
  const composeDir = join(buildRoot, "compose", profileDir);

  // 1) 旁白：按时间轴顺序取逐镜音频并 concat（缺音频视为 tts 未完成）
  const audioByShot = new Map(
    document.doc.scenes.flatMap((scene) => scene.shots.map((shot) => [shot.shotId, shot.audioPath])),
  );
  const inputs = timeline.shots.map((shot) => {
    const audioPath = audioByShot.get(shot.shotId);
    if (!audioPath) {
      throw new VideoForgeError(
        "CONFIG_INVALID",
        `镜头 ${shot.shotId} 缺少 audioPath，请先完成 tts_generate`,
      );
    }
    return join(projectDir, audioPath);
  });
  const audioAll = await concatAudioFiles({
    ffmpegPath: config.tools.ffmpeg_path,
    inputs,
    outputPath: join(composeDir, "voice-all.mp3"),
    workDir: composeDir,
  });

  // 2) 帧：镜头级目录物化为连续序列（含尾停顿）
  const framesDir = join(composeDir, "frames");
  materializeShotFrames({
    shotsDir: join(buildRoot, "render", profileDir, "shots"),
    timeline,
    outDir: framesDir,
  });

  // 3) 字幕：默认烧录；关闭或文件缺失语义见下
  const burnCaptions = options.burnCaptions ?? true;
  const assPath = join(projectDir, CAPTIONS_RELATIVE_PATH);
  if (burnCaptions && !existsSync(assPath)) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `字幕轨不存在（${CAPTIONS_RELATIVE_PATH}），请先完成 captions_generate 或关闭字幕`,
    );
  }

  // 4) 合成：ASS 用相对路径 + cwd=projectDir，规避 Windows 盘符在 filter 中的转义
  return composeVideo({
    ffmpegPath: config.tools.ffmpeg_path,
    framesPattern: join(framesDir, "%08d.jpeg"),
    audioPath: audioAll,
    outputPath: options.outFile,
    fps: timeline.fps,
    logPath: join(composeDir, "ffmpeg.log"),
    bgmPath: options.bgmPath,
    bgmVolume: options.bgmVolume,
    loudnessTarget: options.loudnessTarget,
    assPath: burnCaptions ? CAPTIONS_RELATIVE_PATH : undefined,
    cwd: projectDir,
  });
}
