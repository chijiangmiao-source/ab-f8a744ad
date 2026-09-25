FROM node:20-slim

WORKDIR /app

# 无第三方依赖：仅复制源码与清单，利用构建缓存
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000

# 容器内健康检查使用 Node 自带 fetch（不依赖 curl）
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
