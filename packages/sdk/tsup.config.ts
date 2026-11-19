import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "migrate-cli": "src/db/migrate-cli.ts" },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  target: "node22",
  // The migrator reads .sql files next to the bundle.
  onSuccess: "cp -R src/db/migrations dist/migrations",
});
