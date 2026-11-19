# @strand/sdk

Durable workflows on Postgres. You write a workflow as an ordinary async function; Strand records
the result of each step, so a run survives worker crashes, deploys and restarts, and can sleep
for days or wait for an outside event without holding a process.

```ts
import { StrandClient, Worker, workflow } from "@strand/sdk";

export const fulfillOrder = workflow(
  { name: "fulfill-order", retry: { maxAttempts: 5 } },
  async (ctx, input: { orderId: string; amountCents: number }) => {
    const charge = await ctx.step("charge-card", () =>
      payments.charge(input.orderId, input.amountCents, {
        idempotencyKey: ctx.idempotencyKey("charge-card"),
      }),
    );

    const review = await ctx.waitForSignal<{ ok: boolean }>("fraud-review", { timeout: "2d" });
    if (review.timedOut || !review.payload.ok) {
      await ctx.step("refund", () => payments.refund(charge.id));
      return { status: "refunded" as const };
    }

    await ctx.sleep("cooling-off", "10m");
    await ctx.step("ship", () => shipping.create(input.orderId));
    return { status: "shipped" as const };
  },
);

// In a long-running process:
const worker = new Worker({
  connectionString: process.env.DATABASE_URL!,
  workflows: [fulfillOrder],
  concurrency: 20,
});
await worker.start(); // applies migrations, then starts claiming runs
process.on("SIGTERM", () => void worker.stop({ graceMs: 30_000 }));

// From your application:
const client = new StrandClient({ connectionString: process.env.DATABASE_URL! });
const run = await client.start(fulfillOrder, { orderId: "o_1", amountCents: 4200 }, {
  idempotencyKey: "order:o_1",
});
await client.signal(run.id, "fraud-review", { ok: true });
const done = await client.waitForResult(run.id, { timeoutMs: 30_000 });
```

## How it works

A worker claims a run, then calls your workflow function from the top. Each `ctx.step` checks
whether that step already has a stored result: if so it returns it without running `fn`; if not
it runs `fn` and stores the result. When the function hits a sleep, a signal wait or a retry, the
run is parked and the worker moves on. When it is due again, any worker claims it and replays the
function, which fast-forwards through the steps that are already done.

Two consequences to design for:

- **Workflow code must be deterministic.** Don't read the clock, generate random numbers or call
  external services outside a step. Use `await ctx.now()` for the time and put side effects in
  steps. If a workflow is changed so that it skips steps recorded by an older run, the run still
  completes but gets a `nondeterminism_detected` event.
- **Step results are JSON.** `undefined` becomes `null` and a `Date` becomes an ISO string, on the
  first run as well as on replays, so both see the same value. A result that can't be serialised
  (a `BigInt`, a cycle) fails the step with a clear error.

## Guarantees

- A step's **result is committed once**: writes are fenced by a per-claim token, so a worker that
  stalled past its lease can never overwrite the work of the worker that took over.
- A step's **function may run more than once**: a worker can crash after `fn` succeeds but before
  the result is stored. Make side effects idempotent, with `ctx.idempotencyKey(stepName)` as the
  key to pass to the external service. It is stable across retries and replays.
- Runs are never lost: a crashed worker's leases expire and the runs are resumed elsewhere.

## API

### `workflow(options | name, fn)`

`options`: `name`, and `retry` (a partial policy: `maxAttempts` 3, `initialDelayMs` 1000,
`backoffCoefficient` 2, `maxDelayMs` 60000; jittered) used as the default for the workflow's steps.

### `ctx`

| Member | Meaning |
| --- | --- |
| `step(name, fn, { retry }?)` | Run `fn` once and store its result. Retries on failure with backoff; once attempts run out it throws `StepFailedError` into your code, which can catch it and compensate |
| `sleep(name, duration)` | Durable timer. Durations are milliseconds or `"500ms"`, `"30s"`, `"10m"`, `"2h"`, `"1d"` |
| `waitForSignal(name, { timeout }?)` | Resolves `{ timedOut: false, payload }` or `{ timedOut: true }`. Signals sent early are buffered and consumed in order |
| `now()` | Current time, recorded so a resumed run sees the same value |
| `idempotencyKey(stepName)` | Stable key for the step, for external idempotency |
| `signal` | An `AbortSignal` that fires if the worker loses the run or shuts down; pass it to long operations |
| `runId`, `workflow`, `attempt`, `log` | Run metadata and a logger |

Repeated step names (in a loop) get distinct keys (`send`, `send#2`, ...).

### `Worker`

`new Worker({ connectionString | pool, workflows, concurrency = 10, leaseMs = 30000, pollIntervalMs = 1000, scheduler = true })`

- `start()` applies migrations and begins claiming runs. `stop({ graceMs })` stops claiming, waits
  for in-flight runs, then aborts the rest and releases their leases so other workers take them
  immediately.
- Workers are woken by Postgres `NOTIFY`, so a new run starts within milliseconds; polling is the
  fallback.
- Emits `run:completed`, `run:failed`, `run:suspended` and `error`.
- With `scheduler: true` (the default) a worker takes part in cron scheduling; exactly one worker
  at a time (the holder of a Postgres advisory lock) fires schedules.

### `StrandClient`

`start`, `signal`, `cancel`, `retry`, `get`, `getDetail`, `list`, `waitForResult`,
`upsertSchedule`, `deleteSchedule`, `listSchedules`, `close`.

- `waitForResult` rejects with `RunFailedError`, `RunCancelledError` or `WaitTimeoutError`.
- `retry` re-queues a failed run; completed steps stay memoised, so it resumes at the step that failed.
- Schedules take a cron expression (5 fields, or 6 with seconds) and a time zone. A schedule that
  fell behind (all workers were down) fires once for the oldest missed slot and then resumes; it
  does not backfill.

## Migrations

Workers apply migrations when they start. To apply them separately:

```bash
DATABASE_URL=postgres://localhost/mydb npx strand-migrate
```
