<script setup lang="ts">
/**
 * 个人设置页（Web 专题 §5.7）：当前用户信息 + 修改密码表单。
 *
 * - `Descriptions` 展示用户名、显示名、角色（只读）；
 * - 修改密码 `Form`（旧密码 / 新密码 / 确认新密码）→ `POST /api/auth/password`，
 *   成功后 message 提示并重新拉取 `/api/auth/me`（`mustChangePassword` 归零）；
 * - `?force=1`（首次登录强制改密）：隐藏用户信息，仅保留顶部告警与改密表单，
 *   改密成功前路由守卫不放行（`router-guard` 强制停留本页）。
 */
import { computed, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message } from "ant-design-vue";
import type { FormInstance } from "ant-design-vue";
import { useAuthStore } from "../stores/auth";
import { formatApiError } from "../services/api";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

/** 改密表单实例（用于重置校验状态）。 */
const formRef = ref<FormInstance>();
/** 是否正在提交改密。 */
const submitting = ref(false);

/** 是否处于「首次登录强制改密」模式（`/settings?force=1`）。 */
const forced = computed(() => route.query.force === "1");

/** 角色中文文案。 */
const roleText = computed(() => (auth.me?.role === "admin" ? "管理员" : "普通用户"));

/** 改密表单字段。 */
const form = reactive({ currentPassword: "", newPassword: "", confirm: "" });

/**
 * 确认新密码校验器：必须与「新密码」逐字一致。
 * @param _rule Ant Design 校验规则（未使用）
 * @param value 当前确认密码输入值
 * @returns 校验通过返回 resolved，否则 rejected 并携带提示
 */
function validateConfirm(_rule: unknown, value: string): Promise<void> {
  if (!value) {
    return Promise.reject(new Error("请再次输入新密码"));
  }
  if (value !== form.newPassword) {
    return Promise.reject(new Error("两次输入的新密码不一致"));
  }
  return Promise.resolve();
}

/** 改密表单校验规则（长度与服务端注册规则保持一致：8 到 128 字符）。 */
const rules = {
  currentPassword: [{ required: true, message: "请输入当前密码", trigger: "blur" }],
  newPassword: [
    { required: true, message: "请输入新密码", trigger: "blur" },
    { min: 8, max: 128, message: "密码长度需为 8 到 128 个字符", trigger: "blur" },
  ],
  confirm: [{ validator: validateConfirm, trigger: "blur" }],
};

/**
 * 提交修改密码：调用 store（内部完成 `POST /api/auth/password` + 重新拉取 me）。
 * 成功后清空表单；强制改密模式下改密成功即解除强制，跳转默认页。
 */
async function onSubmit(): Promise<void> {
  submitting.value = true;
  try {
    await auth.changePassword(form.currentPassword, form.newPassword);
    message.success("密码已修改");
    form.currentPassword = "";
    form.newPassword = "";
    form.confirm = "";
    formRef.value?.clearValidate();
    console.info("[web] 密码修改成功");
    if (forced.value) {
      // 强制改密完成后 mustChangePassword 已归零，回到默认落地页
      await router.replace("/projects");
    }
  } catch (error) {
    message.error(formatApiError(error));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="settings-view">
    <div class="page-header">
      <h1 class="page-title">个人设置</h1>
      <p class="page-subtitle">查看账户信息并修改密码</p>
    </div>

    <a-alert
      v-if="forced"
      type="warning"
      show-icon
      message="首次登录请先修改初始密码"
      description="修改成功前，其他页面暂不可访问。"
      class="settings-alert"
    />

    <a-card v-if="!forced" title="账户信息" class="settings-card" :bordered="false">
      <a-descriptions :column="1" size="small">
        <a-descriptions-item label="用户名">{{ auth.me?.username ?? "-" }}</a-descriptions-item>
        <a-descriptions-item label="显示名">{{ auth.me?.displayName ?? "-" }}</a-descriptions-item>
        <a-descriptions-item label="角色">{{ roleText }}</a-descriptions-item>
      </a-descriptions>
    </a-card>

    <a-card title="修改密码" class="settings-card" :bordered="false">
      <a-form ref="formRef" :model="form" :rules="rules" layout="vertical" @finish="onSubmit">
        <a-form-item label="当前密码" name="currentPassword">
          <a-input-password
            v-model:value="form.currentPassword"
            placeholder="请输入当前密码"
            autocomplete="current-password"
          />
        </a-form-item>
        <a-form-item label="新密码" name="newPassword">
          <a-input-password
            v-model:value="form.newPassword"
            placeholder="8 到 128 个字符"
            autocomplete="new-password"
          />
        </a-form-item>
        <a-form-item label="确认新密码" name="confirm">
          <a-input-password
            v-model:value="form.confirm"
            placeholder="请再次输入新密码"
            autocomplete="new-password"
          />
        </a-form-item>
        <a-button type="primary" html-type="submit" :loading="submitting">保存修改</a-button>
      </a-form>
    </a-card>
  </div>
</template>

<style scoped>
.page-header {
  margin-bottom: 24px;
}

.page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
}

.page-subtitle {
  margin: 4px 0 0;
  color: rgb(0 0 0 / 45%);
}

.settings-alert {
  margin-bottom: 16px;
}

.settings-card {
  margin-bottom: 16px;
  box-shadow: 0 1px 4px rgb(0 0 0 / 6%);
}

.settings-card :deep(.ant-form-item:last-child) {
  margin-bottom: 0;
}
</style>
