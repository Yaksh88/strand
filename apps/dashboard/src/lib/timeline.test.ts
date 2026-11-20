import { describe, expect, it } from "vitest";

import type { RunEvent, Step } from "../api/types";
import { buildTimeline } from "./timeline";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const run = { createdAt: at(0), completedAt: at(10_000) };

const step = (
  key: string,
  startMs: number,
  endMs: number | null,
  extra: Partial<Step> = {},
): Step => ({
  runId: "r",
  stepKey: key,
  status: endMs === null ? "retrying" : "completed",
  output: null,
  error: null,
  attempts: 1,
  startedAt: at(startMs),
  completedAt: endMs === null ? null : at(endMs),
  ...extra,
});

let nextId = 1;
const event = (
  type: RunEvent["type"],
  ms: number,
  data: Record<string, unknown> = {},
): RunEvent => ({
  id: String(nextId++),
  runId: "r",
  type,
  data,
  at: at(ms),
});

describe("buildTimeline", () => {
  it("orders steps by when they started and measures their durations", () => {
    const { items } = buildTimeline(run, [step("b", 500, 900), step("a", 0, 400)], []);
    expect(items.map((i) => (i.type === "row" ? i.key : "?"))).toEqual(["a", "b"]);
    expect(items[0]).toMatchObject({ startMs: 0, durationMs: 400, ongoing: false });
  });

  it("tells sleeps and signal waits from ordinary steps by the events that parked the run", () => {
    const events = [
      event("run_sleeping", 100, { stepKey: "nap", wakeAt: at(5000) }),
      event("run_waiting", 6000, { stepKey: "review", signal: "fraud-review", deadline: null }),
    ];
    const { items } = buildTimeline(
      run,
      [step("charge", 0, 100), step("nap", 100, 5000), step("review", 6000, 9000)],
      events,
    );
    const kinds = Object.fromEntries(
      items.flatMap((i) => (i.type === "row" ? [[i.key, i.kind]] : [])),
    );
    expect(kinds).toEqual({ charge: "step", nap: "sleep", review: "wait" });
    expect(items.find((i) => i.type === "row" && i.key === "review")).toMatchObject({
      signal: "fraud-review",
    });
  });

  it("attaches each retry to the step that was retried", () => {
    const events = [
      event("step_retry_scheduled", 200, { stepKey: "pay", attempts: 1, error: "timeout" }),
      event("step_retry_scheduled", 700, { stepKey: "pay", attempts: 2, error: "503" }),
      event("step_retry_scheduled", 800, { stepKey: "other", attempts: 1, error: "x" }),
    ];
    const { items } = buildTimeline(
      run,
      [step("pay", 0, 1000, { attempts: 3 }), step("other", 0, 900)],
      events,
    );
    const pay = items.find((i) => i.type === "row" && i.key === "pay");
    expect(pay).toMatchObject({
      retries: [
        { atMs: 200, attempt: 1, message: "timeout" },
        { atMs: 700, attempt: 2, message: "503" },
      ],
    });
  });

  it("shows a crash handover: which worker lost the run and which took it over", () => {
    const events = [
      event("run_claimed", 0, { owner: "worker-a", attempt: 1 }),
      event("lease_expired", 3000, { previousOwner: "worker-a" }),
      event("run_claimed", 3000, { owner: "worker-b", attempt: 2 }),
    ];
    const timeline = buildTimeline(run, [step("one", 0, 1000), step("two", 3100, 4000)], events);

    expect(timeline.owners).toEqual(["worker-a", "worker-b"]);
    const recovery = timeline.items.find((i) => i.type === "recovery");
    expect(recovery).toEqual({
      type: "recovery",
      atMs: 3000,
      previousOwner: "worker-a",
      nextOwner: "worker-b",
    });
    // The handover sits between the steps on either side of it.
    expect(timeline.items.map((i) => i.type)).toEqual(["row", "recovery", "row"]);
  });

  it("draws an unfinished step up to the current time", () => {
    const { items } = buildTimeline(
      { createdAt: at(0), completedAt: null },
      [step("working", 1000, null)],
      [],
      T0 + 6000,
    );
    expect(items[0]).toMatchObject({ ongoing: true, durationMs: 5000 });
  });

  it("scales bar widths logarithmically so milliseconds and days fit together", () => {
    const day = 86_400_000;
    const { items } = buildTimeline(
      { createdAt: at(0), completedAt: at(2 * day) },
      [step("fast", 0, 5), step("medium", 10, 60_010), step("slow", 100_000, day + 100_000)],
      [],
    );
    const widths = items.map((i) => (i.type === "row" ? i.width : 0));
    expect(widths[0]).toBeLessThan(widths[1] ?? 0);
    expect(widths[1]).toBeLessThan(widths[2] ?? 0);
    expect(widths[2]).toBeCloseTo(1, 5);
    expect(widths[0]).toBeGreaterThan(0.05); // a 5 ms step is still visible next to a day
    expect(widths[1]).toBeGreaterThan(0.3); // a linear scale would make it invisible
  });

  it("handles a run with no steps yet", () => {
    expect(buildTimeline(run, [], [])).toEqual({ items: [], owners: [], totalMs: 10_000 });
  });
});
