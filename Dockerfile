# The sessiondb server: Bun runs the TypeScript directly, no build step.
#   docker build -t sessiondb .
FROM oven/bun:1.4-slim

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV PORT=7200
# Only for SESSIONDB_STORE_URL=file:///data; a bucket needs no volume.
RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]
EXPOSE 7200
USER bun

HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://localhost:7200/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["bun", "run", "src/main.ts"]
