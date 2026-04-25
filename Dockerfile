FROM oven/bun:1.3.10-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    freerdp3-x11 \
    novnc \
    openbox \
    pulseaudio \
    x11vnc \
    xvfb \
    websockify \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock tsconfig.json eslint.config.js ./
COPY packages ./packages
COPY apps ./apps
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
  && bun install --frozen-lockfile \
  && bun run build

EXPOSE 3000 6080

CMD ["/entrypoint.sh"]
