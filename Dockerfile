FROM node:20-alpine

WORKDIR /app

# 零依赖：直接拷贝源码即可运行
COPY package.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY test ./test

RUN node scripts/build.js

ENV HOST=0.0.0.0 \
    PORT=8080 \
    HEALTH_PATH=/healthz

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}${HEALTH_PATH}" >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]
