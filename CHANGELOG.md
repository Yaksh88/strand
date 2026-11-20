# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-20

First release.

### Added

- Workflows as async functions with checkpointed steps: stored results are replayed instead of
  re-run, repeated step names get stable keys, and results are normalised through JSON so the first
  run and every replay agree.
- Retries with jittered exponential backoff, durable sleep, durable signals (buffered, ordered,
  with timeouts) and a recorded `ctx.now()`.
- Postgres-only coordination: runs are claimed with `FOR UPDATE SKIP LOCKED` under a lease, and
  every state change is fenced by a per-claim token checked under a row lock.
- Worker with lease heartbeats, `LISTEN/NOTIFY` wake-ups with polling as the fallback, graceful
  shutdown that releases in-flight runs, and abort of an execution that loses its lease.
- Cron schedules in a time zone, fired by one leader elected with a Postgres advisory lock; a
  schedule that fell behind fires once and does not backfill.
- `StrandClient` and a REST API: start (idempotently), list, inspect, signal, cancel and retry
  runs, manage schedules, and read stats, per-workflow summaries and worker liveness. Optional
  bearer token and Prometheus metrics.
- React dashboard with a run timeline that shows retries, sleeps, signal waits and worker handovers.
- Order-fulfillment example, a chaos test that kills and freezes worker processes and audits the
  database, and a throughput benchmark.
- Docker images, a Compose stack with a demo profile, and CI.

### Known limitations

- No child workflows, per-key concurrency limits or workflow versioning API.
- A workflow changed while runs are in flight is detected, not migrated.
