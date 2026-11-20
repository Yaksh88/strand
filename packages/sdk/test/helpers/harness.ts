import { pino } from "pino";

import { Worker, type AnyWorkflow, type WorkerOptions } from "../../src/index.js";
import type { Store } from "../../src/store.js";
import type { TestDb } from "./db.js";

export const logger = pino({ level: "silent" });
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until the probe returns something truthy, or throws after `timeoutMs`. */
export async function waitFor<T>(
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await pause(20);
  }
}

export const waitForStatus = (store: Store, runId: string, status: string, timeoutMs = 8000) =>
  waitFor(async () => {
    const run = await store.getRun(runId);
    return run?.status === status ? run : undefined;
  }, timeoutMs);

/** Creates workers on a test database and stops them all when `stopAll` is called. */
export function workerFactory(db: TestDb) {
  const workers: Worker[] = [];
  return {
    make(workflows: AnyWorkflow[], options: Partial<WorkerOptions> = {}): Worker {
      const worker = new Worker({
        pool: db.pool,
        workflows,
        pollIntervalMs: 25,
        leaseMs: 1000,
        scheduler: false,
        logger,
        ...options,
      });
      workers.push(worker);
      return worker;
    },
    async stopAll() {
      await Promise.all(workers.splice(0).map((w) => w.stop({ graceMs: 200 })));
    },
  };
}
