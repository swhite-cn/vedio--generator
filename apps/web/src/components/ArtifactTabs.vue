<script setup lang="ts">
/**
 * 产物面板（Web 专题 §5.4.4）：六个 Tab（文案 / 图片 / 场景 / 音频 / 时间轴 / 成片）。
 * 数据来自 `GET /api/projects/:id/artifacts` 的产物索引；`copy.json` 与 `timeline.json`
 * 经 `/api/media/*` 拉取后结构化展示（不裸显 JSON）；媒体一律经 `/api/media/*` 相对路径加载。
 */
import { computed, nextTick, onUnmounted, reactive, ref, watch } from "vue";
import { FileTextOutlined, PlayCircleOutlined } from "@ant-design/icons-vue";
import { apiRequest } from "../services/api";
import { getMediaTicket } from "../services/media-ticket";
import { buildMediaUrl } from "./media-url";
import { formatBytes, formatDurationMs } from "./format";
import { useGenerationStore, type GenerationRecord } from "../stores/generations";
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
  /** 请求对单个场景做定向重生成（父组件写入草稿，交给 Agent 按最小范围执行）。 */
  (event: "regenerate", payload: { stage: "image" | "scene" | "tts"; sceneId: string }): void;
}>();

/** 项目生成上下文（提示词 / 模型 / 是否降级）。 */
const generations = useGenerationStore();

/** 从产物文件名推导场景 ID（`images/s1.png` → `s1`）。 */
function sceneIdOf(relativePath: string): string {
  return fileName(relativePath).replace(/\.[^.]+$/, "");
}

/** 取某阶段某场景的最新生成记录。 */
function generationOf(
  stage: GenerationRecord["stage"],
  relativePath: string,
): GenerationRecord | undefined {
  return generations.find(stage, sceneIdOf(relativePath));
}

/** 请求定向重生成单个场景产物。 */
function requestRegeneration(stage: "image" | "scene" | "tts", relativePath: string): void {
  emit("regenerate", { stage, sceneId: sceneIdOf(relativePath) });
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

/** 图片条目 + 各自的生成上下文（避免模板里重复查询）。 */
const imageItems = computed(() =>
  imageEntries.value.map((entry) => ({
    entry,
    generation: generationOf("image", entry.relativePath),
  })),
);
/** 场景条目 + 各自的生成上下文。 */
const sceneItems = computed(() =>
  sceneEntries.value.map((entry) => ({
    entry,
    generation: generationOf("scene", entry.relativePath),
  })),
);
/** 音频条目 + 各自的生成上下文。 */
const audioItems = computed(() =>
  audioEntries.value.map((entry) => ({
    entry,
    generation: generationOf("tts", entry.relativePath),
  })),
);

/** 取文件名（展示用）。 */
function fileName(relativePath: string): string {
  const segments = relativePath.split("/");
  return segments[segments.length - 1] ?? relativePath;
}

/** 媒体票据（`<img>` / `<audio>` / `<video>` 等原生标签无法带 Authorization，改用票据）。 */
const mediaTicket = ref("");
/** 当前在弹窗中预览的场景路径。 */
const previewScenePath = ref<string | null>(null);

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

/** 构造带自动播放标记的场景预览地址。 */
function scenePreviewUrl(relativePath: string): string {
  const url = mediaUrl(relativePath);
  if (!url) return "";
  return `${url}${url.includes("?") ? "&" : "?"}preview=1`;
}

/** 在工作台弹窗中打开场景动画。 */
function previewScene(relativePath: string): void {
  previewScenePath.value = relativePath;
}

/** 关闭场景预览弹窗。 */
function closeScenePreview(): void {
  previewScenePath.value = null;
}

/** 场景预览容器（按容器宽度等比缩放 1920×1080 的场景文档）。 */
const previewStageEl = ref<HTMLElement | null>(null);
/** 场景预览缩放比例（容器宽度 / 1920）。 */
const previewScale = ref(0.475);
/** 容器尺寸监听器。 */
let previewObserver: ResizeObserver | null = null;

/** 依据容器实际宽度重算缩放比例，避免只露出场景左上角。 */
function syncPreviewScale(): void {
  const width = previewStageEl.value?.clientWidth ?? 0;
  if (width > 0) previewScale.value = width / 1920;
}

// 弹窗打开后容器才挂载，挂载完成再按实际宽度缩放并持续跟随尺寸变化
watch(previewScenePath, async (path) => {
  previewObserver?.disconnect();
  previewObserver = null;
  if (!path) return;
  await nextTick();
  syncPreviewScale();
  if (previewStageEl.value && typeof ResizeObserver !== "undefined") {
    previewObserver = new ResizeObserver(syncPreviewScale);
    previewObserver.observe(previewStageEl.value);
  }
});

onUnmounted(() => {
  previewObserver?.disconnect();
  previewObserver = null;
});

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
    <!-- 文案：文档概要 + 编号分镜列表（对齐设计稿的信息密度） -->
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
          <li v-for="(item, index) in copyDoc.scenes" :key="item.sceneId">
            <span class="copy-scene-index">{{ index + 1 }}</span>
            <div class="copy-scene-body">
              <span class="copy-scene-title">{{ item.title }}</span>
              <span class="copy-scene-narration">{{ item.narration }}</span>
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

    <!-- 场景 -->
    <a-tab-pane key="scene" tab="场景">
      <ul v-if="sceneItems.length > 0" class="scene-list">
        <li v-for="item in sceneItems" :key="item.entry.relativePath">
          <span>{{ fileName(item.entry.relativePath) }}</span>
          <a-button type="link" size="small" @click="previewScene(item.entry.relativePath)">
            <template #icon><play-circle-outlined /></template>
            预览动画
          </a-button>
          <a :href="scenePreviewUrl(item.entry.relativePath)" target="_blank" rel="noopener">
            新窗口打开
          </a>
          <a-popover trigger="click" placement="top" title="生成信息">
            <template #content>
              <div class="gen-info">
                <p class="gen-line">模型：{{ item.generation?.model ?? "-" }}</p>
                <p class="gen-line">提示词集：{{ item.generation?.promptSet ?? "-" }}</p>
                <p class="gen-line">
                  是否降级：{{ item.generation?.fallback ? "是（内置模板）" : "否" }}
                </p>
                <p class="gen-line">生成时间：{{ item.generation?.createdAt ?? "-" }}</p>
                <pre class="gen-prompt">{{ promptPreview(item.generation) }}</pre>
              </div>
            </template>
            <a-button type="link" size="small">生成信息</a-button>
          </a-popover>
          <a-button
            type="link"
            size="small"
            @click="requestRegeneration('scene', item.entry.relativePath)"
          >
            重生成
          </a-button>
        </li>
      </ul>
      <a-empty v-else description="该产物尚未生成" />
    </a-tab-pane>

    <!-- 音频 -->
    <a-tab-pane key="audio" tab="音频">
      <div v-if="audioItems.length > 0" class="audio-list">
        <div v-for="item in audioItems" :key="item.entry.relativePath" class="audio-item">
          <span class="audio-name">{{ fileName(item.entry.relativePath) }}</span>
          <audio
            controls
            preload="metadata"
            :src="mediaUrl(item.entry.relativePath)"
            :aria-label="`音频 ${fileName(item.entry.relativePath)}`"
            @loadedmetadata="onAudioMetadata(item.entry.relativePath, $event)"
          />
          <span class="audio-duration">
            时长
            {{
              audioDurations[item.entry.relativePath]
                ? formatDurationMs(audioDurations[item.entry.relativePath] * 1000)
                : "-"
            }}
          </span>
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
            @click="requestRegeneration('tts', item.entry.relativePath)"
          >
            重新配音
          </a-button>
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

  <a-modal
    :open="Boolean(previewScenePath)"
    :title="previewScenePath ? `场景预览 · ${fileName(previewScenePath)}` : '场景预览'"
    :footer="null"
    :width="960"
    destroy-on-close
    @cancel="closeScenePreview"
  >
    <div v-if="previewScenePath" class="scene-preview">
      <!--
        场景 HTML 的相对资源（../vendor/gsap.min.js、../images/*.png）依赖 vf_media Cookie 鉴权，
        若只给 allow-scripts，iframe 会成为不透明源、子资源请求丢失 Cookie，动画时间轴无法创建。
        因此必须同时放行 allow-same-origin；其余能力（弹窗、表单、顶层跳转）仍被禁用。
      -->
      <div
        ref="previewStageEl"
        class="scene-preview-stage"
        :style="{ '--scene-preview-scale': previewScale }"
      >
        <iframe
          :key="previewScenePath"
          :src="scenePreviewUrl(previewScenePath)"
          :title="`场景动画预览：${fileName(previewScenePath)}`"
          class="scene-preview-frame"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    </div>
  </a-modal>
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

.scene-list {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 4px;
  list-style: none;
}

.scene-list li {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
}

.scene-list li > span {
  min-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scene-preview {
  overflow: hidden;
  border-radius: var(--vf-radius-sm);
  background: #0b1020;
}

/* 场景文档固定 1920×1080，用 transform 等比缩放避免只露出左上角 */
.scene-preview-stage {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
}

.scene-preview-frame {
  position: absolute;
  top: 0;
  left: 0;
  width: 1920px;
  height: 1080px;
  border: 0;
  background: #0b1020;
  transform: scale(var(--scene-preview-scale, 0.5));
  transform-origin: top left;
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
