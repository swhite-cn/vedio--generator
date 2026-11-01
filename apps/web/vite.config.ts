import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { loadApiProxyTarget } from "./vite-server-config";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: loadApiProxyTarget(projectRoot),
        changeOrigin: true,
      },
    },
  },
});
