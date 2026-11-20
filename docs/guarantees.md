# Guarantees and failure modes

**Step execution is at-least-once. Step results are committed exactly once.** Everything below
follows from those two sentences. A step's function can run more than once; the result Strand
stores for it, and the value every later replay sees, comes from exactly one of those runs.

## What happens when something fails

| Failure                                                                             | What happens                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A step throws                                                                       | The failure is recorded and the run sleeps for a jittered backoff, then retries. After `maxAttempts` the step throws `StepFailedError` into your workflow code, which can catch it and compensate; if uncaught, the run fails |
| A worker is killed mid-step                                                         | Its lease expires and another worker resumes the run. Completed steps are not run again; the interrupted step runs again from the start                                                                                       |
| A worker crashes after a step's function succeeded but before the result was stored | The function runs again. This is the at-least-once case: use `ctx.idempotencyKey` so the repeat has no extra effect                                                                                                           |
| A worker stalls past its lease, then wakes up (a zombie)                            | Its next write is refused by the fencing check and its execution is aborted. The worker that took over is unaffected                                                                                                          |
| A worker shuts down gracefully                                                      | In-flight runs finish within the grace period; the rest are released and picked up at once                                                                                                                                    |
| Postgres restarts or the connection drops                                           | Worker operations fail and are retried on the next poll. A run whose worker can't reach the database leaves its lease to expire rather than failing the run. Committed state is as durable as your Postgres configuration     |
| Two workers claim at once                                                           | `FOR UPDATE SKIP LOCKED` gives each run to exactly one                                                                                                                                                                        |
| A signal arrives before the workflow waits for it                                   | It is buffered and consumed when the wait is reached                                                                                                                                                                          |
| A signal races the run parking itself                                               | Parking re-checks for pending signals under the run's row lock, so the wake-up cannot be lost                                                                                                                                 |
| Two schedulers briefly both think they lead                                         | A slot's idempotency key means it still starts only one run                                                                                                                                                                   |
| The workflow code changes while runs are in flight                                  | If a run completes without reaching steps recorded by an older version, it gets a `nondeterminism_detected` event. It is detected, not repaired                                                                               |

## What is not covered

- **Non-deterministic workflow code.** Strand replays your function. If code outside a step reads
  the clock, generates random numbers or calls a service, a replay can take a different path.
  Use `await ctx.now()` and put side effects in steps.
- **Side effects that aren't idempotent.** A step that charges a card with no idempotency key can
  charge twice after a crash at the wrong moment. Strand can't know what your function did.
- **Postgres durability.** If Postgres loses committed data (for example after a failover to an
  asynchronous replica that hadn't received it), Strand loses it too.
- **Large results.** Step results are stored as JSON in Postgres. Keep them small and store large
  data elsewhere.
- **Clock skew between workers.** Lease expiry uses the database clock, so skew doesn't affect
  crash recovery. But sleep wake-up times and retry times are computed from the worker's clock when
  they are first reached and then stored, so a worker whose clock is wrong schedules those late or
  early by that error.
- **Changing a workflow definition.** There is no versioning API yet: a deploy that reorders or
  renames steps affects runs that are mid-flight.

## How this is verified

- The store's concurrency rules are tested directly against Postgres: concurrent claims, expired
  and reclaimed leases, commits from a stale token, and signals racing parking. The race tests fail
  if the pending-signal check is removed.
- The [chaos test](../tests/chaos/README.md) runs real worker processes, kills and freezes them
  while runs are in flight, and audits the result. It fails if the fencing check is removed.
