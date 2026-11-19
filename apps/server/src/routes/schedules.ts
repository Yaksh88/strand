import { nextFireAfter, type Store, type StrandClient } from "@strand/sdk";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { presentSchedule } from "../present.js";

export function scheduleRoutes(app: FastifyInstance, store: Store, client: StrandClient): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  app.get("/v1/schedules", async () => (await store.listSchedules()).map(presentSchedule));

  typed.post(
    "/v1/schedules",
    {
      schema: {
        body: z.object({
          id: z.string().min(1).max(100),
          workflow: z.string().min(1).max(200),
          cron: z.string().min(1).max(100),
          timezone: z.string().min(1).max(100).optional(),
          input: z.unknown().optional(),
          enabled: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const schedule = await client.upsertSchedule(request.body);
      return reply.code(201).send(presentSchedule(schedule));
    },
  );

  typed.delete(
    "/v1/schedules/:id",
    { schema: { params: z.object({ id: z.string().min(1) }) } },
    async (request, reply) => {
      if (!(await store.deleteSchedule(request.params.id))) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Schedule not found" } });
      }
      return reply.code(204).send();
    },
  );

  // The next few fire times for an expression, so a UI can show what a cron string means.
  typed.get(
    "/v1/schedules/preview",
    {
      schema: {
        querystring: z.object({
          cron: z.string().min(1),
          timezone: z.string().min(1).default("UTC"),
          count: z.coerce.number().int().min(1).max(20).default(5),
        }),
      },
    },
    async (request) => {
      const { cron, timezone, count } = request.query;
      const times: string[] = [];
      let after = new Date();
      for (let i = 0; i < count; i += 1) {
        after = nextFireAfter(cron, timezone, after);
        times.push(after.toISOString());
      }
      return { cron, timezone, next: times };
    },
  );
}
