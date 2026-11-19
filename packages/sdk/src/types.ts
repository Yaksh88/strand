import type { SerializedError } from "./errors.js";

export type RunStatus =
  "queued" | "running" | "sleeping" | "waiting" | "completed" | "failed" | "cancelled";

export const TERMINAL_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"];

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  backoffCoefficient: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  backoffCoefficient: 2,
  maxDelayMs: 60_000,
};

export interface RunRecord {
  id: string;
  workflow: string;
  status: RunStatus;
  input: unknown;
  output: unknown;
  error: SerializedError | null;
  idempotencyKey: string | null;
  claimCount: number;
  leaseOwner: string | null;
  /** Fencing token (a Postgres bigint, so a string in JS). */
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  availableAt: Date;
  waitingSignal: string | null;
  scheduleId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export type StepStatus = "completed" | "failed" | "retrying";

export interface StepRecord {
  runId: string;
  stepKey: string;
  status: StepStatus;
  output: unknown;
  error: SerializedError | null;
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface SignalRecord {
  id: string;
  runId: string;
  name: string;
  payload: unknown;
  createdAt: Date;
  consumedBy: string | null;
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

export interface EventRecord {
  id: string;
  runId: string;
  type: EventType;
  data: Record<string, unknown>;
  at: Date;
}

/** Proof that a worker holds a run: the run id plus the fencing token issued when it claimed it. */
export interface Lease {
  runId: string;
  token: string;
  owner: string;
}

export interface ScheduleRecord {
  id: string;
  workflow: string;
  cron: string;
  timezone: string;
  input: unknown;
  enabled: boolean;
  nextFireAt: Date;
  createdAt: Date;
}
