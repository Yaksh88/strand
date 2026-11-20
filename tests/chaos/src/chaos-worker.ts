import { createPool, Worker } from "@strand/sdk";
import { pino } from "pino";

import { createChaosWorkflow } from "./workflow.js";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL is required");

const pool = createPool(url, { max: 10, options: process.env["SEARCH_PATH_OPTIONS"] });
const worker = new Worker({
  pool,
  workflows: [createChaosWorkflow(pool)],
  id: process.env["WORKER_ID"],
  concurrency: 10,
  leaseMs: Number(process.env["LEASE_MS"] ?? 2000),
  pollIntervalMs: 100,
  scheduler: false,
  logger: pino({ level: "silent" }),
});

await worker.start();
process.on("SIGTERM", () => void worker.stop({ graceMs: 2000 }).then(() => process.exit(0)));
