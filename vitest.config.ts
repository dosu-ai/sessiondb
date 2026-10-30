import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The SDK's `bun` export condition points at its source; Vite does not know that condition
    // and would take `default`, the dist/ build, which only exists after `bun run build`.
    alias: {
      "@dosu/sessiondb": fileURLToPath(new URL("./sdks/typescript/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["sdks/typescript/src/**/*.test.ts", "server/src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
  },
});
