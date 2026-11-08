import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

/** 冒烟模式标记：由 pnpm test:smoke 通过 VF_SMOKE=1 打开 */
const smokeOnly = process.env.VF_SMOKE === "1";

/**
 * 创建项目统一测试配置，确保单元测试可以直接引用共享模块源码。
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    // VF_SMOKE=1（pnpm test:smoke）时只跑 tests/integration 真机冒烟测试；
    // 默认全量单测排除该目录，避免真 Chromium/真实外部依赖被卷入
    include: [
      smokeOnly ? "tests/integration/**/*.test.{ts,tsx}" : "tests/**/*.test.{ts,tsx}",
    ],
    exclude: smokeOnly ? ["**/node_modules/**"] : ["tests/integration/**", "**/node_modules/**"],
  },
  // pnpm 严格隔离下根目录没有 vue/pinia/ant-design-vue（装在 apps/web），
  // 挂载型组件测试（T301 起）统一解析到 apps/web 的实例，保证单例与插件命中
  resolve: {
    alias: {
      vue: fileURLToPath(
        new URL("./apps/web/node_modules/vue/dist/vue.runtime.esm-bundler.js", import.meta.url),
      ),
      pinia: fileURLToPath(new URL("./apps/web/node_modules/pinia", import.meta.url)),
      "vue-router": fileURLToPath(
        new URL("./apps/web/node_modules/vue-router", import.meta.url),
      ),
      "ant-design-vue": fileURLToPath(
        new URL("./apps/web/node_modules/ant-design-vue", import.meta.url),
      ),
      "@videoforge/shared": fileURLToPath(
        new URL("./packages/shared/src/index.ts", import.meta.url),
      ),
      "@videoforge/pipeline": fileURLToPath(
        new URL("./packages/pipeline/src/index.ts", import.meta.url),
      ),
      "@videoforge/template-sdk": fileURLToPath(
        new URL("./packages/template-sdk/src/index.ts", import.meta.url),
      ),
      "@videoforge/remotion-engine": fileURLToPath(
        new URL("./packages/remotion-engine/src/index.ts", import.meta.url),
      ),
      // 同理：remotion 只装在 packages/remotion-engine，测试的 vi.mock 需要同一解析路径
      remotion: fileURLToPath(
        new URL(
          "./packages/remotion-engine/node_modules/remotion/dist/esm/index.mjs",
          import.meta.url,
        ),
      ),
    },
  },
});
