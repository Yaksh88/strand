import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", app: "src/app.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node22",
});
