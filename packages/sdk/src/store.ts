import { randomUUID } from "node:crypto";
import type pg from "pg";

import type { SerializedError } from "./errors.js";
import { InvalidStateError, LeaseLostError, RunNotFoundError } from "./errors.js";
import type {
  EventRecord,
  EventType,
  Lease,
  RunRecord,
  RunStatus,
  SignalRecord,
  StepRecord,
  StepStatus,
} from "./types.js";
import { TERMINAL_STATUSES } from "./types.js";

/** Channel workers LISTEN on; the payload is the workflow name that has new work. */
export const WAKE_CHANNEL = "strand_wake";

// ---------------------------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------------------------

interface RunRow {
  id: string;
  workflow: string;
  status: RunStatus;
  input: unknown;
  output: unknown;
  error: SerializedError | null;
  idempotency_key: string | null;
  claim_count: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  available_at: Date | number | string;
  waiting_signal: string | null;
  schedule_id: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface StepRow {
  run_id: string;
  step_key: string;
  status: StepStatus;
  output: { v?: unknown } | null;
  error: SerializedError | null;
  attempts: number;
  started_at: Date | null;
  completed_at: Date | null;
}

interface SignalRow {
  id: string;
  run_id: string;
  name: string;
  payload: unknown;
  created_at: Date;
  consumed_by: string | null;
}

interface EventRow {
  id: string;
  run_id: string;
  type: EventType;
  data: Record<string, unknown>;
  at: Date;
}

/** `available_at` is `infinity` for a wait with no deadline, which node-postgres can't make a Date. */
const FAR_FUTURE = new Date(8.64e15);

function toDate(value: Date | number | string): Date {
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? FAR_FUTURE : date;
}

const toRun = (row: RunRow): RunRecord => ({
  id: row.id,
  workflow: row.workflow,
  status: row.status,
  input: row.input,
  output: row.output,
  error: row.error,
  idempotencyKey: row.idempotency_key,
  claimCount: row.claim_count,
  leaseOwner: row.lease_owner,
  leaseToken: row.lease_token,
  leaseExpiresAt: row.lease_expires_at,
  availableAt: toDate(row.available_at),
  waitingSignal: row.waiting_signal,
  scheduleId: row.schedule_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

const toStep = (row: StepRow): StepRecord => ({
  runId: row.run_id,
  stepKey: row.step_key,
  status: row.status,
  // Outputs are stored as {"v": value} so null and undefined survive the round trip.
  output: row.output && "v" in row.output ? row.output.v : null,
  error: row.error,
  attempts: row.attempts,
  startedAt: row.started_at,
  completedAt: row.completed_at,
});

const toSignal = (row: SignalRow): SignalRecord => ({
  id: row.id,
  runId: row.run_id,
  name: row.name,
  payload: row.payload,
  createdAt: row.created_at,
  consumedBy: row.consumed_by,
});

const toEvent = (row: EventRow): EventRecord => ({
  id: row.id,
  runId: row.run_id,
  type: row.type,
  data: row.data,
  at: row.at,
});

/** JSON for a jsonb parameter. Passing objects straight to node-postgres would mangle arrays. */
export function toJson(value: unknown): string {
  const text = JSON.stringify(value === undefined ? null : value);
  return text ?? "null"; // functions and symbols stringify to undefined
}

const wrap = (value: unknown): string => toJson({ v: value === undefined ? null : value });

const encodeCursor = (createdAt: string, id: string): string =>
  Buffer.from(`${createdAt}|${id}`).toString("base64url");

function decodeCursor(cursor: string): [string, string] {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (!createdAt || !id) throw new InvalidStateError("Malformed cursor");
  return [createdAt, id];
}

export interface NewEvent {
  runId: string;
  type: EventType;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

/**
 * Every SQL statement in Strand lives here.
 *
 * Writes that a worker makes on behalf of a run it is executing are *fenced*: they first lock
 * the run's row `FOR UPDATE` while checking that the worker's fencing token is still the one
 * stored on it, and throw `LeaseLostError` if not. The row lock is what makes the check safe: a
 * concurrent reclaim of an expired lease either committed first (so the check fails) or has to
 * wait for the fenced write to finish. A worker that stalled past its lease can therefore never
 * commit a result after another worker took the run over.
 */
export class Store {
  constructor(private readonly pool: pg.Pool) {}

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async fence(client: pg.PoolClient, lease: Lease): Promise<{ workflow: string }> {
    const { rows } = await client.query<{ workflow: string }>(
      `select workflow from strand_runs
        where id = $1 and lease_token = $2 and status = 'running'
        for update`,
      [lease.runId, lease.token],
    );
    const row = rows[0];
    if (!row)
      throw new LeaseLostError(`Lease on run ${lease.runId} (token ${lease.token}) was lost`);
    return row;
  }

  private async insertEvents(client: pg.PoolClient, events: NewEvent[]): Promise<void> {
    if (events.length === 0) return;
    await client.query(
      `insert into strand_events (run_id, type, data)
       select * from unnest($1::uuid[], $2::text[], $3::jsonb[])`,
      [
        events.map((e) => e.runId),
        events.map((e) => e.type),
        events.map((e) => toJson(e.data ?? {})),
      ],
    );
  }

  private notify(client: pg.PoolClient, workflow: string): Promise<unknown> {
    return client.query("select pg_notify($1, $2)", [WAKE_CHANNEL, workflow]);
  }

  // ---- creating and claiming runs ----------------------------------------------------------

  async createRun(p: {
    workflow: string;
    input: unknown;
    idempotencyKey?: string;
    scheduleId?: string;
  }): Promise<{ run: RunRecord; created: boolean }> {
    return this.tx(async (client) => {
      const inserted = await client.query<RunRow>(
        `insert into strand_runs (id, workflow, status, input, idempotency_key, schedule_id)
         values ($1, $2, 'queued', $3::jsonb, $4, $5)
         on conflict (idempotency_key) do nothing
         returning *`,
        [randomUUID(), p.workflow, toJson(p.input), p.idempotencyKey ?? null, p.scheduleId ?? null],
      );
      const row = inserted.rows[0];
      if (row) {
        await this.insertEvents(client, [{ runId: row.id, type: "run_created" }]);
        await this.notify(client, p.workflow);
        return { run: toRun(row), created: true };
      }
      const existing = await client.query<RunRow>(
        "select * from strand_runs where idempotency_key = $1",
        [p.idempotencyKey],
      );
      return { run: toRun(existing.rows[0] as RunRow), created: false };
    });
  }

  /** Claim up to `limit` runs that are due, or whose previous worker's lease has expired. */
  async claimRuns(p: {
    owner: string;
    workflows: string[];
    limit: number;
    leaseMs: number;
  }): Promise<RunRecord[]> {
    if (p.workflows.length === 0 || p.limit <= 0) return [];
    return this.tx(async (client) => {
      const { rows } = await client.query<
        RunRow & { prev_status: RunStatus; prev_owner: string | null }
      >(
        `with picked as (
           select id, status as prev_status, lease_owner as prev_owner
             from strand_runs
            where workflow = any($3::text[])
              and ((status in ('queued', 'sleeping', 'waiting') and available_at <= now())
                   or (status = 'running' and lease_expires_at < now()))
            order by available_at
            limit $4
              for update skip locked
         )
         update strand_runs r
            set status = 'running',
                lease_owner = $1,
                lease_token = nextval('strand_lease_seq'),
                lease_expires_at = now() + make_interval(secs => $2),
                claim_count = r.claim_count + 1,
                waiting_signal = null,
                updated_at = now()
           from picked p
          where r.id = p.id
        returning r.*, p.prev_status, p.prev_owner`,
        [p.owner, p.leaseMs / 1000, p.workflows, p.limit],
      );

      const events: NewEvent[] = [];
      for (const row of rows) {
        if (row.prev_status === "running") {
          events.push({
            runId: row.id,
            type: "lease_expired",
            data: { previousOwner: row.prev_owner },
          });
        }
        events.push({
          runId: row.id,
          type: "run_claimed",
          data: { owner: p.owner, attempt: row.claim_count },
        });
      }
      await this.insertEvents(client, events);
      return rows.map(toRun);
    });
  }

  /** Extend the leases of in-flight runs. Returns the ids of the runs still held. */
  async heartbeat(p: { leases: Lease[]; leaseMs: number }): Promise<Set<string>> {
    if (p.leases.length === 0) return new Set();
    const { rows } = await this.pool.query<{ id: string }>(
      `update strand_runs r
          set lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
         from unnest($1::uuid[], $2::bigint[]) as l(id, token)
        where r.id = l.id and r.lease_token = l.token and r.status = 'running'
        returning r.id`,
      [p.leases.map((l) => l.runId), p.leases.map((l) => l.token), p.leaseMs / 1000],
    );
    return new Set(rows.map((r) => r.id));
  }

  async loadHistory(runId: string): Promise<{ steps: StepRecord[]; signals: SignalRecord[] }> {
    const [steps, signals] = await Promise.all([
      this.pool.query<StepRow>("select * from strand_steps where run_id = $1 order by started_at", [
        runId,
      ]),
      this.pool.query<SignalRow>(
        "select * from strand_signals where run_id = $1 and consumed_by is null order by id",
        [runId],
      ),
    ]);
    return { steps: steps.rows.map(toStep), signals: signals.rows.map(toSignal) };
  }

  // ---- fenced writes: a run's execution --------------------------------------------------------

  /** Record a finished step. One statement, so the hot path costs a single round trip. */
  async completeStep(
    lease: Lease,
    p: { stepKey: string; output: unknown; attempts: number; startedAt: Date },
  ): Promise<void> {
    const { rowCount } = await this.pool.query(
      `with held as (
         select id from strand_runs
          where id = $1 and lease_token = $2 and status = 'running'
            for update
       ), step as (
         insert into strand_steps
                (run_id, step_key, status, output, error, attempts, started_at, completed_at)
         select $1, $3, 'completed', $4::jsonb, null, $5, $6, now() from held
         on conflict (run_id, step_key) do update
            set status = 'completed',
                output = excluded.output,
                error = null,
                attempts = excluded.attempts,
                started_at = coalesce(strand_steps.started_at, excluded.started_at),
                completed_at = excluded.completed_at
         returning 1
       )
       insert into strand_events (run_id, type, data)
       select $1, 'step_completed', $7::jsonb from step`,
      [
        lease.runId,
        lease.token,
        p.stepKey,
        wrap(p.output),
        p.attempts,
        p.startedAt,
        toJson({ stepKey: p.stepKey, attempts: p.attempts }),
      ],
    );
    if (!rowCount) throw new LeaseLostError(`Lease on run ${lease.runId} was lost`);
  }

  /** A step failed but has attempts left: record it and put the run to sleep until `retryAt`. */
  async scheduleStepRetry(
    lease: Lease,
    p: { stepKey: string; error: SerializedError; attempts: number; retryAt: Date },
  ): Promise<void> {
    await this.tx(async (client) => {
      await this.fence(client, lease);
      await client.query(
        `insert into strand_steps (run_id, step_key, status, error, attempts, started_at)
         values ($1, $2, 'retrying', $3::jsonb, $4, now())
         on conflict (run_id, step_key) do update
            set status = 'retrying', error = excluded.error, attempts = excluded.attempts`,
        [lease.runId, p.stepKey, toJson(p.error), p.attempts],
      );
      await this.suspend(client, lease.runId, "sleeping", p.retryAt, null);
      await this.insertEvents(client, [
        {
          runId: lease.runId,
          type: "step_retry_scheduled",
          data: {
            stepKey: p.stepKey,
            attempts: p.attempts,
            retryAt: p.retryAt.toISOString(),
            error: p.error.message,
          },
        },
      ]);
    });
  }

  /** A step used up its attempts. The run keeps going: workflow code may catch the failure. */
  async failStep(
    lease: Lease,
    p: { stepKey: string; error: SerializedError; attempts: number },
  ): Promise<void> {
    await this.tx(async (client) => {
      await this.fence(client, lease);
      await client.query(
        `insert into strand_steps
                (run_id, step_key, status, error, attempts, started_at, completed_at)
         values ($1, $2, 'failed', $3::jsonb, $4, now(), now())
         on conflict (run_id, step_key) do update
            set status = 'failed', error = excluded.error, attempts = excluded.attempts,
                completed_at = excluded.completed_at`,
        [lease.runId, p.stepKey, toJson(p.error), p.attempts],
      );
      await this.insertEvents(client, [
        {
          runId: lease.runId,
          type: "step_failed",
          data: { stepKey: p.stepKey, attempts: p.attempts, error: p.error.message },
        },
      ]);
    });
  }

  private suspend(
    client: pg.PoolClient,
    runId: string,
    status: "sleeping" | "waiting",
    availableAt: Date | null,
    waitingSignal: string | null,
  ): Promise<unknown> {
    return client.query(
      `update strand_runs
          set status = $2,
              available_at = coalesce($3::timestamptz, 'infinity'::timestamptz),
              waiting_signal = $4,
              lease_owner = null, lease_token = null, lease_expires_at = null,
              updated_at = now()
        where id = $1`,
      [runId, status, availableAt, waitingSignal],
    );
  }

  /**
   * Durable sleep. The step row stores the wake-up time the first time the sleep is reached, so
   * replays never recompute it.
   */
  async suspendSleeping(
    lease: Lease,
    p: { stepKey: string; wakeAt: Date; firstTime: boolean },
  ): Promise<void> {
    await this.tx(async (client) => {
      await this.fence(client, lease);
      if (p.firstTime) {
        await client.query(
          `insert into strand_steps (run_id, step_key, status, output, attempts, started_at)
           values ($1, $2, 'retrying', $3::jsonb, 0, now())
           on conflict (run_id, step_key) do nothing`,
          [lease.runId, p.stepKey, wrap({ wakeAt: p.wakeAt.toISOString() })],
        );
      }
      await this.suspend(client, lease.runId, "sleeping", p.wakeAt, null);
      await this.insertEvents(client, [
        {
          runId: lease.runId,
          type: "run_sleeping",
          data: { stepKey: p.stepKey, wakeAt: p.wakeAt.toISOString() },
        },
      ]);
    });
  }

  /**
   * Park the run until a signal named `signal` arrives (or `deadline`, if any).
   *
   * Returns false, changing nothing, if a matching signal is already waiting: it arrived after
   * the caller last looked, and parking now would sleep through it.
   */
  async suspendWaiting(
    lease: Lease,
    p: { stepKey: string; signal: string; deadline: Date | null; firstTime: boolean },
  ): Promise<boolean> {
    return this.tx(async (client) => {
      await this.fence(client, lease);
      const pending = await client.query(
        `select 1 from strand_signals
          where run_id = $1 and name = $2 and consumed_by is null limit 1`,
        [lease.runId, p.signal],
      );
      if (pending.rowCount) return false;

      if (p.firstTime) {
        await client.query(
          `insert into strand_steps (run_id, step_key, status, output, attempts, started_at)
           values ($1, $2, 'retrying', $3::jsonb, 0, now())
           on conflict (run_id, step_key) do nothing`,
          [lease.runId, p.stepKey, wrap({ deadline: p.deadline?.toISOString() ?? null })],
        );
      }
      await this.suspend(client, lease.runId, "waiting", p.deadline, p.signal);
      await this.insertEvents(client, [
        {
          runId: lease.runId,
          type: "run_waiting",
          data: {
            stepKey: p.stepKey,
            signal: p.signal,
            deadline: p.deadline?.toISOString() ?? null,
          },
        },
      ]);
      return true;
    });
  }

  /** Oldest unconsumed signal with this name, if any. */
  async findSignal(runId: string, name: string): Promise<SignalRecord | null> {
    const { rows } = await this.pool.query<SignalRow>(
      `select * from strand_signals
        where run_id = $1 and name = $2 and consumed_by is null
        order by id limit 1`,
      [runId, name],
    );
    return rows[0] ? toSignal(rows[0]) : null;
  }

  /** Mark a signal consumed and complete the waiting step in one fenced transaction. */
  async consumeSignal(
    lease: Lease,
    p: { stepKey: string; signalId: string; output: unknown },
  ): Promise<void> {
    await this.tx(async (client) => {
      await this.fence(client, lease);
      const consumed = await client.query(
        `update strand_signals set consumed_by = $3
          where id = $1 and run_id = $2 and consumed_by is null`,
        [p.signalId, lease.runId, p.stepKey],
      );
      if (!consumed.rowCount) throw new LeaseLostError(`Signal ${p.signalId} was already consumed`);
      await client.query(
        `insert into strand_steps
                (run_id, step_key, status, output, attempts, started_at, completed_at)
         values ($1, $2, 'completed', $3::jsonb, 0, now(), now())
         on conflict (run_id, step_key) do update
            set status = 'completed', output = excluded.output, completed_at = excluded.completed_at`,
        [lease.runId, p.stepKey, wrap(p.output)],
      );
      await this.insertEvents(client, [
        { runId: lease.runId, type: "step_completed", data: { stepKey: p.stepKey } },
      ]);
    });
  }

  async completeRun(lease: Lease, output: unknown): Promise<void> {
    await this.tx(async (client) => {
      await this.fence(client, lease);
      await client.query(
        `update strand_runs
            set status = 'completed', output = $2::jsonb, completed_at = now(), updated_at = now(),
                lease_owner = null, lease_token = null, lease_expires_at = null
          where id = $1`,
        [lease.runId, toJson(output)],
      );
      await this.insertEvents(client, [{ runId: lease.runId, type: "run_completed" }]);
    });
  }

  async failRun(lease: Lease, error: SerializedError): Promise<void> {
    await this.tx(async (client) => {
      await this.fence(client, lease);
      await client.query(
        `update strand_runs
            set status = 'failed', error = $2::jsonb, completed_at = now(), updated_at = now(),
                lease_owner = null, lease_token = null, lease_expires_at = null
          where id = $1`,
        [lease.runId, toJson(error)],
      );
      await this.insertEvents(client, [
        { runId: lease.runId, type: "run_failed", data: { error: error.message } },
      ]);
    });
  }

  /** Give a run back (graceful shutdown) so another worker can claim it immediately. */
  async releaseRun(lease: Lease): Promise<void> {
    await this.tx(async (client) => {
      const { workflow } = await this.fence(client, lease);
      await client.query(
        `update strand_runs
            set status = 'queued', available_at = now(), updated_at = now(),
                lease_owner = null, lease_token = null, lease_expires_at = null
          where id = $1`,
        [lease.runId],
      );
      await this.notify(client, workflow);
    });
  }

  // ---- signals and operator actions ----------------------------------------------------------

  /**
   * Deliver a signal. It is buffered, so it is not lost if the workflow hasn't reached its wait.
   *
   * The run row is locked first so this is ordered against the worker parking the run in
   * `suspendWaiting`: either the signal is visible to that worker's final check, or the run is
   * already `waiting` here and gets woken. (The foreign key on `strand_signals` takes a
   * conflicting lock too, but correctness shouldn't hinge on that implicit detail.)
   */
  async sendSignal(runId: string, name: string, payload: unknown): Promise<void> {
    await this.tx(async (client) => {
      const locked = await client.query<{ status: RunStatus; workflow: string }>(
        "select status, workflow from strand_runs where id = $1 for update",
        [runId],
      );
      const run = locked.rows[0];
      if (!run) throw new RunNotFoundError(`No run with id ${runId}`);
      if (TERMINAL_STATUSES.includes(run.status)) {
        throw new InvalidStateError(`Run ${runId} already ${run.status}`);
      }
      await client.query(
        "insert into strand_signals (run_id, name, payload) values ($1, $2, $3::jsonb)",
        [runId, name, toJson(payload)],
      );
      const woke = await client.query(
        `update strand_runs
            set status = 'queued', available_at = now(), waiting_signal = null, updated_at = now()
          where id = $1 and status = 'waiting' and waiting_signal = $2`,
        [runId, name],
      );
      await this.insertEvents(client, [{ runId, type: "signal_received", data: { name } }]);
      if (woke.rowCount) await this.notify(client, run.workflow);
    });
  }

  async cancelRun(runId: string): Promise<RunRecord> {
    return this.tx(async (client) => {
      const { rows } = await client.query<RunRow>(
        `update strand_runs
            set status = 'cancelled', completed_at = now(), updated_at = now(),
                lease_owner = null, lease_token = null, lease_expires_at = null
          where id = $1 and status not in ('completed', 'failed', 'cancelled')
          returning *`,
        [runId],
      );
      const row = rows[0];
      if (!row) {
        const existing = await client.query<{ status: RunStatus }>(
          "select status from strand_runs where id = $1",
          [runId],
        );
        if (!existing.rows[0]) throw new RunNotFoundError(`No run with id ${runId}`);
        throw new InvalidStateError(`Run ${runId} already ${existing.rows[0].status}`);
      }
      await this.insertEvents(client, [{ runId, type: "run_cancelled" }]);
      return toRun(row);
    });
  }

  /** Re-queue a failed run. Steps that completed stay memoised, so it resumes where it failed. */
  async retryRun(runId: string): Promise<RunRecord> {
    return this.tx(async (client) => {
      const locked = await client.query<{ status: RunStatus }>(
        "select status from strand_runs where id = $1 for update",
        [runId],
      );
      const current = locked.rows[0];
      if (!current) throw new RunNotFoundError(`No run with id ${runId}`);
      if (current.status !== "failed") {
        throw new InvalidStateError(
          `Only failed runs can be retried; run ${runId} is ${current.status}`,
        );
      }
      await client.query("delete from strand_steps where run_id = $1 and status = 'failed'", [
        runId,
      ]);
      const { rows } = await client.query<RunRow>(
        `update strand_runs
            set status = 'queued', error = null, completed_at = null,
                available_at = now(), updated_at = now()
          where id = $1
          returning *`,
        [runId],
      );
      const run = toRun(rows[0] as RunRow);
      await this.insertEvents(client, [{ runId, type: "run_retried" }]);
      await this.notify(client, run.workflow);
      return run;
    });
  }

  // ---- worker registry -------------------------------------------------------------------------

  async registerWorker(p: {
    id: string;
    hostname: string;
    pid: number;
    workflows: string[];
    concurrency: number;
  }): Promise<void> {
    await this.pool.query(
      `insert into strand_workers (id, hostname, pid, workflows, concurrency)
       values ($1, $2, $3, $4::text[], $5)
       on conflict (id) do update
          set hostname = excluded.hostname, pid = excluded.pid, workflows = excluded.workflows,
              concurrency = excluded.concurrency, started_at = now(), last_seen_at = now()`,
      [p.id, p.hostname, p.pid, p.workflows, p.concurrency],
    );
  }

  async touchWorker(id: string): Promise<void> {
    await this.pool.query("update strand_workers set last_seen_at = now() where id = $1", [id]);
  }

  async removeWorker(id: string): Promise<void> {
    await this.pool.query("delete from strand_workers where id = $1", [id]);
  }

  // ---- reading --------------------------------------------------------------------------------

  async getRun(runId: string): Promise<RunRecord | null> {
    const { rows } = await this.pool.query<RunRow>("select * from strand_runs where id = $1", [
      runId,
    ]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async getRunDetail(
    runId: string,
  ): Promise<{ run: RunRecord; steps: StepRecord[]; events: EventRecord[] } | null> {
    const [run, steps, events] = await Promise.all([
      this.getRun(runId),
      this.pool.query<StepRow>("select * from strand_steps where run_id = $1 order by started_at", [
        runId,
      ]),
      this.pool.query<EventRow>("select * from strand_events where run_id = $1 order by id", [
        runId,
      ]),
    ]);
    if (!run) return null;
    return { run, steps: steps.rows.map(toStep), events: events.rows.map(toEvent) };
  }

  async listRuns(p: {
    status?: RunStatus;
    workflow?: string;
    limit: number;
    before?: string;
  }): Promise<{ items: RunRecord[]; nextCursor: string | null }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (p.status) conditions.push(`status = ${bind(p.status)}`);
    if (p.workflow) conditions.push(`workflow = ${bind(p.workflow)}`);
    if (p.before) {
      const [createdAt, id] = decodeCursor(p.before);
      conditions.push(`(created_at, id) < (${bind(createdAt)}::timestamptz, ${bind(id)}::uuid)`);
    }
    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";

    // created_at is fetched as text: a JS Date would drop Postgres's microseconds and make the
    // keyset cursor skip or repeat rows that share a millisecond.
    const { rows } = await this.pool.query<RunRow & { cursor_ts: string }>(
      `select *, created_at::text as cursor_ts from strand_runs ${where}
        order by created_at desc, id desc limit ${bind(p.limit + 1)}`,
      params,
    );
    const page = rows.slice(0, p.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRun),
      nextCursor: rows.length > p.limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
    };
  }

  async appendEvent(
    runId: string,
    type: EventType,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await this.pool.query(
      "insert into strand_events (run_id, type, data) values ($1, $2, $3::jsonb)",
      [runId, type, toJson(data)],
    );
  }
}
