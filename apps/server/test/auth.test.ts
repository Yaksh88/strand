import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dbAvailable, harness, type Harness } from "./helpers.js";

describe.skipIf(!dbAvailable)("authentication", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ apiToken: "s3cret-token" });
  });
  afterAll(async () => {
    await h.close();
  });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it("rejects /v1 requests without a valid bearer token", async () => {
    for (const headers of [{}, bearer("wrong"), { authorization: "s3cret-token" }, bearer("")]) {
      const response = await h.call("GET", "/v1/runs", undefined, headers);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: { code: "unauthorized", message: "Missing or invalid bearer token" },
      });
    }
  });

  it("accepts the right token on every kind of /v1 request", async () => {
    const headers = bearer("s3cret-token");
    expect((await h.call("GET", "/v1/runs", undefined, headers)).status).toBe(200);
    expect((await h.call("GET", "/v1/workers", undefined, headers)).status).toBe(200);
    const created = await h.call("POST", "/v1/runs", { workflow: "w" }, headers);
    expect(created.status).toBe(201);
    expect((await h.call("POST", "/v1/runs", { workflow: "w" })).status).toBe(401);
  });

  it("keeps health and metrics open for load balancers and scrapers", async () => {
    expect((await h.call("GET", "/healthz")).status).toBe(200);
    expect((await h.call("GET", "/metrics")).status).toBe(200);
  });

  it("answers CORS preflights without credentials", async () => {
    const response = await h.app.inject({
      method: "OPTIONS",
      url: "/v1/runs",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
    });
    expect(response.statusCode).toBeLessThan(300);
  });
});

describe.skipIf(!dbAvailable)("without a token configured", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("leaves the API open", async () => {
    expect((await h.call("GET", "/v1/runs")).status).toBe(200);
  });
});

describe.skipIf(!dbAvailable)("dashboard", () => {
  let h: Harness;
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "strand-dashboard-"));
    await writeFile(join(dir, "index.html"), "<title>Strand dashboard</title>");
    await writeFile(join(dir, "app.js"), "console.log('hi')");
    h = await harness({ dashboardDir: dir, apiToken: "t" });
  });
  afterAll(async () => {
    await h.close();
  });

  it("serves the app and its assets without authentication", async () => {
    const page = await h.call("GET", "/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Strand dashboard");
    expect((await h.call("GET", "/app.js")).status).toBe(200);
  });

  it("falls back to the app for client-side routes", async () => {
    const response = await h.call("GET", "/runs/6f1c0ad2");
    expect(response.status).toBe(200);
    expect(response.text).toContain("Strand dashboard");
  });

  it("keeps unknown API paths as JSON 404s, not the app", async () => {
    const response = await h.call("GET", "/v1/nothing", undefined, { authorization: "Bearer t" });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("not_found");
  });
});

describe.skipIf(!dbAvailable)("without a dashboard", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ dashboardDir: join(tmpdir(), "strand-no-such-dir") });
  });
  afterAll(async () => {
    await h.close();
  });

  it("returns a JSON 404 at the root", async () => {
    const response = await h.call("GET", "/");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("not_found");
  });
});
