import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sdk = (file: string) =>
  fileURLToPath(new URL(`../../packages/sdk/src/${file}`, import.meta.url));

export default defineConfig({
  // Tests run against the SDK sources, so no build is needed in between.
  resolve: {
    alias: [
      { find: "@strand/sdk/testing", replacement: sdk("testing.ts") },
      { find: "@strand/sdk", replacement: sdk("index.ts") },
    ],
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 15_000 },
});
