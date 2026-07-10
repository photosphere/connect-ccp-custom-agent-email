import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: "email.html",
    },
  },
  server: {
    port: 8080,
    open: "/email.html",
    // 开发环境把 /api 请求转发到后端
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
