<script setup lang="ts">
/**
 * 产物面板（Web 专题 §5.4.4）：六个 Tab（文案 / 图片 / 场景 / 音频 / 时间轴 / 成片）。
 * 数据来自 `GET /api/projects/:id/artifacts` 的产物索引；`copy.json`、`scenes/spec.json`、
 * `audio/cues.json`、`timeline.json` 经 `/api/media/*` 拉取后按契约 v2 结构化展示（不裸显 JSON）；
 * 媒体一律经 `/api/media/*` 相对路径加载。
 */
import { computed, ref, watch } from "vue";
import { FileTextOutlined } from "@ant-design/icons-vue";
import { apiRequest } from "../services/api";
import { getMediaTicket } from "../services/media-ticket";
import { buildMediaUrl } from "./media-url";
import { formatBytes, formatDurationMs } from "./format";
import { useGenerationStore, type GenerationRecord } from "../stores/generations";
import type { ArtifactEntry, ArtifactIndex } from "../stores/workbench-reducer";
import type { Project } from "../stores/projects";

/** copy.json v2 的镜头（见 `packages/shared/src/contracts/copy.ts`）。 */
interface CopyShot {
  shotId: string;
  narration: string;
}
/** copy.json v2 的叙事段落（章节）。 */
interface CopyScene {
  sceneId: string;
  title: string;
  shots: CopyShot[];
}
/** copy.json v2 结构化子集。 */
interface CopyDoc {
  topic: string;
  style: string;
  title: string;
  scenes: CopyScene[];
}

/** timeline.json v2 的镜头切点（见 `packages/shared/src/contracts/timeline.ts`）。 */
interface TimelineShot {
  shotId: string;
  sceneId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}
/** timeline.json v2 结构化子集。 */
interface TimelineDoc {
  fps: number;
  timingSource: string;
  totalMs: number;
  shots: TimelineShot[];
  cues: unknown[];
}

/** scenes/spec.json（SceneSpec v2）的单镜规格（见 `packages/shared/src/contracts/scene-spec.ts`）。 */
interface SceneShotSpec {
  shotId: string;
  visualType: string;
  componentId?: string;
  transition?: { in: string; out: string };
  animations?: unknown[];
}
/** scenes/spec.json 结构化子集。 */
interface SceneSpecDoc {
  themeId: string;
  shots: SceneShotSpec[];
}

/** audio/cues.json 的镜头音频切点（见 `packages/pipeline/src/audio-cues.ts`）。 */
interface AudioShot {
  shotId: string;
  sceneId: string;
  audioPath: string;
  durationMs: number;
  startMs: number;
  endMs: number;
}
/** audio/cues.json 结构化子集（cue 文本明细由文案/时间轴 Tab 承担，此处只用镜头音频）。 */
interface AudioCuesDoc {
  timingSource: string;
  shots: AudioShot[];
  cues: unknown[];
}

/** 时间戳来源中文名（契约 `TIMING_SOURCES`）。 */
const TIMING_SOURCE_LABELS: Record<string, string> = {
  "tts-native": "TTS 原生时间戳",
  "asr-aligned": "ASR 对齐",
  estimated: "字速估算（降级）",
};
/** 镜头视觉类型中文名（契约 `VISUAL_TYPES`）。 */
const VISUAL_TYPE_LABELS: Record<string, string> = {
  component: "组件版式",
  image: "图片",
  video: "视频",
  symbol: "符号图形",
};
/** 转场类型中文名（契约 `TRANSITION_TYPES`，只允许三型）。 */
const TRANSITION_LABELS: Record<string, string> = {
  "hard-cut": "硬切",
  "title-card": "标题卡",
  "fade-120": "120ms 淡入",
};

/**
 * 把枚举值翻成中文展示名。
 * @param dict 枚举值 → 中文名
 * @param value 枚举原值（缺省返回 `-`）
 * @returns 中文展示名；字典未收录时原样返回
 */
function labelOf(dict: Record<string, string>, value: string | undefined): string {
  if (!value) return "-";
  return dict[value] ?? value;
}

/** 时间轴表格列。 */
const timelineColumns = [
  { title: "镜头", dataIndex: "shotId", key: "shotId" },
  { title: "段落", dataIndex: "sceneId", key: "sceneId" },
  { title: "起始", key: "startMs" },
  { title: "结束", key: "endMs" },
  { title: "时长", key: "duration" },
];
/** 场景规格表格列。 */
const sceneColumns = [
  { title: "镜头", dataIndex: "shotId", key: "shotId" },
  { title: "视觉类型", key: "visualType" },
  { title: "组件", key: "componentId" },
  { title: "转场（入 → 出）", key: "transition" },
  { title: "动效数", key: "animations" },
  { title: "操作", key: "actions" },
];

const props = withDefaults(
  defineProps<{
    /** 产物索引；为 null 表示尚未加载。 */
    artifacts: ArtifactIndex | null;
    /** 所属项目（构造媒体地址）。 */
    project?: Project | null;
    /** run 是否成功完成（用于把默认 Tab 交给父组件控制）。 */
    finalReady?: boolean;
    /** 受控的当前 Tab（父组件可在 run 成功后切到「成片」）。 */
    activeTab?: string;
  }>(),
  { project: null, finalReady: false, activeTab: "copy" },
);

const emit = defineEmits<{
  /** 当前 Tab 同步。 */
  (event: "update:activeTab", value: string): void;
  /** 请求对单个镜头做定向重生成（父组件写入草稿，交给 Agent 按最小范围执行）。 */
  (event: "regenerate", payload: { stage: "image" | "scene" | "tts"; shotId: string }): void;
}>();

/** 项目生成上下文（提示词 / 模型 / 是否降级）。 */
const generations = useGenerationStore();

/** 从产物文件名推导镜头 ID（v2 每镜一产物，如 `images/sh-001.png` → `sh-001`）。 */
function shotIdOf(relativePath: string): string {
  return fileName(relativePath).replace(/\.[^.]+$/, "");
}

/** 取某阶段某镜头的最新生成记录。 */
function generationOf(
  stage: GenerationRecord["stage"],
  relativePath: string,
): GenerationRecord | undefined {
  return generations.find(stage, shotIdOf(relativePath));
}

/** 请求定向重生成单个镜头产物。 */
function requestRegeneration(stage: "image" | "scene" | "tts", relativePath: string): void {
  emit("regenerate", { stage, shotId: shotIdOf(relativePath) });
}

/** 对单个镜头发起场景（版式选型）重生成。 */
function regenerateScene(shotId: string): void {
  emit("regenerate", { stage: "scene", shotId });
}

/** 生成记录里的提示词展示文本（过长时截断，避免撑破弹层）。 */
function promptPreview(record: GenerationRecord | undefined): string {
  if (!record?.prompt) return "该产物没有生成记录（可能是早期版本或手工文件）";
  return record.prompt.length > 600 ? `${record.prompt.slice(0, 600)}…` : record.prompt;
}

/** 受控 Tab（get/set 双向绑定）。 */
const current = computed<string>({
  get: () => props.activeTab,
  set: (value: string) => emit("update:activeTab", value),
});

/** copy.json 内容（拉取失败为 null）。 */
const copyDoc = ref<CopyDoc | null>(null);
/** scenes/spec.json 内容（拉取失败为 null）。 */
const sceneDoc = ref<SceneSpecDoc | null>(null);
/** audio/cues.json 内容（拉取失败为 null）。 */
const audioDoc = ref<AudioCuesDoc | null>(null);
/** timeline.json 内容（拉取失败为 null）。 */
const timelineDoc = ref<TimelineDoc | null>(null);

/** 按阶段取产物条目。 */
function entriesOfStage(stage: string): ArtifactEntry[] {
  return (props.artifacts?.entries ?? []).filter((entry) => entry.stage === stage);
}

/** 取某阶段的第一个产物条目。 */
function firstEntryOfStage(stage: string): ArtifactEntry | undefined {
  return entriesOfStage(stage)[0];
}

/** 文案条目（v2 为单一 `copy.json`）。 */
const copyEntries = computed(() => entriesOfStage("copy"));
/** 场景规格条目（v2 为单一 `scenes/spec.json`）。 */
const sceneEntry = computed(() => firstEntryOfStage("scene"));
/** 音频 cue 条目（v2 为单一 `audio/cues.json`）。 */
const audioEntry = computed(() => firstEntryOfStage("tts"));
/** 时间轴条目（v2 为单一 `timeline.json`）。 */
const timelineEntry = computed(() => firstEntryOfStage("storyboard"));
/** 图片条目（按文件名做数字感知排序，近似镜头顺序）。 */
const imageEntries = computed(() =>
  [...entriesOfStage("image")].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, "zh-Hans-CN", { numeric: true }),
  ),
);
/** 成片条目（缺失时回退 `final.mp4`）。 */
const finalEntry = computed<ArtifactEntry | null>(() => {
  const entry = firstEntryOfStage("compose");
  if (entry) return entry;
  if (props.artifacts?.finalVideoExists) {
    return { stage: "compose", label: "视频合成", relativePath: "final.mp4", sizeBytes: 0 };
  }
  return null;
});

/** 图片条目 + 各自的生成上下文（避免模板里重复查询）。 */
const imageItems = computed(() =>
  imageEntries.value.map((entry) => ({
    entry,
    generation: generationOf("image", entry.relativePath),
  })),
);
/** 镜头音频 + 各自的生成上下文。 */
const audioItems = computed(() =>
  (audioDoc.value?.shots ?? []).map((shot) => ({
    shot,
    generation: generationOf("tts", shot.audioPath),
  })),
);

/** 取文件名（展示用）。 */
function fileName(relativePath: string): string {
  const segments = relativePath.split("/");
  return segments[segments.length - 1] ?? relativePath;
}

/** 媒体票据（`<img>` / `<audio>` / `<video>` 等原生标签无法带 Authorization，改用票据）。 */
const mediaTicket = ref("");

/** 取（或复用缓存）媒体票据；失败时保持空串，由接口 Bearer 路径兜底。 */
async function refreshMediaTicket(): Promise<void> {
  try {
    mediaTicket.value = await getMediaTicket();
  } catch (error) {
    console.warn("[web] 媒体票据获取失败", error);
  }
}

/** 构造媒体地址（附加媒体票据，供浏览器原生标签直接加载）。 */
function mediaUrl(relativePath: string): string {
  return buildMediaUrl(props.project, relativePath, mediaTicket.value);
}

/**
 * 拉取并解析单个结构化产物。
 * @param relativePath 项目内相对路径
 * @param name 展示名（仅用于告警日志）
 * @returns 解析后的文档；失败返回 null（由调用方决定空态文案）
 */
async function fetchDoc<T>(relativePath: string, name: string): Promise<T | null> {
  try {
    return await apiRequest<T>(mediaUrl(relativePath));
  } catch (error) {
    console.warn(`[web] ${name} 拉取失败`, error);
    return null;
  }
}

/** 拉取并结构化 copy.json / scenes/spec.json / audio/cues.json / timeline.json。 */
async function loadDocs(): Promise<void> {
  copyDoc.value = null;
  sceneDoc.value = null;
  audioDoc.value = null;
  timelineDoc.value = null;
  if (!props.project) return;

  const copy = copyEntries.value[0];
  if (copy) copyDoc.value = await fetchDoc<CopyDoc>(copy.relativePath, "copy.json");
  if (sceneEntry.value) {
    sceneDoc.value = await fetchDoc<SceneSpecDoc>(sceneEntry.value.relativePath, "scenes/spec.json");
  }
  if (audioEntry.value) {
    audioDoc.value = await fetchDoc<AudioCuesDoc>(audioEntry.value.relativePath, "audio/cues.json");
  }
  if (timelineEntry.value) {
    timelineDoc.value = await fetchDoc<TimelineDoc>(timelineEntry.value.relativePath, "timeline.json");
  }
}

// 项目切换或产物清单变化时重拉结构化文档，并确保媒体票据可用
watch(
  () => [
    props.project?.id ?? "",
    props.artifacts?.entries.length ?? 0,
    props.artifacts?.finalVideoExists,
  ],
  () => {
    void refreshMediaTicket();
    void loadDocs();
    // 生成上下文跟着项目走：切项目或产物数量变化时刷新（新产物会有新记录）
    const projectId = props.project?.id;
    if (projectId) {
      void generations.load(projectId).catch((error) => {
        console.warn("[web] 生成上下文加载失败", error);
      });
    }
  },
  { immediate: true },
);
</script>

<template>
  <a-tabs v-model:activeKey="current" size="small" class="artifact-tabs">
    <!-- 文案：文档概要 + 章节/镜头列表（对齐设计稿的信息密度） -->
    <a-tab-pane key="copy" tab="文案">
      <div v-if="copyDoc" class="artifact-copy">
        <div class="copy-doc">
          <file-text-outlined class="copy-doc-icon" aria-hidden="true" />
          <span class="copy-doc-title">{{ copyDoc.title }}</span>
        </div>
        <dl class="copy-meta">
          <div>
            <dt>主题</dt>
            <dd>{{ copyDoc.topic }}</dd>
          </div>
          <div>
            <dt>风格</dt>
            <dd>{{ copyDoc.style }}</dd>
          </div>
        </dl>
        <ol class="copy-scenes">
          <li v-for="(scene, index) in copyDoc.scenes" :key="scene.sceneId">
            <span class="copy-scene-index">{{ index + 1 }}</span>
            <div class="copy-scene-body">
              <span class="copy-scene-title">{{ scene.title }}</span>
              <ul class="copy-shots">
                <li v-for="shot in scene.shots" :key="shot.shotId">
                  <span class="copy-shot-id">{{ shot.shotId }}</span>
                  <span class="copy-scene-narration">{{ shot.narration }}</span>
                </li>
              </ul>
            </div>
          </li>
        </ol>
      </div>
      <a-empty v-else-if="copyEntries.length === 0" description="该产物尚未生成" />
      <a-empty v-else description="文案文件加载失败或格式非法" />
    </a-tab-pane>

    <!-- 图片 -->
    <a-tab-pane key="image" tab="图片">
      <div v-if="imageItems.length > 0" class="image-wall">
        <div v-for="item in imageItems" :key="item.entry.relativePath" class="image-cell">
          <a-image-preview-group>
            <a-image
              :src="mediaUrl(item.entry.relativePath)"
              :alt="fileName(item.entry.relativePath)"
              :width="120"
            />
          </a-image-preview-group>
          <div class="asset-actions">
            <a-popover trigger="click" placement="top" title="生成信息">
              <template #content>
                <div class="gen-info">
                  <p class="gen-line">模型：{{ item.generation?.model ?? "-" }}</p>
                  <p class="gen-line">提示词集：{{ item.generation?.promptSet ?? "-" }}</p>
                  <p class="gen-line">生成时间：{{ item.generation?.createdAt ?? "-" }}</p>
                  <pre class="gen-prompt">{{ promptPreview(item.generation) }}</pre>
                </div>
              </template>
              <a-button type="link" size="small">生成信息</a-button>
            </a-popover>
            <a-button
              type="link"
              size="small"
              @click="requestRegeneration('image', item.entry.relativePath)"
            >
              重生成
            </a-button>
          </div>
        </div>
      </div>
      <a-empty v-else description="该产物尚未生成" />
    </a-tab-pane>

    <!-- 场景：v2 产物为组件选型规格（scenes/spec.json），不再是可预览的 HTML 文档 -->
    <a-tab-pane key="scene" tab="场景">
      <div v-if="sceneDoc" class="artifact-scene">
        <p class="scene-meta">
          主题：{{ sceneDoc.themeId }} · 镜头规格 {{ sceneDoc.shots.length }} 条（组件选型 + 参数）
        </p>
        <a-table
          :data-source="sceneDoc.shots"
          :pagination="false"
          size="small"
          row-key="shotId"
          :columns="sceneColumns"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'visualType'">{{
              labelOf(VISUAL_TYPE_LABELS, record.visualType)
            }}</template>
            <template v-else-if="column.key === 'componentId'">{{
              record.componentId ?? "-"
            }}</template>
            <template v-else-if="column.key === 'transition'">
              {{ labelOf(TRANSITION_LABELS, record.transition?.in) }} →
              {{ labelOf(TRANSITION_LABELS, record.transition?.out) }}
            </template>
            <template v-else-if="column.key === 'animations'">{{
              record.animations?.length ?? 0
            }}</template>
            <template v-else-if="column.key === 'actions'">
              <a-button type="link" size="small" @click="regenerateScene(record.shotId)">
                重生成
              </a-button>
            </template>
          </template>
        </a-table>
      </div>
      <a-empty v-else-if="sceneEntry" description="场景规格文件加载失败或格式非法" />
      <a-empty v-else description="该产物尚未生成" />
    </a-tab-pane>

    <!-- 音频：v2 以 audio/cues.json 的镜头切点为索引，逐镜给出音频地址与实测时长 -->
    <a-tab-pane key="audio" tab="音频">
      <div v-if="audioItems.length > 0" class="audio-list">
        <div v-for="item in audioItems" :key="item.shot.shotId" class="audio-item">
          <span class="audio-name">{{ item.shot.shotId }}</span>
          <audio
            controls
            preload="metadata"
            :src="mediaUrl(item.shot.audioPath)"
            :aria-label="`镜头 ${item.shot.shotId} 配音`"
          />
          <span class="audio-duration">时长 {{ formatDurationMs(item.shot.durationMs) }}</span>
          <a-popover trigger="click" placement="top" title="生成信息">
            <template #content>
              <div class="gen-info">
                <p class="gen-line">音色：{{ item.generation?.model ?? "-" }}</p>
                <p class="gen-line">生成时间：{{ item.generation?.createdAt ?? "-" }}</p>
                <pre class="gen-prompt">{{ promptPreview(item.generation) }}</pre>
              </div>
            </template>
            <a-button type="link" size="small">生成信息</a-button>
          </a-popover>
          <a-button
            type="link"
            size="small"
            @click="requestRegeneration('tts', item.shot.audioPath)"
          >
            重新配音
          </a-button>
        </div>
      </div>
      <a-empty v-else-if="audioEntry" description="音频 cue 文件加载失败或格式非法" />
      <a-empty v-else description="该产物尚未生成" />
    </a-tab-pane>

    <!-- 时间轴 -->
    <a-tab-pane key="timeline" tab="时间轴">
      <div v-if="timelineDoc" class="artifact-timeline">
        <p class="timeline-total">
          总时长：{{ formatDurationMs(timelineDoc.totalMs) }} · 帧率：{{ timelineDoc.fps }}fps ·
          时间戳来源：{{ labelOf(TIMING_SOURCE_LABELS, timelineDoc.timingSource) }} ·
          旁白 cue：{{ timelineDoc.cues?.length ?? 0 }} 条
        </p>
        <a-table
          :data-source="timelineDoc.shots"
          :pagination="false"
          size="small"
          row-key="shotId"
          :columns="timelineColumns"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'startMs'">{{
              formatDurationMs(record.startMs)
            }}</template>
            <template v-else-if="column.key === 'endMs'">{{
              formatDurationMs(record.endMs)
            }}</template>
            <template v-else-if="column.key === 'duration'">{{
              formatDurationMs(record.durationMs)
            }}</template>
          </template>
        </a-table>
      </div>
      <a-empty v-else-if="timelineEntry" description="时间轴文件加载失败或格式非法" />
      <a-empty v-else description="该产物尚未生成" />
    </a-tab-pane>

    <!-- 成片 -->
    <a-tab-pane key="final" tab="成片">
      <div v-if="finalEntry" class="artifact-final">
        <video
          controls
          :src="mediaUrl(finalEntry.relativePath)"
          aria-label="成片播放器"
          class="final-video"
        >
          您的浏览器不支持视频播放。
        </video>
        <p class="final-meta">
          {{ fileName(finalEntry.relativePath) }} · {{ formatBytes(finalEntry.sizeBytes) }}
        </p>
      </div>
      <a-empty v-else description="尚未合成" />
    </a-tab-pane>
  </a-tabs>
</template>

<style scoped>
.artifact-tabs {
  height: 100%;
}

.copy-scenes {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 10px;
  list-style: none;
}

.artifact-copy {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.copy-doc {
  display: flex;
  align-items: center;
  gap: 8px;
}

.copy-doc-icon {
  color: var(--vf-primary);
}

.copy-doc-title {
  font-weight: 600;
}

.copy-meta {
  display: flex;
  margin: 0;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 12px;
}

.copy-meta div {
  display: flex;
  gap: 6px;
}

.copy-meta dt {
  color: var(--vf-text-tertiary);
}

.copy-meta dd {
  margin: 0;
  color: var(--vf-text-secondary);
}

.copy-scenes li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.copy-scene-index {
  display: inline-flex;
  width: 18px;
  height: 18px;
  flex: none;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
  border-radius: 50%;
  background: var(--vf-primary-soft);
  color: var(--vf-primary);
  font-size: 11px;
  font-weight: 600;
}

.copy-scene-body {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.copy-scene-title {
  font-size: 13px;
  font-weight: 600;
}

/* 章节下的镜头：镜头号 + 口播文本 */
.copy-shots {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 2px;
  list-style: none;
}

.copy-shots li {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.copy-shot-id {
  flex: none;
  color: var(--vf-text-tertiary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.copy-scene-narration {
  color: var(--vf-text-secondary);
  font-size: 12px;
  line-height: 1.55;
}

.image-wall {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 单个图片：缩略图 + 生成信息 / 重生成入口 */
.image-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.asset-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* 生成信息弹层：展示当时实际发送的提示词与模型 */
.gen-info {
  max-width: 420px;
}

.gen-line {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--vf-text-secondary);
}

.gen-prompt {
  max-height: 220px;
  margin: 6px 0 0;
  padding: 8px;
  overflow: auto;
  border-radius: 6px;
  background: rgb(0 0 0 / 4%);
  color: var(--vf-text-secondary);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.artifact-scene {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.scene-meta {
  margin: 0;
  color: var(--vf-text-secondary);
  font-size: 12px;
}

.audio-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.audio-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.audio-name {
  min-width: 120px;
  font-size: 13px;
}

.audio-duration {
  color: rgb(0 0 0 / 45%);
  font-size: 12px;
}

.timeline-total {
  margin: 0 0 8px;
  font-size: 13px;
}

.final-video {
  width: 100%;
  max-height: 320px;
  background: #000;
}

.final-meta {
  margin: 8px 0 0;
  color: rgb(0 0 0 / 45%);
  font-size: 12px;
}
</style>
