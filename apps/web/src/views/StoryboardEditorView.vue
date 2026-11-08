<script setup lang="ts">
/**
 * 分镜时间轴编辑器（方案 §8.5 第 6 页 / T308）。
 *
 * 左：场景栏（章节点 + 镜头数 + 时长）；中：16:9 预览画布 + 镜头条 + 三轨（画面/字幕/BGM）；
 * 右：Inspector（口播、cue、屏上文字、组件、资产绑定、风格锚、转场、主题色板、重生成）。
 *
 * 所有编辑走 `PATCH /api/projects/:id/shots/:shotId`（服务端可逆编辑并记 agent_actions）；
 * 单镜重生成走 `POST .../shots/:shotId/regenerate`（run scope 只跑目标镜头）。
 * 数据来自 `storyboard` store（`GET /api/projects/:id/storyboard`），前端不推导状态机。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { apiRequest, formatApiError } from "../services/api";
import { getMediaTicket } from "../services/media-ticket";
import { buildMediaUrl } from "../components/media-url";
import { formatMediaDuration } from "../components/state-mapping";
import { useStoryboardStore, type StoryboardShot } from "../stores/storyboard";
import type { Project } from "../stores/projects";
import VfButton from "../components/ui/VfButton.vue";
import VfPill from "../components/ui/VfPill.vue";

const route = useRoute();
const router = useRouter();
const storyboard = useStoryboardStore();

/** 当前项目 id。 */
const projectId = computed(() => String(route.params.id ?? ""));
/** 完整项目（媒体地址需要 user_id / name）。 */
const project = ref<Project | null>(null);
/** 媒体票据。 */
const mediaTicket = ref("");
/** 当前选中镜头 id。 */
const selectedShotId = ref("");
/** 保存中。 */
const saving = ref(false);
/** 行内错误。 */
const actionError = ref("");
/** Inspector 的屏上文字草稿。 */
const onScreenTextDraft = ref("");
/** Inspector 的强调词草稿（逗号分隔）。 */
const emphasisDraft = ref("");
/** 预览动效触发标记。 */
const previewing = ref(false);
/** 重生成阶段选择。 */
const regenerateStages = ref<Array<"image" | "scene" | "tts">>(["image"]);
/** 重生成提交中。 */
const regenerating = ref(false);

let previewTimer: ReturnType<typeof setTimeout> | null = null;

/** 场景分组。 */
const sceneGroups = computed(() =>
  (storyboard.data?.scenes ?? []).map((scene) => ({
    scene,
    shots: storyboard.shotsByScene.get(scene.sceneId) ?? [],
  })),
);

/** 全部镜头（编辑器内顺序导航用）。 */
const allShots = computed(() => storyboard.data?.shots ?? []);

/** 当前镜头。 */
const selectedShot = computed<StoryboardShot | null>(
  () =>
    allShots.value.find((shot) => shot.shotId === selectedShotId.value) ??
    allShots.value[0] ??
    null,
);

/** 当前镜头的 timeline 切点。 */
const selectedSpan = computed(() => {
  const id = selectedShot.value?.shotId;
  return storyboard.spans.find((span) => span.shotId === id) ?? null;
});

/** 当前镜头的 narration cue。 */
const selectedCues = computed(() =>
  selectedShot.value ? (storyboard.cuesByShot.get(selectedShot.value.shotId) ?? []) : [],
);

/** 全片总时长（缺 timeline 时按 spans 末值兜底）。 */
const totalMs = computed(
  () => storyboard.data?.timeline?.totalMs ?? storyboard.spans.at(-1)?.endMs ?? 0,
);

/** 当前镜头缩略/背景地址。 */
const shotImageUrl = computed(() =>
  project.value && selectedShot.value?.imagePath
    ? buildMediaUrl(project.value, selectedShot.value.imagePath, mediaTicket.value)
    : "",
);

/** 组件注册表（用于 Inspector 选型）。 */
const components = computed(() => storyboard.data?.components ?? []);

/** 主题色板（tokens 子集）。 */
const themePalette = computed(() => {
  const tokens = storyboard.themeTokens;
  const secondary = Array.isArray(tokens.secondary) ? (tokens.secondary as string[]) : [];
  return {
    text: String(tokens.text ?? ""),
    background: String(tokens.background ?? ""),
    accent: String(tokens.accent ?? ""),
    secondary,
    fontFamily: String(tokens.font_family ?? ""),
  };
});

/** 当前镜头时长文案。 */
const shotDurationText = computed(() =>
  selectedSpan.value ? formatMediaDuration(selectedSpan.value.durationMs) : "—",
);

/**
 * 计算时间轴块的位置与宽度（百分比）。
 * @param startMs 起始毫秒
 * @param endMs 结束毫秒
 * @returns 内联样式
 */
function blockStyle(startMs: number, endMs: number): Record<string, string> {
  if (totalMs.value <= 0) return { left: "0%", width: "100%" };
  const left = Math.max(0, Math.min(100, (startMs / totalMs.value) * 100));
  const width = Math.max(0.5, Math.min(100 - left, ((endMs - startMs) / totalMs.value) * 100));
  return { left: `${left}%`, width: `${width}%` };
}

/**
 * 选择镜头并同步 Inspector 草稿。
 * @param shot 目标镜头
 */
function selectShot(shot: StoryboardShot): void {
  selectedShotId.value = shot.shotId;
  onScreenTextDraft.value = shot.onScreenText;
  emphasisDraft.value = shot.emphasis.join(", ");
  previewing.value = false;
}

/**
 * 点击时间轴块选择镜头。
 * @param shotId 镜头 id
 */
function selectSpanShot(shotId: string): void {
  const shot = allShots.value.find((item) => item.shotId === shotId);
  if (shot) selectShot(shot);
}

/**
 * 按键盘左右键切换镜头（输入控件内不拦截）。
 * @param event 键盘事件
 */
function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const index = allShots.value.findIndex((shot) => shot.shotId === selectedShot.value?.shotId);
  if (index < 0) return;
  const nextIndex = event.key === "ArrowLeft" ? index - 1 : index + 1;
  const next = allShots.value[nextIndex];
  if (next) {
    event.preventDefault();
    selectShot(next);
  }
}

/**
 * 提交镜头补丁（可逆编辑）。
 * @param changes PATCH changes 载荷
 * @param successText 成功提示
 */
async function patchShot(changes: Record<string, unknown>, successText: string): Promise<void> {
  if (!selectedShot.value) return;
  saving.value = true;
  actionError.value = "";
  try {
    await apiRequest(
      `/api/projects/${encodeURIComponent(projectId.value)}/shots/${encodeURIComponent(
        selectedShot.value.shotId,
      )}`,
      { method: "PATCH", body: { changes } },
    );
    await storyboard.refresh();
    message.success(successText);
  } catch (error) {
    actionError.value = formatApiError(error);
  } finally {
    saving.value = false;
  }
}

/** 保存屏上文字。 */
function saveOnScreenText(): void {
  const text = onScreenTextDraft.value.trim();
  if (!selectedShot.value || text === selectedShot.value.onScreenText) return;
  void patchShot({ onScreenText: text }, "屏上文字已更新");
}

/** 保存强调词（逗号/顿号分隔，最多 10 个）。 */
function saveEmphasis(): void {
  const words = emphasisDraft.value
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 10);
  void patchShot({ emphasis: words }, "强调词已更新");
}

/**
 * 切换组件（保留原参数，组件变化由 scene 阶段重新装配动效）。
 * @param event change 事件
 */
function changeComponent(event: Event): void {
  const id = (event.target as HTMLSelectElement).value;
  if (!id) return;
  void patchShot(
    { component: { id, params: selectedShot.value?.component?.params ?? {} } },
    "组件已切换",
  );
}

/**
 * 切换转场。
 * @param key 方向：in/out
 * @param event change 事件
 */
function changeTransition(key: "transitionIn" | "transitionOut", event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  void patchShot({ [key]: value }, "转场已更新");
}

/** 触发一次静态动效预览（文字入场）。 */
function previewMotion(): void {
  previewing.value = false;
  if (previewTimer) clearTimeout(previewTimer);
  requestAnimationFrame(() => {
    previewing.value = true;
    previewTimer = setTimeout(() => {
      previewing.value = false;
    }, 800);
  });
}

/**
 * 勾选/取消重生成阶段。
 * @param stage 阶段
 * @param checked 是否选中
 */
function toggleRegenerateStage(stage: "image" | "scene" | "tts", checked: boolean): void {
  const set = new Set(regenerateStages.value);
  if (checked) set.add(stage);
  else set.delete(stage);
  regenerateStages.value = Array.from(set);
}

/** 提交单镜重生成（只跑目标镜头）。 */
async function regenerate(): Promise<void> {
  if (!selectedShot.value || regenerateStages.value.length === 0) return;
  regenerating.value = true;
  actionError.value = "";
  try {
    const result = await apiRequest<{ run: { id: string } }>(
      `/api/projects/${encodeURIComponent(projectId.value)}/shots/${encodeURIComponent(
        selectedShot.value.shotId,
      )}/regenerate`,
      { method: "POST", body: { stages: regenerateStages.value } },
    );
    message.success("已发起单镜重生成，其余镜头逐帧不变");
    void router.push(`/projects/${projectId.value}/runs/${result.run.id}`);
  } catch (error) {
    actionError.value = formatApiError(error);
  } finally {
    regenerating.value = false;
  }
}

/** 返回工作台。 */
function goBack(): void {
  void router.push(`/projects/${projectId.value}`);
}

/**
 * 加载聚合数据、完整项目与媒体票据。
 */
async function load(): Promise<void> {
  if (!projectId.value) return;
  try {
    const detail = await apiRequest<{ project: Project }>(
      `/api/projects/${encodeURIComponent(projectId.value)}`,
    );
    project.value = detail.project;
  } catch (error) {
    console.warn("[web] 分镜编辑器加载项目失败", error);
  }
  try {
    await storyboard.load(projectId.value, true);
  } catch (error) {
    console.warn("[web] 分镜编辑器加载分镜失败", error);
  }
  try {
    mediaTicket.value = await getMediaTicket();
  } catch (error) {
    console.warn("[web] 媒体票据获取失败", error);
  }
  if (!selectedShotId.value) {
    const first = allShots.value[0];
    if (first) selectShot(first);
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  await load();
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  if (previewTimer) clearTimeout(previewTimer);
  storyboard.reset();
});

watch(projectId, () => {
  selectedShotId.value = "";
  void load();
});

// 数据重拉后保持当前选中，被删除时回退首镜
watch(
  () => allShots.value.length,
  () => {
    if (!allShots.value.some((shot) => shot.shotId === selectedShotId.value)) {
      const first = allShots.value[0];
      if (first) selectShot(first);
    }
  },
);
</script>

<template>
  <div class="storyboard-editor">
    <header class="se-header">
      <button type="button" class="se-back" aria-label="返回工作台" @click="goBack">← 返回</button>
      <h1 class="se-title">分镜编辑器</h1>
      <span class="se-meta is-mono">{{ allShots.length }} 镜 · {{ formatMediaDuration(totalMs) }}</span>
      <span v-if="storyboard.data?.timeline" class="se-meta is-mono">
        timing：{{ storyboard.data.timeline.timingSource }}
      </span>
      <VfPill v-if="storyboard.data?.subtitles" tone="teal">字幕已生成</VfPill>
      <span class="se-hint">← → 切换镜头</span>
    </header>

    <p v-if="storyboard.error" class="se-error">分镜数据加载失败，请检查服务是否在线。</p>
    <p v-else-if="storyboard.loading && !storyboard.data" class="se-muted">正在加载分镜…</p>
    <p v-else-if="allShots.length === 0" class="se-muted">
      该项目尚无 v2 分镜（copy 阶段完成后可编辑）。
    </p>

    <div v-else class="se-body">
      <!-- 左：场景栏 -->
      <aside class="se-scenes" aria-label="场景与镜头">
        <div v-for="group in sceneGroups" :key="group.scene.sceneId" class="se-scene">
          <header class="se-scene__head">
            <span class="se-scene__chapter is-mono">
              {{ group.scene.chapterNo ? `CH.${group.scene.chapterNo}` : "—" }}
            </span>
            <span class="se-scene__title">{{ group.scene.title }}</span>
            <span class="se-scene__count is-mono">{{ group.shots.length }}</span>
          </header>
          <button
            v-for="shot in group.shots"
            :key="shot.shotId"
            type="button"
            class="se-shot"
            :class="{ 'is-active': selectedShot?.shotId === shot.shotId }"
            :aria-pressed="selectedShot?.shotId === shot.shotId"
            @click="selectShot(shot)"
          >
            <span class="se-shot__id is-mono">{{ shot.shotId }}</span>
            <span class="se-shot__text">{{ shot.onScreenText || shot.narration }}</span>
          </button>
        </div>
      </aside>

      <!-- 中：画布 + 镜头条 + 三轨 -->
      <section class="se-canvas-area" aria-label="预览与时间轴">
        <div class="se-canvas" :style="{ background: themePalette.background || 'var(--film-bg)' }">
          <img
            v-if="shotImageUrl"
            :src="shotImageUrl"
            :alt="`镜头 ${selectedShot?.shotId} 预览`"
            class="se-canvas__image"
          />
          <div class="se-canvas__scrim" aria-hidden="true" />
          <span v-if="selectedShot?.chapterNo" class="se-canvas__chapter is-mono">
            CH.{{ selectedShot.chapterNo }}
          </span>
          <p
            class="se-canvas__text"
            :class="{ 'is-previewing': previewing }"
            :style="{ color: themePalette.text || 'var(--film-text)' }"
          >
            <template v-if="selectedShot?.onScreenText">
              {{ selectedShot.onScreenText }}
            </template>
            <template v-else>{{ selectedShot?.narration }}</template>
          </p>
          <span v-if="selectedShot?.sourceRef" class="se-canvas__source">
            来源：{{ selectedShot.sourceRef.label }}
          </span>
        </div>

        <div class="se-shotbar" role="tablist" aria-label="镜头条">
          <button
            v-for="shot in allShots"
            :key="shot.shotId"
            type="button"
            class="se-shotbar__item"
            :class="{ 'is-active': selectedShot?.shotId === shot.shotId }"
            :aria-selected="selectedShot?.shotId === shot.shotId"
            @click="selectShot(shot)"
          >
            <span class="is-mono">{{ shot.shotId }}</span>
          </button>
        </div>

        <div class="se-tracks" aria-label="三轨时间轴">
          <div class="se-track">
            <span class="se-track__label">画面</span>
            <div class="se-track__lane">
              <button
                v-for="span in storyboard.spans"
                :key="span.shotId"
                type="button"
                class="se-block"
                :class="{ 'is-active': selectedShot?.shotId === span.shotId }"
                :style="blockStyle(span.startMs, span.endMs)"
                :title="`${span.shotId}`"
                @click="selectSpanShot(span.shotId)"
              >
                {{ span.shotId }}
              </button>
              <span v-if="storyboard.spans.length === 0" class="se-track__empty">
                尚未生成时间轴
              </span>
            </div>
          </div>

          <div class="se-track">
            <span class="se-track__label">字幕</span>
            <div class="se-track__lane">
              <span
                v-for="cue in storyboard.data?.cues ?? []"
                :key="cue.cueId"
                class="se-cue"
                :class="{ 'is-animation': cue.kind === 'animation' }"
                :style="
                  cue.kind === 'narration'
                    ? blockStyle(cue.startMs ?? 0, cue.endMs ?? 0)
                    : blockStyle(cue.atMs ?? 0, (cue.atMs ?? 0) + (cue.durationMs ?? 0))
                "
                :title="cue.kind === 'narration' ? cue.text : cue.effect"
              >
                {{ cue.kind === "narration" ? cue.text : "动效" }}
              </span>
            </div>
          </div>

          <div class="se-track">
            <span class="se-track__label">BGM</span>
            <div class="se-track__lane">
              <span class="se-bgm" :style="blockStyle(0, totalMs)">
                BGM 轨（合成阶段混入；响度目标由配置控制）
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- 右：Inspector -->
      <aside class="se-inspector" aria-label="镜头 Inspector">
        <header class="se-inspector__head">
          <h2 class="se-inspector__title is-mono">{{ selectedShot?.shotId }}</h2>
          <span class="se-meta">{{ selectedShot?.sceneTitle }}</span>
        </header>

        <p v-if="actionError" class="se-error" role="alert">{{ actionError }}</p>

        <section class="se-field">
          <span class="se-label">口播（只读，改文案请回到对话）</span>
          <p class="se-narration">{{ selectedShot?.narration }}</p>
        </section>

        <section class="se-field">
          <span class="se-label">cue 时间戳</span>
          <ul class="se-cues">
            <li v-for="cue in selectedCues" :key="cue.cueId" class="is-mono">
              {{ cue.kind === "narration" ? "口播" : "动效" }}
              ·
              {{ cue.kind === "narration" ? `${formatMediaDuration(cue.startMs)} - ${formatMediaDuration(cue.endMs)}` : `@${formatMediaDuration(cue.atMs)}` }}
              <span v-if="cue.text" class="se-cue-text">{{ cue.text }}</span>
            </li>
          </ul>
          <p class="se-meta is-mono">镜头时长 {{ shotDurationText }}</p>
        </section>

        <section class="se-field">
          <label class="se-label" for="se-onscreen">屏上文字</label>
          <textarea id="se-onscreen" v-model="onScreenTextDraft" class="se-textarea" rows="2" />
          <VfButton variant="ghost" :disabled="saving" @click="saveOnScreenText">保存文字</VfButton>
        </section>

        <section class="se-field">
          <label class="se-label" for="se-emphasis">强调词（逗号分隔，≤10）</label>
          <input id="se-emphasis" v-model="emphasisDraft" class="se-input" />
          <VfButton variant="ghost" :disabled="saving" @click="saveEmphasis">保存强调</VfButton>
        </section>

        <section class="se-field">
          <label class="se-label" for="se-component">组件模板</label>
          <select
            id="se-component"
            class="se-input"
            :value="selectedShot?.component?.id ?? ''"
            @change="changeComponent"
          >
            <option value="">（未选型）</option>
            <option v-for="component in components" :key="component.id" :value="component.id">
              {{ component.name }}
            </option>
          </select>
        </section>

        <section class="se-field">
          <span class="se-label">素材绑定</span>
          <ul class="se-assets">
            <li v-for="ref in selectedShot?.assetRefs ?? []" :key="ref.assetId" class="is-mono">
              {{ ref.role ?? "ref" }} · {{ ref.label ?? ref.assetId }}
            </li>
            <li v-if="(selectedShot?.assetRefs ?? []).length === 0" class="se-meta">未绑定资产</li>
          </ul>
        </section>

        <section class="se-field">
          <span class="se-label">风格锚</span>
          <div class="se-anchors">
            <VfPill
              v-for="key in selectedShot?.anchorKeys ?? []"
              :key="key"
              tone="teal"
            >
              {{ key }}
            </VfPill>
            <span v-if="(selectedShot?.anchorKeys ?? []).length === 0" class="se-meta">
              无（使用默认风格）
            </span>
          </div>
        </section>

        <section class="se-field se-field--row">
          <label class="se-label" for="se-in">入场转场</label>
          <select
            id="se-in"
            class="se-input"
            :value="selectedShot?.transitionIn ?? 'hard-cut'"
            @change="changeTransition('transitionIn', $event)"
          >
            <option value="hard-cut">硬切</option>
            <option value="title-card">标题卡</option>
            <option value="fade-120">淡入 120ms</option>
          </select>
          <label class="se-label" for="se-out">出场转场</label>
          <select
            id="se-out"
            class="se-input"
            :value="selectedShot?.transitionOut ?? 'hard-cut'"
            @change="changeTransition('transitionOut', $event)"
          >
            <option value="hard-cut">硬切</option>
            <option value="title-card">标题卡</option>
            <option value="fade-120">淡出 120ms</option>
          </select>
        </section>

        <section class="se-field">
          <span class="se-label">主题 token</span>
          <div class="se-palette" aria-label="主题色板">
            <span
              v-for="(color, index) in [themePalette.accent, ...themePalette.secondary].filter(Boolean)"
              :key="`${color}-${index}`"
              class="se-swatch"
              :style="{ background: color }"
              :title="color"
            />
            <span class="se-meta is-mono">{{ themePalette.fontFamily }}</span>
          </div>
        </section>

        <section class="se-field">
          <span class="se-label">重生成此镜头（只跑选中阶段）</span>
          <div class="se-checks">
            <label v-for="stage in ['image', 'scene', 'tts'] as const" :key="stage">
              <input
                type="checkbox"
                :checked="regenerateStages.includes(stage)"
                @change="toggleRegenerateStage(stage, ($event.target as HTMLInputElement).checked)"
              />
              {{ stage }}
            </label>
          </div>
          <div class="se-inspector__actions">
            <VfButton variant="ghost" @click="previewMotion">预览动效</VfButton>
            <VfButton
              :disabled="regenerating || regenerateStages.length === 0"
              @click="regenerate"
            >
              {{ regenerating ? "提交中…" : "重生成此镜头" }}
            </VfButton>
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.storyboard-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.se-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-soft);
}

.se-back {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--text-sec);
  font-family: inherit;
  font-size: var(--font-size-small);
  cursor: pointer;
}

.se-back:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.se-title {
  margin: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.se-meta {
  font-size: var(--font-size-meta);
  color: var(--text-ter);
}

.se-hint {
  margin-inline-start: auto;
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.se-muted {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.se-error {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--danger);
}

.se-body {
  display: grid;
  grid-template-columns: 188px minmax(0, 1fr) var(--shell-inspector-width);
  gap: var(--space-3);
  align-items: start;
}

/* 左场景栏 */
.se-scenes {
  display: flex;
  max-height: calc(100vh - 180px);
  flex-direction: column;
  gap: var(--space-3);
  overflow: auto;
  padding: var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

.se-scene {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.se-scene__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.se-scene__chapter {
  font-size: var(--font-size-caption);
  color: var(--accent);
}

.se-scene__title {
  min-width: 0;
  overflow: hidden;
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-strong);
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.se-scene__count {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.se-shot {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-1) var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: var(--surface-2);
  color: var(--text-sec);
  font-family: inherit;
  text-align: start;
  cursor: pointer;
}

.se-shot.is-active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}

.se-shot:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.se-shot__id {
  font-size: var(--font-size-caption);
  color: var(--accent);
}

.se-shot__text {
  overflow: hidden;
  font-size: var(--font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 中：画布 */
.se-canvas-area {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-2);
}

.se-canvas {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

.se-canvas__image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.se-canvas__scrim {
  position: absolute;
  inset: 0;
  background: var(--deep);
  opacity: 0.35;
}

.se-canvas__chapter {
  position: absolute;
  top: var(--space-3);
  left: var(--space-3);
  padding: 2px var(--space-2);
  background: var(--film-bg);
  color: var(--film-text);
  font-size: var(--font-size-caption);
}

.se-canvas__text {
  position: absolute;
  inset: auto 8% 18%;
  margin: 0;
  font-size: clamp(18px, 3.2vw, 44px);
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
}

.se-canvas__text.is-previewing {
  animation: se-title-in 800ms ease-out;
}

@keyframes se-title-in {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.se-canvas__source {
  position: absolute;
  right: var(--space-3);
  bottom: var(--space-2);
  padding: 1px var(--space-2);
  background: var(--deep);
  color: var(--text-sec);
  font-size: var(--font-size-caption);
}

/* 镜头条 */
.se-shotbar {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.se-shotbar__item {
  flex: none;
  min-height: 26px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--text-ter);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
  cursor: pointer;
}

.se-shotbar__item.is-active {
  border-color: var(--accent);
  color: var(--accent);
}

/* 三轨 */
.se-tracks {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  overflow-x: auto;
}

.se-track {
  display: flex;
  align-items: stretch;
  gap: var(--space-2);
  min-width: 640px;
}

.se-track__label {
  width: 44px;
  flex: none;
  font-size: var(--font-size-caption);
  color: var(--text-ter);
  line-height: 26px;
}

.se-track__lane {
  position: relative;
  flex: 1;
  height: 26px;
  background: var(--inset);
  border-radius: var(--radius-control);
}

.se-track__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  padding-inline-start: var(--space-2);
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.se-block,
.se-cue,
.se-bgm {
  position: absolute;
  top: 2px;
  bottom: 2px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-2);
  color: var(--text-sec);
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.se-block {
  padding: 0 var(--space-1);
  cursor: pointer;
}

.se-block.is-active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.se-cue {
  padding: 0 var(--space-1);
  background: var(--info-soft);
  border-color: var(--info);
  color: var(--info);
}

.se-cue.is-animation {
  min-width: 4px;
  background: var(--warning-soft);
  border-color: var(--warning);
  color: var(--warning);
}

.se-bgm {
  padding: 0 var(--space-2);
  background: var(--teal-soft);
  border-color: var(--teal);
  color: var(--teal);
}

/* Inspector */
.se-inspector {
  display: flex;
  max-height: calc(100vh - 180px);
  flex-direction: column;
  gap: var(--space-3);
  overflow: auto;
  padding: var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

.se-inspector__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.se-inspector__title {
  margin: 0;
  font-size: var(--font-size-card-title);
  color: var(--text);
}

.se-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-soft);
}

.se-field--row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--space-2);
  align-items: center;
}

.se-label {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.se-narration {
  margin: 0;
  font-size: var(--font-size-small);
  line-height: var(--line-height-body);
  color: var(--text-sec);
}

.se-textarea,
.se-input {
  width: 100%;
  padding: var(--space-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text);
  font-family: inherit;
  font-size: var(--font-size-small);
}

.se-textarea:focus,
.se-input:focus {
  outline: none;
  border-color: var(--accent);
}

.se-cues,
.se-assets {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 2px;
  list-style: none;
  font-size: var(--font-size-caption);
  color: var(--text-sec);
}

.se-cue-text {
  display: block;
  overflow: hidden;
  color: var(--text-ter);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.se-anchors {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.se-palette {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.se-swatch {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-control);
  border: 1px solid var(--border);
}

.se-checks {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  font-size: var(--font-size-small);
  color: var(--text-sec);
}

.se-inspector__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.is-mono {
  font-family: var(--font-mono);
}

/* 响应式：<1280 Inspector 移到画布下方；<768 底部抽屉语义改为整列堆叠 */
@media (max-width: 1279.98px) {
  .se-body {
    grid-template-columns: 160px minmax(0, 1fr);
  }

  .se-inspector {
    grid-column: 1 / -1;
    max-height: none;
  }
}

@media (max-width: 767.98px) {
  .se-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .se-scenes {
    max-height: 220px;
  }

  .se-inspector {
    max-height: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .se-canvas__text.is-previewing {
    animation: none;
  }
}
</style>
