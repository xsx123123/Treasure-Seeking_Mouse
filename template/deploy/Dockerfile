# syntax=docker/dockerfile:1
# {{PROJECT_NAME}} · Docker 构建（Agent 项目模板）
#   web   —— 多阶段：Node 24 构建 Vite 静态产物 → nginx 托管 + /chat-api 反代
#   chat  —— Node 24 直接跑 server/local.mjs（原生 type-stripping，零运行时 npm 依赖）
# 构建上下文必须设为应用根目录（deploy/ 的上级），.dockerignore 位于上下文根

# ---------- 前端构建层 ----------
FROM node:24-alpine AS build
WORKDIR /app

# 先拷依赖清单，最大化利用层缓存
COPY package.json ./
RUN npm install --no-audit --no-fund

# 前端构建期变量：同源反代（/chat-api → chat 服务），由 nginx 完成转发
# VITE_CHAT_API 是构建期固化的，改了必须重新 build
ARG VITE_CHAT_API=/chat-api
ARG VITE_BASE_PATH=/
ENV VITE_CHAT_API=$VITE_CHAT_API \
    VITE_BASE_PATH=$VITE_BASE_PATH
# 可选：配云模式实例则恢复云端登录，不配则纯游客 + 本地账号模式
ARG VITE_SUPABASE_URL=
ARG VITE_SUPABASE_ANON_KEY=
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

COPY . .
RUN npm run build   # 产出 /app/dist

# ---------- web：静态托管 + 反代 ----------
FROM nginx:1.28-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.docker.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

# ---------- chat：对话服务 ----------
FROM node:24-alpine AS chat
WORKDIR /app
# server/local.mjs 以仓库根为 root 加载 functions/agent-chat/index.ts
COPY server ./server
COPY functions ./functions
ENV CHAT_API_PORT=8787 \
    NODE_ENV=production
EXPOSE 8787
CMD ["node", "server/local.mjs"]