# The sessiondb server: Bun runs the TypeScript directly, no build step. Build from the
# repository root, since the server is a workspace package that depends on the SDK beside it:
#   docker build -f server/Dockerfile -t sessiondb .
FROM oven/bun:1.4-slim

WORKDIR /app
COPY package.json bun.lock ./
COPY sdks/typescript/package.json ./sdks/typescript/
COPY server/package.json ./server/
RUN bun install --frozen-lockfile --production

COPY sdks/typescript/src ./sdks/typescript/src
COPY server/src ./server/src

ENV PORT=7200
# Only for SESSIONDB_STORE_URL=file:///data; a bucket needs no volume.
RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]
EXPOSE 7200
USER bun

HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://localhost:7200/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

WORKDIR /app/server
CMD ["bun", "run", "src/main.ts"]
