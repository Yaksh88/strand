# Chaos test

Workers get killed and frozen while runs are in flight, and then the database is audited. The
claim under test: **no run is lost, no step's result is committed twice, and a resumed run
always uses its stored step results.**

```bash
pnpm --filter @strand/chaos chaos                                # defaults: 500 runs, 4 workers
pnpm --filter @strand/chaos chaos --runs 1000 --workers 4 --kill-every 800 --duration 150
```

## What it does

1. Creates a fresh schema and starts N worker **processes** (2 s leases).
2. Starts R runs of a workflow with 5 steps. Each step sleeps 10 to 100 ms, records a side effect
   under its idempotency key in a `chaos_effects` table, and then fails 10% of the time (so
   failures happen _after_ the effect, and every retry repeats an effect that already happened).
   Each step returns a random number.
3. Every `--kill-every` ms, one worker suffers an incident, alternating between:
   - **`SIGKILL`**: the process dies mid-step. Its lease expires and another worker resumes the run.
   - **freeze** (`SIGSTOP` for 1.5 leases, then `SIGCONT`): a stalled "zombie" that wakes up
     holding steps it no longer owns. Fencing tokens are what stop it committing them.

   Dead workers are replaced immediately.

4. When every run is finished, it checks:
   - every run completed (none lost or failed);
   - every run has exactly 5 completed step rows;
   - there are exactly R x 5 effect rows, and every completed step has one;
   - every run's final output equals its stored step results, so no replay re-ran a finished step;
   - workers were killed, workers were frozen, and leases were taken over, so the test really
     did something.

It exits non-zero if any check fails.

## Result

1,000 runs, 4 workers, one incident every 800 ms, 2 s leases (Apple M1, local Postgres 16):

```
Result after 16.5s
  runs completed                      1000 / 1000
  runs with 5 completed steps         1000 / 1000
  effect rows (expected 5000)          5000
  final outputs matching stored steps 1000 / 1000
  workers killed (SIGKILL)            12
  workers frozen past their lease     8
  leases that expired and were taken over  151
  step retries (injected failures)    559
  steps whose effect ran more than once    564 (618 extra executions, absorbed by idempotency keys)

PASSED: no run lost, no step committed twice, every replay used stored results.
```

The 618 extra executions are the point: step functions **do** run more than once (a worker can die
after the effect and before the result is stored), which is why Strand's guarantee is at-least-once
execution with exactly-once result commit, and why side effects should use `ctx.idempotencyKey`.

## Does the test catch real bugs?

Yes. Removing the fencing check from the step-commit query (so a stale worker can write) makes this
test fail every time: with it removed, the same configuration ended with 1000 of 1000 runs
failing to complete. It can't be satisfied by luck either: it fails if nothing was killed, nothing
was frozen, or no lease was taken over.
