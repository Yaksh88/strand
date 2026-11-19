import type { Store } from "@strand/sdk";
import { collectDefaultMetrics, Counter, Gauge, Registry } from "prom-client";

const STATUSES = ["queued", "running", "sleeping", "waiting", "completed", "failed", "cancelled"];

export function createMetrics(store: Store) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  new Gauge({
    name: "strand_runs",
    help: "Workflow runs by status.",
    labelNames: ["status"],
    registers: [registry],
    // Read at scrape time, so the numbers are never stale.
    async collect() {
      const counts = await store.countByStatus();
      this.reset();
      for (const status of STATUSES) this.set({ status }, counts[status] ?? 0);
    },
  });

  const requests = new Counter({
    name: "strand_http_requests_total",
    help: "HTTP requests handled by the API.",
    labelNames: ["route", "status"],
    registers: [registry],
  });

  return { registry, requests };
}
