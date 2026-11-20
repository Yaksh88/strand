import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createContext, Suspend, type ContextInit } from "../src/context.js";
import { LeaseLostError, StepFailedError } from "../src/errors.js";
import { DEFAULT_RETRY, type Lease, type RunRecord } from "../src/types.js";
import { dbAvailable, testDb, type TestDb } from "./helpers/db.js";

const logger = pino({ level: "silent" });
const T0 = new Date("2026-01-01T00:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe.skipIf(!dbAvailable)("workflow context", () => {
  let db: TestDb;
  let counter = 0;

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(async () => {
    await db.cleanup();
  });

  interface Claimed {
    run: RunRecord;
    lease: Lease;
    workflow: string;
  }

  async function startRun(owner = "w1"): Promise<Claimed> {
    const workflow = `ctx-${++counter}`;
    await db.store.createRun({ workflow, input: null });
    return claimAgain({ workflow } as Claimed, owner, false);
  }

  /** Claim the run again, e.g. after a sleep or crash. `makeDue` pulls it forward first. */
  async function claimAgain(
    from: { workflow: string },
    owner: string,
    makeDue = true,
  ): Promise<Claimed> {
    if (makeDue) {
      await db.pool.query(
        "update strand_runs set available_at = now() where workflow = $1 and status in ('sleeping', 'waiting')",
        [from.workflow],
      );
    }
    const [run] = await db.store.claimRuns({
      owner,
      workflows: [from.workflow],
      limit: 1,
      leaseMs: 30_000,
    });
    if (!run?.leaseToken) throw new Error("nothing to claim");
    return { run, workflow: from.workflow, lease: { runId: run.id, token: run.leaseToken, owner } };
  }

  /** A fresh execution of the workflow, as a worker would build after claiming the run. */
  async function contextFor(claimed: Claimed, overrides: Partial<ContextInit> = {}) {
    return createContext({
      run: claimed.run,
      lease: claimed.lease,
      history: await db.store.loadHistory(claimed.run.id),
      store: db.store,
      defaults: DEFAULT_RETRY,
      signal: new AbortController().signal,
      logger,
      clock: () => T0,
      random: () => 1,
      ...overrides,
    });
  }

  const steps = async (runId: string) => (await db.store.loadHistory(runId)).steps;
  const statusOf = async (runId: string) => (await db.store.getRun(runId))?.status;

  describe("step", () => {
    it("runs a step once and returns its stored result on every replay", async () => {
      const claimed = await startRun();
      const fn = vi.fn(async () => ({ id: "ch_1" }));

      const first = await (await contextFor(claimed)).step("charge", fn);
      const replay = await (await contextFor(claimed)).step("charge", fn);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(first).toEqual({ id: "ch_1" });
      expect(replay).toEqual(first);
    });

    it("memoises repeated step names by occurrence", async () => {
      const claimed = await startRun();
      const send = async (
        ctx: Awaited<ReturnType<typeof contextFor>>,
        fn: (n: number) => number,
      ) => {
        const results: number[] = [];
        for (const n of [1, 2, 3]) results.push(await ctx.step("send", () => fn(n)));
        return results;
      };

      expect(await send(await contextFor(claimed), (n) => n * 10)).toEqual([10, 20, 30]);
      expect((await steps(claimed.run.id)).map((s) => s.stepKey).sort()).toEqual([
        "send",
        "send#2",
        "send#3",
      ]);

      const never = () => {
        throw new Error("a memoised step must not run again");
      };
      expect(await send(await contextFor(claimed), never)).toEqual([10, 20, 30]);
    });

    it("returns the same value the first time and on replay for undefined and Dates", async () => {
      const claimed = await startRun();
      const when = new Date("2026-03-04T05:06:07.000Z");
      const ctx = await contextFor(claimed);
      const firstUndefined = await ctx.step("nothing", () => undefined);
      const firstDate = await ctx.step("when", () => when);

      const replay = await contextFor(claimed);
      expect(firstUndefined).toBeNull();
      expect(await replay.step("nothing", () => undefined)).toBeNull();
      expect(firstDate).toBe(when.toISOString());
      expect(await replay.step("when", () => when)).toBe(when.toISOString());
    });

    it("schedules a retry with backoff and suspends the run", async () => {
      const claimed = await startRun();
      const ctx = await contextFor(claimed);

      await expect(
        ctx.step("flaky", () => {
          throw new Error("boom");
        }),
      ).rejects.toBeInstanceOf(Suspend);

      const run = (await db.store.getRun(claimed.run.id))!;
      expect(run.status).toBe("sleeping");
      expect(run.availableAt.getTime()).toBe(T0.getTime() + 1000); // attempt 1, no jitter
      const [step] = await steps(claimed.run.id);
      expect(step).toMatchObject({ stepKey: "flaky", status: "retrying", attempts: 1 });
      expect(step?.error?.message).toBe("boom");
    });

    it("counts attempts across resumptions and throws StepFailedError once they run out", async () => {
      const claimed = await startRun();
      const policy = { retry: { maxAttempts: 2 } };
      const failing = () => {
        throw new Error("still broken");
      };

      await expect((await contextFor(claimed)).step("pay", failing, policy)).rejects.toBeInstanceOf(
        Suspend,
      );
      const resumed = await claimAgain(claimed, "w2");
      const error = await (await contextFor(resumed)).step("pay", failing, policy).catch((e) => e);

      expect(error).toBeInstanceOf(StepFailedError);
      expect(error.message).toContain("still broken");
      const [step] = await steps(claimed.run.id);
      expect(step).toMatchObject({ status: "failed", attempts: 2 });
      expect(await statusOf(claimed.run.id)).toBe("running"); // workflow code decides what happens next
    });

    it("lets workflow code catch a failed step and compensate", async () => {
      const claimed = await startRun();
      const workflow = async (ctx: Awaited<ReturnType<typeof contextFor>>) => {
        try {
          await ctx.step(
            "charge",
            () => {
              throw new Error("card declined");
            },
            { retry: { maxAttempts: 1 } },
          );
          return "charged";
        } catch (error) {
          expect(error).toBeInstanceOf(StepFailedError);
          return ctx.step("release-stock", () => "released");
        }
      };

      expect(await workflow(await contextFor(claimed))).toBe("released");
      // Replaying must reach the same branch without running the failed step again.
      expect(await workflow(await contextFor(claimed))).toBe("released");
      expect((await steps(claimed.run.id)).map((s) => [s.stepKey, s.status]).sort()).toEqual([
        ["charge", "failed"],
        ["release-stock", "completed"],
      ]);
    });

    it("rejects a step commit from a worker whose lease was reclaimed", async () => {
      const zombie = await startRun("zombie");
      let finish!: (value: string) => void;
      const stalled = new Promise<string>((resolve) => (finish = resolve));

      const pending = (await contextFor(zombie)).step("charge", () => stalled);
      // While the zombie is stalled its lease expires and another worker takes over.
      await db.pool.query(
        "update strand_runs set lease_expires_at = now() - interval '1 second' where id = $1",
        [zombie.run.id],
      );
      const rescuer = await claimAgain(zombie, "rescuer", false);
      finish("committed by the zombie");

      await expect(pending).rejects.toBeInstanceOf(LeaseLostError);
      expect(await steps(zombie.run.id)).toEqual([]);

      expect(
        await (await contextFor(rescuer)).step("charge", () => "committed by the rescuer"),
      ).toBe("committed by the rescuer");
    });

    it("fails the step with a clear error when its output is not JSON-serialisable", async () => {
      const claimed = await startRun();
      const ctx = await contextFor(claimed);

      const error = await ctx.step("big", () => 10n).catch((e) => e);
      expect(error).toBeInstanceOf(StepFailedError);
      expect(error.message).toMatch(/not JSON-serialisable/);
      expect((await steps(claimed.run.id))[0]).toMatchObject({ stepKey: "big", status: "failed" });
      expect(await statusOf(claimed.run.id)).toBe("running"); // the run is not corrupted

      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      await expect(ctx.step("loop", () => circular)).rejects.toBeInstanceOf(StepFailedError);
    });

    it("does not call the step or write anything once the lease is lost", async () => {
      const claimed = await startRun();
      const controller = new AbortController();
      const ctx = await contextFor(claimed, { signal: controller.signal });
      const fn = vi.fn(() => "ran");

      controller.abort();
      await expect(ctx.step("s", fn)).rejects.toBeInstanceOf(LeaseLostError);
      expect(fn).not.toHaveBeenCalled();
      expect(await steps(claimed.run.id)).toEqual([]);
    });

    it("treats an error thrown after the lease was lost as lease loss, not a step failure", async () => {
      const claimed = await startRun();
      const controller = new AbortController();
      const ctx = await contextFor(claimed, { signal: controller.signal });

      await expect(
        ctx.step("s", () => {
          controller.abort();
          throw new Error("connection reset");
        }),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect(await steps(claimed.run.id)).toEqual([]); // no retry scheduled, no failure recorded
    });
  });

  describe("idempotencyKey", () => {
    it("is stable across retries and distinguishes repeated step names", async () => {
      const claimed = await startRun();
      const seen: string[] = [];
      const flaky = (ctx: Awaited<ReturnType<typeof contextFor>>) => () => {
        seen.push(ctx.idempotencyKey("pay"));
        throw new Error("try again");
      };

      const first = await contextFor(claimed);
      expect(first.idempotencyKey("pay")).toBe(`${claimed.run.id}:pay`); // before the step: the next key
      await first.step("pay", flaky(first)).catch(() => {});

      const second = await contextFor(await claimAgain(claimed, "w2"));
      await second.step("pay", flaky(second)).catch(() => {});

      expect(seen).toEqual([`${claimed.run.id}:pay`, `${claimed.run.id}:pay`]);

      // After a suspend the run isn't held, so claim it again for the final check.
      const third = await contextFor(await claimAgain(claimed, "w3"));
      await third.step("other", () => 1);
      expect(third.idempotencyKey("other")).toBe(`${claimed.run.id}:other#2`); // the next occurrence
    });
  });

  describe("sleep", () => {
    it("suspends until the wake-up time, then continues", async () => {
      const claimed = await startRun();
      await expect((await contextFor(claimed)).sleep("nap", "1h")).rejects.toBeInstanceOf(Suspend);

      expect(await statusOf(claimed.run.id)).toBe("sleeping");
      const wakeAt = minutes(60);
      expect((await db.store.getRun(claimed.run.id))!.availableAt.getTime()).toBe(wakeAt.getTime());

      // Resumed too early (say, after a crash): it suspends again with the original wake-up time.
      const early = await claimAgain(claimed, "w2");
      await expect(
        (await contextFor(early, { clock: () => minutes(30) })).sleep("nap", "1h"),
      ).rejects.toBeInstanceOf(Suspend);
      expect((await db.store.getRun(claimed.run.id))!.availableAt.getTime()).toBe(wakeAt.getTime());

      const late = await claimAgain(claimed, "w3");
      await (await contextFor(late, { clock: () => minutes(61) })).sleep("nap", "1h");
      expect((await steps(claimed.run.id))[0]).toMatchObject({
        stepKey: "nap",
        status: "completed",
      });

      // Replays after the sleep don't suspend, whatever the clock says.
      await (await contextFor(late, { clock: () => T0 })).sleep("nap", "1h");
    });

    it("returns immediately for a zero-length sleep", async () => {
      const claimed = await startRun();
      await (await contextFor(claimed)).sleep("nothing", 0);
      expect(await statusOf(claimed.run.id)).toBe("running");
    });
  });

  describe("now", () => {
    it("returns the same time on every replay", async () => {
      const claimed = await startRun();
      const first = await (await contextFor(claimed, { clock: () => minutes(1) })).now();
      const replay = await (await contextFor(claimed, { clock: () => minutes(99) })).now();

      expect(first.toISOString()).toBe(minutes(1).toISOString());
      expect(replay.toISOString()).toBe(first.toISOString());
    });
  });

  describe("waitForSignal", () => {
    it("consumes a signal that arrived before the workflow reached the wait", async () => {
      const claimed = await startRun();
      await db.store.sendSignal(claimed.run.id, "approve", { by: "ana" });

      const result = await (await contextFor(claimed)).waitForSignal<{ by: string }>("approve");
      expect(result).toEqual({ timedOut: false, payload: { by: "ana" } });
      expect(await statusOf(claimed.run.id)).toBe("running"); // never had to park
    });

    it("parks the run, then returns the signal once it arrives", async () => {
      const claimed = await startRun();
      await expect((await contextFor(claimed)).waitForSignal("approve")).rejects.toBeInstanceOf(
        Suspend,
      );
      expect(await statusOf(claimed.run.id)).toBe("waiting");

      await db.store.sendSignal(claimed.run.id, "approve", "yes");
      const resumed = await claimAgain(claimed, "w2", false);
      expect(await (await contextFor(resumed)).waitForSignal("approve")).toEqual({
        timedOut: false,
        payload: "yes",
      });
    });

    it("times out when no signal arrives before the deadline", async () => {
      const claimed = await startRun();
      await expect(
        (await contextFor(claimed)).waitForSignal("approve", { timeout: "2d" }),
      ).rejects.toBeInstanceOf(Suspend);
      expect((await db.store.getRun(claimed.run.id))!.availableAt.getTime()).toBe(
        T0.getTime() + 2 * 86_400_000,
      );

      const afterDeadline = await claimAgain(claimed, "w2");
      const result = await (
        await contextFor(afterDeadline, { clock: () => new Date(T0.getTime() + 3 * 86_400_000) })
      ).waitForSignal("approve", { timeout: "2d" });
      expect(result).toEqual({ timedOut: true });
    });

    it("hands two waits for the same name two signals, in the order they were sent", async () => {
      const claimed = await startRun();
      await db.store.sendSignal(claimed.run.id, "tick", 1);
      await db.store.sendSignal(claimed.run.id, "tick", 2);
      await db.store.sendSignal(claimed.run.id, "tick", 3);

      const ctx = await contextFor(claimed);
      expect(await ctx.waitForSignal("tick")).toEqual({ timedOut: false, payload: 1 });
      expect(await ctx.waitForSignal("tick")).toEqual({ timedOut: false, payload: 2 });
      expect((await db.store.findSignal(claimed.run.id, "tick"))?.payload).toBe(3); // left over
    });
  });

  it("tracks which steps an execution reached", async () => {
    const claimed = await startRun();
    const ctx = await contextFor(claimed);
    await ctx.step("a", () => 1);
    await ctx.step("a", () => 2);
    await ctx.sleep("z", 0);
    expect([...ctx.visitedKeys()].sort()).toEqual(["a", "a#2", "z"]);
  });
});
