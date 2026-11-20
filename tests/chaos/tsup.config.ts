import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "run-chaos": "src/run-chaos.ts", "chaos-worker": "src/chaos-worker.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node22",
});
