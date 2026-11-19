import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  InvalidStateError,
  LeaseLostError,
  RunNotFoundError,
  type Lease,
  type RunRecord,
} from "../src/index.js";
import { toJson, WAKE_CHANNEL, type Store } from "../src/store.js";
import { dbAvailable, testDb, type TestDb } from "./helpers/db.js";

describe.skipIf(!dbAvailable)("Store", () => {
  let db: TestDb;
  let store: Store;
  let counter = 0;

  beforeAll(async () => {
    db = await testDb();
    store = db.store;
  });
  afterAll(async () => {
    await db.cleanup();
  });

  /** Each test uses its own workflow name so claims never see another test's runs. */
  const workflowName = () => `wf-${++counter}`;
  const newRun = async (workflow: string, input: unknown = { n: 1 }) =>
    (await store.createRun({ workflow, input })).run;

  interface Claimed {
    run: RunRecord;
    lease: Lease;
  }
  /** Claims a run: a brand new one unless `create` is false (then one that already exists). */
  async function claim(workflow: string, owner = "worker-1", create = true): Promise<Claimed> {
    if (create) await newRun(workflow);
    const [run] = await store.claimRuns({
      owner,
      workflows: [workflow],
      limit: 1,
      leaseMs: 30_000,
    });
    if (!run?.leaseToken) throw new Error("expected a claimable run");
    return { run, lease: { runId: run.id, token: run.leaseToken, owner } };
  }
  const expireLease = (runId: string) =>
    db.pool.query(
      "update strand_runs set lease_expires_at = now() - interval '1 second' where id = $1",
      [runId],
    );
  const statusOf = async (runId: string) => (await store.getRun(runId))?.status;
  const eventTypes = async (runId: string) =>
    (await store.getRunDetail(runId))?.events.map((e) => e.type) ?? [];
  const startedAt = () => new Date();

  describe("createRun", () => {
    it("returns the existing run when the idempotency key repeats", async () => {
      const wf = workflowName();
      const first = await store.createRun({ workflow: wf, input: 1, idempotencyKey: `k-${wf}` });
      const second = await store.createRun({ workflow: wf, input: 2, idempotencyKey: `k-${wf}` });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.run.id).toBe(first.run.id);
      expect(second.run.input).toBe(1); // the original input wins
    });

    it("creates a queued run, records an event and notifies workers", async () => {
      const wf = workflowName();
      const listener = await db.pool.connect();
      const seen: string[] = [];
      listener.on("notification", (n) => n.channel === WAKE_CHANNEL && seen.push(n.payload ?? ""));
      await listener.query(`listen ${WAKE_CHANNEL}`);

      try {
        const run = await newRun(wf, { orderId: "o_1", tags: ["a", "b"] });
        await expect.poll(() => seen).toContain(wf);

        expect(run.status).toBe("queued");
        expect(run.input).toEqual({ orderId: "o_1", tags: ["a", "b"] }); // arrays survive jsonb
        expect(await eventTypes(run.id)).toEqual(["run_created"]);
      } finally {
        await listener.query(`unlisten ${WAKE_CHANNEL}`);
        listener.release();
      }
    });

    it("keeps null and array inputs intact", async () => {
      const wf = workflowName();
      expect((await newRun(wf, null)).input).toBeNull();
      expect((await store.createRun({ workflow: wf, input: undefined })).run.input).toBeNull();
      expect((await newRun(wf, [1, [2, 3]])).input).toEqual([1, [2, 3]]);
    });
  });

  describe("claimRuns", () => {
    it("never hands the same run to two workers claiming at once", async () => {
      const wf = workflowName();
      const ids = new Set(
        (await Promise.all(Array.from({ length: 10 }, () => newRun(wf)))).map((r) => r.id),
      );

      const claim10 = (owner: string) =>
        store.claimRuns({ owner, workflows: [wf], limit: 10, leaseMs: 30_000 });
      const [a, b] = await Promise.all([claim10("a"), claim10("b")]);

      const claimedA = new Set(a.map((r) => r.id));
      const claimedB = new Set(b.map((r) => r.id));
      expect([...claimedA].filter((id) => claimedB.has(id))).toEqual([]);
      expect(new Set([...claimedA, ...claimedB])).toEqual(ids);
    });

    it("only claims workflows the worker handles", async () => {
      const [mine, other] = [workflowName(), workflowName()];
      await newRun(other);
      expect(
        await store.claimRuns({ owner: "w", workflows: [mine], limit: 5, leaseMs: 1000 }),
      ).toEqual([]);
      expect(await store.claimRuns({ owner: "w", workflows: [], limit: 5, leaseMs: 1000 })).toEqual(
        [],
      );
    });

    it("does not claim runs that aren't due yet", async () => {
      const wf = workflowName();
      const run = await newRun(wf);
      await db.pool.query(
        "update strand_runs set available_at = now() + interval '1 hour' where id = $1",
        [run.id],
      );
      expect(
        await store.claimRuns({ owner: "w", workflows: [wf], limit: 5, leaseMs: 1000 }),
      ).toEqual([]);
    });

    it("marks the run running, counts the claim and records an event", async () => {
      const wf = workflowName();
      const { run, lease } = await claim(wf);
      const created = await newRun(wf);
      expect(run.status).toBe("running");
      expect(run.claimCount).toBe(1);
      expect(run.leaseOwner).toBe(lease.owner);
      expect(run.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(await eventTypes(created.id)).toEqual(["run_created"]); // unclaimed one is untouched
    });

    it("reclaims a run whose lease expired, with a larger fencing token", async () => {
      const wf = workflowName();
      const first = await claim(wf, "crashed");
      await expireLease(first.run.id);

      const second = await claim(wf, "rescuer", false);
      expect(second.run.id).toBe(first.run.id);
      expect(BigInt(second.lease.token)).toBeGreaterThan(BigInt(first.lease.token));
      expect(second.run.claimCount).toBe(2);
      expect(await eventTypes(first.run.id)).toEqual(
        expect.arrayContaining(["run_claimed", "lease_expired"]),
      );
    });

    it("leaves a run with a live lease alone", async () => {
      const wf = workflowName();
      await claim(wf);
      expect(
        await store.claimRuns({ owner: "w2", workflows: [wf], limit: 5, leaseMs: 1000 }),
      ).toEqual([]);
    });
  });

  describe("fenced writes", () => {
    it("records a step result and returns it from history", async () => {
      const wf = workflowName();
      const { lease } = await claim(wf);
      await store.completeStep(lease, {
        stepKey: "charge",
        output: { id: "ch_1", amounts: [1, 2] },
        attempts: 1,
        startedAt: startedAt(),
      });
      await store.completeStep(lease, {
        stepKey: "nothing",
        output: undefined,
        attempts: 1,
        startedAt: startedAt(),
      });

      const { steps } = await store.loadHistory(lease.runId);
      const byKey = Object.fromEntries(steps.map((s) => [s.stepKey, s]));
      expect(byKey["charge"]).toMatchObject({
        status: "completed",
        output: { id: "ch_1", amounts: [1, 2] },
        attempts: 1,
      });
      expect(byKey["nothing"]?.output).toBeNull(); // undefined round-trips as null
      expect(await eventTypes(lease.runId)).toContain("step_completed");
    });

    it("rejects a step commit with a token that isn't current, and writes nothing", async () => {
      const wf = workflowName();
      const { lease } = await claim(wf);
      const forged = { ...lease, token: String(BigInt(lease.token) + 1000n) };

      await expect(
        store.completeStep(forged, {
          stepKey: "s",
          output: 1,
          attempts: 1,
          startedAt: startedAt(),
        }),
      ).rejects.toThrow(LeaseLostError);
      expect((await store.loadHistory(lease.runId)).steps).toEqual([]);
    });

    it("rejects a commit from a worker whose lease was reclaimed by another", async () => {
      const wf = workflowName();
      const zombie = await claim(wf, "zombie");
      await expireLease(zombie.run.id); // the zombie stalls past its lease...
      const rescuer = await claim(wf, "rescuer", false); // ...and the run moves to another worker

      await expect(
        store.completeStep(zombie.lease, {
          stepKey: "s",
          output: "from the zombie",
          attempts: 1,
          startedAt: startedAt(),
        }),
      ).rejects.toThrow(LeaseLostError);
      await store.completeStep(rescuer.lease, {
        stepKey: "s",
        output: "from the rescuer",
        attempts: 1,
        startedAt: startedAt(),
      });

      const { steps } = await store.loadHistory(zombie.run.id);
      expect(steps.map((s) => s.output)).toEqual(["from the rescuer"]);
      await expect(store.completeRun(zombie.lease, "late")).rejects.toThrow(LeaseLostError);
      await expect(store.failRun(zombie.lease, { name: "E", message: "m" })).rejects.toThrow(
        LeaseLostError,
      );
    });

    it("commits one result per step even when two commits race", async () => {
      const wf = workflowName();
      const { lease } = await claim(wf);
      const commit = (output: string) =>
        store.completeStep(lease, { stepKey: "s", output, attempts: 1, startedAt: startedAt() });
      await Promise.all([commit("a"), commit("b")]);

      const { steps } = await store.loadHistory(lease.runId);
      expect(steps).toHaveLength(1); // primary key (run_id, step_key)
    });

    it("schedules a retry: records the failed attempt and puts the run to sleep", async () => {
      const wf = workflowName();
      const { lease } = await claim(wf);
      const retryAt = new Date(Date.now() + 60_000);
      await store.scheduleStepRetry(lease, {
        stepKey: "flaky",
        error: { name: "Error", message: "boom" },
        attempts: 1,
        retryAt,
      });

      const run = (await store.getRun(lease.runId))!;
      expect(run.status).toBe("sleeping");
      expect(run.leaseToken).toBeNull();
      expect(Math.abs(run.availableAt.getTime() - retryAt.getTime())).toBeLessThan(5);
      const { steps } = await store.loadHistory(lease.runId);
      expect(steps[0]).toMatchObject({ stepKey: "flaky", status: "retrying", attempts: 1 });
      expect(steps[0]?.error?.message).toBe("boom");
      // Asleep until retryAt, so nothing can claim it now.
      expect(
        await store.claimRuns({ owner: "w", workflows: [wf], limit: 5, leaseMs: 1000 }),
      ).toEqual([]);
      // The old token can no longer write.
      await expect(store.completeRun(lease, null)).rejects.toThrow(LeaseLostError);
    });

    it("records an exhausted step as failed without ending the run", async () => {
      const wf = workflowName();
      const { lease } = await claim(wf);
      await store.failStep(lease, {
        stepKey: "s",
        error: { name: "Error", message: "nope" },
        attempts: 3,
      });

      expect((await store.loadHistory(lease.runId)).steps[0]).toMatchObject({
        status: "failed",
        attempts: 3,
      });
      expect(await statusOf(lease.runId)).toBe("running");
    });

    it("completes and fails runs, clearing the lease", async () => {
      const wf = workflowName();
      const done = await claim(wf);
      await store.completeRun(done.lease, { ok: true });
      const completed = (await store.getRun(done.lease.runId))!;
      expect(completed).toMatchObject({
        status: "completed",
        output: { ok: true },
        leaseToken: null,
      });
      expect(completed.completedAt).not.toBeNull();
      const failing = await claim(wf, "w3");
      await store.failRun(failing.lease, { name: "TypeError", message: "bad input" });
      expect((await store.getRun(failing.lease.runId))!).toMatchObject({
        status: "failed",
        error: { name: "TypeError", message: "bad input" },
      });
    });

    it("releases a run so another worker can claim it straight away", async () => {
      const wf = workflowName();
      const { lease } = await claim(wf, "leaving");
      await store.releaseRun(lease);

      expect(await statusOf(lease.runId)).toBe("queued");
      const next = await claim(wf, "arriving", false);
      expect(next.run.id).toBe(lease.runId);
    });
  });

  describe("heartbeat", () => {
    it("extends held leases and reports only the ones still held", async () => {
      const wf = workflowName();
      const held = await claim(wf, "a");
      const lost = await claim(wf, "a");
      await expireLease(lost.run.id);
      await claim(wf, "someone-else", false); // takes over `lost`

      const before = (await store.getRun(held.run.id))!.leaseExpiresAt!;
      const still = await store.heartbeat({ leases: [held.lease, lost.lease], leaseMs: 120_000 });

      expect(still).toEqual(new Set([held.run.id]));
      expect((await store.getRun(held.run.id))!.leaseExpiresAt!.getTime()).toBeGreaterThan(
        before.getTime(),
      );
      expect(await store.heartbeat({ leases: [], leaseMs: 1000 })).toEqual(new Set());
    });
  });

  describe("signals", () => {
    async function waitingRun(signal: string) {
      const wf = workflowName();
      const claimed = await claim(wf);
      const parked = await store.suspendWaiting(claimed.lease, {
        stepKey: "wait",
        signal,
        deadline: null,
        firstTime: true,
      });
      expect(parked).toBe(true);
      return claimed.run.id;
    }

    it("wakes a run waiting for that signal", async () => {
      const id = await waitingRun("approve");
      expect(await statusOf(id)).toBe("waiting");

      await store.sendSignal(id, "approve", { ok: true });
      const run = (await store.getRun(id))!;
      expect(run.status).toBe("queued");
      expect(run.waitingSignal).toBeNull();
      expect(await store.findSignal(id, "approve")).toMatchObject({ payload: { ok: true } });
    });

    it("leaves a run waiting for a different signal asleep", async () => {
      const id = await waitingRun("approve");
      await store.sendSignal(id, "something-else", null);
      expect(await statusOf(id)).toBe("waiting");
    });

    it("buffers a signal sent before the workflow reaches its wait", async () => {
      const wf = workflowName();
      const run = await newRun(wf);
      await store.sendSignal(run.id, "early", { n: 1 });

      const { lease } = await claim(wf, "worker-1", false);
      expect(await store.findSignal(lease.runId, "early")).toMatchObject({ payload: { n: 1 } });
      // Parking now would sleep through it, so the store refuses.
      expect(
        await store.suspendWaiting(lease, {
          stepKey: "w",
          signal: "early",
          deadline: null,
          firstTime: true,
        }),
      ).toBe(false);
      expect(await statusOf(lease.runId)).toBe("running");
    });

    it("hands out signals oldest first and consumes each once", async () => {
      const wf = workflowName();
      const { lease } = await claim(wf);
      await store.sendSignal(lease.runId, "s", "first");
      await store.sendSignal(lease.runId, "s", "second");

      const first = (await store.findSignal(lease.runId, "s"))!;
      expect(first.payload).toBe("first");
      await store.consumeSignal(lease, {
        stepKey: "wait",
        signalId: first.id,
        output: { timedOut: false, payload: first.payload },
      });

      expect((await store.findSignal(lease.runId, "s"))!.payload).toBe("second");
      expect((await store.loadHistory(lease.runId)).steps[0]).toMatchObject({
        stepKey: "wait",
        status: "completed",
        output: { timedOut: false, payload: "first" },
      });
      await expect(
        store.consumeSignal(lease, { stepKey: "again", signalId: first.id, output: null }),
      ).rejects.toThrow(LeaseLostError);
    });

    it("never loses a wake-up when a signal races the run parking itself", async () => {
      // The dangerous interleaving: the signal arrives after the worker last looked for it but
      // before the run is marked waiting. Run it many times; each outcome must be safe.
      const outcomes = await Promise.all(
        Array.from({ length: 40 }, async () => {
          const wf = workflowName();
          const { lease } = await claim(wf);
          const [parked] = await Promise.all([
            store.suspendWaiting(lease, {
              stepKey: "w",
              signal: "go",
              deadline: null,
              firstTime: true,
            }),
            store.sendSignal(lease.runId, "go", null),
          ]);
          return {
            parked,
            status: await statusOf(lease.runId),
            pending: await store.findSignal(lease.runId, "go"),
          };
        }),
      );

      for (const { parked, status, pending } of outcomes) {
        if (parked)
          expect(status).toBe("queued"); // it parked, and the signal woke it
        else expect(pending).not.toBeNull(); // it refused to park because the signal was there
      }
    });

    it("rejects signals to unknown and finished runs", async () => {
      await expect(
        store.sendSignal("00000000-0000-4000-8000-000000000000", "x", null),
      ).rejects.toThrow(RunNotFoundError);
      const wf = workflowName();
      const { lease } = await claim(wf);
      await store.completeRun(lease, null);
      await expect(store.sendSignal(lease.runId, "x", null)).rejects.toThrow(InvalidStateError);
    });

    it("parks a run with no deadline indefinitely and one with a deadline until then", async () => {
      const wf = workflowName();
      const open = await claim(wf);
      await store.suspendWaiting(open.lease, {
        stepKey: "w",
        signal: "s",
        deadline: null,
        firstTime: true,
      });
      expect((await store.getRun(open.run.id))!.availableAt.getFullYear()).toBeGreaterThan(9999);

      const timed = await claim(wf);
      const deadline = new Date(Date.now() + 5_000);
      await store.suspendWaiting(timed.lease, {
        stepKey: "w",
        signal: "s",
        deadline,
        firstTime: true,
      });
      expect(
        Math.abs((await store.getRun(timed.run.id))!.availableAt.getTime() - deadline.getTime()),
      ).toBeLessThan(5);
    });
  });

  describe("durable sleep", () => {
    it("stores the wake time once and sleeps until then", async () => {
      const wf = workflowName();
      const { lease } = await claim(wf);
      const wakeAt = new Date(Date.now() + 3_600_000);
      await store.suspendSleeping(lease, { stepKey: "nap", wakeAt, firstTime: true });

      expect(await statusOf(lease.runId)).toBe("sleeping");
      const step = (await store.loadHistory(lease.runId)).steps[0]!;
      expect(step.output).toEqual({ wakeAt: wakeAt.toISOString() });
      expect(await eventTypes(lease.runId)).toContain("run_sleeping");
    });

    it("does not overwrite the stored wake time on a later suspend", async () => {
      const wf = workflowName();
      const first = await claim(wf);
      const original = new Date(Date.now() + 1_000);
      await store.suspendSleeping(first.lease, {
        stepKey: "nap",
        wakeAt: original,
        firstTime: true,
      });
      await db.pool.query("update strand_runs set available_at = now() where id = $1", [
        first.run.id,
      ]);

      const second = await claim(wf, "w2", false);
      await store.suspendSleeping(second.lease, {
        stepKey: "nap",
        wakeAt: new Date(Date.now() + 9_999_000),
        firstTime: false,
      });
      expect((await store.loadHistory(first.run.id)).steps[0]!.output).toEqual({
        wakeAt: original.toISOString(),
      });
    });
  });

  describe("operator actions", () => {
    it("cancels a running run, after which its worker can no longer write", async () => {
      const wf = workflowName();
      const { lease } = await claim(wf);
      const cancelled = await store.cancelRun(lease.runId);

      expect(cancelled.status).toBe("cancelled");
      await expect(store.completeRun(lease, "late")).rejects.toThrow(LeaseLostError);
      expect(await store.heartbeat({ leases: [lease], leaseMs: 1000 })).toEqual(new Set());
      expect(await eventTypes(lease.runId)).toContain("run_cancelled");
    });

    it("refuses to cancel finished or unknown runs", async () => {
      const wf = workflowName();
      const { lease } = await claim(wf);
      await store.completeRun(lease, null);
      await expect(store.cancelRun(lease.runId)).rejects.toThrow(InvalidStateError);
      await expect(store.cancelRun("00000000-0000-4000-8000-000000000000")).rejects.toThrow(
        RunNotFoundError,
      );
    });

    it("retries a failed run from where it failed, keeping completed steps", async () => {
      const wf = workflowName();
      const { lease } = await claim(wf);
      await store.completeStep(lease, {
        stepKey: "good",
        output: "kept",
        attempts: 1,
        startedAt: startedAt(),
      });
      await store.failStep(lease, {
        stepKey: "bad",
        error: { name: "E", message: "x" },
        attempts: 3,
      });
      await store.failRun(lease, { name: "E", message: "x" });

      const retried = await store.retryRun(lease.runId);
      expect(retried).toMatchObject({ status: "queued", error: null, completedAt: null });
      const { steps } = await store.loadHistory(lease.runId);
      expect(steps.map((s) => [s.stepKey, s.status])).toEqual([["good", "completed"]]);
      expect(await eventTypes(lease.runId)).toContain("run_retried");
      expect((await claim(wf, "w2", false)).run.id).toBe(lease.runId);
    });

    it("only retries failed runs", async () => {
      const wf = workflowName();
      const run = await newRun(wf);
      await expect(store.retryRun(run.id)).rejects.toThrow(InvalidStateError);
      await expect(store.retryRun("00000000-0000-4000-8000-000000000000")).rejects.toThrow(
        RunNotFoundError,
      );
    });
  });

  describe("reading", () => {
    it("pages through runs newest first without repeats or gaps", async () => {
      const wf = workflowName();
      const ids = (await Promise.all(Array.from({ length: 25 }, () => newRun(wf)))).map(
        (r) => r.id,
      );

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await store.listRuns({ workflow: wf, limit: 7, before: cursor });
        seen.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor);

      expect(pages).toBe(4);
      expect(new Set(seen).size).toBe(25);
      expect(new Set(seen)).toEqual(new Set(ids));
      const times = (await Promise.all(seen.map((id) => store.getRun(id)))).map((r) =>
        r!.createdAt.getTime(),
      );
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it("filters by status and workflow", async () => {
      const [a, b] = [workflowName(), workflowName()];
      await newRun(b);
      const { lease } = await claim(a);
      await store.completeRun(lease, null);

      expect(
        (await store.listRuns({ workflow: a, status: "completed", limit: 10 })).items,
      ).toHaveLength(1);
      expect(
        (await store.listRuns({ workflow: a, status: "queued", limit: 10 })).items,
      ).toHaveLength(0);
      expect((await store.listRuns({ workflow: b, limit: 10 })).items).toHaveLength(1);
    });

    it("returns a run's steps and events, and null for an unknown run", async () => {
      const wf = workflowName();
      const { lease } = await claim(wf);
      await store.completeStep(lease, {
        stepKey: "s",
        output: 1,
        attempts: 1,
        startedAt: startedAt(),
      });

      const detail = (await store.getRunDetail(lease.runId))!;
      expect(detail.run.id).toBe(lease.runId);
      expect(detail.steps.map((s) => s.stepKey)).toEqual(["s"]);
      expect(detail.events.map((e) => e.type)).toEqual([
        "run_created",
        "run_claimed",
        "step_completed",
      ]);
      expect(await store.getRunDetail("00000000-0000-4000-8000-000000000000")).toBeNull();
      expect(await store.getRun("00000000-0000-4000-8000-000000000000")).toBeNull();
    });
  });

  describe("toJson", () => {
    it("maps undefined and functions to null, and refuses what JSON can't hold", () => {
      expect(toJson(undefined)).toBe("null");
      expect(toJson(() => 1)).toBe("null");
      expect(toJson({ a: [1] })).toBe('{"a":[1]}');
      expect(() => toJson(10n)).toThrow(TypeError);
    });
  });
});
