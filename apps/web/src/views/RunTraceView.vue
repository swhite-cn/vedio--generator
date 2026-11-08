<script setup lang="ts">
/**
 * 旧 Trace 路由重定向（T307）：`/runs/:id/trace` → `/projects/:id/runs/:runId`。
 *
 * 旧链接只带 run id，需要先取 run 详情拿到 project_id；失败时给出返回项目列表的兜底入口。
 * `?admin=1` 等查询参数原样带到新路由。
 */
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiRequest } from "../services/api";
import VfButton from "../components/ui/VfButton.vue";

const route = useRoute();
const router = useRouter();

/** 跳转失败提示。 */
const failed = ref(false);

onMounted(async () => {
  const runId = String(route.params.id ?? "");
  try {
    const result = await apiRequest<{ run: { project_id: string } }>(
      `/api/runs/${encodeURIComponent(runId)}`,
    );
    await router.replace({
      path: `/projects/${result.run.project_id}/runs/${runId}`,
      query: route.query,
    });
  } catch (error) {
    failed.value = true;
    console.warn("[web] 旧 Trace 路由重定向失败", error);
  }
});
</script>

<template>
  <section class="legacy-redirect">
    <p v-if="!failed" class="legacy-redirect__text">正在跳转到 Run 详情…</p>
    <template v-else>
      <p class="legacy-redirect__text">无法定位该 Run，可能已被删除或无权访问。</p>
      <VfButton @click="router.push('/projects')">返回项目列表</VfButton>
    </template>
  </section>
</template>

<style scoped>
.legacy-redirect {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  padding-top: var(--space-8);
}

.legacy-redirect__text {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}
</style>
