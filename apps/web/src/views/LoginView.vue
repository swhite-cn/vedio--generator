<script setup lang="ts">
/**
 * 登录页（方案 §8.5 第 1 页 / SKILL §4 #1）：左品牌区 + 右表单，blank 布局。
 *
 * - 左：Logo、slogan「把内容创作交给 Agent 流水线」、3 项能力特性、流水线阶段 chips；
 * - 右：用户名、密码、记住我、忘记密码、登录，"联系管理员创建"说明；
 * - **无公开注册**（与现有 auth 一致）；错误一律行内提示，不用弹窗；
 * - 键盘：原生 form + submit 按钮，Enter 直接提交；所有控件有可见标签与焦点环。
 */
import { computed, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { formatApiError } from "../services/api";
import { STAGE_LABELS } from "../components/state-mapping";
import VfButton from "../components/ui/VfButton.vue";
import VfInput from "../components/ui/VfInput.vue";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

/** 登录表单字段（受控）。 */
const form = reactive({ username: "", password: "" });
/** 记住我：默认勾选（与旧行为一致，持久到 localStorage）。 */
const remember = ref(true);
/** 提交中（禁用重复提交与输入）。 */
const submitting = ref(false);
/** 行内错误提示（AUTH_INVALID 或其它业务错误）。 */
const errorText = ref("");
/** 行内提示（忘记密码说明等中性信息，role=status）。 */
const hintText = ref("");

/** 登录成功后的回跳目标（服务端 401 跳转携带的 redirect）。 */
const redirectTarget = computed(() =>
  typeof route.query.redirect === "string" && route.query.redirect.length > 0
    ? route.query.redirect
    : "/projects",
);

/** 流水线阶段 chips：与工作台的阶段命名同源（STAGE_LABELS 唯一来源）。 */
const stageChips = Object.values(STAGE_LABELS);

/** 品牌区 3 项能力特性（均为已落地能力，不写未实现项）。 */
const FEATURES = [
  { title: "一句一镜", detail: "每句口播对应一个镜头，改一镜不必整片重跑" },
  { title: "逐句字幕", detail: "cue 级时间戳驱动字幕轨，与画面切点同源" },
  { title: "质检门禁", detail: "静帧、字幕溢出、来源、对比度、动效五项检查" },
] as const;

/**
 * 提交登录：成功回跳，失败行内提示。
 */
async function onSubmit(): Promise<void> {
  errorText.value = "";
  hintText.value = "";
  submitting.value = true;
  try {
    await auth.login(form.username.trim(), form.password, remember.value);
    await router.replace(redirectTarget.value);
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    // 登录失败统一行内提示（方案要求不用弹窗）；AUTH_INVALID 收敛为固定文案
    errorText.value = code === "AUTH_INVALID" ? "用户名或密码错误" : formatApiError(error);
    form.password = "";
  } finally {
    submitting.value = false;
  }
}

/**
 * 「忘记密码」：本机无自助找回接口，管理员可在管理页或 CLI 重置，
 * 因此只给出可执行的行内指引，不提供假跳转。
 */
function onForgotPassword(): void {
  errorText.value = "";
  hintText.value = "本机账号由管理员维护：请联系管理员在「管理 → 用户」重置密码。";
}
</script>

<template>
  <div class="login">
    <!-- 左：品牌区 -->
    <section class="login-brand" aria-labelledby="login-slogan">
      <div class="login-brand__inner">
        <div class="login-logo">
          <span class="login-logo__mark" aria-hidden="true">V</span>
          <span class="login-logo__name">VideoForge</span>
        </div>

        <h1 id="login-slogan" class="login-slogan">把内容创作交给 Agent 流水线</h1>
        <p class="login-sub">
          从一句口播到一个镜头：文案、配图、场景、配音、字幕、时间轴、渲染、合成，八阶段确定性执行。
        </p>

        <ul class="login-features">
          <li v-for="feature in FEATURES" :key="feature.title" class="login-feature">
            <h2 class="login-feature__title">{{ feature.title }}</h2>
            <p class="login-feature__detail">{{ feature.detail }}</p>
          </li>
        </ul>

        <div class="login-stages" aria-label="流水线阶段">
          <span v-for="chip in stageChips" :key="chip" class="login-stage">{{ chip }}</span>
        </div>
      </div>
    </section>

    <!-- 右：登录表单 -->
    <section class="login-panel" aria-labelledby="login-title">
      <div class="login-card">
        <h2 id="login-title" class="login-card__title">登录工作台</h2>
        <p class="login-card__desc">使用管理员分配的账号登录本机工作台。</p>

        <form class="login-form" novalidate @submit.prevent="onSubmit">
          <div class="login-field">
            <label class="login-label" for="login-username">用户名</label>
            <VfInput
              id="login-username"
              v-model="form.username"
              placeholder="请输入用户名"
              autocomplete="username"
              :disabled="submitting"
            />
          </div>

          <div class="login-field">
            <label class="login-label" for="login-password">密码</label>
            <VfInput
              id="login-password"
              v-model="form.password"
              type="password"
              placeholder="请输入密码"
              autocomplete="current-password"
              :disabled="submitting"
            />
          </div>

          <div class="login-row">
            <label class="login-remember">
              <input v-model="remember" type="checkbox" class="login-remember__box" />
              <span>记住我</span>
            </label>
            <button type="button" class="login-link" @click="onForgotPassword">忘记密码</button>
          </div>

          <p v-if="errorText" class="login-error" role="alert">{{ errorText }}</p>
          <p v-else-if="hintText" class="login-hint" role="status">{{ hintText }}</p>

          <VfButton type="submit" variant="accent" class="login-submit" :disabled="submitting">
            {{ submitting ? "登录中…" : "登录" }}
          </VfButton>
        </form>

        <footer class="login-footer">
          VideoForge 不开放自助注册；账号由管理员在「管理 → 用户」创建或重置。
        </footer>
      </div>
    </section>
  </div>
</template>

<style scoped>
.login {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 480px;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
}

/* --- 左品牌区 --- */
.login-brand {
  display: flex;
  align-items: center;
  padding: var(--space-8) 64px;
  background: var(--deep);
  border-inline-end: 1px solid var(--border-soft);
}

.login-brand__inner {
  max-width: 560px;
}

.login-logo {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-7);
}

.login-logo__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--accent);
  color: #ffffff;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
}

.login-logo__name {
  font-size: 16px;
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.login-slogan {
  margin: 0 0 var(--space-4);
  font-size: 32px;
  line-height: 1.35;
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.login-sub {
  margin: 0 0 var(--space-6);
  font-size: var(--font-size-body);
  line-height: var(--line-height-body);
  color: var(--text-sec);
}

.login-features {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  margin: 0 0 var(--space-6);
  padding: 0;
  list-style: none;
}

.login-feature {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-inline-start: var(--space-3);
  border-inline-start: 2px solid var(--accent);
}

.login-feature__title {
  margin: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.login-feature__detail {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.login-stages {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.login-stage {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-caption);
  color: var(--text-sec);
}

/* --- 右表单区 --- */
.login-panel {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-8) var(--space-6);
}

.login-card {
  width: 100%;
  max-width: 360px;
}

.login-card__title {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-page-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.login-card__desc {
  margin: 0 0 var(--space-6);
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.login-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.login-label {
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-strong);
  color: var(--text-sec);
}

.login-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.login-remember {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-small);
  color: var(--text-sec);
  cursor: pointer;
}

.login-remember__box {
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
  cursor: pointer;
}

.login-remember__box:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.login-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-sec);
  font: inherit;
  font-size: var(--font-size-small);
  cursor: pointer;
}

.login-link:hover {
  color: var(--text);
  text-decoration: underline;
}

.login-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-control);
}

/* 行内错误/提示：软底 + 语义前景，不用弹窗 */
.login-error,
.login-hint {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  font-size: var(--font-size-small);
  line-height: var(--line-height-body);
}

.login-error {
  background: var(--danger-soft);
  color: var(--danger);
}

.login-hint {
  background: var(--surface-2);
  color: var(--text-sec);
}

.login-submit {
  width: 100%;
  min-height: 40px; /* 主 CTA 略高于常规按钮 */
}

.login-footer {
  margin-top: var(--space-5);
  font-size: var(--font-size-caption);
  line-height: var(--line-height-body);
  color: var(--text-ter);
}

/* --- 响应式：<960 单列（品牌区在上，表单在下） --- */
@media (max-width: 959.98px) {
  .login {
    grid-template-columns: minmax(0, 1fr);
  }

  .login-brand {
    padding: var(--space-7) var(--space-6) var(--space-6);
    border-inline-end: 0;
    border-block-end: 1px solid var(--border-soft);
  }

  .login-slogan {
    font-size: 24px;
  }

  .login-panel {
    padding: var(--space-6);
  }
}

/* --- 窄屏（390×844 验收档）：隐藏次要说明，保留标题与 chips --- */
@media (max-width: 480px) {
  .login-features,
  .login-sub {
    display: none;
  }

  .login-brand {
    padding: var(--space-6) var(--space-5) var(--space-5);
  }

  .login-logo {
    margin-bottom: var(--space-4);
  }

  .login-panel {
    padding: var(--space-5);
  }
}

@media (prefers-reduced-motion: reduce) {
  .login * {
    transition: none !important;
    animation: none !important;
  }
}
</style>
