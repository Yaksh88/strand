import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests share one Postgres, each in its own schema, so files can run in parallel.
    testTimeout: 15_000,
  },
});
