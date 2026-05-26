FROM node:lts-alpine AS base
RUN apk add --no-cache tini git bash curl python3 py3-pip dos2unix \
    && pip3 install --break-system-packages huggingface_hub

FROM base AS builder
WORKDIR /app
# Replace with your GitHub repo URL
ARG REPO_URL=https://github.com/YourUsername/TavernPlusPlus.git
ARG REPO_BRANCH=main
RUN git clone --depth 1 --branch ${REPO_BRANCH} ${REPO_URL} .
RUN npm ci --omit=dev --no-audit --no-fund --no-progress \
    && npm cache clean --force

FROM base AS runtime
WORKDIR /app
COPY --from=builder /app /app
COPY launch.sh sync_data.sh ./
RUN dos2unix launch.sh sync_data.sh 2>/dev/null; \
    chmod +x launch.sh sync_data.sh; \
    mkdir -p config data-headless /tmp/backup

ENV NODE_ENV=production
EXPOSE 8001

ENTRYPOINT ["tini", "--"]
CMD ["/bin/bash", "-c", "cd /app && exec ./launch.sh 2>&1"]
