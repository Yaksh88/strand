import type { Store } from "@strand/sdk";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const WINDOWS = {
  "1h": { lookbackMs: 3_600_000, bucketMs: 60_000 },
  "24h": { lookbackMs: 86_400_000, bucketMs: 900_000 },
  "7d": { lookbackMs: 604_800_000, bucketMs: 10_800_000 },
} as const;

export function statsRoutes(app: FastifyInstance, store: Store): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/v1/stats",
    { schema: { querystring: z.object({ window: z.enum(["1h", "24h", "7d"]).default("24h") }) } },
    async (request) => {
      const { window } = request.query;
      const { lookbackMs, bucketMs } = WINDOWS[window];
      const now = Date.now();
      const since = new Date(now - lookbackMs);
      const stats = await store.stats({ since, bucketMs });

      // Buckets with no runs are absent from the query; fill them so charts have a point for
      // every interval. Boundaries match Postgres's date_bin with an epoch origin.
      const byTs = new Map(stats.series.map((p) => [p.ts.getTime(), p]));
      const series = [];
      for (let ts = Math.floor(since.getTime() / bucketMs) * bucketMs; ts <= now; ts += bucketMs) {
        const point = byTs.get(ts);
        series.push({
          ts: new Date(ts).toISOString(),
          started: point?.started ?? 0,
          completed: point?.completed ?? 0,
          failed: point?.failed ?? 0,
        });
      }
      return { window, totals: stats.totals, series };
    },
  );

  app.get("/v1/workflows", async () => store.workflowSummaries());

  app.get("/v1/workers", async () =>
    (await store.listWorkers()).map((w) => ({
      ...w,
      startedAt: w.startedAt.toISOString(),
      lastSeenAt: w.lastSeenAt.toISOString(),
    })),
  );
}
