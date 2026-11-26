# Veyra remote camera agent — only needed for cameras on another network than the Veyra server.
# Build from the repository root:
#   docker build -f apps/camera-agent/Dockerfile -t veyra-agent .
FROM node:22-alpine
RUN apk add --no-cache ffmpeg tini && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/camera-agent/package.json apps/camera-agent/
COPY packages/shared/package.json packages/shared/
COPY packages/capture/package.json packages/capture/
RUN pnpm install --prod --frozen-lockfile --filter camera-agent... && pnpm store prune
COPY packages/capture/src packages/capture/src
COPY apps/camera-agent/src apps/camera-agent/src
ENV VEYRA_STATE_FILE=/data/agent.json
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
WORKDIR /app/apps/camera-agent
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
