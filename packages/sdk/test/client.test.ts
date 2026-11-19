import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  InvalidCronError,
  InvalidStateError,
  RunCancelledError,
  RunFailedError,
  StrandClient,
  WaitTimeoutError,
  workflow,
} from "../src/index.js";
import { dbAvailable, testDb, type TestDb } from "./helpers/db.js";
import { pause, waitFor, waitForStatus, workerFactory } from "./helpers/harness.js";

describe.skipIf(!dbAvailable)("StrandClient", () => {
  let db: TestDb;
  let client: StrandClient;
  let workers: ReturnType<typeof workerFactory>;
  let counter = 0;

  beforeAll(async () => {
    db = await testDb();
    client = new StrandClient({ pool: db.pool });
    workers = workerFactory(db);
  });
  afterEach(async () => {
    await workers.stopAll();
  });
  afterAll(async () => {
    await db.cleanup();
  });

  const name = () => `client-wf-${++counter}`;

  it("starts a run from a definition or a name, idempotently", async () => {
    const wf = name();
    const def = workflow(wf, async (_ctx, input: { n: number }) => input.n);

    const first = await client.start(def, { n: 1 }, { idempotencyKey: `order:${wf}` });
    const again = await client.start(wf, { n: 2 }, { idempotencyKey: `order:${wf}` });

    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ workflow: wf, status: "queued", input: { n: 1 } });
  });

  it("queues runs for workflows nobody handles yet", async () => {
    const run = await client.start("not-registered-anywhere", { x: 1 });
    await pause(100);
    expect((await client.get(run.id))?.status).toBe("queued");
  });

  it("resolves waitForResult with the output and rejects with the failure", async () => {
    const okName = name();
    const badName = name();
    await workers
      .make([
        workflow(okName, async () => ({ answer: 42 })),
        workflow(badName, async () => {
          throw new RangeError("out of stock");
        }),
      ])
      .start();

    const ok = await client.start(okName, null);
    expect((await client.waitForResult<{ answer: number }>(ok.id)).output.answer).toBe(42);

    const bad = await client.start(badName, null);
    const error = await client.waitForResult(bad.id).catch((e) => e);
    expect(error).toBeInstanceOf(RunFailedError);
    expect(error.failure).toMatchObject({ name: "RangeError", message: "out of stock" });
  });

  it("times out when the run doesn't finish", async () => {
    const run = await client.start("nobody-home", null);
    await expect(
      client.waitForResult(run.id, { timeoutMs: 150, pollMs: 20 }),
    ).rejects.toBeInstanceOf(WaitTimeoutError);
  });

  it("rejects waitForResult for a cancelled run", async () => {
    const run = await client.start("cancel-me", null);
    await client.cancel(run.id);
    await expect(client.waitForResult(run.id)).rejects.toBeInstanceOf(RunCancelledError);
  });

  it("cancels a running run: its worker is told, and nothing it computed is committed", async () => {
    const wf = name();
    let aborted = false;
    const def = workflow(wf, async (ctx) =>
      ctx.step("work", async () => {
        while (!ctx.signal.aborted) await pause(20);
        aborted = true;
        return "too late";
      }),
    );
    await workers.make([def], { leaseMs: 600 }).start();

    const run = await client.start(wf, null);
    await waitForStatus(db.store, run.id, "running");
    await client.cancel(run.id);

    await waitFor(() => aborted, 5000);
    await pause(100);
    const detail = await client.getDetail(run.id);
    expect(detail?.run.status).toBe("cancelled");
    expect(detail?.steps).toEqual([]);
    await expect(client.cancel(run.id)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("retries a failed run from the step that failed, without repeating earlier steps", async () => {
    const wf = name();
    let firstRuns = 0;
    let fixed = false;
    const def = workflow({ name: wf, retry: { maxAttempts: 1 } }, async (ctx) => {
      await ctx.step("first", () => (firstRuns += 1));
      return ctx.step("second", () => {
        if (!fixed) throw new Error("dependency down");
        return "recovered";
      });
    });
    await workers.make([def]).start();

    const run = await client.start(wf, null);
    await waitForStatus(db.store, run.id, "failed");
    fixed = true;
    await client.retry(run.id);

    expect((await client.waitForResult(run.id)).output).toBe("recovered");
    expect(firstRuns).toBe(1);
    await expect(client.retry(run.id)).rejects.toBeInstanceOf(InvalidStateError); // no longer failed
  });

  it("lists runs with filters and returns full detail", async () => {
    const wf = name();
    await workers.make([workflow(wf, async (ctx) => ctx.step("only", () => 1))]).start();
    const run = await client.start(wf, null);
    await client.waitForResult(run.id);

    const page = await client.list({ workflow: wf, status: "completed", limit: 10 });
    expect(page.items.map((r) => r.id)).toEqual([run.id]);
    const detail = await client.getDetail(run.id);
    expect(detail?.steps.map((s) => s.stepKey)).toEqual(["only"]);
    expect(detail?.events.map((e) => e.type)).toContain("run_completed");
    expect(await client.get("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  describe("schedules", () => {
    it("creates, replaces, lists and deletes schedules", async () => {
      const created = await client.upsertSchedule({
        id: "nightly",
        workflow: "report",
        cron: "0 2 * * *",
        timezone: "Europe/Paris",
        input: { full: true },
      });
      expect(created).toMatchObject({ id: "nightly", timezone: "Europe/Paris", enabled: true });
      expect(created.nextFireAt.getTime()).toBeGreaterThan(Date.now());

      const replaced = await client.upsertSchedule({
        id: "nightly",
        workflow: "report",
        cron: "30 3 * * *",
        enabled: false,
      });
      expect(replaced).toMatchObject({ cron: "30 3 * * *", timezone: "UTC", enabled: false });
      expect((await client.listSchedules()).map((s) => s.id)).toContain("nightly");

      expect(await client.deleteSchedule("nightly")).toBe(true);
      expect(await client.deleteSchedule("nightly")).toBe(false);
    });

    it("rejects an invalid cron expression or time zone", async () => {
      await expect(
        client.upsertSchedule({ id: "bad", workflow: "w", cron: "not a cron" }),
      ).rejects.toBeInstanceOf(InvalidCronError);
      await expect(
        client.upsertSchedule({
          id: "bad",
          workflow: "w",
          cron: "* * * * *",
          timezone: "Mars/Base",
        }),
      ).rejects.toBeInstanceOf(InvalidCronError);
      expect((await client.listSchedules()).map((s) => s.id)).not.toContain("bad");
    });
  });
});
