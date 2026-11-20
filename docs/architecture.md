# Architecture

Strand has three moving parts: the **store** (every SQL statement, in `packages/sdk/src/store.ts`),
the **worker** (claims and executes runs), and the **client/server** (create and inspect runs).
Postgres is the only shared state; there is no broker.

## Data model

| Table              | Holds                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `strand_runs`      | One row per run: status, input, output, error, the current lease (owner, fencing token, expiry), and `available_at`, the time it is next due |
| `strand_steps`     | One row per step per run, keyed `(run_id, step_key)`: status, result or error, attempts                                                      |
| `strand_signals`   | Signals sent to runs, with the step that consumed each                                                                                       |
| `strand_events`    | An append-only timeline per run, which the dashboard draws                                                                                   |
| `strand_workers`   | Registered workers and their last heartbeat                                                                                                  |
| `strand_schedules` | Cron schedules and their next fire time                                                                                                      |

A run's status is one of `queued`, `running`, `sleeping` (due again at `available_at`), `waiting`
(for a signal, optionally until a deadline), `completed`, `failed` or `cancelled`.

## Claiming a run

Workers claim work with one statement:

```sql
select id from strand_runs
 where workflow = any($workflows)
   and ((status in ('queued','sleeping','waiting') and available_at <= now())
        or (status = 'running' and lease_expires_at < now()))
 order by available_at limit $n
   for update skip locked
```

`SKIP LOCKED` lets many workers claim concurrently without waiting on each other and without ever
receiving the same run. The claim also sets `lease_owner`, a new `lease_token` from a sequence (so
every claim's token is larger than any before it), and `lease_expires_at`. The second branch is
crash recovery: a run whose lease has expired is simply claimable again. Lease expiry is measured
by the database's clock, so worker clock skew does not matter for it.

## Replay

On claiming a run the worker loads its steps and calls the workflow function from the top.

- `ctx.step(name, fn)` looks up the step. **Completed**: return the stored result without calling
  `fn`. **Failed**: throw the stored error into the workflow code. Otherwise run `fn` and store the
  result.
- The n-th call with the same name gets the key `name`, then `name#2`, `name#3`, so a loop over
  items memoises each iteration separately.
- Results pass through JSON before being returned, even the first time, so the first execution and
  every replay see identical values.

When a step fails with attempts left, the engine records the failure, parks the run as `sleeping`
until the backoff time, releases the lease, and unwinds the function. `ctx.sleep` and
`ctx.waitForSignal` do the same, storing their wake-up time or deadline in the step row the first
time they are reached so a replay never recomputes it.

## Fencing

Every write a worker makes on behalf of a run is fenced: it first locks the run's row with
`SELECT ... FOR UPDATE` while checking that the worker's token is still the one stored and the run
is still `running`, and throws `LeaseLostError` if not. Step commits do this in a single statement
(a CTE that selects the run `FOR UPDATE` and inserts only from that result).

The row lock is what makes the check sound. If another worker reclaims the run first, the check
fails; if the fenced write goes first, the reclaim waits for it. A worker that stalled past its lease
(a long pause, a frozen VM) therefore cannot commit a result after losing the run. When a worker's
heartbeat finds a lease gone, it also aborts the in-flight execution through `ctx.signal`.

## Signals

`client.signal` stores the signal and, if the run is `waiting` for that name, makes it `queued`. It
locks the run's row first. When the workflow reaches `waitForSignal`, it looks for an unconsumed
signal; if there is none, parking the run re-checks inside the same fenced transaction and refuses
to park if one arrived in the meantime. Together these close the window where a signal could arrive
after the worker looked but before the run was marked `waiting`, which would otherwise sleep forever.
Signals sent before the wait is reached are buffered and consumed in order.

## Waking workers

Creating a run or a signal that wakes one issues `pg_notify`; workers `LISTEN` on a dedicated
connection and poll immediately when it fires. Polling every second is the fallback, so a missed
notification costs at most a poll interval. Sleeping runs wake by polling: a sleep is just
`available_at` in the future.

## Cron

Any worker may run the scheduler, but only the holder of a Postgres advisory lock (taken on a
dedicated connection, scoped to the schema) acts. If that connection dies the lock is released
and another worker takes over. A due schedule starts a run whose idempotency key is
`schedule:<id>:<slot>`, so a slot cannot start twice even if two schedulers briefly overlap. A
schedule that fell behind fires once for the oldest missed slot and then continues from the next
slot after now; missed slots are not backfilled.

## Shutdown

`worker.stop({ graceMs })` stops claiming and waits for in-flight runs. Those still running after
the grace period are aborted and their leases released (the run returns to `queued`), so another
worker picks them up immediately instead of waiting for the lease to expire.

## Server

The server (`apps/server`) never executes workflows. It validates requests with zod, calls the
store, and serves the dashboard. Metrics are read from the database at scrape time.
