import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dbAvailable, harness, workflow, type Harness } from "./helpers.js";

describe.skipIf(!dbAvailable)("runs API", () => {
  let h: Harness;
  let counter = 0;
  const name = () => `api-wf-${++counter}`;

  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  describe("POST /v1/runs", () => {
    it("creates a queued run, and returns the same run for a repeated idempotency key", async () => {
      const wf = name();
      const first = await h.call("POST", "/v1/runs", {
        workflow: wf,
        input: { orderId: "o_1" },
        idempotencyKey: `k-${wf}`,
      });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        workflow: wf,
        status: "queued",
        input: { orderId: "o_1" },
      });

      const again = await h.call("POST", "/v1/runs", {
        workflow: wf,
        input: { orderId: "different" },
        idempotencyKey: `k-${wf}`,
      });
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect(again.body.input).toEqual({ orderId: "o_1" });
    });

    it("doesn't leak lease internals", async () => {
      const { body } = await h.call("POST", "/v1/runs", { workflow: name() });
      expect(Object.keys(body)).not.toEqual(expect.arrayContaining(["leaseToken"]));
      expect(body).not.toHaveProperty("leaseOwner");
      expect(body).not.toHaveProperty("leaseExpiresAt");
    });

    it.each([
      [{}, /workflow/],
      [{ workflow: "" }, /workflow/],
      [{ workflow: "x", idempotencyKey: "" }, /idempotencyKey/],
      [{ workflow: 5 }, /workflow/],
    ])("rejects an invalid body %j", async (body, message) => {
      const response = await h.call("POST", "/v1/runs", body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
      expect(response.body.error.message).toMatch(message);
    });
  });

  describe("GET /v1/runs", () => {
    it("pages through runs newest first with a cursor, and filters", async () => {
      const wf = name();
      const other = name();
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        ids.push((await h.call("POST", "/v1/runs", { workflow: wf, input: { i } })).body.id);
      }
      await h.call("POST", "/v1/runs", { workflow: other });

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `/v1/runs?workflow=${wf}&limit=2${cursor ? `&before=${cursor}` : ""}`;
        const page: { body: { items: { id: string }[]; nextCursor: string | null } } = await h.call(
          "GET",
          query,
        );
        seen.push(...page.body.items.map((r) => r.id));
        cursor = page.body.nextCursor;
        pages += 1;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].reverse());

      const queued = await h.call("GET", `/v1/runs?workflow=${wf}&status=queued`);
      expect(queued.body.items).toHaveLength(5);
      const failed = await h.call("GET", `/v1/runs?workflow=${wf}&status=failed`);
      expect(failed.body.items).toEqual([]);
    });

    it("returns summaries without payloads", async () => {
      const wf = name();
      await h.call("POST", "/v1/runs", { workflow: wf, input: { big: "payload" } });
      const { body } = await h.call("GET", `/v1/runs?workflow=${wf}`);
      expect(body.items[0]).not.toHaveProperty("input");
      expect(body.items[0]).not.toHaveProperty("output");
      expect(body.items[0]).toHaveProperty("durationMs", null);
    });

    it.each(["status=bogus", "limit=0", "limit=500", "limit=abc"])("rejects %s", async (query) => {
      const response = await h.call("GET", `/v1/runs?${query}`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    });
  });

  describe("GET /v1/runs/:id", () => {
    it("returns the run with its steps and event timeline", async () => {
      const wf = name();
      await h.startWorker([
        workflow(wf, async (ctx) => {
          const a = await ctx.step("first", () => 1);
          return ctx.step("second", () => a + 1);
        }),
      ]);
      const { body: created } = await h.call("POST", "/v1/runs", { workflow: wf });
      const run = await h.waitForStatus(created.id, "completed");

      const { status, body } = await h.call("GET", `/v1/runs/${created.id}`);
      expect(status).toBe(200);
      expect(run.output).toBe(2);
      expect(
        body.steps.map((s: { stepKey: string; output: unknown }) => [s.stepKey, s.output]),
      ).toEqual([
        ["first", 1],
        ["second", 2],
      ]);
      expect(body.events.map((e: { type: string }) => e.type)).toEqual([
        "run_created",
        "run_claimed",
        "step_completed",
        "step_completed",
        "run_completed",
      ]);
    });

    it("returns 404 for an unknown run and 400 for a malformed id", async () => {
      const missing = await h.call("GET", "/v1/runs/00000000-0000-4000-8000-000000000000");
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: { code: "not_found", message: "Run not found" } });
      expect((await h.call("GET", "/v1/runs/not-a-uuid")).status).toBe(400);
    });

    it("reports a wait with no deadline as a null availableAt rather than year 275760", async () => {
      const wf = name();
      await h.startWorker([workflow(wf, async (ctx) => ctx.waitForSignal("never"))]);
      const { body: created } = await h.call("POST", "/v1/runs", { workflow: wf });
      const run = await h.waitForStatus(created.id, "waiting");
      expect(run.availableAt).toBeNull();
      expect(run.waitingSignal).toBe("never");
    });
  });

  describe("signals", () => {
    it("accepts a signal, wakes the run and passes the payload through", async () => {
      const wf = name();
      await h.startWorker([
        workflow(wf, async (ctx) => ctx.waitForSignal<{ ok: boolean }>("review")),
      ]);
      const { body: created } = await h.call("POST", "/v1/runs", { workflow: wf });
      await h.waitForStatus(created.id, "waiting");

      const response = await h.call("POST", `/v1/runs/${created.id}/signals/review`, {
        payload: { ok: true },
      });
      expect(response.status).toBe(202);

      const run = await h.waitForStatus(created.id, "completed");
      expect(run.output).toEqual({ timedOut: false, payload: { ok: true } });
    });

    it("accepts a signal without a body", async () => {
      const wf = name();
      const { body: created } = await h.call("POST", "/v1/runs", { workflow: wf });
      expect((await h.call("POST", `/v1/runs/${created.id}/signals/ping`)).status).toBe(202);
    });

    it("tolerates a JSON content type with an empty body, as fetch sends for body-less POSTs", async () => {
      const { body: created } = await h.call("POST", "/v1/runs", { workflow: name() });
      const headers = { "content-type": "application/json" };
      const signal = await h.app.inject({
        method: "POST",
        url: `/v1/runs/${created.id}/signals/x`,
        headers,
      });
      expect(signal.statusCode).toBe(202);
      const cancel = await h.app.inject({
        method: "POST",
        url: `/v1/runs/${created.id}/cancel`,
        headers,
      });
      expect(cancel.statusCode).toBe(200);
    });

    it("still rejects malformed JSON", async () => {
      const response = await h.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { "content-type": "application/json" },
        payload: "{not json",
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("bad_request");
    });

    it("404s for an unknown run and 409s for a finished one", async () => {
      const missing = await h.call(
        "POST",
        "/v1/runs/00000000-0000-4000-8000-000000000000/signals/x",
        {},
      );
      expect(missing.status).toBe(404);

      const { body: created } = await h.call("POST", "/v1/runs", { workflow: name() });
      await h.call("POST", `/v1/runs/${created.id}/cancel`);
      const finished = await h.call("POST", `/v1/runs/${created.id}/signals/x`, {});
      expect(finished.status).toBe(409);
      expect(finished.body.error.code).toBe("invalid_state");
    });
  });

  describe("cancel and retry", () => {
    it("cancels a run once, then reports a conflict", async () => {
      const { body: created } = await h.call("POST", "/v1/runs", { workflow: name() });
      const cancelled = await h.call("POST", `/v1/runs/${created.id}/cancel`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.status).toBe("cancelled");

      const again = await h.call("POST", `/v1/runs/${created.id}/cancel`);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("invalid_state");
      expect(
        (await h.call("POST", "/v1/runs/00000000-0000-4000-8000-000000000000/cancel")).status,
      ).toBe(404);
    });

    it("409s when retrying a run that hasn't failed", async () => {
      const { body: created } = await h.call("POST", "/v1/runs", { workflow: name() });
      expect((await h.call("POST", `/v1/runs/${created.id}/retry`)).status).toBe(409);
    });

    it("retries a failed run, which then completes without repeating finished steps", async () => {
      const wf = name();
      let firstRuns = 0;
      let healthy = false;
      await h.startWorker([
        workflow({ name: wf, retry: { maxAttempts: 1 } }, async (ctx) => {
          await ctx.step("first", () => (firstRuns += 1));
          return ctx.step("second", () => {
            if (!healthy) throw new Error("downstream is down");
            return "ok";
          });
        }),
      ]);
      const { body: created } = await h.call("POST", "/v1/runs", { workflow: wf });
      const failed = await h.waitForStatus(created.id, "failed");
      expect(failed.error.message).toContain("downstream is down");

      healthy = true;
      const retried = await h.call("POST", `/v1/runs/${created.id}/retry`);
      expect(retried.status).toBe(200);
      expect((await h.waitForStatus(created.id, "completed")).output).toBe("ok");
      expect(firstRuns).toBe(1);
    });
  });

  it("answers unknown API paths with a JSON 404", async () => {
    const response = await h.call("GET", "/v1/nothing-here");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("not_found");
  });
});
