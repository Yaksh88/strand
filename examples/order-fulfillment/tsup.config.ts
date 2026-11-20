import { defineConfig } from "tsup";

export default defineConfig({
  entry: { worker: "src/worker.ts", "start-orders": "src/start-orders.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node22",
});
