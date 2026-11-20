import { pino } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { workflow, Worker, type AnyWorkflow, type WorkerOptions } from "../src/index.js";
import { dbAvailable, testDb, type TestDb } from "./helpers/db.js";

const logger = pino({ level: "silent" });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!dbAvailable)("Worker", () => {
  let db: TestDb;
  let counter = 0;
  const workers: Worker[] = [];

  beforeAll(async () => {
    db = await testDb();
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop({ graceMs: 200 })));
  });
  afterAll(async () => {
    await db.cleanup();
  });

  const name = () => `worker-wf-${++counter}`;

  function makeWorker(workflows: AnyWorkflow[], options: Partial<WorkerOptions> = {}): Worker {
    const worker = new Worker({
      pool: db.pool,
      workflows,
      pollIntervalMs: 25,
      leaseMs: 1000,
      logger,
      ...options,
    });
    workers.push(worker);
    return worker;
  }

  async function waitFor<T>(
    probe: () => Promise<T | undefined | false> | T | undefined | false,
    timeoutMs = 8000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) throw new Error("timed out waiting for condition");
      await pause(20);
    }
  }

  const start = (workflowName: string, input: unknown = null) =>
    db.store.createRun({ workflow: workflowName, input }).then((r) => r.run.id);
  const waitForStatus = (runId: string, status: string, timeoutMs = 8000) =>
    waitFor(async () => {
      const run = await db.store.getRun(runId);
      return run?.status === status ? run : undefined;
    }, timeoutMs);
  const eventTypes = async (runId: string) =>
    (await db.store.getRunDetail(runId))?.events.map((e) => e.type) ?? [];

  it("runs a multi-step workflow to completion and records its timeline", async () => {
    const wf = name();
    const def = workflow(wf, async (ctx, input: { n: number }) => {
      const a = await ctx.step("double", () => input.n * 2);
      const b = await ctx.step("add", () => a + 1);
      const c = await ctx.step("label", () => `result:${b}`);
      return { a, b, c };
    });
    await makeWorker([def]).start();

    const id = await start(wf, { n: 5 });
    const run = await waitForStatus(id, "completed");

    expect(run.output).toEqual({ a: 10, b: 11, c: "result:11" });
    expect((await eventTypes(id)).filter((t) => t === "step_completed")).toHaveLength(3);
    expect(await eventTypes(id)).toEqual(
      expect.arrayContaining(["run_created", "run_claimed", "run_completed"]),
    );
  });

  it("never runs more than `concurrency` runs at once", async () => {
    const wf = name();
    let active = 0;
    let peak = 0;
    const def = workflow(wf, async (ctx) => {
      active += 1;
      peak = Math.max(peak, active);
      await ctx.step("work", () => pause(80));
      active -= 1;
    });
    await makeWorker([def], { concurrency: 2 }).start();

    const ids = await Promise.all(Array.from({ length: 6 }, () => start(wf)));
    await Promise.all(ids.map((id) => waitForStatus(id, "completed")));
    expect(peak).toBe(2);
  });

  it("fails the run when workflow code throws, keeping the error", async () => {
    const wf = name();
    const def = workflow(wf, async () => {
      throw new TypeError("order has no items");
    });
    await makeWorker([def]).start();

    const run = await waitForStatus(await start(wf), "failed");
    expect(run.error).toMatchObject({ name: "TypeError", message: "order has no items" });
  });

  it("fails the run, rather than leaving it stuck, when its output can't be stored", async () => {
    const wf = name();
    const def = workflow(wf, async () => 10n);
    await makeWorker([def]).start();

    const run = await waitForStatus(await start(wf), "failed");
    expect(run.error?.message).toMatch(/BigInt/);
  });

  it("fails the run when a step runs out of attempts and the workflow doesn't catch it", async () => {
    const wf = name();
    const def = workflow(
      { name: wf, retry: { maxAttempts: 2, initialDelayMs: 10 } },
      async (ctx) => {
        await ctx.step("pay", () => {
          throw new Error("card declined");
        });
      },
    );
    await makeWorker([def]).start();

    const run = await waitForStatus(await start(wf), "failed");
    expect(run.error).toMatchObject({ name: "StepFailedError" });
    expect(run.error?.message).toContain("card declined");
  });

  it("retries a flaky step with backoff until it succeeds", async () => {
    const wf = name();
    let calls = 0;
    const def = workflow({ name: wf, retry: { maxAttempts: 5, initialDelayMs: 20 } }, async (ctx) =>
      ctx.step("flaky", () => {
        calls += 1;
        if (calls < 3) throw new Error(`failure ${calls}`);
        return "ok";
      }),
    );
    await makeWorker([def]).start();

    const id = await start(wf);
    const run = await waitForStatus(id, "completed");

    expect(run.output).toBe("ok");
    expect(calls).toBe(3);
    expect((await eventTypes(id)).filter((t) => t === "step_retry_scheduled")).toHaveLength(2);
    expect((await db.store.loadHistory(id)).steps[0]).toMatchObject({
      status: "completed",
      attempts: 3,
    });
  });

  it("sleeps without holding a worker, then resumes", async () => {
    const wf = name();
    let before = 0;
    const def = workflow(wf, async (ctx) => {
      await ctx.step("before", () => (before += 1));
      await ctx.sleep("nap", "300ms");
      return ctx.step("after", () => "awake");
    });
    await makeWorker([def]).start();

    const startedAt = Date.now();
    const id = await start(wf);
    await waitForStatus(id, "sleeping");
    const run = await waitForStatus(id, "completed");

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(290);
    expect(run.output).toBe("awake");
    expect(before).toBe(1); // the first half was not run again after the sleep
  });

  it("picks up a new run immediately when notified, without waiting for a poll", async () => {
    const wf = name();
    const def = workflow(wf, async () => "done");
    await makeWorker([def], { pollIntervalMs: 10_000 }).start();

    const startedAt = Date.now();
    await waitForStatus(await start(wf), "completed", 3000);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it("leaves runs of workflows it doesn't handle alone", async () => {
    const [mine, theirs] = [name(), name()];
    await makeWorker([workflow(mine, async () => "x")]).start();

    const other = await start(theirs);
    await pause(200);
    expect((await db.store.getRun(other))?.status).toBe("queued");
  });

  it("keeps a long-running step's lease alive with heartbeats", async () => {
    const wf = name();
    let executions = 0;
    const def = workflow(wf, async (ctx) =>
      ctx.step("long", async () => {
        executions += 1;
        await pause(1500); // well past the 500ms lease
        return "finished";
      }),
    );
    await makeWorker([def], { id: "holder", leaseMs: 500 }).start();
    await makeWorker([def], { id: "rival", leaseMs: 500 }).start(); // would steal an expired lease

    const run = await waitForStatus(await start(wf), "completed", 10_000);
    expect(run.output).toBe("finished");
    expect(executions).toBe(1);
  });

  describe("crashes and shutdown", () => {
    it("resumes a run on another worker after the first one dies, without repeating finished steps", async () => {
      const wf = name();
      let stepOneRuns = 0;
      let stepTwoRuns = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const def = workflow(wf, async (ctx) => {
        await ctx.step("one", () => (stepOneRuns += 1));
        return ctx.step("two", async () => {
          stepTwoRuns += 1;
          if (stepTwoRuns === 1) {
            await gate; // the first worker hangs here, then "dies"
            return "from the crashed worker";
          }
          return "from the rescuer";
        });
      });

      const crashing = makeWorker([def], { id: "crashing", leaseMs: 600 });
      await crashing.start();
      const id = await start(wf);
      await waitFor(() => stepTwoRuns === 1);
      await crashing.stop({ abandon: true }); // no release: only lease expiry can free the run

      await makeWorker([def], { id: "rescuer", leaseMs: 600 }).start();
      const run = await waitForStatus(id, "completed", 10_000);

      release(); // the zombie's step finally returns; it must not overwrite anything
      await pause(150);

      expect(run.output).toBe("from the rescuer");
      expect(stepOneRuns).toBe(1); // step one was memoised, not re-run
      const history = await db.store.loadHistory(id);
      expect(history.steps.map((s) => [s.stepKey, s.output])).toEqual(
        expect.arrayContaining([
          ["one", 1],
          ["two", "from the rescuer"],
        ]),
      );
      expect((await db.store.getRun(id))?.output).toBe("from the rescuer");
      expect(await eventTypes(id)).toContain("lease_expired");
    });

    it("releases in-flight runs on shutdown so another worker takes them straight away", async () => {
      const wf = name();
      let started = 0;
      const def = workflow(wf, async (ctx) =>
        ctx.step("slow", async () => {
          started += 1;
          await pause(800);
          return "done";
        }),
      );
      const leaving = makeWorker([def], { id: "leaving", leaseMs: 30_000 });
      await leaving.start();
      const id = await start(wf);
      await waitFor(() => started === 1);

      await leaving.stop({ graceMs: 50 });
      expect((await db.store.getRun(id))?.status).toBe("queued"); // released, not left to expire

      await makeWorker([def], { id: "arriving", leaseMs: 30_000 }).start();
      const run = await waitForStatus(id, "completed", 6000); // far sooner than the 30s lease
      expect(run.output).toBe("done");
    });

    it("waits for in-flight runs to finish when they fit within the grace period", async () => {
      const wf = name();
      let started = false;
      const def = workflow(wf, async (ctx) =>
        ctx.step("quick", async () => {
          started = true;
          await pause(200);
          return "done";
        }),
      );
      const worker = makeWorker([def]);
      await worker.start();
      const id = await start(wf);
      await waitFor(() => started);

      await worker.stop({ graceMs: 5000 });
      expect((await db.store.getRun(id))?.status).toBe("completed");
    });

    it("aborts a run that is cancelled mid-step and does not commit its result", async () => {
      const wf = name();
      let sawAbort = false;
      const def = workflow(wf, async (ctx) =>
        ctx.step("work", async () => {
          while (!ctx.signal.aborted) await pause(20); // runs until the worker notices
          sawAbort = true;
          return "late result";
        }),
      );
      await makeWorker([def], { leaseMs: 600 }).start();

      const id = await start(wf);
      await waitFor(async () => (await db.store.getRun(id))?.status === "running");
      await db.store.cancelRun(id);

      await waitFor(() => sawAbort, 5000); // the next heartbeat finds the lease gone
      await pause(100);
      expect((await db.store.getRun(id))?.status).toBe("cancelled");
      expect((await db.store.loadHistory(id)).steps).toEqual([]);
    });
  });

  it("flags a workflow that skips steps recorded by an earlier version", async () => {
    const wf = name();
    const v1 = workflow(wf, async (ctx) => {
      await ctx.step("a", () => 1);
      await ctx.step("b", () => 2);
      await ctx.sleep("nap", "300ms");
    });
    const first = makeWorker([v1]);
    await first.start();
    const id = await start(wf);
    await waitForStatus(id, "sleeping");
    await first.stop({ graceMs: 200 });

    const v2 = workflow(wf, async (ctx) => {
      await ctx.step("a", () => 1);
      return "done";
    });
    await makeWorker([v2]).start();
    const run = await waitForStatus(id, "completed");

    expect(run.output).toBe("done"); // still completes
    const detail = await db.store.getRunDetail(id);
    const flagged = detail?.events.find((e) => e.type === "nondeterminism_detected");
    expect(flagged?.data["unvisited"]).toEqual(["b", "nap"]);
  });

  it("reports a worker's registration and removes it when it stops cleanly", async () => {
    const worker = makeWorker([workflow(name(), async () => null)], { id: "registered" });
    await worker.start();
    const rows = await db.pool.query(
      "select id, concurrency, workflows from strand_workers where id = 'registered'",
    );
    expect(rows.rows).toHaveLength(1);

    await worker.stop();
    const after = await db.pool.query("select 1 from strand_workers where id = 'registered'");
    expect(after.rows).toHaveLength(0);
  });
});
