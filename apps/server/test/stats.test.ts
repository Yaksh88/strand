import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dbAvailable, harness, pause, workflow, type Harness } from "./helpers.js";

describe.skipIf(!dbAvailable)("stats API", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
    await h.startWorker(
      [
        workflow("stats-ok", async (ctx) => {
          await ctx.step("work", () => pause(30));
          return "done";
        }),
        workflow({ name: "stats-bad", retry: { maxAttempts: 1 } }, async (ctx) =>
          ctx.step("boom", () => {
            throw new Error("nope");
          }),
        ),
        workflow("stats-wait", async (ctx) => ctx.waitForSignal("never")),
      ],
      "stats-worker",
    );
    const start = (wf: string) => h.call("POST", "/v1/runs", { workflow: wf });
    const ok = await Promise.all([start("stats-ok"), start("stats-ok"), start("stats-ok")]);
    const bad = await start("stats-bad");
    const waiting = await start("stats-wait");
    for (const run of ok) await h.waitForStatus(run.body.id, "completed");
    await h.waitForStatus(bad.body.id, "failed");
    await h.waitForStatus(waiting.body.id, "waiting");
  });
  afterAll(async () => {
    await h.close();
  });

  describe("GET /v1/stats", () => {
    it("reports totals for the window and current runs by status", async () => {
      const { status, body } = await h.call("GET", "/v1/stats?window=1h");
      expect(status).toBe(200);
      expect(body.window).toBe("1h");
      expect(body.totals).toMatchObject({
        started: 5,
        completed: 3,
        failed: 1,
        waiting: 1,
        running: 0,
        queued: 0,
      });
    });

    it.each([
      ["1h", 60_000],
      ["24h", 900_000],
      ["7d", 10_800_000],
    ])(
      "returns an evenly spaced, gap-free series for %s that accounts for every run",
      async (window, bucketMs) => {
        const { body } = await h.call("GET", `/v1/stats?window=${window}`);
        const times = body.series.map((p: { ts: string }) => Date.parse(p.ts));

        expect(times.length).toBeGreaterThan(1);
        for (let i = 1; i < times.length; i += 1) expect(times[i] - times[i - 1]).toBe(bucketMs);
        const sum = (key: string) =>
          body.series.reduce((n: number, p: Record<string, number>) => n + (p[key] ?? 0), 0);
        expect([sum("started"), sum("completed"), sum("failed")]).toEqual([5, 3, 1]);
      },
    );

    it("defaults to 24 hours and rejects other windows", async () => {
      expect((await h.call("GET", "/v1/stats")).body.window).toBe("24h");
      const bad = await h.call("GET", "/v1/stats?window=1y");
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("validation_error");
    });
  });

  describe("GET /v1/workflows", () => {
    it("summarises each workflow with counts and duration percentiles", async () => {
      const { status, body } = await h.call("GET", "/v1/workflows");
      expect(status).toBe(200);
      const byName = Object.fromEntries(body.map((w: { workflow: string }) => [w.workflow, w]));

      expect(byName["stats-ok"]).toMatchObject({ total: 3, completed: 3, failed: 0 });
      expect(byName["stats-ok"].p50Ms).toBeGreaterThanOrEqual(30);
      expect(byName["stats-ok"].p95Ms).toBeGreaterThanOrEqual(byName["stats-ok"].p50Ms);
      expect(byName["stats-bad"]).toMatchObject({ total: 1, failed: 1, completed: 0, p50Ms: null });
      expect(byName["stats-wait"]).toMatchObject({ total: 1, running: 0 });
      expect(body[0].workflow).toBe("stats-ok"); // busiest first
    });
  });

  describe("GET /v1/workers", () => {
    it("lists registered workers and whether they are alive", async () => {
      const { body } = await h.call("GET", "/v1/workers");
      const worker = body.find((w: { id: string }) => w.id === "stats-worker");

      expect(worker).toMatchObject({ alive: true, concurrency: 10 });
      expect(worker.workflows).toEqual(
        expect.arrayContaining(["stats-ok", "stats-bad", "stats-wait"]),
      );
      expect(worker.pid).toBe(process.pid);
      expect(Date.now() - Date.parse(worker.lastSeenAt)).toBeLessThan(10_000);
    });

    it("marks a worker that stopped heart-beating as not alive", async () => {
      await h.db.pool.query(
        "update strand_workers set last_seen_at = now() - interval '5 minutes'",
      );
      const { body } = await h.call("GET", "/v1/workers");
      expect(body.every((w: { alive: boolean }) => w.alive === false)).toBe(true);
    });
  });

  describe("operational endpoints", () => {
    it("reports health, and failure when the database is gone", async () => {
      expect((await h.call("GET", "/healthz")).body).toEqual({ status: "ok" });
    });

    it("exposes Prometheus metrics, including run counts by status", async () => {
      const response = await h.call("GET", "/metrics");
      expect(response.status).toBe(200);
      expect(String(response.headers["content-type"])).toMatch(/text\/plain/);
      expect(response.text).toContain('strand_runs{status="completed"} 3');
      expect(response.text).toContain('strand_runs{status="waiting"} 1');
      expect(response.text).toContain("strand_http_requests_total");
      expect(response.text).toContain("process_cpu_user_seconds_total");
    });
  });
});
