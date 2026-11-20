import type { Store } from "@strand/sdk";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { presentRun, presentRunSummary } from "../present.js";

const runId = z.object({ id: z.uuid() });
const STATUSES = [
  "queued",
  "running",
  "sleeping",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;

export function runRoutes(app: FastifyInstance, store: Store): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/v1/runs",
    {
      schema: {
        body: z.object({
          workflow: z.string().min(1).max(200),
          input: z.unknown().optional(),
          idempotencyKey: z.string().min(1).max(200).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { workflow, input, idempotencyKey } = request.body;
      const { run, created } = await store.createRun({ workflow, input, idempotencyKey });
      return reply.code(created ? 201 : 200).send(presentRun(run));
    },
  );

  typed.get(
    "/v1/runs",
    {
      schema: {
        querystring: z.object({
          status: z.enum(STATUSES).optional(),
          workflow: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.string().optional(),
        }),
      },
    },
    async (request) => {
      const page = await store.listRuns(request.query);
      return { items: page.items.map(presentRunSummary), nextCursor: page.nextCursor };
    },
  );

  typed.get("/v1/runs/:id", { schema: { params: runId } }, async (request, reply) => {
    const detail = await store.getRunDetail(request.params.id);
    if (!detail) {
      return reply.code(404).send({ error: { code: "not_found", message: "Run not found" } });
    }
    return {
      run: presentRun(detail.run),
      steps: detail.steps.map((s) => ({
        ...s,
        startedAt: s.startedAt?.toISOString() ?? null,
        completedAt: s.completedAt?.toISOString() ?? null,
      })),
      events: detail.events.map((e) => ({ ...e, at: e.at.toISOString() })),
    };
  });

  typed.post(
    "/v1/runs/:id/signals/:name",
    {
      schema: {
        params: z.object({ id: z.uuid(), name: z.string().min(1).max(200) }),
        body: z.object({ payload: z.unknown().optional() }).nullish(),
      },
    },
    async (request, reply) => {
      await store.sendSignal(request.params.id, request.params.name, request.body?.payload ?? null);
      return reply.code(202).send({ accepted: true });
    },
  );

  typed.post("/v1/runs/:id/cancel", { schema: { params: runId } }, async (request) =>
    presentRun(await store.cancelRun(request.params.id)),
  );

  typed.post("/v1/runs/:id/retry", { schema: { params: runId } }, async (request) =>
    presentRun(await store.retryRun(request.params.id)),
  );
}
