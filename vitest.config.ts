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
    include: [smokeOnly ? "tests/integration/**/*.test.ts" : "tests/**/*.test.ts"],
    exclude: smokeOnly ? ["**/node_modules/**"] : ["tests/integration/**", "**/node_modules/**"],
  },
  resolve: {
    alias: {
      "@videoforge/shared": fileURLToPath(
        new URL("./packages/shared/src/index.ts", import.meta.url),
      ),
      "@videoforge/pipeline": fileURLToPath(
        new URL("./packages/pipeline/src/index.ts", import.meta.url),
      ),
      "@videoforge/renderer": fileURLToPath(
        new URL("./packages/renderer/src/index.ts", import.meta.url),
      ),
      "@videoforge/template-sdk": fileURLToPath(
        new URL("./packages/template-sdk/src/index.ts", import.meta.url),
      ),
      // pnpm 严格隔离下根目录无 playwright，统一解析到 packages/renderer 的实例，保证 vi.mock 命中
      playwright: fileURLToPath(
        new URL("./packages/renderer/node_modules/playwright/index.mjs", import.meta.url),
      ),
    },
  },
});
