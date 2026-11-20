// Mirrors the Strand server's /v1 responses (apps/server/src).

export type RunStatus =
  "queued" | "running" | "sleeping" | "waiting" | "completed" | "failed" | "cancelled";

export type StepStatus = "completed" | "failed" | "retrying";

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export interface RunSummary {
  id: string;
  workflow: string;
  status: RunStatus;
  error: SerializedError | null;
  idempotencyKey: string | null;
  scheduleId: string | null;
  claimCount: number;
  waitingSignal: string | null;
  availableAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface Run extends Omit<RunSummary, "durationMs"> {
  input: unknown;
  output: unknown;
}

export interface Step {
  runId: string;
  stepKey: string;
  status: StepStatus;
  output: unknown;
  error: SerializedError | null;
  attempts: number;
  startedAt: string | null;
  completedAt: string | null;
}

export type EventType =
  | "run_created"
  | "run_claimed"
  | "lease_expired"
  | "step_completed"
  | "step_retry_scheduled"
  | "step_failed"
  | "run_sleeping"
  | "run_waiting"
  | "signal_received"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "run_retried"
  | "nondeterminism_detected";

export interface RunEvent {
  id: string;
  runId: string;
  type: EventType;
  data: Record<string, unknown>;
  at: string;
}

export interface RunDetail {
  run: Run;
  steps: Step[];
  events: RunEvent[];
}

export interface RunPage {
  items: RunSummary[];
  nextCursor: string | null;
}

export type Window = "1h" | "24h" | "7d";

export interface Stats {
  window: Window;
  totals: {
    started: number;
    completed: number;
    failed: number;
    queued: number;
    running: number;
    sleeping: number;
    waiting: number;
  };
  series: { ts: string; started: number; completed: number; failed: number }[];
}

export interface WorkflowSummary {
  workflow: string;
  total: number;
  running: number;
  failed: number;
  completed: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface Worker {
  id: string;
  hostname: string;
  pid: number;
  workflows: string[];
  concurrency: number;
  startedAt: string;
  lastSeenAt: string;
  alive: boolean;
}

export interface Schedule {
  id: string;
  workflow: string;
  cron: string;
  timezone: string;
  input: unknown;
  enabled: boolean;
  nextFireAt: string;
  createdAt: string;
}

export interface RunFilters {
  status?: RunStatus;
  workflow?: string;
}
