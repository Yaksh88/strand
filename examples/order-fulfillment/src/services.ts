import type pg from "pg";

export interface ServiceOptions {
  /** Probability that a call fails. Half of the failures happen *after* the side effect. */
  failureRate: number;
  minLatencyMs: number;
  maxLatencyMs: number;
}

export const DEFAULT_SERVICE_OPTIONS: ServiceOptions = {
  failureRate: 0.2,
  minLatencyMs: 50,
  maxLatencyMs: 300,
};

export interface Services {
  payments: {
    charge(orderId: string, amountCents: number, idempotencyKey: string): Promise<{ id: string }>;
    refund(chargeId: string, idempotencyKey: string): Promise<void>;
  };
  inventory: { reserve(orderId: string, idempotencyKey: string): Promise<void> };
  shipping: { create(orderId: string, idempotencyKey: string): Promise<{ trackingId: string }> };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const LEDGER_DDL = `
  create table if not exists demo_ledger (
    idempotency_key text primary key,
    kind            text not null,
    order_id        text not null,
    executions      int not null default 1,
    created_at      timestamptz not null default now()
  )`;

/**
 * Pretend external services that are slow and flaky, and that keep a ledger of what they did.
 *
 * Each effect is recorded under its idempotency key, so a repeated call with the same key
 * changes nothing except an `executions` counter. That is how a real payment API treats an
 * `Idempotency-Key` header, and why a step that runs twice doesn't charge a card twice.
 */
export function createServices(
  pool: pg.Pool,
  options: ServiceOptions = DEFAULT_SERVICE_OPTIONS,
): Services {
  async function call<T>(kind: string, orderId: string, key: string, result: () => T): Promise<T> {
    await sleep(
      options.minLatencyMs + Math.random() * (options.maxLatencyMs - options.minLatencyMs),
    );
    const fails = Math.random() < options.failureRate;
    const failsAfterEffect = fails && Math.random() < 0.5;
    if (fails && !failsAfterEffect) throw new Error(`${kind} service unavailable`);

    await pool.query(
      `insert into demo_ledger (idempotency_key, kind, order_id) values ($1, $2, $3)
       on conflict (idempotency_key) do update set executions = demo_ledger.executions + 1`,
      [key, kind, orderId],
    );
    // The effect happened but the caller never hears about it: the case idempotency is for.
    if (failsAfterEffect) throw new Error(`${kind} service timed out after processing`);
    return result();
  }

  return {
    payments: {
      charge: (orderId, _amount, key) =>
        call("charge", orderId, key, () => ({ id: `ch_${orderId}` })),
      refund: (chargeId, key) => call("refund", chargeId, key, () => undefined),
    },
    inventory: { reserve: (orderId, key) => call("reserve", orderId, key, () => undefined) },
    shipping: {
      create: (orderId, key) =>
        call("ship", orderId, key, () => ({ trackingId: `trk_${orderId}` })),
    },
  };
}
