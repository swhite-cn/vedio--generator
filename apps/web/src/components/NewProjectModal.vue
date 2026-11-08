<script setup lang="ts">
/**
 * 新建项目两步向导（方案 §8.5 第 3 页）。
 *
 * 第一步卡片式选择能力；第二步填写参数（名称*、主题*、风格、输出 Profile、风格锚参考图）。
 * 提交 `POST /api/projects`（服务端会同步建会话并触发首个 run）；若选择了风格锚参考图，
 * 项目创建后经 `POST /api/projects/:id/assets/upload` 作为项目资产上传。
 */
import { reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { useCapabilitiesStore } from "../stores/capabilities";
import { useProjectsStore, type Project } from "../stores/projects";
import { apiRequest, formatApiError } from "../services/api";
import VfModal from "./ui/VfModal.vue";
import VfButton from "./ui/VfButton.vue";
import VfInput from "./ui/VfInput.vue";

const props = withDefaults(
  defineProps<{
    /** 是否打开。 */
    open: boolean;
    /** 预选能力 id（来自能力中心「使用此能力」入口），提供时直接进入第二步。 */
    initialCapabilityId?: string;
  }>(),
  { initialCapabilityId: "" },
);

const emit = defineEmits<{
  /** 关闭状态同步。 */
  (event: "update:open", value: boolean): void;
  /** 项目创建成功。 */
  (event: "created", project: Project): void;
}>();

/** 输出 Profile 兜底项（`GET /api/profiles` 失败时保留离线可用）。 */
const DEFAULT_PROFILE_OPTIONS = [
  { value: "landscape-1080p", label: "横屏 1080p" },
  { value: "portrait-1080p", label: "竖屏 1080p" },
];

/** 单文件上传上限（与服务端 `assets.max_upload_bytes` 默认值一致，仅作前置提示）。 */
const MAX_ANCHOR_BYTES = 50 * 1024 * 1024;

const capabilitiesStore = useCapabilitiesStore();
const projectsStore = useProjectsStore();

/** 输出 Profile 选项（来自服务端 `config/profiles/*.yaml`）。 */
const profileOptions = ref<Array<{ value: string; label: string }>>([...DEFAULT_PROFILE_OPTIONS]);
/** 当前步骤：0 选择能力、1 填写参数。 */
const step = ref(0);
/** 提交中。 */
const submitting = ref(false);
/** 能力列表加载失败标记（禁用「下一步」）。 */
const capabilitiesFailed = ref(false);
/** 项目名额上限标记。 */
const limitReached = ref(false);
/** 提交失败的行内错误。 */
const submitError = ref("");
/** 选中的能力 id。 */
const selectedCapabilityId = ref("");
/** 风格锚参考图（可选）。 */
const anchorFile = ref<File | null>(null);
/** 隐藏的文件输入引用（移除文件时同步清空 value）。 */
const anchorInput = ref<HTMLInputElement | null>(null);

/** 第二步表单字段。 */
const formState = reactive({
  name: "",
  topic: "",
  style: "",
  profile: "landscape-1080p",
});

/** 字段级校验错误。 */
const fieldErrors = reactive<{ name?: string; topic?: string; anchor?: string }>({});

/** 名称非法字符规则（与服务端可接受的 Windows 路径字符一致）。 */
const NAME_PATTERN = /^[^\\/:*?"<>|]+$/;

/**
 * 拉取服务端可用输出 Profile（失败时保留本地默认项）。
 */
async function loadProfiles(): Promise<void> {
  try {
    const result = await apiRequest<{ profiles: Array<{ value: string; label: string }> }>(
      "/api/profiles",
    );
    if (result.profiles.length > 0) {
      profileOptions.value = result.profiles;
      if (!profileOptions.value.some((item) => item.value === formState.profile)) {
        formState.profile = profileOptions.value[0]!.value;
      }
    }
  } catch (error) {
    console.warn("[web] Profile 列表加载失败，回退本地默认项", error);
  }
}

/** 重置向导状态。 */
function resetWizard(): void {
  step.value = 0;
  submitting.value = false;
  capabilitiesFailed.value = false;
  limitReached.value = false;
  submitError.value = "";
  selectedCapabilityId.value = props.initialCapabilityId;
  formState.name = "";
  formState.topic = "";
  formState.style = "";
  formState.profile = "landscape-1080p";
  anchorFile.value = null;
  fieldErrors.name = undefined;
  fieldErrors.topic = undefined;
  fieldErrors.anchor = undefined;
  if (anchorInput.value) {
    anchorInput.value.value = "";
  }
}

/**
 * 打开时初始化：加载能力与 Profile；有预选能力则直接进入第二步。
 */
async function initialize(): Promise<void> {
  resetWizard();
  void loadProfiles();
  try {
    const list = await capabilitiesStore.load();
    if (props.initialCapabilityId && list.some((item) => item.id === props.initialCapabilityId)) {
      selectedCapabilityId.value = props.initialCapabilityId;
      step.value = 1;
    } else if (!selectedCapabilityId.value && list.length > 0) {
      selectedCapabilityId.value = list[0]!.id;
    }
  } catch (error) {
    capabilitiesFailed.value = true;
    console.warn("[web] 能力列表加载失败，新建项目向导禁用于下一步", error);
  }
}

/** 关闭向导。 */
function close(): void {
  emit("update:open", false);
}

/**
 * 选择能力。
 * @param capabilityId 能力 id
 */
function selectCapability(capabilityId: string): void {
  selectedCapabilityId.value = capabilityId;
}

/** 进入第二步（需已选中能力且能力列表加载成功）。 */
function goNext(): void {
  if (capabilitiesFailed.value || !selectedCapabilityId.value) {
    return;
  }
  submitError.value = "";
  step.value = 1;
}

/** 返回第一步。 */
function goPrev(): void {
  step.value = 0;
}

/**
 * 校验第二步字段并写入 `fieldErrors`。
 * @returns 全部通过返回 true
 */
function validateForm(): boolean {
  fieldErrors.name = undefined;
  fieldErrors.topic = undefined;

  const name = formState.name.trim();
  if (!name) {
    fieldErrors.name = "请输入项目名称";
  } else if (name.length > 50) {
    fieldErrors.name = "项目名称不超过 50 个字符";
  } else if (!NAME_PATTERN.test(name)) {
    fieldErrors.name = '项目名称不能包含 \\ / : * ? " < > |';
  }

  if (!formState.topic.trim()) {
    fieldErrors.topic = "请输入主题";
  }

  return !fieldErrors.name && !fieldErrors.topic;
}

/**
 * 选择风格锚参考图：仅接受图片并限制单文件大小（服务端仍做签名校验）。
 * @param event 文件输入变更事件
 */
function onAnchorChange(event: Event): void {
  const files = (event.target as HTMLInputElement).files;
  const file = files?.[0] ?? null;
  fieldErrors.anchor = undefined;
  if (!file) {
    anchorFile.value = null;
    return;
  }
  if (!file.type.startsWith("image/")) {
    fieldErrors.anchor = "风格锚参考图需为图片文件";
    anchorFile.value = null;
    return;
  }
  if (file.size > MAX_ANCHOR_BYTES) {
    fieldErrors.anchor = "参考图不能超过 50MB";
    anchorFile.value = null;
    return;
  }
  anchorFile.value = file;
}

/** 移除已选参考图并清空原生输入。 */
function clearAnchor(): void {
  anchorFile.value = null;
  fieldErrors.anchor = undefined;
  if (anchorInput.value) {
    anchorInput.value.value = "";
  }
}

/**
 * 上传风格锚参考图（项目创建后才有项目 id）。
 * @param projectId 项目 id
 * @param file 图片文件
 */
async function uploadAnchor(projectId: string, file: File): Promise<void> {
  const formData = new FormData();
  formData.append("file", file);
  await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/assets/upload`, {
    method: "POST",
    body: formData,
  });
}

/** 提交新建项目。 */
async function submit(): Promise<void> {
  submitError.value = "";
  limitReached.value = false;
  if (!validateForm()) {
    return;
  }
  submitting.value = true;
  try {
    const project = await projectsStore.create({
      capabilityId: selectedCapabilityId.value,
      name: formState.name.trim(),
      topic: formState.topic.trim(),
      style: formState.style.trim() || undefined,
      profile: formState.profile,
    });

    // 首个 run 已由服务端异步触发；参考图在此之后作为项目资产上传
    if (anchorFile.value) {
      try {
        await uploadAnchor(project.id, anchorFile.value);
      } catch (error) {
        console.warn("[web] 风格锚参考图上传失败", error);
        message.warning("项目已创建，但风格锚参考图上传失败，可在素材库重新上传。");
      }
    }

    emit("created", project);
    close();
  } catch (error) {
    const apiMessage = (error as { message?: string } | undefined)?.message ?? "";
    limitReached.value = apiMessage.includes("项目数量已达上限");
    submitError.value = limitReached.value ? "" : formatApiError(error);
  } finally {
    submitting.value = false;
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      void initialize();
    }
  },
  { immediate: true },
);
</script>

<template>
  <VfModal :open="open" title="新建项目" :width="720" @update:open="emit('update:open', $event)">
    <div class="new-project">
      <div class="wizard-steps" aria-label="新建项目步骤">
        <span class="wizard-step" :class="{ 'is-current': step === 0, 'is-done': step > 0 }">
          <span class="wizard-index is-mono">1</span>选择能力
        </span>
        <span class="wizard-sep" aria-hidden="true" />
        <span class="wizard-step" :class="{ 'is-current': step === 1 }">
          <span class="wizard-index is-mono">2</span>填写参数
        </span>
      </div>

      <p v-if="capabilitiesFailed" class="form-error" role="alert">
        能力列表加载失败，请稍后重试。
      </p>
      <p v-if="limitReached" class="form-error" role="alert">项目数量已达上限（50）。</p>
      <p v-else-if="submitError" class="form-error" role="alert">{{ submitError }}</p>

      <!-- 第一步：卡片式选择能力 -->
      <div v-if="step === 0" class="capability-picker">
        <button
          v-for="capability in capabilitiesStore.list"
          :key="capability.id"
          type="button"
          class="capability-option"
          :class="{ 'is-selected': selectedCapabilityId === capability.id }"
          :aria-pressed="selectedCapabilityId === capability.id"
          @click="selectCapability(capability.id)"
        >
          <span class="option-name">{{ capability.name }}</span>
          <span class="option-desc">{{ capability.description }}</span>
          <span class="option-meta is-mono">{{ capability.stages.length }} 阶段 · {{ capability.finalArtifact }}</span>
        </button>
        <p v-if="capabilitiesStore.list.length === 0" class="form-hint">
          暂无可用能力，请联系管理员。
        </p>
      </div>

      <!-- 第二步：填写参数 -->
      <form v-else class="project-form" novalidate @submit.prevent="submit">
        <div class="field">
          <label class="field-label" for="np-name">名称 <span aria-hidden="true">*</span></label>
          <VfInput id="np-name" v-model="formState.name" placeholder="请输入项目名称" />
          <p v-if="fieldErrors.name" class="field-error" role="alert">{{ fieldErrors.name }}</p>
        </div>

        <div class="field">
          <label class="field-label" for="np-topic">主题 <span aria-hidden="true">*</span></label>
          <textarea
            id="np-topic"
            v-model="formState.topic"
            class="vf-textarea"
            rows="3"
            placeholder="请输入视频主题（口播内容围绕该主题展开）"
          />
          <p v-if="fieldErrors.topic" class="field-error" role="alert">{{ fieldErrors.topic }}</p>
        </div>

        <div class="field">
          <label class="field-label" for="np-style">风格</label>
          <VfInput id="np-style" v-model="formState.style" placeholder="可选，如：轻松科普" />
        </div>

        <div class="field">
          <label class="field-label" for="np-profile">输出 Profile</label>
          <select id="np-profile" v-model="formState.profile" class="vf-select">
            <option v-for="option in profileOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <p class="field-hint">选项来自服务端 config/profiles 配置。</p>
        </div>

        <div class="field">
          <label class="field-label" for="np-anchor">风格锚参考图</label>
          <input
            id="np-anchor"
            ref="anchorInput"
            type="file"
            accept="image/*"
            class="vf-file"
            @change="onAnchorChange"
          />
          <div v-if="anchorFile" class="anchor-selected">
            <span class="is-mono">{{ anchorFile.name }}</span>
            <VfButton variant="ghost" @click="clearAnchor">移除</VfButton>
          </div>
          <p v-if="fieldErrors.anchor" class="field-error" role="alert">{{ fieldErrors.anchor }}</p>
          <p v-else class="field-hint">可选；项目创建后作为项目资产上传，可用于逐镜复用风格。</p>
        </div>
      </form>
    </div>

    <template #footer>
      <VfButton v-if="step === 0" variant="ghost" @click="close">取消</VfButton>
      <VfButton v-else variant="ghost" @click="goPrev">上一步</VfButton>

      <VfButton
        v-if="step === 0"
        :disabled="capabilitiesFailed || !selectedCapabilityId"
        @click="goNext"
      >
        下一步
      </VfButton>
      <VfButton v-else :disabled="submitting" @click="submit">
        {{ submitting ? "创建中…" : "创建项目" }}
      </VfButton>
    </template>
  </VfModal>
</template>

<style scoped>
.new-project {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* 步骤条 */
.wizard-steps {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.wizard-step {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.wizard-step.is-current {
  color: var(--text);
  font-weight: var(--font-weight-strong);
}

.wizard-step.is-done {
  color: var(--success);
}

.wizard-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-caption);
}

.wizard-step.is-current .wizard-index {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}

.wizard-sep {
  width: 24px;
  height: 1px;
  background: var(--border);
}

/* 能力选择卡 */
.capability-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.capability-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text);
  font-family: inherit;
  text-align: start;
  cursor: pointer;
}

.capability-option:hover {
  border-color: var(--accent);
}

.capability-option:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.capability-option.is-selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.option-name {
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-strong);
}

.option-desc {
  font-size: var(--font-size-small);
  line-height: var(--line-height-body);
  color: var(--text-sec);
}

.option-meta {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

/* 表单 */
.project-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.field-label {
  font-size: var(--font-size-small);
  color: var(--text-sec);
}

.field-label span {
  color: var(--danger);
}

.field-hint {
  margin: 0;
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.field-error {
  margin: 0;
  font-size: var(--font-size-caption);
  color: var(--danger);
}

.form-error {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--danger);
}

.form-hint {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

/* 原生 textarea / select / file 与 VfInput 保持同一视觉 */
.vf-textarea,
.vf-select {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text);
  font-family: inherit;
  font-size: var(--font-size-body);
  resize: vertical;
}

.vf-textarea:focus,
.vf-select:focus {
  outline: none;
  border-color: var(--accent);
}

.vf-select {
  height: 36px;
  padding-block: 0;
}

.vf-file {
  font-size: var(--font-size-small);
  color: var(--text-sec);
}

.vf-file::file-selector-button {
  margin-inline-end: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text);
  font-family: inherit;
  font-size: var(--font-size-small);
  cursor: pointer;
}

.anchor-selected {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-2);
  border-radius: var(--radius-control);
  font-size: var(--font-size-caption);
  color: var(--text-sec);
}

.is-mono {
  font-family: var(--font-mono);
}
</style>
