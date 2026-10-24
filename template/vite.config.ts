import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

/**
 * React + Vite 构建配置（Agent 项目模板）
 *
 * 硬约束：
 * - dev server 监听 3015 + strictPort（前端与本地对话服务的约定端口）
 * - outDir 'dist' / assetsDir 'assets' — 归一化产物目录
 */
export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  // 环境变量唯一来源：server/.env（本地 dev 与 docker 部署共用，见 Makefile 头注释）
  // .dockerignore 已排除 server/.env，容器构建只认 Dockerfile 注入的构建期变量，互不干扰
  envDir: "server",
  plugins: [
    tailwindcss(),
    viteReact(),
    tsConfigPaths(),
  ],
  server: {
    host: "0.0.0.0",
    port: 3015,
    strictPort: true,
    allowedHosts: true,
    // 本地自托管对话服务的 dev 同源代理：前端配 VITE_CHAT_API=/chat-api 后，
    // 浏览器只访问本端口（局域网设备也能完整对话），由 vite 转发到本地服务（仅 dev 生效）
    proxy: {
      "/chat-api": {
        target: process.env.CHAT_API_PROXY_TARGET || "http://localhost:8787",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/chat-api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});