import { createPool, migrate } from "@strand/sdk";
import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);

const app = await buildApp({
  pool,
  apiToken: config.apiToken,
  // Defaults to the dashboard bundled next to this server in the Docker image.
  dashboardDir:
    config.dashboardDir ?? fileURLToPath(new URL("../../dashboard/dist", import.meta.url)),
  logger: { level: process.env["LOG_LEVEL"] ?? "info" },
});

async function shutdown(): Promise<void> {
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await app.listen({ port: config.port, host: config.host });
