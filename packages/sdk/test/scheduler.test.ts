import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InvalidCronError,
  nextFireAfter,
  Scheduler,
  StrandClient,
  workflow,
} from "../src/index.js";
import type { Store } from "../src/store.js";
import { dbAvailable, testDb, type TestDb } from "./helpers/db.js";
import { logger, pause, waitFor, workerFactory } from "./helpers/harness.js";

const at = (iso: string) => new Date(iso);

describe("nextFireAfter", () => {
  it("returns the next matching minute, strictly after the given time", () => {
    expect(nextFireAfter("*/5 * * * *", "UTC", at("2026-01-01T12:03:00Z"))).toEqual(
      at("2026-01-01T12:05:00Z"),
    );
    expect(nextFireAfter("*/5 * * * *", "UTC", at("2026-01-01T12:05:00Z"))).toEqual(
      at("2026-01-01T12:10:00Z"),
    );
  });

  it("evaluates the expression in the schedule's time zone, including daylight saving", () => {
    expect(nextFireAfter("0 9 * * *", "America/New_York", at("2026-01-01T12:00:00Z"))).toEqual(
      at("2026-01-01T14:00:00Z"), // EST, UTC-5
    );
    expect(nextFireAfter("0 9 * * *", "America/New_York", at("2026-07-01T12:00:00Z"))).toEqual(
      at("2026-07-01T13:00:00Z"), // EDT, UTC-4
    );
  });

  it("rejects bad expressions and unknown zones with InvalidCronError", () => {
    expect(() => nextFireAfter("every day", "UTC", new Date())).toThrow(InvalidCronError);
    expect(() => nextFireAfter("61 * * * *", "UTC", new Date())).toThrow(InvalidCronError);
    expect(() => nextFireAfter("* * * * *", "Nowhere/Land", new Date())).toThrow(InvalidCronError);
  });
});

describe.skipIf(!dbAvailable)("scheduling", () => {
  let db: TestDb;
  let store: Store;
  let clockNow: Date;
  const schedulers: Scheduler[] = [];

  // A fresh schema per test: schedules are global, and leadership is per schema.
  beforeEach(async () => {
    db = await testDb();
    store = db.store;
    clockNow = at("2026-01-01T12:00:00Z");
  });
  afterEach(async () => {
    await Promise.all(schedulers.splice(0).map((s) => s.stop()));
    await db.cleanup();
  });

  function makeScheduler(options: { electionMs?: number } = {}): Scheduler {
    const scheduler = new Scheduler({
      pool: db.pool,
      store,
      logger,
      tickMs: 60_000, // tests drive ticks by hand
      clock: () => clockNow,
      ...options,
    });
    schedulers.push(scheduler);
    return scheduler;
  }

  const addSchedule = (id: string, nextFireAt: string, extra: { enabled?: boolean } = {}) =>
    store.upsertSchedule({
      id,
      workflow: `wf-${id}`,
      cron: "*/5 * * * *",
      timezone: "UTC",
      input: { from: id },
      enabled: extra.enabled ?? true,
      nextFireAt: at(nextFireAt),
    });
  const runsFor = (workflowName: string) =>
    db.pool.query<{ idempotency_key: string; schedule_id: string; input: unknown }>(
      "select idempotency_key, schedule_id, input from strand_runs where workflow = $1",
      [workflowName],
    );

  it("fires a due schedule once and moves it to the next slot", async () => {
    await addSchedule("a", "2026-01-01T12:05:00Z");
    const scheduler = makeScheduler();
    clockNow = at("2026-01-01T12:04:00Z");
    await scheduler.start();
    expect((await runsFor("wf-a")).rowCount).toBe(0); // not due yet

    clockNow = at("2026-01-01T12:05:01Z");
    await scheduler.tick();
    await scheduler.tick(); // a second pass must not fire the same slot again

    const { rows } = await runsFor("wf-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      schedule_id: "a",
      idempotency_key: "schedule:a:2026-01-01T12:05:00.000Z",
      input: { from: "a" },
    });
    expect((await store.listSchedules())[0]?.nextFireAt).toEqual(at("2026-01-01T12:10:00Z"));
  });

  it("does not start two runs for one slot when callers race", async () => {
    await addSchedule("race", "2026-01-01T12:05:00Z");
    const next = (_s: unknown, after: Date) => nextFireAfter("*/5 * * * *", "UTC", after);

    const counts = await Promise.all(
      Array.from({ length: 6 }, () => store.fireDueSchedules(at("2026-01-01T12:05:01Z"), next)),
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await runsFor("wf-race")).rowCount).toBe(1);
  });

  it("fires once after downtime instead of backfilling every missed slot", async () => {
    await addSchedule("late", "2026-01-01T12:05:00Z");
    const scheduler = makeScheduler();
    clockNow = at("2026-01-01T12:21:00Z"); // slots 12:05, :10, :15 and :20 were all missed
    await scheduler.start();

    const { rows } = await runsFor("wf-late");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotency_key).toBe("schedule:late:2026-01-01T12:05:00.000Z");
    expect((await store.listSchedules())[0]?.nextFireAt).toEqual(at("2026-01-01T12:25:00Z"));
  });

  it("skips disabled schedules", async () => {
    await addSchedule("off", "2026-01-01T12:05:00Z", { enabled: false });
    clockNow = at("2026-01-01T13:00:00Z");
    await makeScheduler().start();
    expect((await runsFor("wf-off")).rowCount).toBe(0);
  });

  it("elects exactly one leader, and another takes over when it stops", async () => {
    const first = makeScheduler({ electionMs: 30 });
    const second = makeScheduler({ electionMs: 30 });
    await first.start();
    await second.start();
    expect([first.isLeader, second.isLeader]).toEqual([true, false]);

    await first.stop();
    expect(first.isLeader).toBe(false);
    await pause(60);
    await second.tick();
    expect(second.isLeader).toBe(true);
  });

  it("only the leader fires schedules", async () => {
    await addSchedule("lead", "2026-01-01T12:05:00Z");
    const leader = makeScheduler();
    const follower = makeScheduler();
    await leader.start(); // clock is 12:00, nothing due
    await follower.start();

    clockNow = at("2026-01-01T12:06:00Z");
    await follower.tick();
    expect((await runsFor("wf-lead")).rowCount).toBe(0); // the follower does nothing
    await leader.tick();
    expect((await runsFor("wf-lead")).rowCount).toBe(1);
  });

  it("runs scheduled workflows end to end through a worker's built-in scheduler", async () => {
    const client = new StrandClient({ pool: db.pool });
    const factory = workerFactory(db);
    const ticks: string[] = [];
    const def = workflow("heartbeat-report", async (_ctx, input: { label: string }) => {
      ticks.push(input.label);
    });

    try {
      await factory.make([def], { scheduler: true }).start();
      await client.upsertSchedule({
        id: "every-second",
        workflow: "heartbeat-report",
        cron: "* * * * * *",
        input: { label: "tick" },
      });

      await waitFor(() => ticks.length >= 2, 8000);
      const { items } = await client.list({ workflow: "heartbeat-report", limit: 10 });
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(items.every((r) => r.scheduleId === "every-second")).toBe(true);
    } finally {
      await factory.stopAll();
    }
  });
});
