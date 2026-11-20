import { createTestDatabase, databaseAvailable, type TestDatabase } from "@strand/sdk/testing";
import { Worker, workflow, type AnyWorkflow } from "@strand/sdk";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";

import { buildApp, type AppOptions } from "../src/app.js";

export const dbAvailable = await databaseAvailable();
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

export interface Harness {
  db: TestDatabase;
  app: FastifyInstance;
  /** Start a worker for the given workflows; it is stopped by `close`. */
  startWorker(workflows: AnyWorkflow[], id?: string): Promise<Worker>;
  /** `app.inject` with a JSON body. */
  call(
    method: "GET" | "POST" | "DELETE",
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{
    status: number;
    body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    headers: Record<string, unknown>;
    text: string;
  }>;
  /** Poll the API until the run reaches `status`. */
  waitForStatus(runId: string, status: string): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  close(): Promise<void>;
}

export async function harness(options: Partial<AppOptions> = {}): Promise<Harness> {
  const db = await createTestDatabase();
  const app = await buildApp({ pool: db.pool, ...options });
  const workers: Worker[] = [];

  const call: Harness["call"] = async (method, url, body, headers) => {
    const response = await app.inject({
      method,
      url,
      headers: headers ?? {},
      ...(body === undefined ? {} : { payload: body as object }),
    });
    let parsed: unknown = null;
    try {
      parsed = response.json();
    } catch {
      // not JSON
    }
    return {
      status: response.statusCode,
      body: parsed,
      headers: response.headers,
      text: response.body,
    };
  };

  return {
    db,
    app,
    call,
    async startWorker(workflows, id) {
      const worker = new Worker({
        pool: db.pool,
        workflows,
        pollIntervalMs: 25,
        leaseMs: 1000,
        scheduler: false,
        logger: pino({ level: "silent" }),
        ...(id ? { id } : {}),
      });
      workers.push(worker);
      await worker.start();
      return worker;
    },
    waitForStatus: (runId, status) =>
      waitFor(async () => {
        const { body } = await call("GET", `/v1/runs/${runId}`);
        return body?.run?.status === status ? body.run : undefined;
      }),
    async close() {
      await Promise.all(workers.map((w) => w.stop({ graceMs: 200 })));
      await app.close();
      await db.cleanup();
    },
  };
}

export { workflow };
