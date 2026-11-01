<script setup lang="ts">
/**
 * 审核卡片（Web 专题 §5.4.2）：`review_gate` 事件触发，展示待审核阶段与该阶段产物摘要；
 * 提供「通过，继续」（主）/「重跑此阶段」（次）+ 可选 feedback 输入框；
 * 提交调用 `POST /api/runs/:id/resume`；**提交后卡片置灰并显示已选结论**。
 * payload 构造与可提交性判断复用纯函数 `review-logic`。
 */
import { computed, ref, watch } from "vue";
import { STAGE_LABELS } from "./state-mapping";
import {
  buildResumePayload,
  canSubmitReview,
  type ResumePayload,
  type ReviewAction,
} from "./review-logic";
import type { ReviewCardData } from "../stores/workbench-reducer";

const props = withDefaults(
  defineProps<{
    /** 审核卡片数据。 */
    review: ReviewCardData;
    /** 是否正在提交（父组件 actionPending）。 */
    submitting?: boolean;
  }>(),
  { submitting: false },
);

const emit = defineEmits<{
  /** 提交审核结论。 */
  (event: "submit", payload: ResumePayload): void;
}>();

/** 反馈文本。 */
const feedback = ref("");

/** 换卡（不同 run/阶段）时重置本地反馈。 */
watch(
  () => `${props.review.runId}-${props.review.stage}`,
  () => {
    feedback.value = "";
  },
);

/** 阶段中文名。 */
const stageLabel = computed(() => STAGE_LABELS[props.review.stage] ?? props.review.stage);

/** 是否已提交（置灰）。 */
const resolved = computed<ReviewAction | null>(() => props.review.resolved ?? null);

/** 是否可提交。 */
const submittable = computed(() =>
  canSubmitReview({ resolved: resolved.value, submitting: props.submitting }),
);

/** 已提交结论文案。 */
const resolvedText = computed(() =>
  resolved.value === "approve"
    ? "已选择：通过，继续"
    : resolved.value === "retry"
      ? "已选择：重跑此阶段"
      : "",
);

/**
 * 点击审核按钮：构造 payload 并向上抛出（父组件调用 store 提交）。
 * @param action 结论
 */
function submit(action: ReviewAction): void {
  if (!submittable.value) {
    return;
  }
  emit("submit", buildResumePayload(action, feedback.value));
}
</script>

<template>
  <div class="review-card" :class="{ 'is-resolved': Boolean(resolved) }">
    <div class="review-head">
      <a-tag color="warning">审核点</a-tag>
      <span class="review-title">{{ stageLabel }}阶段待审核</span>
    </div>

    <p class="review-summary">{{ review.summary }}</p>

    <template v-if="!resolved">
      <a-textarea
        v-model:value="feedback"
        :rows="2"
        :disabled="!submittable"
        placeholder="可选反馈，如：文案再口语化一点"
        class="review-feedback"
      />
      <div class="review-actions">
        <a-button
          type="primary"
          :disabled="!submittable"
          :loading="submitting"
          @click="submit('approve')"
        >
          通过，继续
        </a-button>
        <a-button :disabled="!submittable" @click="submit('retry')">重跑此阶段</a-button>
      </div>
    </template>

    <div v-else class="review-resolved">
      <span class="review-resolved-text">{{ resolvedText }}</span>
      <span v-if="review.feedback" class="review-resolved-feedback"
        >反馈：{{ review.feedback }}</span
      >
    </div>
  </div>
</template>

<style scoped>
.review-card {
  padding: 12px 14px;
  border: 1px solid #ffe58f;
  border-radius: 8px;
  background: #fffbe6;
}

.review-card.is-resolved {
  opacity: 0.65;
  filter: grayscale(0.2);
}

.review-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.review-title {
  font-weight: 600;
}

.review-summary {
  margin: 8px 0;
  color: rgb(0 0 0 / 65%);
  font-size: 13px;
  white-space: pre-wrap;
}

.review-feedback {
  margin-bottom: 8px;
}

.review-actions {
  display: flex;
  gap: 8px;
}

.review-resolved {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.review-resolved-text {
  font-weight: 600;
}

.review-resolved-feedback {
  color: rgb(0 0 0 / 45%);
}
</style>
