import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dbAvailable, harness, type Harness } from "./helpers.js";

describe.skipIf(!dbAvailable)("schedules API", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("creates, lists, replaces and deletes a schedule", async () => {
    const created = await h.call("POST", "/v1/schedules", {
      id: "nightly",
      workflow: "report",
      cron: "0 2 * * *",
      timezone: "Europe/Paris",
      input: { full: true },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: "nightly", enabled: true, timezone: "Europe/Paris" });
    expect(Date.parse(created.body.nextFireAt)).toBeGreaterThan(Date.now());

    const replaced = await h.call("POST", "/v1/schedules", {
      id: "nightly",
      workflow: "report",
      cron: "30 3 * * *",
      enabled: false,
    });
    expect(replaced.body).toMatchObject({ cron: "30 3 * * *", enabled: false, timezone: "UTC" });
    expect((await h.call("GET", "/v1/schedules")).body.map((s: { id: string }) => s.id)).toEqual([
      "nightly",
    ]);

    expect((await h.call("DELETE", "/v1/schedules/nightly")).status).toBe(204);
    const gone = await h.call("DELETE", "/v1/schedules/nightly");
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe("not_found");
  });

  it.each([
    [{ id: "bad", workflow: "w", cron: "not a cron" }, /cron/i],
    [{ id: "bad", workflow: "w", cron: "* * * * *", timezone: "Mars/Base" }, /time zone/i],
    [{ workflow: "w", cron: "* * * * *" }, /id/],
  ])("rejects %j with a validation error", async (body, message) => {
    const response = await h.call("POST", "/v1/schedules", body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
    expect(response.body.error.message).toMatch(message);
    expect((await h.call("GET", "/v1/schedules")).body).toEqual([]);
  });

  describe("preview", () => {
    it("returns the next fire times for an expression, in order", async () => {
      const { status, body } = await h.call(
        "GET",
        "/v1/schedules/preview?cron=*/15%20*%20*%20*%20*",
      );
      expect(status).toBe(200);
      expect(body.next).toHaveLength(5);
      const times = body.next.map(Date.parse);
      for (let i = 1; i < times.length; i += 1) expect(times[i] - times[i - 1]).toBe(15 * 60_000);
      expect(times[0]).toBeGreaterThan(Date.now());
    });

    it("honours the time zone and the requested count", async () => {
      const { body } = await h.call(
        "GET",
        "/v1/schedules/preview?cron=0%209%20*%20*%20*&timezone=America/New_York&count=2",
      );
      expect(body.next).toHaveLength(2);
      const hours = body.next.map((iso: string) => new Date(iso).getUTCHours());
      expect(hours.every((hour: number) => hour === 13 || hour === 14)).toBe(true); // 9am ET
    });

    it("rejects an invalid expression", async () => {
      const response = await h.call("GET", "/v1/schedules/preview?cron=nope");
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    });
  });
});
