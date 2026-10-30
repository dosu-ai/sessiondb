import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["sdks/typescript/src/**/*.test.ts", "server/src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
  },
});
