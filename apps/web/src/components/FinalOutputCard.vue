<script setup lang="ts">
/**
 * 最终产物卡（方案 §8.5 第 5 页）：final.mp4 播放、分辨率/时长/大小、下载。
 * 所有媒体地址经 `/api/media/*` 相对路径 + 媒体票据加载；缺失时显示「尚未合成」。
 */
import { computed, onMounted, ref } from "vue";
import { getMediaTicket } from "../services/media-ticket";
import { buildMediaUrl } from "./media-url";
import { formatBytes, formatDurationMs } from "./format";
import { formatMediaDuration } from "./state-mapping";
import type { ArtifactEntry, ArtifactIndex } from "../stores/workbench-reducer";
import type { Project } from "../stores/projects";
import VfPill from "./ui/VfPill.vue";

const props = withDefaults(
  defineProps<{
    /** 所属项目（构造媒体地址）。 */
    project?: Project | null;
    /** 产物索引。 */
    artifacts?: ArtifactIndex | null;
    /** 服务端成片就绪标记。 */
    finalReady?: boolean;
  }>(),
  { project: null, artifacts: null, finalReady: false },
);

/** 媒体票据（原生 video 标签无法带 Authorization）。 */
const mediaTicket = ref("");

onMounted(() => {
  void getMediaTicket()
    .then((ticket) => {
      mediaTicket.value = ticket;
    })
    .catch((error) => console.warn("[web] 媒体票据获取失败", error));
});

/** 成片条目（compose 产物优先，缺失时回退 final.mp4 探测）。 */
const finalEntry = computed<ArtifactEntry | null>(() => {
  const entry = (props.artifacts?.entries ?? []).find((item) => item.stage === "compose");
  if (entry) return entry;
  if (props.artifacts?.finalVideoExists) {
    return { stage: "compose", label: "视频合成", relativePath: "final.mp4", sizeBytes: 0 };
  }
  return null;
});

/** 成片媒体地址。 */
const videoUrl = computed(() =>
  finalEntry.value && props.project
    ? buildMediaUrl(props.project, finalEntry.value.relativePath, mediaTicket.value)
    : "",
);

/** 成片时长（服务端派生指标；缺失显示破折号）。 */
const durationText = computed(() => formatMediaDuration(props.project?.totalMs ?? null));

/** 分辨率文案（按输出 Profile；未知回退原始值）。 */
const resolutionText = computed(() => {
  const profile = props.project?.profile ?? "";
  if (profile.startsWith("portrait")) return "1080 × 1920";
  if (profile.startsWith("landscape")) return "1920 × 1080";
  return profile || "—";
});

/** video 元数据加载后记录真实分辨率（覆盖静态推导值）。 */
const videoSize = ref("");

/**
 * 读取视频真实宽高。
 * @param event video 元数据事件
 */
function onVideoMetadata(event: Event): void {
  const video = event.target as HTMLVideoElement | null;
  if (video && video.videoWidth > 0 && video.videoHeight > 0) {
    videoSize.value = `${video.videoWidth} × ${video.videoHeight}`;
  }
}
</script>

<template>
  <section class="final-card" aria-label="最终产物">
    <header class="final-card__head">
      <h3 class="final-card__title">最终产物</h3>
      <VfPill :tone="finalEntry ? 'success' : 'neutral'">
        {{ finalEntry ? "final.mp4 就绪" : "尚未合成" }}
      </VfPill>
    </header>

    <template v-if="finalEntry">
      <video
        class="final-card__video"
        controls
        preload="metadata"
        :src="videoUrl"
        aria-label="成片播放器"
        @loadedmetadata="onVideoMetadata"
      >
        您的浏览器不支持视频播放。
      </video>
      <dl class="final-card__meta">
        <div>
          <dt>分辨率</dt>
          <dd class="is-mono">{{ videoSize || resolutionText }}</dd>
        </div>
        <div>
          <dt>时长</dt>
          <dd class="is-mono">{{ durationText }}</dd>
        </div>
        <div>
          <dt>大小</dt>
          <dd class="is-mono">{{ formatBytes(finalEntry.sizeBytes) }}</dd>
        </div>
      </dl>
      <a class="final-card__download" :href="videoUrl" download="final.mp4">下载成片</a>
    </template>

    <p v-else class="final-card__empty">
      运行成功后，final.mp4 会出现在这里；也可在「产物」Tab 查看各阶段中间产物。
    </p>
  </section>
</template>

<style scoped>
.final-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

.final-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.final-card__title {
  margin: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.final-card__video {
  width: 100%;
  max-height: 260px;
  background: var(--deep);
  border-radius: var(--radius-control);
}

.final-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  margin: 0;
}

.final-card__meta div {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.final-card__meta dt {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.final-card__meta dd {
  margin: 0;
  font-size: var(--font-size-meta);
  color: var(--text-sec);
}

.final-card__download {
  align-self: flex-start;
  color: var(--accent);
  font-size: var(--font-size-small);
}

.final-card__empty {
  margin: 0;
  font-size: var(--font-size-small);
  line-height: var(--line-height-body);
  color: var(--text-ter);
}

.is-mono {
  font-family: var(--font-mono);
}
</style>
