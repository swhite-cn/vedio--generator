<script setup lang="ts">
/**
 * 风格锚管理模态（T401，方案 §5.7/§8.5 素材库）：
 * - 为每个锚点绑定项目图片资产（复用同一资产 = 跨镜头一致）；
 * - 编辑 seed（同一种子跨镜头复用；留空表示恢复 image 阶段稳定派生值）；
 * - 显式重建：清空已缓存锚点图，让下一次 image 阶段重新生成。
 *
 * 只提交 `PATCH/POST /api/projects/:id/style-anchors/:key`，返回后由父页面重新拉取 storyboard。
 */
import { computed, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { apiRequest, formatApiError } from "../services/api";
import type { Project } from "../stores/projects";
import { buildMediaUrl } from "./media-url";
import VfButton from "./ui/VfButton.vue";
import VfModal from "./ui/VfModal.vue";

/** 风格锚（copy v2 快照子集）。 */
export interface StyleAnchorItem {
  key: string;
  label?: string;
  color?: string;
  assetId?: string;
  assetPath?: string;
  seed?: number;
}

/** 可绑定为锚点的图片资产子集。 */
export interface AnchorImageAsset {
  id: string;
  label: string;
  mime_type: string;
  relative_path: string;
}

/** 行内编辑状态。 */
interface AnchorRow {
  seedText: string;
  assetId: string;
}

const props = withDefaults(
  defineProps<{
    /** 是否打开（v-model:open）。 */
    open: boolean;
    /** 当前项目；为空时禁用提交。 */
    project: Project | null;
    /** 当前项目的风格锚列表。 */
    anchors: StyleAnchorItem[];
    /** 可绑定的图片资产。 */
    imageAssets: AnchorImageAsset[];
    /** 媒体票据（缩略图鉴权）。 */
    mediaTicket?: string;
  }>(),
  { mediaTicket: "" },
);

const emit = defineEmits<{
  "update:open": [value: boolean];
  /** 任一锚点变更成功后触发，父页面据此刷新素材库/分镜。 */
  saved: [];
}>();

/** 每个锚点的行内编辑值。 */
const rows = reactive<Record<string, AnchorRow>>({});
/** 正在提交的锚点 key（空串表示空闲）。 */
const savingKey = ref("");
/** 行内错误。 */
const errorText = ref("");

/**
 * 用服务端快照重置行内编辑值。
 */
function syncRows(): void {
  for (const key of Object.keys(rows)) delete rows[key];
  for (const anchor of props.anchors) {
    rows[anchor.key] = {
      seedText: anchor.seed === undefined ? "" : String(anchor.seed),
      assetId: anchor.assetId ?? "",
    };
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      errorText.value = "";
      syncRows();
    }
  },
  { immediate: true },
);

// 弹层内容在关闭时也可能被渲染（AntD 隐藏但不销毁），因此锚点一变化就同步行内值
watch(() => props.anchors, syncRows, { deep: true, immediate: true });

/** 关闭并回写 v-model:open。 */
function close(): void {
  emit("update:open", false);
}

/**
 * 构造锚点缩略图地址。
 * @param assetPath 锚点已生成/绑定的项目相对路径
 * @returns 媒体 URL；项目或路径缺失时为空串
 */
function thumbUrl(assetPath?: string): string {
  if (!props.project || !assetPath) return "";
  return buildMediaUrl(props.project, assetPath, props.mediaTicket);
}

/**
 * 保存单个锚点的 seed 与资产绑定。
 * @param anchor 目标锚点
 */
async function saveAnchor(anchor: StyleAnchorItem): Promise<void> {
  if (!props.project || savingKey.value) return;
  const row = rows[anchor.key];
  if (!row) return;
  const trimmed = row.seedText.trim();
  const seed = trimmed === "" ? null : Number(trimmed);
  if (seed !== null && (!Number.isInteger(seed) || seed < 0)) {
    errorText.value = "seed 必须是 0 或正整数（留空表示自动派生）";
    return;
  }
  savingKey.value = anchor.key;
  errorText.value = "";
  try {
    await apiRequest(`/api/projects/${props.project.id}/style-anchors/${encodeURIComponent(anchor.key)}`, {
      method: "PATCH",
      body: { seed, assetId: row.assetId || null },
    });
    message.success(`风格锚「${anchor.label ?? anchor.key}」已保存`);
    emit("saved");
  } catch (error) {
    errorText.value = formatApiError(error);
  } finally {
    savingKey.value = "";
  }
}

/**
 * 显式重建锚点：清空缓存图，下一次 image 阶段重新生成。
 * @param anchor 目标锚点
 */
async function rebuildAnchor(anchor: StyleAnchorItem): Promise<void> {
  if (!props.project || savingKey.value) return;
  savingKey.value = anchor.key;
  errorText.value = "";
  try {
    const result = await apiRequest<{ archived: boolean }>(
      `/api/projects/${props.project.id}/style-anchors/${encodeURIComponent(anchor.key)}/rebuild`,
      { method: "POST", body: {} },
    );
    message.success(
      result.archived
        ? "已归档旧锚点图，下次 image 阶段将重新生成"
        : "已标记重建，下次 image 阶段将生成锚点图",
    );
    emit("saved");
  } catch (error) {
    errorText.value = formatApiError(error);
  } finally {
    savingKey.value = "";
  }
}
</script>

<template>
  <VfModal :open="open" title="管理风格锚" :width="760" @update:open="emit('update:open', $event)">
    <p class="sa-hint">
      同一锚点绑定一份图片资产并复用同一 seed，跨镜头保持一致；重建会归档缓存图并在下次 image 阶段重新生成。
    </p>
    <p v-if="errorText" class="sa-error" role="alert">{{ errorText }}</p>

    <div v-if="anchors.length === 0" class="sa-empty">
      该项目尚未定义风格锚（copy v2 `styleAnchors` 为空）。
    </div>

    <ul v-else class="sa-list">
      <li v-for="anchor in anchors" :key="anchor.key" class="sa-row">
        <span class="sa-thumb" aria-hidden="true">
          <img v-if="thumbUrl(anchor.assetPath)" :src="thumbUrl(anchor.assetPath)" :alt="`风格锚 ${anchor.key}`" />
          <span v-else>{{ anchor.key.slice(0, 2) }}</span>
        </span>

        <div class="sa-meta">
          <span class="sa-label">{{ anchor.label ?? anchor.key }}</span>
          <span class="sa-key is-mono">{{ anchor.key }}</span>
          <span class="sa-color is-mono">{{ anchor.color ?? "—" }}</span>
        </div>

        <div class="sa-fields">
          <label class="sa-field">
            <span class="sa-field__label">seed</span>
            <input
              v-model="rows[anchor.key].seedText"
              class="sa-input is-mono"
              type="text"
              inputmode="numeric"
              placeholder="自动派生"
              :aria-label="`风格锚 ${anchor.key} 的 seed`"
            />
          </label>
          <label class="sa-field sa-field--wide">
            <span class="sa-field__label">绑定素材</span>
            <select
              v-model="rows[anchor.key].assetId"
              class="sa-input"
              :aria-label="`风格锚 ${anchor.key} 绑定的图片资产`"
            >
              <option value="">不绑定（由 image 阶段生成）</option>
              <option v-for="asset in imageAssets" :key="asset.id" :value="asset.id">
                {{ asset.label }}
              </option>
            </select>
          </label>
        </div>

        <div class="sa-actions">
          <VfButton :disabled="savingKey === anchor.key" @click="saveAnchor(anchor)">
            {{ savingKey === anchor.key ? "保存中…" : "保存" }}
          </VfButton>
          <VfButton
            variant="ghost"
            :disabled="savingKey === anchor.key"
            title="归档当前锚点图，下次 image 阶段重新生成"
            @click="rebuildAnchor(anchor)"
          >
            重建
          </VfButton>
        </div>
      </li>
    </ul>

    <template #footer>
      <VfButton variant="ghost" @click="close">关闭</VfButton>
    </template>
  </VfModal>
</template>

<style scoped>
.sa-hint {
  margin: 0 0 var(--space-3);
  color: var(--text-sec);
  font-size: var(--font-size-caption);
  line-height: 1.6;
}

.sa-error {
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--danger);
  border-radius: var(--radius-control);
  color: var(--danger);
  font-size: var(--font-size-caption);
}

.sa-empty {
  padding: var(--space-6) 0;
  color: var(--text-ter);
  text-align: center;
}

.sa-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 52vh;
  overflow-y: auto;
}

.sa-row {
  display: grid;
  grid-template-columns: 56px 120px minmax(260px, 1fr) auto;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

.sa-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text-ter);
  font-size: var(--font-size-caption);
}

.sa-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sa-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.sa-label {
  color: var(--text);
  font-weight: var(--font-weight-strong);
}

.sa-key,
.sa-color {
  color: var(--text-ter);
  font-size: var(--font-size-caption);
}

.sa-fields {
  display: grid;
  grid-template-columns: 100px minmax(180px, 1fr);
  gap: var(--space-2);
  min-width: 0;
}

.sa-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.sa-field__label {
  color: var(--text-ter);
  font-size: var(--font-size-caption);
}

.sa-input {
  width: 100%;
  height: 32px;
  padding: 0 var(--space-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text);
  font-family: inherit;
  font-size: var(--font-size-caption);
}

.sa-input:focus {
  outline: none;
  border-color: var(--accent);
}

.sa-actions {
  display: flex;
  gap: var(--space-2);
}

@media (max-width: 720px) {
  .sa-row {
    grid-template-columns: 48px 1fr;
  }

  .sa-thumb {
    width: 48px;
    height: 48px;
  }

  .sa-fields,
  .sa-actions {
    grid-column: 1 / -1;
  }

  .sa-fields {
    grid-template-columns: 100px minmax(120px, 1fr);
  }
}
</style>
