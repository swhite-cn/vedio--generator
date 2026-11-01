<script setup lang="ts">
/**
 * 新建项目两步向导（Web 专题 §5.2）：第一步卡片式选择能力，第二步填写参数。
 * 提交 `POST /api/projects`（载荷含 `capabilityId`）；成功 emit `created`。
 */
import { reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { useCapabilitiesStore } from "../stores/capabilities";
import { useProjectsStore, type Project } from "../stores/projects";
import { formatApiError } from "../services/api";

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

/** 输出 Profile 的固定两项（服务端未提供 Profile 列表接口，见 Web 专题 §5.2）。 */
const PROFILE_OPTIONS = [
  { value: "landscape-1080p", label: "横屏 1080p（landscape-1080p）" },
  { value: "portrait-1080p", label: "竖屏 1080p（portrait-1080p）" },
] as const;

const capabilitiesStore = useCapabilitiesStore();
const projectsStore = useProjectsStore();

/** 当前步骤：0 选择能力、1 填写参数。 */
const step = ref(0);
/** 提交中。 */
const submitting = ref(false);
/** 能力列表加载失败标记（禁用于下一步）。 */
const capabilitiesFailed = ref(false);
/** 命中项目数量上限标记。 */
const limitReached = ref(false);
/** 选中的能力 id。 */
const selectedCapabilityId = ref("");
/** 表单实例。 */
const formRef = ref<{ validate: () => Promise<unknown> } | null>(null);

/** 第二步表单字段。 */
const formState = reactive({
  name: "",
  topic: "",
  style: "",
  profile: "landscape-1080p",
});

/** 表单校验规则（名称与主题必填，名称限制非法字符与服务端可接受范围一致）。 */
const formRules = {
  name: [
    { required: true, message: "请输入项目名称", trigger: "blur" },
    { max: 50, message: "项目名称不超过 50 个字符", trigger: "blur" },
    {
      pattern: /^[^\\/:*?"<>|]+$/,
      message: '项目名称不能包含 \\ / : * ? " < > |',
      trigger: "blur",
    },
  ],
  topic: [{ required: true, message: "请输入主题", trigger: "blur" }],
};

/** 重置向导状态。 */
function resetWizard(): void {
  step.value = 0;
  submitting.value = false;
  capabilitiesFailed.value = false;
  limitReached.value = false;
  selectedCapabilityId.value = props.initialCapabilityId;
  formState.name = "";
  formState.topic = "";
  formState.style = "";
  formState.profile = "landscape-1080p";
}

/**
 * 打开时初始化：加载能力列表；有预选能力则直接进入第二步。
 */
async function initialize(): Promise<void> {
  resetWizard();
  try {
    const list = await capabilitiesStore.load();
    if (props.initialCapabilityId && list.some((item) => item.id === props.initialCapabilityId)) {
      selectedCapabilityId.value = props.initialCapabilityId;
      step.value = 1;
    } else if (!selectedCapabilityId.value && list.length > 0) {
      selectedCapabilityId.value = list[0].id;
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

/** 进入第二步（需已选中能力且能力列表加载成功）。 */
function goNext(): void {
  if (capabilitiesFailed.value || !selectedCapabilityId.value) {
    return;
  }
  step.value = 1;
}

/** 返回第一步。 */
function goPrev(): void {
  step.value = 0;
}

/**
 * 提交新建项目。
 */
async function submit(): Promise<void> {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  submitting.value = true;
  limitReached.value = false;
  try {
    const project = await projectsStore.create({
      capabilityId: selectedCapabilityId.value,
      name: formState.name.trim(),
      topic: formState.topic.trim(),
      style: formState.style.trim() || undefined,
      profile: formState.profile,
    });
    emit("created", project);
    close();
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "CONFIG_INVALID") {
      limitReached.value = true;
    } else {
      message.error(formatApiError(error));
    }
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
);
</script>

<template>
  <a-modal :open="open" title="新建项目" width="640px" :mask-closable="false" @cancel="close">
    <a-alert
      v-if="capabilitiesFailed"
      type="error"
      show-icon
      message="能力列表加载失败，请稍后重试"
      style="margin-bottom: 16px"
    />
    <a-alert
      v-if="limitReached"
      type="warning"
      show-icon
      message="项目数量已达上限（50）"
      style="margin-bottom: 16px"
    />

    <a-steps :current="step" size="small" style="margin-bottom: 24px">
      <a-step title="选择能力" />
      <a-step title="填写参数" />
    </a-steps>

    <!-- 第一步：卡片式选择能力 -->
    <a-radio-group v-if="step === 0" v-model:value="selectedCapabilityId" class="capability-picker">
      <a-radio
        v-for="capability in capabilitiesStore.list"
        :key="capability.id"
        :value="capability.id"
        class="capability-picker-item"
      >
        <span class="picker-title">{{ capability.name }}</span>
        <span class="picker-desc">{{ capability.description }}</span>
      </a-radio>
      <a-empty
        v-if="capabilitiesStore.list.length === 0"
        description="暂无可用能力，请联系管理员"
      />
    </a-radio-group>

    <!-- 第二步：填写参数 -->
    <a-form v-else ref="formRef" :model="formState" :rules="formRules" layout="vertical">
      <a-form-item label="项目名称" name="name">
        <a-input v-model:value="formState.name" placeholder="请输入项目名称" :maxlength="50" />
      </a-form-item>
      <a-form-item label="主题" name="topic">
        <a-textarea v-model:value="formState.topic" :rows="3" placeholder="请输入视频主题" />
      </a-form-item>
      <a-form-item label="风格" name="style">
        <a-input v-model:value="formState.style" placeholder="可选，如：轻松科普" />
      </a-form-item>
      <a-form-item label="输出 Profile" name="profile">
        <a-select v-model:value="formState.profile" :options="[...PROFILE_OPTIONS]" />
        <p class="profile-hint">选项来源：前端固定两项（服务端暂未提供 Profile 列表接口）。</p>
      </a-form-item>
    </a-form>

    <template #footer>
      <a-button v-if="step === 1" @click="goPrev">上一步</a-button>
      <a-button v-else @click="close">取消</a-button>
      <a-button
        v-if="step === 0"
        type="primary"
        :disabled="capabilitiesFailed || !selectedCapabilityId"
        @click="goNext"
      >
        下一步
      </a-button>
      <a-button v-else type="primary" :loading="submitting" @click="submit">创建项目</a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.capability-picker {
  display: grid;
  width: 100%;
  gap: 12px;
}

.capability-picker-item {
  display: block;
  padding: 12px 16px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  white-space: normal;
}

.picker-title {
  display: block;
  font-weight: 600;
}

.picker-desc {
  display: block;
  color: rgb(0 0 0 / 65%);
  font-size: 13px;
}

.profile-hint {
  margin: 4px 0 0;
  color: rgb(0 0 0 / 45%);
  font-size: 12px;
}
</style>
