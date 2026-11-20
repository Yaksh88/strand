import { createPool, StrandClient, Worker } from "@strand/sdk";
import { pino } from "pino";

import { createServices, DEFAULT_SERVICE_OPTIONS, LEDGER_DDL } from "./services.js";
import { createWorkflows } from "./workflows.js";

const databaseUrl = process.env["DATABASE_URL"] ?? "postgres://localhost/strand";
const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

const pool = createPool(databaseUrl);
await pool.query(LEDGER_DDL);

const services = createServices(pool, {
  ...DEFAULT_SERVICE_OPTIONS,
  failureRate: Number(process.env["FAILURE_RATE"] ?? DEFAULT_SERVICE_OPTIONS.failureRate),
});
const { fulfillOrder, dailyReport } = createWorkflows(services, pool);

const worker = new Worker({
  connectionString: databaseUrl,
  workflows: [fulfillOrder, dailyReport],
  concurrency: Number(process.env["CONCURRENCY"] ?? 20),
  logger,
});
worker.on("run:failed", (event) => logger.error(event, "run failed"));
await worker.start();

// A cron schedule: summarise the ledger every minute (daily in real life).
const client = new StrandClient({ connectionString: databaseUrl });
await client.upsertSchedule({ id: "ledger-report", workflow: "daily-report", cron: "* * * * *" });

logger.info(
  { workerId: worker.id },
  "order-fulfillment worker running; start orders with `pnpm orders`",
);

async function shutdown(): Promise<void> {
  logger.info("shutting down: finishing in-flight runs");
  await worker.stop({ graceMs: 30_000 });
  await client.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
