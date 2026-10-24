# 部署专项指南（Agent 项目模板）

> 本文与 `deploy/` 目录及 `Makefile` 的实际 target 一一对应；命令均可直接复制执行。
> 前置：已完成 `node init.mjs` 初始化与 `server/.env` 配置（见 README 第 5 章）。

## 1. 拓扑总览

双容器（docker compose 编排）：

```
                ┌──────────────────────────────────────────┐
   browser ────►│  web 容器（nginx:80）                      │
   :10087       │  ├─ /            → 前端静态产物（dist/）    │
                │  └─ /chat-api/   → 反代到 chat:8787       │
                └───────────────┬──────────────────────────┘
                                │ compose 内网
                ┌───────────────▼──────────────────────────┐
                │  chat 容器（node:24-alpine）               │
                │  node server/local.mjs（监听 0.0.0.0:8787）│
                │  → 进程内 import functions/agent-chat       │
                │  → LLM 网关 + 领域工具上游                   │
                │  数据卷：/app/data（统计 + 账号 + 历史）      │
                └──────────────────────────────────────────┘
```

- **web**：多阶段构建——Node 24 层跑 `npm run build` 产出 `dist/`，nginx 托管 + 反代；
- **chat**：Node 24 直接跑 `server/local.mjs`（原生 type-stripping，**零运行时 npm 依赖**，镜像极小）。

## 2. 构建与启动

一键（预检密钥 → 端口检测 → 构建 → 启动 → 健康检查）：

```bash
make docker-start
```

手动等价：

```bash
docker compose --env-file server/.env -f deploy/docker-compose.yml up -d --build
```

启动后访问 `http://localhost:10087/`（端口由 `server/.env` 的 `WEB_PORT` 控制，默认 10087）。

其他 target：

```bash
make docker-logs      # 跟踪 chat 服务日志（Ctrl+C 退出）
make docker-status    # 容器状态
make docker-restart   # 重启（不重新构建，读 server/.env 最新值）
make docker-stop      # 停止并移除容器
make docker-clean     # 停止并删除镜像
```

## 3. 卷挂载与数据持久化

- `stats-data` 命名卷挂到 chat 容器 `/app/data`：
  - 使用统计快照：`STATS_FILE=/app/data/stats.json`（每 15s 有变化才落盘，tmp+rename 原子写）；
  - 账号/历史/榜单：`DATA_DIR` 缺省推导到 `/app/data`（account-api.mjs 的 `defaultDataDir`）；
- `docker compose down` **不会**删除命名卷；`down -v` 才会（慎用）。

## 4. nginx SSE 反代要点（deploy/nginx.docker.conf）

三条都是 SSE 流式的硬前提：

1. `proxy_buffering off` —— 关闭响应缓冲，否则 delta 帧被攒着不发，前端表现为「卡很久后一次性吐完」；
2. `proxy_read_timeout 600s` —— 拉长读超时，长回复（多轮 tool-calling）不会被反代掐断；
3. **精确匹配无尾斜杠的 `location = /chat-api`** —— 前端 endpoint 是无尾斜杠形态，若只配 `location /chat-api/`，无斜杠请求会落到 `location /` 的 `try_files`，被 301 到 `http://<host>/chat-api/`（**丢端口**），浏览器跟到 80 端口直接挂。

另注意 `index.html` 配 `Cache-Control: no-cache`（它引用带 hash 的 JS/CSS，缓存它会让用户拿不到新版）；`/assets/` 配 30 天 immutable 长缓存（文件名带 hash，内容变即换名）。

## 5. 密钥注入与构建期变量

- **运行时密钥**（LLM_API_KEY / WEATHER_API_KEY / CHAT_SHARED_SECRET 等）：`env_file: ../server/.env` 注入 chat 容器；`.dockerignore` 排除该文件，**密钥不进镜像**；
- **构建期变量**（VITE_*）：web 服务的 build args 注入，`VITE_CHAT_API=/chat-api` 固化为同源反代形态（**改了要重新 build**）；
- `make docker-start` 前自动跑 `deploy/check-llm-key.py` 预检：验证密钥有效性/网关可达性/模型存在性，避免「容器起来了但一对话就报错」；`SKIP_LLM_CHECK=1` 可跳过。

## 6. 容器内 HOST 注意事项

`server/local.mjs` 默认只绑 `127.0.0.1`（宿主裸跑安全默认）；compose 已对 chat 容器显式覆盖：

```yaml
CHAT_API_HOST: "0.0.0.0"   # 容器内必须全网卡监听，否则 web(nginx) 访问不到 chat
```

**勿删该覆盖**。若自行改用其它编排（k8s 等），记得同样设置。

## 7. WEB_PORT 占用排查

`make docker-start` 的 `check-port` 预检：宿主端口被其他进程占用时**报错停止**（本项目容器自身占用除外——重启场景放行）。解决：释放端口，或改 `server/.env` 的 `WEB_PORT`。

## 8. 构建上下文

构建上下文为**仓库根**（deploy/ 的上级），`.dockerignore` 位于根：排除 node_modules / dist / server/.env / 运行数据，只把 server/ 与 functions/ 拷进 chat 镜像。

## 9. 本地 dev 的同源代理（不进 Docker）

`vite.config.ts` 的 dev 代理：前端配 `VITE_CHAT_API=/chat-api` 后，浏览器只访问 3015 一个端口（局域网设备也能完整对话），由 vite 转发到 `CHAT_API_PROXY_TARGET`（默认 `http://localhost:8787`）。仅 dev 生效，Docker 部署由 nginx 承担同角色。