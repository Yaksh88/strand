# Design decisions

The choices that shaped Strand, with what each costs.

## 1. Postgres is the only dependency

**Decision.** Work is queued, leased and recorded in Postgres. There is no broker and no separate
orchestration server.

**Why.** Most teams already run Postgres and trust it. Claiming a run, storing a step result and
recording an event can happen in one transaction, which is what makes the fencing guarantee simple
to state and to test. One system to back up, monitor and secure.

**Trade-off.** Throughput is bounded by Postgres write throughput (see the benchmarks), and
long-lived connections are needed for `LISTEN` and the scheduler lock. A dedicated queue would
scale further.

## 2. Replay with memoised steps, not event-sourced history

**Decision.** A workflow function is re-run from the top whenever it resumes, and `ctx.step`
returns stored results for finished steps.

**Why.** It is easy to explain and easy to debug: the history is a table of step results. Workflow
code looks like ordinary code.

**Trade-off.** Determinism is the user's job. A system that records and replays every non-deterministic
call (time, randomness) in an event history can enforce more; Strand only memoises what goes
through `ctx.step`, `ctx.now`, sleeps and signals, and flags a run that skipped recorded steps.

## 3. Fencing tokens, checked under a row lock

**Decision.** Each claim gets a larger token from a sequence, and every write checks it inside a
`SELECT ... FOR UPDATE`.

**Why.** Leases alone aren't safe: a worker that stalls past its lease still believes it owns the
run. The token plus the row lock turns "lost the lease" into "cannot write", which is what the
chaos test's frozen workers exercise.

**Trade-off.** Each fenced write takes a row lock and, outside the hot step-commit path, runs in a
small transaction. Step commits are a single statement to keep that cost down.

## 4. `FOR UPDATE SKIP LOCKED` for claiming

**Decision.** Workers claim due runs with `SKIP LOCKED` rather than a separate lock service or
advisory locks per run.

**Why.** It is the standard Postgres queue pattern: no coordination between workers, no run handed
out twice, and an expired lease is claimable by the same query.

**Trade-off.** Claiming is a polling query. Notifications make it prompt, but under heavy load the
claim query and its indexes matter.

## 5. LISTEN/NOTIFY as an optimisation, polling as the guarantee

**Decision.** Workers wake on notifications but also poll every second.

**Why.** Notifications are lost if a connection drops or a worker starts late. Treating them as a
hint means a missed one costs a poll interval, never a stuck run.

## 6. Step results are JSON, normalised on the first run

**Decision.** Results go through JSON before being returned to the workflow, the first time as well
as on replay; `undefined` becomes `null`, a `Date` an ISO string. Unserialisable results fail the
step.

**Why.** If the first execution returned a `Date` and a replay returned a string, workflows would
behave differently after a crash. Normalising makes the two indistinguishable.

**Trade-off.** Steps can't return class instances, `Map`s or `BigInt`s.

## 7. Infrastructure errors don't fail runs

**Decision.** A database or network error while executing a run leaves the lease to expire instead
of marking the run failed.

**Why.** A dropped connection says nothing about the workflow. Failing the run would turn a brief
outage into permanent failures; letting the lease expire turns it into a delayed retry.

## 8. Cron catches up once, doesn't backfill

**Decision.** A schedule that fell behind fires once for the oldest missed slot and then resumes.

**Why.** After downtime, hundreds of backfilled "every minute" runs are rarely what anyone wants.
Each slot's idempotency key still guarantees none starts twice.

## 9. The server is not a workflow runner

**Decision.** `apps/server` reads and writes runs but never executes workflow code.

**Why.** Workflow code lives in your application; the server only needs the database. It can be
scaled, secured and deployed independently of workers.
