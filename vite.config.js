import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        email: "email.html",
        email_m: "email_m.html",
      },
    },
  },
  server: {
    port: 8080,
    open: "/email_m.html",
    // 开发环境把 /api 请求转发到后端
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
