import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

/**
 * Player 应用构建配置（T208）。
 * lib 模式单入口 IIFE bundle（`dist/player.js`），由 Fastify 在 `/player/` 前缀提供静态服务，
 * HTML 入口由 `GET /api/player/:projectId/:shotId?` 动态渲染并内联渲染数据；
 * `index.html` 仅作为本地手动调试模板，不参与构建。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("./src/main.tsx", import.meta.url)),
      formats: ["iife"],
      name: "VideoForgePlayer",
      fileName: () => "player.js",
    },
    rollupOptions: {
      // react/react-dom 打进 bundle（iframe 内自包含），不依赖宿主提供
      external: [],
    },
  },
  resolve: {
    alias: {
      // workspace 包的 exports 已指向 TS/TSX 源码（remotion-engine 提供浏览器安全子路径），
      // 这里不再做字符串 alias——前缀匹配会破坏 "pkg/sub" 子路径解析
    },
  },
});
