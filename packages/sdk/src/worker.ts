import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import type pg from "pg";
import { pino, type Logger } from "pino";

import { createContext, Suspend } from "./context.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { LeaseLostError, serializeError, type SerializedError } from "./errors.js";
import { WakeListener } from "./notify.js";
import { Store, WAKE_CHANNEL } from "./store.js";
import type { Lease, RunRecord } from "./types.js";
import type { AnyWorkflow } from "./workflow.js";

export interface WorkerOptions {
  connectionString?: string;
  pool?: pg.Pool;
  workflows: AnyWorkflow[];
  /** Runs executed at once. Default 10. */
  concurrency?: number;
  /** How long a claim lasts without a heartbeat. Default 30s. */
  leaseMs?: number;
  /** How often to look for work when nothing wakes the worker. Default 1s. */
  pollIntervalMs?: number;
  /** Run the cron scheduler in this worker. Default true. */
  scheduler?: boolean;
  id?: string;
  logger?: Logger;
}

export interface RunEvent {
  runId: string;
  workflow: string;
}

interface WorkerEvents {
  "run:completed": [RunEvent];
  "run:failed": [RunEvent & { error: SerializedError }];
  "run:suspended": [RunEvent];
  error: [unknown];
}

interface InFlight {
  lease: Lease;
  controller: AbortController;
  promise: Promise<void>;
}

const INFRASTRUCTURE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);

/** Database and network failures say nothing about the workflow, so they must not fail the run. */
function isInfrastructureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return (
    severity !== undefined ||
    (typeof code === "string" && INFRASTRUCTURE_CODES.has(code)) ||
    /connection (terminated|timeout)/i.test(error.message)
  );
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Claims runs from Postgres and executes them.
 *
 * A worker holds a lease on every run it executes and extends it with a heartbeat. If the worker
 * dies, the leases expire and another worker resumes the runs, replaying them from their stored
 * steps. If a worker is merely slow and loses a lease, its in-flight execution is aborted and
 * its writes are refused by the store's fencing check.
 */
export class Worker extends EventEmitter<WorkerEvents> {
  readonly id: string;

  private readonly workflows: Map<string, AnyWorkflow>;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;
  private readonly inFlight = new Map<string, InFlight>();

  private pool!: pg.Pool;
  private store!: Store;
  private ownsPool = false;
  private listener: WakeListener | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private loopPromise: Promise<void> = Promise.resolve();
  private beating = false;

  private started = false;
  private stopping = false;
  private poked = false;
  private waker: (() => void) | null = null;

  constructor(private readonly options: WorkerOptions) {
    super();
    if (!options.pool && !options.connectionString) {
      throw new Error("Worker needs a connectionString or a pool");
    }
    this.workflows = new Map(options.workflows.map((w) => [w.name, w]));
    this.id = options.id ?? `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
    this.concurrency = options.concurrency ?? 10;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.logger = (
      options.logger ?? pino({ level: process.env["STRAND_LOG_LEVEL"] ?? "warn" })
    ).child({ worker: this.id });
  }

  /** Applies pending migrations, registers the worker and starts claiming runs. */
  async start(): Promise<void> {
    if (this.started) throw new Error("Worker already started");
    this.started = true;

    this.ownsPool = !this.options.pool;
    this.pool = this.options.pool ?? createPool(this.options.connectionString as string);
    this.store = new Store(this.pool);
    await migrate(this.pool);
    await this.store.registerWorker({
      id: this.id,
      hostname: hostname(),
      pid: process.pid,
      workflows: [...this.workflows.keys()],
      concurrency: this.concurrency,
    });

    this.listener = new WakeListener(
      this.pool.options,
      WAKE_CHANNEL,
      (workflow) => {
        if (workflow === "" || this.workflows.has(workflow)) this.poke();
      },
      this.logger,
    );
    await this.listener.start();

    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.leaseMs / 3);
    this.loopPromise = this.loop();
  }

  /**
   * Stop claiming and wait up to `graceMs` for in-flight runs to finish. Runs still going after
   * that are aborted and their leases released, so other workers pick them up immediately.
   *
   * `abandon` simulates a crash for tests: nothing is released, and leases expire on their own.
   */
  async stop(opts: { graceMs?: number; abandon?: boolean } = {}): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;
    clearInterval(this.heartbeatTimer);
    this.poke();
    await this.listener?.stop();
    await this.loopPromise;

    const running = [...this.inFlight.values()];
    if (opts.abandon) {
      for (const entry of running) entry.controller.abort(new LeaseLostError("worker abandoned"));
      return;
    }

    const drained = await Promise.race([
      Promise.allSettled(running.map((r) => r.promise)).then(() => true),
      delay(opts.graceMs ?? 30_000).then(() => false),
    ]);
    if (!drained) {
      for (const entry of running) entry.controller.abort(new LeaseLostError("worker stopping"));
      await Promise.all(
        [...this.inFlight.values()].map((entry) =>
          this.store.releaseRun(entry.lease).catch((error) => {
            if (!(error instanceof LeaseLostError)) this.report(error);
          }),
        ),
      );
    }
    await this.store.removeWorker(this.id).catch(() => {});
    if (this.ownsPool) await this.pool.end();
  }

  // ---- the claim loop ---------------------------------------------------------------------

  private poke(): void {
    this.poked = true;
    this.waker?.();
  }

  private idle(ms: number): Promise<void> {
    if (this.poked) {
      this.poked = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waker = null;
        this.poked = false;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.waker = finish;
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        const free = this.concurrency - this.inFlight.size;
        if (free > 0) {
          const runs = await this.store.claimRuns({
            owner: this.id,
            workflows: [...this.workflows.keys()],
            limit: free,
            leaseMs: this.leaseMs,
          });
          for (const run of runs) this.launch(run);
          if (runs.length === free && !this.stopping) continue; // a full batch: more may be due
        }
      } catch (error) {
        this.report(error);
      }
      await this.idle(this.pollIntervalMs);
    }
  }

  private launch(run: RunRecord): void {
    const definition = this.workflows.get(run.workflow);
    const lease: Lease = { runId: run.id, token: run.leaseToken as string, owner: this.id };
    if (!definition) {
      // Can't happen (claims are filtered by workflow), but never strand a claimed run.
      this.logger.error({ runId: run.id, workflow: run.workflow }, "claimed an unknown workflow");
      void this.store.releaseRun(lease).catch(() => {});
      return;
    }
    const controller = new AbortController();
    const entry: InFlight = { lease, controller, promise: Promise.resolve() };
    this.inFlight.set(run.id, entry);
    entry.promise = this.execute(run, lease, controller, definition).finally(() => {
      this.inFlight.delete(run.id);
      this.poke(); // a slot is free
    });
  }

  // ---- executing one run --------------------------------------------------------------------

  private async execute(
    run: RunRecord,
    lease: Lease,
    controller: AbortController,
    definition: AnyWorkflow,
  ): Promise<void> {
    const event: RunEvent = { runId: run.id, workflow: run.workflow };
    try {
      const history = await this.store.loadHistory(run.id);
      const ctx = createContext({
        run,
        lease,
        history,
        store: this.store,
        defaults: definition.retry,
        signal: controller.signal,
        logger: this.logger,
      });

      const output = await definition.fn(ctx, run.input as never);

      // Steps stored by an earlier execution that this one never reached mean the workflow code
      // changed in between. Record it rather than fail: the run itself still completed.
      const unvisited = history.steps
        .map((s) => s.stepKey)
        .filter((key) => !ctx.visitedKeys().has(key));
      if (unvisited.length > 0) {
        this.logger.warn(
          { ...event, unvisited },
          "workflow skipped steps recorded by an earlier run",
        );
        await this.store.appendEvent(run.id, "nondeterminism_detected", { unvisited });
      }

      await this.store.completeRun(lease, output);
      this.emit("run:completed", event);
    } catch (error) {
      if (error instanceof Suspend) {
        this.emit("run:suspended", event);
      } else if (error instanceof LeaseLostError || controller.signal.aborted) {
        this.logger.warn(event, "lost the lease on a run; another worker will continue it");
      } else if (isInfrastructureError(error)) {
        // Leave the lease to expire so another worker retries once the database is reachable.
        this.logger.error({ ...event, err: error }, "infrastructure error while executing a run");
        this.report(error);
      } else {
        const failure = serializeError(error);
        try {
          await this.store.failRun(lease, failure);
          this.emit("run:failed", { ...event, error: failure });
        } catch (failError) {
          if (!(failError instanceof LeaseLostError)) this.report(failError);
        }
      }
    }
  }

  // ---- heartbeats ---------------------------------------------------------------------------

  private async heartbeat(): Promise<void> {
    if (this.beating || this.stopping) return;
    this.beating = true;
    try {
      const entries = [...this.inFlight.values()];
      const held = await this.store.heartbeat({
        leases: entries.map((e) => e.lease),
        leaseMs: this.leaseMs,
      });
      for (const entry of entries) {
        if (!held.has(entry.lease.runId)) {
          entry.controller.abort(new LeaseLostError(`Lease on ${entry.lease.runId} was lost`));
        }
      }
      await this.store.touchWorker(this.id);
    } catch (error) {
      this.report(error);
    } finally {
      this.beating = false;
    }
  }

  private report(error: unknown): void {
    this.logger.error({ err: error }, "worker error");
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }
}
