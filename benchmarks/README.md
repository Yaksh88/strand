# Benchmarks

How fast can workers drain a backlog of runs? `throughput.ts` preloads 5,000 runs of three no-op
steps, starts N in-process workers (10 concurrent runs each), and times how long they take to
finish them all.

```bash
pnpm --filter @strand/benchmarks bench                      # defaults
pnpm --filter @strand/benchmarks bench -- --workers 2,4 --runs 20000 --steps 5
```

It needs a local Postgres (`DATABASE_URL`, default `postgres://localhost/strand_test`). Each
worker count runs in a fresh schema.

## Results

Apple M1, 8 cores, 8 GB RAM, macOS. Node 25, PostgreSQL 16 on the same machine as the workers.
5,000 runs of 3 no-op steps. This is one of three runs; the ranges below are across all three.

| Workers | Runs/s | Steps/s | Service p50 |   p95 |   p99 |
| ------: | -----: | ------: | ----------: | ----: | ----: |
|       1 |  1,921 |   5,762 |        3 ms |  5 ms |  6 ms |
|       2 |  2,429 |   7,288 |        5 ms |  7 ms | 20 ms |
|       4 |  2,705 |   8,116 |        9 ms | 15 ms | 35 ms |
|       8 |  2,303 |   6,909 |       18 ms | 54 ms | 97 ms |

Across three runs: 1 worker 1,660 to 1,921 runs/s; 2 workers 2,429 to 2,772; 4 workers 2,538 to
2,705; 8 workers 2,287 to 2,461.

## Reading the numbers

- **Throughput stops improving after two or three workers here.** The workers, their Postgres
  connections and Postgres itself all share one 8-core laptop, so the database is the
  bottleneck. Every step is a committed transaction, and more workers mostly add contention. On
  separate hardware the curve would look different; this measures one box, not a deployment.
- **Service time** is the time from a worker claiming a run to the run completing, taken from the
  run's own event timeline. It rises with worker count because more runs are in flight against the
  same database. Queue wait is deliberately excluded: with a preloaded backlog it only reflects how
  long the backlog is.
- **Steps are no-ops.** Real steps spend their time in the work they do, not in Strand, so these
  figures bound the engine's overhead (roughly a transaction per step) rather than predict
  application throughput.
- Single runs vary by 10 to 20 percent. Treat the figures as an order of magnitude.
