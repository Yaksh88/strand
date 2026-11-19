import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { StrandClient, workflow } from "../src/index.js";
import { dbAvailable, testDb, type TestDb } from "./helpers/db.js";
import { pause, waitForStatus, workerFactory } from "./helpers/harness.js";

describe.skipIf(!dbAvailable)("signals", () => {
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

  const name = () => `signal-wf-${++counter}`;

  it("parks the run until a signal arrives, then continues with its payload", async () => {
    const wf = name();
    const def = workflow(wf, async (ctx) => {
      const review = await ctx.waitForSignal<{ ok: boolean }>("fraud-review");
      return ctx.step("decide", () =>
        review.timedOut ? "timeout" : review.payload.ok ? "ship" : "refund",
      );
    });
    await workers.make([def]).start();

    const run = await client.start(wf, null);
    await waitForStatus(db.store, run.id, "waiting");
    await client.signal(run.id, "fraud-review", { ok: true });

    const done = await client.waitForResult(run.id);
    expect(done.output).toBe("ship");
  });

  it("consumes a signal that arrived before the workflow reached its wait", async () => {
    const wf = name();
    const def = workflow(wf, async (ctx) => {
      await ctx.step("slow-start", () => pause(200));
      return ctx.waitForSignal<string>("go");
    });
    await workers.make([def]).start();

    const run = await client.start(wf, null);
    await client.signal(run.id, "go", "early"); // the workflow is still in its first step

    const done = await client.waitForResult<{ payload: string }>(run.id);
    expect(done.output).toEqual({ timedOut: false, payload: "early" });
  });

  it("consumes a signal sent before any worker has even claimed the run", async () => {
    const wf = name();
    const def = workflow(wf, async (ctx) => ctx.waitForSignal<number>("n"));
    const run = await client.start(wf, null);
    await client.signal(run.id, "n", 42);

    await workers.make([def]).start();
    expect((await client.waitForResult(run.id)).output).toEqual({ timedOut: false, payload: 42 });
  });

  it("times out when no signal arrives in time", async () => {
    const wf = name();
    const def = workflow(wf, async (ctx) => ctx.waitForSignal("approval", { timeout: "200ms" }));
    await workers.make([def]).start();

    const startedAt = Date.now();
    const run = await client.start(wf, null);
    const done = await client.waitForResult(run.id);

    expect(done.output).toEqual({ timedOut: true });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
  });

  it("ignores signals with other names", async () => {
    const wf = name();
    const def = workflow(wf, async (ctx) => ctx.waitForSignal<string>("wanted"));
    await workers.make([def]).start();

    const run = await client.start(wf, null);
    await waitForStatus(db.store, run.id, "waiting");
    await client.signal(run.id, "unwanted", "x");
    await pause(150);
    expect((await client.get(run.id))?.status).toBe("waiting");

    await client.signal(run.id, "wanted", "y");
    expect((await client.waitForResult(run.id)).output).toEqual({ timedOut: false, payload: "y" });
  });

  it("gives two waits for the same name two signals in order and leaves the third", async () => {
    const wf = name();
    const def = workflow(wf, async (ctx) => {
      const first = await ctx.waitForSignal<number>("tick");
      const second = await ctx.waitForSignal<number>("tick");
      return [first, second];
    });
    await workers.make([def]).start();

    const run = await client.start(wf, null);
    for (const n of [1, 2, 3]) await client.signal(run.id, "tick", n);

    const done = await client.waitForResult(run.id);
    expect(done.output).toEqual([
      { timedOut: false, payload: 1 },
      { timedOut: false, payload: 2 },
    ]);
    expect((await db.store.findSignal(run.id, "tick"))?.payload).toBe(3);
  });

  it("survives the worker restarting while the run waits", async () => {
    const wf = name();
    let before = 0;
    const def = workflow(wf, async (ctx) => {
      await ctx.step("before", () => (before += 1));
      return ctx.waitForSignal<string>("resume");
    });
    const first = workers.make([def], { id: "first" });
    await first.start();
    const run = await client.start(wf, null);
    await waitForStatus(db.store, run.id, "waiting");
    await first.stop({ graceMs: 200 });

    await workers.make([def], { id: "second" }).start();
    await client.signal(run.id, "resume", "back");

    expect((await client.waitForResult(run.id)).output).toEqual({
      timedOut: false,
      payload: "back",
    });
    expect(before).toBe(1);
  });
});
