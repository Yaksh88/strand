create table strand_runs (
  id               uuid primary key,
  workflow         text not null,
  status           text not null
                   check (status in ('queued','running','sleeping','waiting','completed','failed','cancelled')),
  input            jsonb,
  output           jsonb,
  error            jsonb,
  idempotency_key  text unique,
  claim_count      int not null default 0,
  lease_owner      text,
  lease_token      bigint,
  lease_expires_at timestamptz,
  available_at     timestamptz not null default now(),
  waiting_signal   text,
  schedule_id      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz
);

-- Fencing tokens: each claim of a run gets a larger number than any before it.
create sequence strand_lease_seq;

create index strand_runs_claimable on strand_runs (available_at)
  where status in ('queued', 'sleeping', 'waiting');
create index strand_runs_expired_leases on strand_runs (lease_expires_at)
  where status = 'running';
create index strand_runs_workflow_created on strand_runs (workflow, created_at desc);
create index strand_runs_status_created on strand_runs (status, created_at desc);

create table strand_steps (
  run_id       uuid not null references strand_runs (id) on delete cascade,
  step_key     text not null,
  status       text not null check (status in ('completed', 'failed', 'retrying')),
  output       jsonb,
  error        jsonb,
  attempts     int not null default 0,
  started_at   timestamptz,
  completed_at timestamptz,
  primary key (run_id, step_key)
);

create table strand_signals (
  id          bigserial primary key,
  run_id      uuid not null references strand_runs (id) on delete cascade,
  name        text not null,
  payload     jsonb,
  created_at  timestamptz not null default now(),
  consumed_by text
);
create index strand_signals_run_name on strand_signals (run_id, name) where consumed_by is null;

create table strand_events (
  id      bigserial primary key,
  run_id  uuid not null references strand_runs (id) on delete cascade,
  type    text not null,
  data    jsonb not null default '{}',
  at      timestamptz not null default now()
);
create index strand_events_run on strand_events (run_id, id);

create table strand_workers (
  id           text primary key,
  hostname     text not null,
  pid          int not null,
  workflows    text[] not null,
  concurrency  int not null,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table strand_schedules (
  id           text primary key,
  workflow     text not null,
  cron         text not null,
  timezone     text not null default 'UTC',
  input        jsonb,
  enabled      boolean not null default true,
  next_fire_at timestamptz not null,
  created_at   timestamptz not null default now()
);
