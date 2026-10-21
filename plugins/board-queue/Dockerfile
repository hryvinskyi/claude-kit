# syntax=docker/dockerfile:1
#
# board-queue as a long-running service: `board-queue service`, a pass every five minutes under a
# GitHub App, until the container is stopped. Build it from this directory:
#
#   docker build -t board-queue:<version> plugins/board-queue
#
# The image holds the code and its production dependencies, nothing else. It runs as an unprivileged
# user and writes only under /data (the queue, its log and the heartbeat), which the deployment
# mounts, so it runs with a read-only root filesystem. The deployment supplies the configuration,
# the App's key file and the coordination server's token file; the README's "As a service" section
# lists what goes where.

# Node 26.10.0 on Debian trixie, slim; the digest is the multi-platform index of that tag.
ARG NODE_IMAGE=docker.io/library/node:26.10.0-trixie-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM ${NODE_IMAGE}
# The package manager is a build tool; nothing at run time needs it.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production \
    HOME=/tmp \
    BOARD_QUEUE_STATE_DIR=/data \
    BOARD_QUEUE_CONFIG=/config/config.json
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY bin/board-queue.ts ./bin/board-queue.ts
COPY src ./src
USER 10001:10001
HEALTHCHECK --interval=1m --timeout=10s --start-period=2m --retries=3 \
    CMD ["node", "/app/bin/board-queue.ts", "health"]
ENTRYPOINT ["node", "/app/bin/board-queue.ts"]
CMD ["service"]
