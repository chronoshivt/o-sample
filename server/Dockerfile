FROM oven/bun:1

# yt-dlp_linux is a self-contained PyInstaller bundle — no system python needed.
# It only ships x86_64; aarch64 hosts should swap to yt-dlp_linux_aarch64.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version \
    && ffmpeg -version > /dev/null \
    && apt-get remove -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile --production || bun install --production

COPY . .

ENV PORT=3847
ENV DOWNLOAD_DIR=/app/downloads
ENV NODE_ENV=production
# Pin absolute paths so Bun.spawn doesn't depend on $PATH resolution at runtime.
ENV YT_DLP=/usr/local/bin/yt-dlp
ENV FFMPEG=/usr/bin/ffmpeg
RUN mkdir -p /app/downloads

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3847) + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["bun", "run", "index.ts"]
