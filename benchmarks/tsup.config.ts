import { defineConfig } from "tsup";

export default defineConfig({
  entry: { throughput: "src/throughput.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node22",
});
