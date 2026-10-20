FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
RUN apt-get update && apt-get install -y --no-install-recommends util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts/start-sandbox.js ./scripts/start-sandbox.js
COPY deploy/entrypoint.sh /usr/local/bin/nostro-entrypoint
RUN chmod 755 /usr/local/bin/nostro-entrypoint
USER node
ENTRYPOINT ["/usr/local/bin/nostro-entrypoint"]
