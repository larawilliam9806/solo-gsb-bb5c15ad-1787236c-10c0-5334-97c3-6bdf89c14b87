# ---- 构建阶段：安装依赖并编译 better-sqlite3 原生模块 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 仅在依赖清单变化时重建依赖层
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- 运行阶段 ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

# 数据卷目录（SQLite 数据库）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV HOST=0.0.0.0
ENV PORT=3000
ENV DB_PATH=/app/data/loto.db
EXPOSE 3000

# 容器启动：先建库（幂等，已有数据则跳过）再启动服务
CMD ["sh", "-c", "node server/init-db.js && node server/index.js"]
