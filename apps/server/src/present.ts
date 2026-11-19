import type { RunRecord, ScheduleRecord } from "@strand/sdk";

/** A wait with no deadline is stored as `infinity`; report that as null, not year 275760. */
const finite = (date: Date): string | null =>
  date.getUTCFullYear() > 9999 ? null : date.toISOString();

/** A run as the API returns it: no lease internals, and infinite timestamps made explicit. */
export function presentRun(run: RunRecord) {
  return {
    id: run.id,
    workflow: run.workflow,
    status: run.status,
    input: run.input,
    output: run.output,
    error: run.error,
    idempotencyKey: run.idempotencyKey,
    scheduleId: run.scheduleId,
    claimCount: run.claimCount,
    waitingSignal: run.waitingSignal,
    availableAt: finite(run.availableAt),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

/** The lighter shape used in lists: no input or output payloads. */
export function presentRunSummary(run: RunRecord) {
  const full = presentRun(run);
  return {
    id: full.id,
    workflow: full.workflow,
    status: full.status,
    error: full.error,
    idempotencyKey: full.idempotencyKey,
    scheduleId: full.scheduleId,
    claimCount: full.claimCount,
    waitingSignal: full.waitingSignal,
    availableAt: full.availableAt,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
    completedAt: full.completedAt,
    durationMs: run.completedAt ? run.completedAt.getTime() - run.createdAt.getTime() : null,
  };
}

export function presentSchedule(schedule: ScheduleRecord) {
  return {
    id: schedule.id,
    workflow: schedule.workflow,
    cron: schedule.cron,
    timezone: schedule.timezone,
    input: schedule.input,
    enabled: schedule.enabled,
    nextFireAt: schedule.nextFireAt.toISOString(),
    createdAt: schedule.createdAt.toISOString(),
  };
}
