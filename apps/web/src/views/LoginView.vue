<script setup lang="ts">
/**
 * 登录 / 注册页（Web 专题 §5.1）：全屏浅灰底 + 居中 360px 卡片 + 登录/注册 Tab。
 * 注册受服务端 `server.allow_registration` 控制；因契约未暴露该开关，采用
 * 「注册提交返回 AUTH_FORBIDDEN 即隐藏注册 Tab」的处置（见汇报受控偏差登记）。
 */
import { computed, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { useAuthStore } from "../stores/auth";
import { formatApiError } from "../services/api";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

/** 当前 Tab：登录 / 注册。 */
const activeTab = ref<"login" | "register">("login");
/** 登录提交中。 */
const loginSubmitting = ref(false);
/** 注册提交中。 */
const registerSubmitting = ref(false);
/** 表单上方错误提示（AUTH_INVALID）。 */
const errorText = ref("");
/** 自助注册已关闭。 */
const registrationClosed = ref(false);

/** 登录表单字段。 */
const loginForm = reactive({ username: "", password: "" });
/** 注册表单字段。 */
const registerForm = reactive({ username: "", displayName: "", password: "", confirm: "" });

/** 登录成功后的回跳目标。 */
const redirectTarget = computed(() =>
  typeof route.query.redirect === "string" && route.query.redirect.length > 0
    ? route.query.redirect
    : "/projects",
);

/** 确认密码校验器：需与新密码一致。 */
function validateConfirm(_rule: unknown, value: string): Promise<void> {
  if (!value) {
    return Promise.reject(new Error("请再次输入密码"));
  }
  if (value !== registerForm.password) {
    return Promise.reject(new Error("两次输入的密码不一致"));
  }
  return Promise.resolve();
}

/** 注册表单校验规则。 */
const registerRules = {
  username: [{ required: true, message: "请输入用户名", trigger: "blur" }],
  password: [
    { required: true, message: "请输入密码", trigger: "blur" },
    { min: 8, max: 128, message: "密码长度需为 8 到 128 个字符", trigger: "blur" },
  ],
  confirm: [{ validator: validateConfirm, trigger: "blur" }],
};

/**
 * 提交登录。
 */
async function onSubmitLogin(): Promise<void> {
  errorText.value = "";
  loginSubmitting.value = true;
  try {
    await auth.login(loginForm.username, loginForm.password);
    await router.replace(redirectTarget.value);
  } catch (error) {
    handleAuthError(error);
  } finally {
    loginSubmitting.value = false;
  }
}

/**
 * 提交注册（成功后自动登录）。
 */
async function onSubmitRegister(): Promise<void> {
  errorText.value = "";
  registerSubmitting.value = true;
  try {
    await auth.register(
      registerForm.username,
      registerForm.password,
      registerForm.displayName || undefined,
    );
    await router.replace(redirectTarget.value);
  } catch (error) {
    handleAuthError(error);
  } finally {
    registerSubmitting.value = false;
  }
}

/**
 * 统一处理鉴权类错误：AUTH_INVALID 显示表单上方 Alert，AUTH_FORBIDDEN（注册）隐藏注册 Tab，其余走 message。
 * @param error 捕获到的错误
 */
function handleAuthError(error: unknown): void {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "AUTH_INVALID") {
    errorText.value = "用户名或密码错误";
    return;
  }
  if (code === "AUTH_FORBIDDEN") {
    registrationClosed.value = true;
    activeTab.value = "login";
    console.info("[web] 自助注册已关闭，隐藏注册入口");
    return;
  }
  message.error(formatApiError(error));
}
</script>

<template>
  <div class="login-page">
    <a-card class="login-card" :bordered="false">
      <h1 class="login-brand">VideoForge</h1>
      <p class="login-tagline">本机视频流水线工作台</p>

      <a-tabs v-model:activeKey="activeTab" class="login-tabs">
        <a-tab-pane key="login" tab="登录">
          <a-alert
            v-if="errorText"
            type="error"
            show-icon
            :message="errorText"
            style="margin-bottom: 16px"
          />
          <a-form :model="loginForm" layout="vertical" @finish="onSubmitLogin">
            <a-form-item
              label="用户名"
              name="username"
              :rules="[{ required: true, message: '请输入用户名' }]"
            >
              <a-input
                v-model:value="loginForm.username"
                placeholder="请输入用户名"
                autocomplete="username"
              />
            </a-form-item>
            <a-form-item
              label="密码"
              name="password"
              :rules="[{ required: true, message: '请输入密码' }]"
            >
              <a-input-password
                v-model:value="loginForm.password"
                placeholder="请输入密码"
                autocomplete="current-password"
              />
            </a-form-item>
            <a-button type="primary" html-type="submit" block :loading="loginSubmitting"
              >登录</a-button
            >
          </a-form>
        </a-tab-pane>

        <a-tab-pane v-if="!registrationClosed" key="register" tab="注册">
          <a-alert
            v-if="errorText"
            type="error"
            show-icon
            :message="errorText"
            style="margin-bottom: 16px"
          />
          <a-form
            :model="registerForm"
            :rules="registerRules"
            layout="vertical"
            @finish="onSubmitRegister"
          >
            <a-form-item label="用户名" name="username">
              <a-input
                v-model:value="registerForm.username"
                placeholder="请输入用户名"
                autocomplete="username"
              />
            </a-form-item>
            <a-form-item label="显示名" name="displayName">
              <a-input v-model:value="registerForm.displayName" placeholder="可选" />
            </a-form-item>
            <a-form-item label="密码" name="password">
              <a-input-password
                v-model:value="registerForm.password"
                placeholder="8 到 128 个字符"
                autocomplete="new-password"
              />
            </a-form-item>
            <a-form-item label="确认密码" name="confirm">
              <a-input-password
                v-model:value="registerForm.confirm"
                placeholder="请再次输入密码"
                autocomplete="new-password"
              />
            </a-form-item>
            <a-button type="primary" html-type="submit" block :loading="registerSubmitting"
              >注册并登录</a-button
            >
          </a-form>
        </a-tab-pane>
      </a-tabs>

      <a-alert
        v-if="registrationClosed"
        type="info"
        show-icon
        message="自助注册已关闭，请联系管理员创建账号"
      />
    </a-card>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: #f0f2f5;
}

.login-card {
  width: 360px;
  max-width: 100%;
  box-shadow: 0 2px 8px rgb(0 0 0 / 8%);
}

.login-brand {
  margin: 0;
  text-align: center;
  font-size: 24px;
  font-weight: 700;
}

.login-tagline {
  margin: 4px 0 16px;
  text-align: center;
  color: rgb(0 0 0 / 45%);
}

.login-tabs :deep(.ant-tabs-nav) {
  margin-bottom: 16px;
}
</style>
