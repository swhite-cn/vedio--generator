/**
 * 分镜聚合 store（T306/T308）：`GET /api/projects/:id/storyboard` 的一次性只读数据。
 *
 * 工作台「分镜」Tab 与分镜编辑器共用；所有字段来自服务端（copy v2 / cues / timeline /
 * theme 快照 / SceneSpec / assets / quality），前端只做展示与局部编辑请求。
 */
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { apiRequest } from "../services/api";

/** 分镜镜头（copy v2 shot + 场景归属，由服务端平铺）。 */
export interface StoryboardShot {
  shotId: string;
  sceneId: string;
  chapterNo: number | null;
  sceneTitle: string;
  narration: string;
  onScreenText: string;
  emphasis: string[];
  visualType: string;
  component?: { id: string; params: Record<string, unknown> } | null;
  assetRefs: Array<{ assetId: string; label?: string; role?: string }>;
  anchorKeys: string[];
  imagePath?: string;
  audioPath?: string;
  audioDurationMs?: number;
  transitionIn: string;
  transitionOut: string;
  sourceRef?: { label: string; url?: string } | null;
  targetDurationMs?: number;
}

/** 分镜场景（章节）分组。 */
export interface StoryboardScene {
  sceneId: string;
  chapterNo: number | null;
  title: string;
  shotIds: string[];
}

/** 句级 cue（narration / animation 联合）。 */
export interface StoryboardCue {
  cueId: string;
  shotId: string;
  kind: "narration" | "animation";
  startMs?: number;
  endMs?: number;
  atMs?: number;
  durationMs?: number;
  text?: string;
  effect?: string;
}

/** 时间轴 v2 子集。 */
export interface StoryboardTimeline {
  fps: number;
  tailPauseMs: number;
  timingSource: string;
  totalMs: number;
  shots: Array<{ shotId: string; sceneId: string; startMs: number; endMs: number; durationMs: number }>;
  cues: StoryboardCue[];
}

/** 质检报告子集。 */
export interface StoryboardQuality {
  version: string;
  runId: string;
  generatedAt: string;
  checks: Array<{
    id: string;
    label: string;
    status: string;
    violations: Array<{ shotId?: string; detail: string }>;
  }>;
}

/** 聚合响应。 */
export interface StoryboardData {
  project: {
    id: string;
    name: string;
    contractVersion?: string;
    themeId?: string | null;
    profile: string;
  };
  contractVersion?: string;
  copy: {
    topic?: string;
    style?: string;
    title?: string;
    theme?: { id: string };
    styleAnchors?: Array<{
      key: string;
      label?: string;
      color?: string;
      assetId?: string;
      assetPath?: string;
      seed?: number;
    }>;
    scenes?: Array<{ sceneId: string; chapterNo?: number; title: string; shots: unknown[] }>;
  } | null;
  scenes: StoryboardScene[];
  shots: StoryboardShot[];
  cues: StoryboardCue[];
  timeline: StoryboardTimeline | null;
  theme: { theme?: { id: string; name: string; tokens: Record<string, unknown> } } | null;
  spec: unknown;
  components: Array<{ id: string; name: string; category: string }>;
  assets: Array<{ id: string; label: string; kind: string; source: string; visual_category?: string | null }>;
  quality: StoryboardQuality | null;
  subtitles: { relativePath: string } | null;
  specPath?: string;
}

export const useStoryboardStore = defineStore("storyboard", () => {
  /** 聚合数据；未加载时为 null。 */
  const data = ref<StoryboardData | null>(null);
  /** 加载中。 */
  const loading = ref(false);
  /** 最近一次错误。 */
  const error = ref<unknown>(null);
  /** 已加载的项目 id（避免重复请求）。 */
  const projectId = ref("");

  /** 镜头按 sceneId 分组（保持服务端顺序）。 */
  const shotsByScene = computed(() => {
    const map = new Map<string, StoryboardShot[]>();
    for (const shot of data.value?.shots ?? []) {
      const list = map.get(shot.sceneId) ?? [];
      list.push(shot);
      map.set(shot.sceneId, list);
    }
    return map;
  });

  /** cue 按 shotId 分组。 */
  const cuesByShot = computed(() => {
    const map = new Map<string, StoryboardCue[]>();
    for (const cue of data.value?.cues ?? []) {
      const list = map.get(cue.shotId) ?? [];
      list.push(cue);
      map.set(cue.shotId, list);
    }
    return map;
  });

  /** 主题色板（快照缺失时返回空对象）。 */
  const themeTokens = computed(
    () => (data.value?.theme?.theme?.tokens ?? {}) as Record<string, unknown>,
  );

  /** 风格锚列表（copy v2 快照）。 */
  const styleAnchors = computed(() => data.value?.copy?.styleAnchors ?? []);

  /** 时间轴镜头段（缺失时按空数组）。 */
  const spans = computed(() => data.value?.timeline?.shots ?? []);

  /**
   * 加载项目分镜聚合数据。
   * @param id 项目 id
   * @param force 为 true 时忽略缓存重新请求
   * @returns 聚合数据
   */
  async function load(id: string, force = false): Promise<StoryboardData> {
    if (!force && data.value && projectId.value === id) {
      return data.value;
    }
    loading.value = true;
    error.value = null;
    try {
      const result = await apiRequest<StoryboardData>(
        `/api/projects/${encodeURIComponent(id)}/storyboard`,
      );
      data.value = result;
      projectId.value = id;
      console.info(
        `[web-store] 分镜数据已加载：${result.shots.length} 镜 / ${result.cues.length} cue`,
      );
      return result;
    } catch (caught) {
      error.value = caught;
      throw caught;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 强制重拉当前项目（SSE `shot.updated` / `asset.bound` 后使用）。
   */
  async function refresh(): Promise<void> {
    if (projectId.value) {
      await load(projectId.value, true);
    }
  }

  /** 清空缓存（切换到另一个项目前调用）。 */
  function reset(): void {
    data.value = null;
    projectId.value = "";
    error.value = null;
  }

  return {
    data,
    loading,
    error,
    projectId,
    shotsByScene,
    cuesByShot,
    themeTokens,
    styleAnchors,
    spans,
    load,
    refresh,
    reset,
  };
});
