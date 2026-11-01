<script setup lang="ts">
/**
 * 产物面板（Web 专题 §5.4.4）：六个 Tab（文案 / 图片 / 场景 / 音频 / 时间轴 / 成片）。
 * 数据来自 `GET /api/projects/:id/artifacts` 的产物索引；`copy.json` 与 `timeline.json`
 * 经 `/api/media/*` 拉取后结构化展示（不裸显 JSON）；媒体一律经 `/api/media/*` 相对路径加载。
 */
import { computed, reactive, ref, watch } from "vue";
import { apiRequest } from "../services/api";
import { buildMediaUrl } from "./media-url";
import { formatBytes, formatDurationMs } from "./format";
import type { ArtifactEntry, ArtifactIndex } from "../stores/workbench-reducer";
import type { Project } from "../stores/projects";

/** copy.json 的结构化子集（见 `packages/pipeline/src/copy-contract.ts`）。 */
interface CopyScene {
  sceneId: string;
  title: string;
  narration: string;
}
/** copy.json 结构化子集。 */
interface CopyDoc {
  topic: string;
  style: string;
  title: string;
  scenes: CopyScene[];
}
/** timeline.json 的结构化子集（见 `packages/renderer/src/render-frames.ts`）。 */
interface TimelineEntry {
  sceneId: string;
  startMs: number;
  endMs: number;
}
/** timeline.json 结构化子集。 */
interface TimelineDoc {
  entries: TimelineEntry[];
  totalMs?: number;
}

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
}>();

/** 受控 Tab（get/set 双向绑定）。 */
const current = computed<string>({
  get: () => props.activeTab,
  set: (value: string) => emit("update:activeTab", value),
});

/** copy.json 内容（拉取失败为 null）。 */
const copyDoc = ref<CopyDoc | null>(null);
/** timeline.json 内容（拉取失败为 null）。 */
const timelineDoc = ref<TimelineDoc | null>(null);
/** 音频时长（相对路径 → 秒），由 `<audio>` 元数据加载回填。 */
const audioDurations = reactive<Record<string, number>>({});

/** 按阶段取产物条目。 */
function entriesOfStage(stage: string): ArtifactEntry[] {
  return (props.artifacts?.entries ?? []).filter((entry) => entry.stage === stage);
}

/** 取某阶段的第一个产物条目。 */
function firstEntryOfStage(stage: string): ArtifactEntry | undefined {
  return entriesOfStage(stage)[0];
}

/** 文案 Tab 的结构化文档是否存在。 */
const copyEntries = computed(() => entriesOfStage("copy"));
/** 图片条目（按文件名做数字感知排序，近似 sceneId 顺序）。 */
const imageEntries = computed(() =>
  [...entriesOfStage("image")].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, "zh-Hans-CN", { numeric: true }),
  ),
);
/** 场景 html 条目。 */
const sceneEntries = computed(() =>
  [...entriesOfStage("scene")].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, "zh-Hans-CN", { numeric: true }),
  ),
);
/** 音频条目。 */
const audioEntries = computed(() =>
  [...entriesOfStage("tts")].sort((a, b) =>
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

/** 取文件名（展示用）。 */
function fileName(relativePath: string): string {
  const segments = relativePath.split("/");
  return segments[segments.length - 1] ?? relativePath;
}

/** 构造媒体地址。 */
function mediaUrl(relativePath: string): string {
  return buildMediaUrl(props.project, relativePath);
}

/** 音频元数据加载后记录时长。 */
function onAudioMetadata(relativePath: string, event: Event): void {
  const element = event.target as HTMLAudioElement | null;
  if (element && Number.isFinite(element.duration)) {
    audioDurations[relativePath] = element.duration;
  }
}

/** 拉取并结构化 copy.json / timeline.json。 */
async function loadDocs(): Promise<void> {
  copyDoc.value = null;
  timelineDoc.value = null;
  if (!props.project) return;

  const copyEntry = firstEntryOfStage("copy");
  if (copyEntry) {
    try {
      copyDoc.value = await apiRequest<CopyDoc>(mediaUrl(copyEntry.relativePath));
    } catch (error) {
      console.warn("[web] copy.json 拉取失败", error);
    }
  }

  const timelineEntry = firstEntryOfStage("storyboard");
  if (timelineEntry) {
    try {
      timelineDoc.value = await apiRequest<TimelineDoc>(mediaUrl(timelineEntry.relativePath));
    } catch (error) {
      console.warn("[web] timeline.json 拉取失败", error);
    }
  }
}

// 项目切换或产物清单变化时重拉结构化文档
watch(
  () => [
    props.project?.id ?? "",
    props.artifacts?.entries.length ?? 0,
    props.artifacts?.finalVideoExists,
  ],
  () => {
    void loadDocs();
  },
  { immediate: true },
);
</script>

<template>
  <a-tabs v-model:activeKey="current" size="small" class="artifact-tabs">
    <!-- 文案 -->
    <a-tab-pane key="copy" tab="文案">
      <div v-if="copyDoc" class="artifact-copy">
        <a-descriptions :column="1" size="small" bordered>
          <a-descriptions-item label="主题">{{ copyDoc.topic }}</a-descriptions-item>
          <a-descriptions-item label="风格">{{ copyDoc.style }}</a-descriptions-item>
          <a-descriptions-item label="标题">{{ copyDoc.title }}</a-descriptions-item>
        </a-descriptions>
        <a-list :data-source="copyDoc.scenes" size="small" class="copy-scenes">
          <template #renderItem="{ item }">
            <a-list-item>
              <a-list-item-meta :title="item.title" :description="item.narration" />
            </a-list-item>
          </template>
        </a-list>
      </div>
      <a-empty v-else-if="copyEntries.length === 0" description="该产物尚未生成" />
      <a-empty v-else description="文案文件加载失败或格式非法" />
    </a-tab-pane>

    <!-- 图片 -->
    <a-tab-pane key="image" tab="图片">
      <a-image-preview-group v-if="imageEntries.length > 0" class="image-wall">
        <a-image
          v-for="entry in imageEntries"
          :key="entry.relativePath"
          :src="mediaUrl(entry.relativePath)"
          :alt="fileName(entry.relativePath)"
          :width="120"
        />
      </a-image-preview-group>
      <a-empty v-else description="该产物尚未生成" />
    </a-tab-pane>

    <!-- 场景 -->
    <a-tab-pane key="scene" tab="场景">
      <ul v-if="sceneEntries.length > 0" class="scene-list">
        <li v-for="entry in sceneEntries" :key="entry.relativePath">
          <a :href="mediaUrl(entry.relativePath)" target="_blank" rel="noopener">
            {{ fileName(entry.relativePath) }}
          </a>
        </li>
      </ul>
      <a-empty v-else description="该产物尚未生成" />
    </a-tab-pane>

    <!-- 音频 -->
    <a-tab-pane key="audio" tab="音频">
      <div v-if="audioEntries.length > 0" class="audio-list">
        <div v-for="entry in audioEntries" :key="entry.relativePath" class="audio-item">
          <span class="audio-name">{{ fileName(entry.relativePath) }}</span>
          <audio
            controls
            preload="metadata"
            :src="mediaUrl(entry.relativePath)"
            :aria-label="`音频 ${fileName(entry.relativePath)}`"
            @loadedmetadata="onAudioMetadata(entry.relativePath, $event)"
          />
          <span class="audio-duration">
            时长
            {{
              audioDurations[entry.relativePath]
                ? formatDurationMs(audioDurations[entry.relativePath] * 1000)
                : "-"
            }}
          </span>
        </div>
      </div>
      <a-empty v-else description="该产物尚未生成" />
    </a-tab-pane>

    <!-- 时间轴 -->
    <a-tab-pane key="timeline" tab="时间轴">
      <div v-if="timelineDoc" class="artifact-timeline">
        <p class="timeline-total">总时长：{{ formatDurationMs(timelineDoc.totalMs ?? 0) }}</p>
        <a-table
          :data-source="timelineDoc.entries"
          :pagination="false"
          size="small"
          row-key="sceneId"
          :columns="[
            { title: '分镜', dataIndex: 'sceneId', key: 'sceneId' },
            { title: '起始', dataIndex: 'startMs', key: 'startMs' },
            { title: '结束', dataIndex: 'endMs', key: 'endMs' },
            { title: '时长', key: 'duration' },
          ]"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'startMs'">{{
              formatDurationMs(record.startMs)
            }}</template>
            <template v-else-if="column.key === 'endMs'">{{
              formatDurationMs(record.endMs)
            }}</template>
            <template v-else-if="column.key === 'duration'">
              {{ formatDurationMs(record.endMs - record.startMs) }}
            </template>
          </template>
        </a-table>
      </div>
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
  margin-top: 12px;
}

.image-wall {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.scene-list {
  margin: 0;
  padding-inline-start: 18px;
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
