import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The Strand server serves the built app at the root; in dev the API is proxied to it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { "/v1": "http://localhost:4000" } },
  build: { outDir: "dist", chunkSizeWarningLimit: 600 },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
