# Veyra – everything in one image: API, background jobs, web UI and FFmpeg.
# Build:  docker compose up -d --build   (see docker-compose.yml)

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/camera-agent/package.json apps/camera-agent/
COPY packages/shared/package.json packages/shared/
COPY packages/capture/package.json packages/capture/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter web build

FROM node:22-alpine
RUN apk add --no-cache ffmpeg tini && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/camera-agent/package.json apps/camera-agent/
COPY packages/shared/package.json packages/shared/
COPY packages/capture/package.json packages/capture/
RUN pnpm install --prod --frozen-lockfile --filter server... && pnpm store prune
COPY packages/shared/src packages/shared/src
COPY packages/capture/src packages/capture/src
COPY apps/server/tsconfig.json apps/server/
COPY apps/server/drizzle apps/server/drizzle
COPY apps/server/src apps/server/src
COPY --from=build /app/apps/web/dist /app/web

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIST=/app/web
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
USER node
WORKDIR /app/apps/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "src/main.ts"]
