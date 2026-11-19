import type pg from "pg";

import { createPool } from "./db/pool.js";
import {
  InvalidStateError,
  RunCancelledError,
  RunFailedError,
  WaitTimeoutError,
} from "./errors.js";
import { nextFireAfter } from "./scheduler.js";
import { Store } from "./store.js";
import type { EventRecord, RunRecord, RunStatus, ScheduleRecord, StepRecord } from "./types.js";
import type { WorkflowDefinition } from "./workflow.js";

export interface StartOptions {
  /** Starting twice with the same key returns the first run instead of creating another. */
  idempotencyKey?: string;
}

export interface ScheduleInput {
  id: string;
  workflow: string;
  cron: string;
  timezone?: string;
  input?: unknown;
  enabled?: boolean;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Start, signal, inspect and control runs from application code. */
export class StrandClient {
  private readonly pool: pg.Pool;
  private readonly ownsPool: boolean;
  private readonly store: Store;

  constructor(options: { connectionString?: string; pool?: pg.Pool }) {
    if (!options.pool && !options.connectionString) {
      throw new Error("StrandClient needs a connectionString or a pool");
    }
    this.ownsPool = !options.pool;
    this.pool = options.pool ?? createPool(options.connectionString as string);
    this.store = new Store(this.pool);
  }

  /** Queue a run. Any worker that handles the workflow will pick it up. */
  async start<I, O>(
    workflow: WorkflowDefinition<I, O> | string,
    input: I,
    options: StartOptions = {},
  ): Promise<RunRecord> {
    const name = typeof workflow === "string" ? workflow : workflow.name;
    const { run } = await this.store.createRun({
      workflow: name,
      input,
      idempotencyKey: options.idempotencyKey,
    });
    return run;
  }

  signal(runId: string, name: string, payload?: unknown): Promise<void> {
    return this.store.sendSignal(runId, name, payload);
  }

  cancel(runId: string): Promise<RunRecord> {
    return this.store.cancelRun(runId);
  }

  /** Re-queue a failed run; steps that already completed are not run again. */
  retry(runId: string): Promise<RunRecord> {
    return this.store.retryRun(runId);
  }

  get(runId: string): Promise<RunRecord | null> {
    return this.store.getRun(runId);
  }

  getDetail(
    runId: string,
  ): Promise<{ run: RunRecord; steps: StepRecord[]; events: EventRecord[] } | null> {
    return this.store.getRunDetail(runId);
  }

  list(query: {
    status?: RunStatus;
    workflow?: string;
    limit: number;
    before?: string;
  }): Promise<{ items: RunRecord[]; nextCursor: string | null }> {
    return this.store.listRuns(query);
  }

  /**
   * Wait for a run to finish. Resolves with the completed run; rejects with `RunFailedError`,
   * `RunCancelledError`, or `WaitTimeoutError` if it doesn't finish in time.
   */
  async waitForResult<O = unknown>(
    runId: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<RunRecord & { output: O }> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    const pollMs = options.pollMs ?? 100;
    for (;;) {
      const run = await this.store.getRun(runId);
      if (!run) throw new InvalidStateError(`No run with id ${runId}`);
      if (run.status === "completed") return run as RunRecord & { output: O };
      if (run.status === "failed") {
        throw new RunFailedError(runId, run.error ?? { name: "Error", message: "unknown error" });
      }
      if (run.status === "cancelled") throw new RunCancelledError(runId);
      if (Date.now() + pollMs > deadline) {
        throw new WaitTimeoutError(`Run ${runId} is still ${run.status} after the timeout`);
      }
      await delay(pollMs);
    }
  }

  /** Create or replace a cron schedule. Throws `InvalidCronError` for a bad expression or zone. */
  async upsertSchedule(schedule: ScheduleInput): Promise<ScheduleRecord> {
    const timezone = schedule.timezone ?? "UTC";
    return this.store.upsertSchedule({
      id: schedule.id,
      workflow: schedule.workflow,
      cron: schedule.cron,
      timezone,
      input: schedule.input ?? null,
      enabled: schedule.enabled ?? true,
      nextFireAt: nextFireAfter(schedule.cron, timezone, new Date()),
    });
  }

  deleteSchedule(id: string): Promise<boolean> {
    return this.store.deleteSchedule(id);
  }

  listSchedules(): Promise<ScheduleRecord[]> {
    return this.store.listSchedules();
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
