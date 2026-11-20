import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    testing: "src/testing.ts",
    "migrate-cli": "src/db/migrate-cli.ts",
  },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts", testing: "src/testing.ts" } },
  clean: true,
  target: "node22",
  // The migrator reads .sql files next to the bundle.
  onSuccess: "mkdir -p dist/migrations && cp src/db/migrations/*.sql dist/migrations/",
});
