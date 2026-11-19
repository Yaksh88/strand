import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  InvalidCronError,
  InvalidStateError,
  RunNotFoundError,
  Store,
  StrandClient,
} from "@strand/sdk";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { hasZodFastifySchemaValidationErrors, validatorCompiler } from "fastify-type-provider-zod";
import type pg from "pg";

import { createMetrics } from "./metrics.js";
import { runRoutes } from "./routes/runs.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { statsRoutes } from "./routes/stats.js";

export interface AppOptions {
  pool: pg.Pool;
  /** When set, every /v1 request needs `Authorization: Bearer <token>`. */
  apiToken?: string | undefined;
  /** A built dashboard to serve at the root. */
  dashboardDir?: string | undefined;
  logger?: FastifyServerOptions["logger"];
}

const digest = (value: string) => createHash("sha256").update(value).digest();

function error(code: string, message: string) {
  return { error: { code, message } };
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  app.setValidatorCompiler(validatorCompiler);

  // POST endpoints like cancel and retry take no body, yet clients such as fetch send a JSON
  // content type anyway. Accept an empty body as "no body" instead of failing the request.
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    if (typeof body === "string" && body.trim() === "") return done(null, undefined);
    parseJson(request, body as string, done);
  });

  const store = new Store(options.pool);
  const client = new StrandClient({ pool: options.pool });
  const metrics = createMetrics(store);

  await app.register(cors, { origin: true });

  // Authentication covers the API only; health, metrics and the dashboard's static files are open.
  const expected = options.apiToken ? digest(options.apiToken) : null;
  app.addHook("onRequest", async (request, reply) => {
    if (!expected || request.method === "OPTIONS" || !request.url.startsWith("/v1/")) return;
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!timingSafeEqual(digest(token), expected)) {
      return reply.code(401).send(error("unauthorized", "Missing or invalid bearer token"));
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    metrics.requests.inc({
      route: request.routeOptions.url ?? "unmatched",
      status: String(reply.statusCode),
    });
  });

  app.get("/healthz", async (_request, reply) => {
    try {
      await options.pool.query("select 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  runRoutes(app, store);
  statsRoutes(app, store);
  scheduleRoutes(app, store, client);

  app.setErrorHandler((err: Error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issue = err.validation[0];
      const path = issue?.instancePath.replace(/^\//, "").replaceAll("/", ".");
      return reply
        .code(400)
        .send(
          error(
            "validation_error",
            `${path ? `${path}: ` : ""}${issue?.message ?? "invalid request"}`,
          ),
        );
    }
    if (err instanceof RunNotFoundError)
      return reply.code(404).send(error("not_found", err.message));
    if (err instanceof InvalidStateError)
      return reply.code(409).send(error("invalid_state", err.message));
    if (err instanceof InvalidCronError)
      return reply.code(400).send(error("validation_error", err.message));

    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send(error("bad_request", err.message));
    }
    request.log.error({ err }, "unhandled error");
    return reply.code(500).send(error("internal", "Internal server error"));
  });

  const dashboardIndex = options.dashboardDir && join(options.dashboardDir, "index.html");
  const hasDashboard = Boolean(dashboardIndex && existsSync(dashboardIndex));
  if (hasDashboard && options.dashboardDir) {
    await app.register(fastifyStatic, { root: options.dashboardDir });
  }

  app.setNotFoundHandler(async (request, reply) => {
    // Client-side routes (/runs/abc) resolve to the dashboard; unknown API paths stay JSON 404s.
    const isApi = request.url.startsWith("/v1/") || request.url === "/metrics";
    if (hasDashboard && request.method === "GET" && !isApi) return reply.sendFile("index.html");
    return reply
      .code(404)
      .send(error("not_found", `Route ${request.method} ${request.url} not found`));
  });

  return app;
}
