# 地方口述史事件年表 —— 本机一键运行镜像
FROM node:20-alpine

WORKDIR /app

# 仅含纯 JS + WebAssembly 的依赖（sql.js），无需编译工具链
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# SQLite 数据库文件目录（挂载卷以持久化）
RUN mkdir -p /app/data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/app/data/chronicle.sqlite

EXPOSE 8080

# 容器启动即建库建表（首次运行时由应用自动初始化）
CMD ["node", "src/server.js"]
