FROM node:20-slim

# ffmpeg + yt-dlp. apt's yt-dlp is months stale, so install via pip; the
# `--break-system-packages` is needed on Debian 12+ (Trixie). Same logic
# the sibling MusicDown uses, just on a node base instead of python.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg python3 python3-pip ca-certificates curl \
    && pip install --break-system-packages --no-cache-dir yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first so this layer caches across source-only changes.
COPY worker/package.json worker/package-lock.json ./worker/
RUN cd worker && npm ci --no-audit --no-fund

COPY worker ./worker
COPY frontend ./frontend

ENV NODE_ENV=production \
    PORT=8787 \
    NODE_NO_WARNINGS=1

EXPOSE 8787

# tsx (TypeScript loader) runs the source directly — no separate build step.
# The cold-start cost is the youtubei.js Innertube session, not the loader.
WORKDIR /app/worker
CMD ["npx", "tsx", "src/node-server.ts"]
