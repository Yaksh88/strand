import { workflow, type Duration } from "@strand/sdk";
import type pg from "pg";

import type { Services } from "./services.js";

export interface OrderInput {
  orderId: string;
  amountCents: number;
}

export interface WorkflowOptions {
  /** How long to wait between fraud review and shipping. Ten minutes in real life; seconds here. */
  coolingOff?: Duration;
}

export function createWorkflows(services: Services, pool: pg.Pool, options: WorkflowOptions = {}) {
  const fulfillOrder = workflow(
    { name: "fulfill-order", retry: { maxAttempts: 8, initialDelayMs: 200, maxDelayMs: 5000 } },
    async (ctx, input: OrderInput) => {
      const charge = await ctx.step("charge-card", () =>
        services.payments.charge(
          input.orderId,
          input.amountCents,
          ctx.idempotencyKey("charge-card"),
        ),
      );
      await ctx.step(
        "reserve-inventory",
        () => services.inventory.reserve(input.orderId, ctx.idempotencyKey("reserve-inventory")),
        { retry: { maxAttempts: 12 } },
      );

      const review = await ctx.waitForSignal<{ ok: boolean }>("fraud-review", { timeout: "2d" });
      if (review.timedOut || !review.payload.ok) {
        await ctx.step("refund", () =>
          services.payments.refund(charge.id, ctx.idempotencyKey("refund")),
        );
        return { status: "refunded" as const };
      }

      await ctx.sleep("cooling-off", options.coolingOff ?? "5s");
      const shipment = await ctx.step("ship", () =>
        services.shipping.create(input.orderId, ctx.idempotencyKey("ship")),
      );
      return { status: "shipped" as const, trackingId: shipment.trackingId };
    },
  );

  const dailyReport = workflow("daily-report", async (ctx) => {
    const totals = await ctx.step("count-ledger", async () => {
      const { rows } = await pool.query<{ kind: string; n: string; reruns: string }>(
        `select kind, count(*) as n, coalesce(sum(executions - 1), 0) as reruns
           from demo_ledger group by kind order by kind`,
      );
      return rows.map((r) => ({
        kind: r.kind,
        effects: Number(r.n),
        repeatedCalls: Number(r.reruns),
      }));
    });
    ctx.log.info({ totals }, "ledger summary");
    return totals;
  });

  return { fulfillOrder, dailyReport };
}
