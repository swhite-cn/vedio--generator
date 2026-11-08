<script setup lang="ts">
/**
 * 工作台右侧 4 Tab（方案 §8.5 第 5 页 / T306）：
 * 阶段进度 / 分镜时间轴（缩略）/ 项目资产 / 流水线产物。
 *
 * 数据来源：
 * - 阶段：`workbench.stages`（SSE + run 详情）；
 * - 分镜：`storyboard` store（`GET /api/projects/:id/storyboard`）；
 * - 资产：父组件传入的 `assets.items`（`GET /api/projects/:id/assets`）；
 * - 产物：`FinalOutputCard` + 既有 `ArtifactTabs`。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getMediaTicket } from "../services/media-ticket";
import { buildMediaUrl } from "./media-url";
import { formatElapsed } from "./format";
import {
  formatMediaDuration,
  mapRunStatus,
  statusTone,
} from "./state-mapping";
import { useStoryboardStore } from "../stores/storyboard";
import type { ProjectAsset } from "../stores/assets";
import type { ArtifactIndex, RunSummary, StageProgress } from "../stores/workbench-reducer";
import type { Project } from "../stores/projects";
import StageSteps from "./StageSteps.vue";
import ArtifactTabs from "./ArtifactTabs.vue";
import FinalOutputCard from "./FinalOutputCard.vue";
import VfPill from "./ui/VfPill.vue";
import VfButton from "./ui/VfButton.vue";

const props = withDefaults(
  defineProps<{
    /** 归属项目。 */
    project?: Project | null;
    /** 当前 run（无 run 时为 null）。 */
    run?: RunSummary | null;
    /** 阶段进度（8 项）。 */
    stages?: StageProgress[];
    /** 产物索引。 */
    artifacts?: ArtifactIndex | null;
    /** 项目资产。 */
    assets?: ProjectAsset[];
    /** 待审核阶段。 */
    reviewStage?: string | null;
    /** run 成功标记（默认切「产物」Tab）。 */
    finalReady?: boolean;
    /** 受控 Tab。 */
    activeTab?: string;
    /** `shot.updated` / `asset.bound` 触发的刷新令牌。 */
    storyboardRefreshToken?: number;
    /** `quality.updated` 触发的刷新令牌。 */
    qualityRefreshToken?: number;
  }>(),
  {
    project: null,
    run: null,
    stages: () => [],
    artifacts: null,
    assets: () => [],
    reviewStage: null,
    finalReady: false,
    activeTab: "stage",
    storyboardRefreshToken: 0,
    qualityRefreshToken: 0,
  },
);

const emit = defineEmits<{
  /** Tab 同步。 */
  (event: "update:activeTab", value: string): void;
  /** 引用项目资产到对话草稿。 */
  (event: "reference-asset", assetId: string): void;
  /** 打开分镜编辑器。 */
  (event: "open-storyboard"): void;
  /** 从产物面板发起定向重生成（v2 按镜头粒度）。 */
  (event: "regenerate", payload: { stage: "image" | "scene" | "tts"; shotId: string }): void;
  /** 点击阶段（滚动定位对话流中的工具卡片）。 */
  (event: "select-stage", stage: string): void;
}>();

const router = useRouter();
const storyboard = useStoryboardStore();

/** 媒体票据。 */
const mediaTicket = ref("");
/** 产物子面板当前 Tab（文案/图片/场景/音频/时间轴/成片）。 */
const artifactTab = ref("copy");
/** 质检报告状态（来自 storyboard store）。 */
const quality = computed(() => storyboard.data?.quality ?? null);

/** 受控 Tab 双向绑定。 */
const current = computed<string>({
  get: () => props.activeTab,
  set: (value: string) => emit("update:activeTab", value),
});

/** 运行耗时（运行中无结束时间，按契约显示破折号，不用前端回推）。 */
const runElapsed = computed(() => formatElapsed(props.run?.started_at, props.run?.ended_at));

/** 分镜场景分组（保持服务端顺序）。 */
const sceneGroups = computed(() =>
  (storyboard.data?.scenes ?? []).map((scene) => ({
    scene,
    shots: storyboard.shotsByScene.get(scene.sceneId) ?? [],
  })),
);

/** 按 shotId 取缩略图地址。 */
function shotThumb(shotId: string): string {
  const shot = storyboard.data?.shots.find((item) => item.shotId === shotId);
  if (!shot?.imagePath || !props.project) return "";
  return buildMediaUrl(props.project, shot.imagePath, mediaTicket.value);
}

/** 取镜头 cue 数。 */
function cueCount(shotId: string): number {
  return storyboard.cuesByShot.get(shotId)?.length ?? 0;
}

/** 质检状态对应的 pill 色调。 */
function qualityTone(status: string): "success" | "danger" | "warning" | "neutral" {
  if (status === "pass") return "success";
  if (status === "fail") return "danger";
  if (status === "warn") return "warning";
  return "neutral";
}

/**
 * 加载分镜聚合数据与媒体票据。
 * @param force 强制重拉
 */
async function loadStoryboard(force = false): Promise<void> {
  if (!props.project?.id) return;
  try {
    await storyboard.load(props.project.id, force);
  } catch (error) {
    console.warn("[web] 分镜聚合数据加载失败", error);
  }
  try {
    mediaTicket.value = await getMediaTicket();
  } catch (error) {
    console.warn("[web] 媒体票据获取失败", error);
  }
}

/** 打开分镜编辑器。 */
function openStoryboard(): void {
  emit("open-storyboard");
}

/** 打开素材库（携带项目作用域）。 */
function openAssets(): void {
  if (props.project) {
    void router.push(`/assets?projectId=${encodeURIComponent(props.project.id)}`);
  }
}

onMounted(() => {
  void loadStoryboard();
});

watch(
  () => props.project?.id,
  () => {
    storyboard.reset();
    void loadStoryboard();
  },
);

watch(
  () => [props.storyboardRefreshToken, props.qualityRefreshToken],
  () => {
    void loadStoryboard(true);
  },
);

watch(
  () => props.finalReady,
  (ready) => {
    if (ready) current.value = "artifacts";
  },
);

/** 质检失败项定位到镜头。 */
function violationText(shotId?: string, detail?: string): string {
  return `${shotId ? `#${shotId} ` : ""}${detail ?? ""}`.trim();
}

/**
 * 刷新当前项目质检（报告随 storyboard 聚合接口一起返回）。
 */
async function refreshQuality(): Promise<void> {
  await loadStoryboard(true);
}
</script>

<template>
  <div class="wb-tabs">
    <div class="wb-tab-list" role="tablist" aria-label="工作台分区">
      <button
        v-for="tab in [
          { key: 'stage', label: '阶段进度' },
          { key: 'storyboard', label: '分镜' },
          { key: 'assets', label: '项目资产' },
          { key: 'artifacts', label: '产物' },
        ]"
        :key="tab.key"
        type="button"
        role="tab"
        class="wb-tab"
        :class="{ 'is-active': current === tab.key }"
        :aria-selected="current === tab.key"
        @click="current = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- 阶段进度 -->
    <section v-show="current === 'stage'" class="wb-pane" role="tabpanel" aria-label="阶段进度">
      <div class="wb-run-meta">
        <VfPill v-if="run" :tone="statusTone(mapRunStatus(run.status, run.error_code).color)">
          {{ mapRunStatus(run.status, run.error_code).text }}
        </VfPill>
        <span v-if="run" class="wb-meta is-mono">耗时 {{ runElapsed }}</span>
        <span v-else class="wb-meta">尚无 run</span>
      </div>

      <StageSteps :stages="stages" :review-stage="reviewStage" @select="emit('select-stage', $event)" />

      <div class="wb-quality">
        <header class="wb-quality__head">
          <h3 class="wb-pane-title">质检门禁</h3>
          <VfButton variant="ghost" @click="refreshQuality">刷新</VfButton>
        </header>
        <p v-if="!quality" class="wb-muted">尚未生成质检报告（合成阶段完成后产出）。</p>
        <ul v-else class="wb-quality__list">
          <li v-for="check in quality.checks" :key="check.id">
            <VfPill :tone="qualityTone(check.status)">{{ check.label }}</VfPill>
            <span v-if="check.violations.length === 0" class="wb-muted">通过</span>
            <ul v-else class="wb-violations">
              <li v-for="(violation, index) in check.violations" :key="index" class="is-mono">
                {{ violationText(violation.shotId, violation.detail) }}
              </li>
            </ul>
          </li>
        </ul>
      </div>
    </section>

    <!-- 分镜 -->
    <section v-show="current === 'storyboard'" class="wb-pane" role="tabpanel" aria-label="分镜">
      <header class="wb-pane-head">
        <h3 class="wb-pane-title">
          分镜时间轴
          <span v-if="storyboard.data?.timeline" class="wb-meta is-mono">
            {{ storyboard.data.timeline.shots.length }} 镜 ·
            {{ formatMediaDuration(storyboard.data.timeline.totalMs) }}
          </span>
        </h3>
        <VfButton @click="openStoryboard">打开编辑器</VfButton>
      </header>

      <p v-if="storyboard.loading" class="wb-muted">正在加载分镜…</p>
      <p v-else-if="storyboard.error" class="wb-error">分镜数据加载失败。</p>
      <p v-else-if="sceneGroups.length === 0" class="wb-muted">
        尚未生成 copy v2 分镜；完成 copy 阶段后这里会显示章节与镜头。
      </p>
      <div v-else class="wb-scenes">
        <article v-for="group in sceneGroups" :key="group.scene.sceneId" class="wb-scene">
          <header class="wb-scene__head">
            <span class="wb-scene__chapter is-mono">
              {{ group.scene.chapterNo ? `CH.${group.scene.chapterNo}` : "—" }}
            </span>
            <span class="wb-scene__title">{{ group.scene.title }}</span>
            <span class="wb-meta is-mono">{{ group.shots.length }} 镜</span>
          </header>
          <div class="wb-shot-grid">
            <div v-for="shot in group.shots" :key="shot.shotId" class="wb-shot">
              <div class="wb-shot__thumb">
                <img
                  v-if="shotThumb(shot.shotId)"
                  :src="shotThumb(shot.shotId)"
                  :alt="`镜头 ${shot.shotId} 缩略图`"
                  loading="lazy"
                />
                <span v-else class="wb-shot__placeholder">无图</span>
              </div>
              <div class="wb-shot__body">
                <span class="wb-shot__id is-mono">{{ shot.shotId }}</span>
                <span class="wb-shot__text">{{ shot.onScreenText || shot.narration }}</span>
                <span class="wb-shot__meta is-mono">
                  {{ shot.visualType }} · {{ cueCount(shot.shotId) }} cue
                </span>
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>

    <!-- 项目资产 -->
    <section v-show="current === 'assets'" class="wb-pane" role="tabpanel" aria-label="项目资产">
      <header class="wb-pane-head">
        <h3 class="wb-pane-title">项目资产</h3>
        <VfButton variant="ghost" @click="openAssets">素材库</VfButton>
      </header>
      <p v-if="assets.length === 0" class="wb-muted">暂无可引用资产。</p>
      <ul v-else class="wb-asset-list">
        <li v-for="asset in assets" :key="asset.id" class="wb-asset">
          <div class="wb-asset__main">
            <span class="wb-asset__kind is-mono">{{ asset.kind }}</span>
            <span class="wb-asset__label">{{ asset.label }}</span>
          </div>
          <span class="wb-meta is-mono">已绑定 {{ asset.boundShots ?? 0 }} 镜</span>
          <VfButton variant="ghost" @click="emit('reference-asset', asset.id)">引用</VfButton>
        </li>
      </ul>
    </section>

    <!-- 产物 -->
    <section v-show="current === 'artifacts'" class="wb-pane" role="tabpanel" aria-label="流水线产物">
      <FinalOutputCard :project="project" :artifacts="artifacts" :final-ready="finalReady" />
      <ArtifactTabs
        v-model:active-tab="artifactTab"
        :artifacts="artifacts"
        :project="project"
        :final-ready="finalReady"
        @regenerate="emit('regenerate', $event)"
      />
    </section>
  </div>
</template>

<style scoped>
.wb-tabs {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: var(--space-3);
}

.wb-tab-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
}

.wb-tab {
  min-height: 30px;
  padding: 0 var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-sec);
  font-family: inherit;
  font-size: var(--font-size-small);
  cursor: pointer;
}

.wb-tab:hover {
  color: var(--text);
}

.wb-tab.is-active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: var(--font-weight-strong);
}

.wb-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.wb-pane {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: var(--space-3);
  overflow: auto;
  padding: var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

.wb-pane-head,
.wb-pane-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.wb-pane-head {
  justify-content: space-between;
}

.wb-run-meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.wb-meta {
  font-size: var(--font-size-meta);
  color: var(--text-ter);
}

.wb-muted {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.wb-error {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--danger);
}

/* 质检 */
.wb-quality {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-soft);
}

.wb-quality__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.wb-quality__list {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: var(--space-2);
  list-style: none;
}

.wb-quality__list li {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.wb-violations {
  margin: 0;
  padding-inline-start: var(--space-4);
  font-size: var(--font-size-caption);
  color: var(--danger);
}

/* 分镜 */
.wb-scenes {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.wb-scene {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.wb-scene__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.wb-scene__chapter {
  font-size: var(--font-size-caption);
  color: var(--accent);
}

.wb-scene__title {
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.wb-shot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--space-2);
}

.wb-shot {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--surface-2);
  border-radius: var(--radius-control);
}

.wb-shot__thumb {
  display: flex;
  width: 56px;
  height: 32px;
  flex: none;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--inset);
  border-radius: var(--radius-control);
}

.wb-shot__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.wb-shot__placeholder {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.wb-shot__body {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.wb-shot__id {
  font-size: var(--font-size-caption);
  color: var(--accent);
}

.wb-shot__text {
  overflow: hidden;
  font-size: var(--font-size-caption);
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-shot__meta {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

/* 资产 */
.wb-asset-list {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: var(--space-2);
  list-style: none;
}

.wb-asset {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-2);
  border-radius: var(--radius-control);
}

.wb-asset__main {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: baseline;
  gap: var(--space-2);
}

.wb-asset__kind {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.wb-asset__label {
  overflow: hidden;
  font-size: var(--font-size-small);
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.is-mono {
  font-family: var(--font-mono);
}

@media (max-width: 767.98px) {
  .wb-shot-grid {
    grid-template-columns: 1fr;
  }
}
</style>
