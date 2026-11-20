import type { Run, RunEvent, SerializedError, Step, StepStatus } from "../api/types";

export type RowKind = "step" | "sleep" | "wait";

export interface TimelineRow {
  type: "row";
  key: string;
  kind: RowKind;
  status: StepStatus;
  /** Milliseconds after the run was created. */
  startMs: number;
  durationMs: number;
  /** Still in progress: the bar runs up to "now". */
  ongoing: boolean;
  attempts: number;
  error: SerializedError | null;
  output: unknown;
  /** For waits: the signal being waited for. */
  signal: string | null;
  retries: { atMs: number; attempt: number; message: string }[];
  /** 0 to 1, on a logarithmic scale across the run's rows. */
  width: number;
}

export interface TimelineRecovery {
  type: "recovery";
  atMs: number;
  previousOwner: string | null;
  nextOwner: string | null;
}

export interface Timeline {
  items: (TimelineRow | TimelineRecovery)[];
  /** Workers that claimed the run, in order. */
  owners: string[];
  totalMs: number;
}

const MIN_WIDTH = 0.06;

/** A bar's share of the track. Logarithmic, so 5 ms and 5 days can share one picture. */
function barWidth(durationMs: number, maxMs: number): number {
  if (maxMs <= 0) return MIN_WIDTH;
  return MIN_WIDTH + (1 - MIN_WIDTH) * (Math.log1p(durationMs) / Math.log1p(maxMs));
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Turn a run's steps and events into rows to draw: each step with its kind (a sleep and a signal
 * wait are steps too, told apart by the events that parked the run), its retries, and the points
 * where one worker lost the run and another took it over.
 */
export function buildTimeline(
  run: Pick<Run, "createdAt" | "completedAt">,
  steps: Step[],
  events: RunEvent[],
  now: number = Date.now(),
): Timeline {
  const t0 = Date.parse(run.createdAt);
  const end = run.completedAt ? Date.parse(run.completedAt) : now;
  const sinceStart = (iso: string) => Date.parse(iso) - t0;

  const kinds = new Map<string, { kind: RowKind; signal: string | null }>();
  const retries = new Map<string, TimelineRow["retries"]>();
  for (const event of events) {
    const key = str(event.data["stepKey"]);
    if (!key) continue;
    if (event.type === "run_sleeping") kinds.set(key, { kind: "sleep", signal: null });
    if (event.type === "run_waiting")
      kinds.set(key, { kind: "wait", signal: str(event.data["signal"]) });
    if (event.type === "step_retry_scheduled") {
      retries.set(key, [
        ...(retries.get(key) ?? []),
        {
          atMs: sinceStart(event.at),
          attempt: Number(event.data["attempts"] ?? 0),
          message: str(event.data["error"]) ?? "",
        },
      ]);
    }
  }

  const ordered = [...steps].sort(
    (a, b) => Date.parse(a.startedAt ?? "9999") - Date.parse(b.startedAt ?? "9999"),
  );
  const rows: TimelineRow[] = ordered.map((step) => {
    const startMs = step.startedAt ? sinceStart(step.startedAt) : 0;
    const ongoing = step.status === "retrying" && !step.completedAt;
    const stopMs = step.completedAt ? sinceStart(step.completedAt) : end - t0;
    const kind = kinds.get(step.stepKey);
    return {
      type: "row",
      key: step.stepKey,
      kind: kind?.kind ?? "step",
      status: step.status,
      startMs,
      durationMs: Math.max(0, stopMs - startMs),
      ongoing,
      attempts: step.attempts,
      error: step.error,
      output: step.output,
      signal: kind?.signal ?? null,
      retries: retries.get(step.stepKey) ?? [],
      width: 0,
    };
  });
  const maxMs = Math.max(0, ...rows.map((r) => r.durationMs));
  for (const row of rows) row.width = barWidth(row.durationMs, maxMs);

  // Claims are recorded in the same transaction as the lease expiry that caused them, so the
  // claim that follows a `lease_expired` event names the worker that took over.
  const owners: string[] = [];
  const recoveries: TimelineRecovery[] = [];
  const ordered_events = [...events].sort((a, b) => Number(a.id) - Number(b.id));
  ordered_events.forEach((event, index) => {
    if (event.type === "run_claimed") owners.push(str(event.data["owner"]) ?? "unknown");
    if (event.type === "lease_expired") {
      const claim = ordered_events.slice(index + 1).find((e) => e.type === "run_claimed");
      recoveries.push({
        type: "recovery",
        atMs: sinceStart(event.at),
        previousOwner: str(event.data["previousOwner"]),
        nextOwner: str(claim?.data["owner"]),
      });
    }
  });

  const items = [...rows, ...recoveries].sort((a, b) => {
    const at = (item: TimelineRow | TimelineRecovery) =>
      item.type === "row" ? item.startMs : item.atMs;
    return at(a) - at(b);
  });
  return { items, owners, totalMs: Math.max(0, end - t0) };
}
