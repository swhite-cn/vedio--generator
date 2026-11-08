<script setup lang="ts">
/**
 * 组件库（方案 §8.5 第 8 页 / T310）：7 类组件预览卡、参数说明与新增指引。
 *
 * 数据：`GET /api/components`（注册表条目含 paramsSchema / coverageNote）与
 * `GET /api/components/:id/preview`（静态 fixture props）。只读，不提供在线编辑器。
 */
import { computed, onMounted, ref } from "vue";
import { apiRequest } from "../services/api";
import VfButton from "../components/ui/VfButton.vue";
import VfPill from "../components/ui/VfPill.vue";

/** 组件类别中文名。 */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  text: "关键词块",
  data: "数据卡",
  quote: "引语卡",
  compare: "对比条",
  progress: "进度环",
  chapter: "章节角标",
  source: "来源标签",
};

/** 单个参数声明。 */
interface ParamSpec {
  type: string;
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  enumValues?: string[];
}

/** 注册表条目。 */
interface ComponentEntry {
  id: string;
  name: string;
  category: string;
  coverageNote?: string;
  paramsSchema: Record<string, ParamSpec>;
  animations: string[];
  previewFixture?: string;
}

/** 预览 fixture。 */
interface PreviewFixture {
  componentId: string;
  props: Record<string, unknown>;
}

const components = ref<ComponentEntry[]>([]);
const fixtures = ref<Record<string, PreviewFixture>>({});
const loading = ref(false);
const error = ref<unknown>(null);

/** 参数名列表（按声明顺序）。 */
function paramNames(entry: ComponentEntry): string[] {
  return Object.keys(entry.paramsSchema);
}

/**
 * 取预览主文案：优先常见内容字段，否则回退组件名。
 * @param entry 注册表条目
 * @returns 预览文案
 */
function previewText(entry: ComponentEntry): string {
  const props = fixtures.value[entry.id]?.props ?? {};
  for (const key of ["title", "text", "quote", "value", "label", "words", "author", "caption"]) {
    const value = props[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (Array.isArray(value) && value.length > 0) return value.join(" · ");
  }
  return entry.name;
}

/** 预览副文案（参数摘要）。 */
function previewMeta(entry: ComponentEntry): string {
  const props = fixtures.value[entry.id]?.props ?? {};
  const parts = Object.entries(props)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .slice(0, 2)
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.join(" · ");
}

/** 加载注册表与全部预览 fixture。 */
async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const result = await apiRequest<{ items: ComponentEntry[] }>("/api/components");
    components.value = result.items;
    const pairs = await Promise.allSettled(
      result.items.map(async (entry) => {
        const preview = await apiRequest<{ fixture: PreviewFixture }>(
          `/api/components/${encodeURIComponent(entry.id)}/preview`,
        );
        return [entry.id, preview.fixture] as const;
      }),
    );
    const map: Record<string, PreviewFixture> = {};
    for (const pair of pairs) {
      if (pair.status === "fulfilled") {
        const [id, fixture] = pair.value;
        map[id] = fixture;
      }
    }
    fixtures.value = map;
  } catch (caught) {
    error.value = caught;
    console.warn("[web] 组件库加载失败", caught);
  } finally {
    loading.value = false;
  }
}

/** 按类别排序的组件列表。 */
const ordered = computed(() =>
  [...components.value].sort((a, b) =>
    Object.keys(CATEGORY_LABELS).indexOf(a.category) -
    Object.keys(CATEGORY_LABELS).indexOf(b.category),
  ),
);

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="components-view">
    <header class="page-head">
      <div class="page-head__text">
        <h1 class="page-title">组件库</h1>
        <p class="page-subtitle">
          版式由组件注册表驱动；LLM 只选型填参，渲染与装配在服务端强校验。
        </p>
      </div>
      <VfButton variant="ghost" @click="load">刷新</VfButton>
    </header>

    <p v-if="error" class="error" role="alert">
      组件库加载失败，请检查服务是否在线。
      <button type="button" class="link-button" @click="load">重试</button>
    </p>
    <p v-else-if="loading && components.length === 0" class="muted">正在加载组件…</p>

    <div v-else class="component-grid">
      <article v-for="entry in ordered" :key="entry.id" class="component-card">
        <div class="component-preview" :aria-label="`${entry.name} 预览`">
          <span class="component-preview__category is-mono">
            {{ CATEGORY_LABELS[entry.category] ?? entry.category }}
          </span>
          <p class="component-preview__text">{{ previewText(entry) }}</p>
          <p v-if="previewMeta(entry)" class="component-preview__meta is-mono">
            {{ previewMeta(entry) }}
          </p>
        </div>

        <div class="component-body">
          <header class="component-head">
            <h2 class="component-name">{{ entry.name }}</h2>
            <VfPill :tone="fixtures[entry.id] ? 'success' : 'warning'">
              {{ fixtures[entry.id] ? "fixture 就绪" : "无 fixture" }}
            </VfPill>
          </header>
          <p class="component-id is-mono">{{ entry.id }} · {{ entry.category }}</p>
          <p v-if="entry.coverageNote" class="component-coverage">{{ entry.coverageNote }}</p>
          <p class="component-params">
            参数：
            <span v-for="name in paramNames(entry)" :key="name" class="param is-mono">
              {{ name }}{{ entry.paramsSchema[name]?.required ? "*" : "" }}
            </span>
            <span v-if="paramNames(entry).length === 0" class="muted">无</span>
          </p>
          <p v-if="entry.animations.length > 0" class="component-anim is-mono">
            动效：{{ entry.animations.join(" · ") }}
          </p>
        </div>
      </article>

      <!-- 新增组件：只给开发指引，不做在线编辑器 -->
      <article class="component-card component-card--guide">
        <h2 class="component-name">新增组件</h2>
        <p class="guide-text">
          在组件注册表追加一条声明（ID / 名称 / 参数 schema / preview fixture / React 实现），
          再补一个 fixture 即可被组件库自动发现；流水线阶段无需改动。
        </p>
        <p class="guide-text muted">本页只做开发指引，不提供在线编辑器。</p>
      </article>
    </div>

    <footer class="page-foot">
      主题 token 驱动，切换主题不需改组件；预览为静态 fixture，最终像素以 Remotion 渲染为准。
    </footer>
  </div>
</template>

<style scoped>
.components-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
}

.page-head__text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.page-title {
  margin: 0;
  font-size: var(--font-size-page-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.page-subtitle {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.error {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--danger);
}

.link-button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: var(--font-size-small);
  cursor: pointer;
}

.muted {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.component-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-4);
}

.component-card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

/* 预览使用成片令牌：只出现在预览画布，不用于界面控件 */
.component-preview {
  position: relative;
  display: flex;
  aspect-ratio: 16 / 9;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  padding: var(--space-4);
  background: var(--film-bg);
  color: var(--film-text);
}

.component-preview__category {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  color: var(--film-secondary-2);
  font-size: var(--font-size-caption);
}

.component-preview__text {
  margin: 0;
  font-size: clamp(14px, 1.6vw, 22px);
  font-weight: 700;
  text-align: center;
  text-decoration: underline;
  text-decoration-color: var(--film-accent);
  text-underline-offset: 4px;
}

.component-preview__meta {
  margin: 0;
  font-size: var(--font-size-caption);
  color: var(--film-secondary-2);
}

.component-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
}

.component-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.component-name {
  margin: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.component-id {
  margin: 0;
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.component-coverage {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-sec);
}

.component-params {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--font-size-caption);
  color: var(--text-sec);
}

.param {
  padding: 1px var(--space-2);
  background: var(--surface-2);
  border-radius: var(--radius-pill);
  color: var(--text-sec);
}

.component-anim {
  margin: 0;
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.component-card--guide {
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  border-style: dashed;
  background: transparent;
}

.guide-text {
  margin: 0;
  font-size: var(--font-size-small);
  line-height: var(--line-height-body);
  color: var(--text-sec);
}

.page-foot {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.is-mono {
  font-family: var(--font-mono);
}
</style>
