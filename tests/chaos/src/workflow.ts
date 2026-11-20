import { workflow } from "@strand/sdk";
import type pg from "pg";

export const STEPS = 5;

export const EFFECTS_DDL = `
  create table if not exists chaos_effects (
    idempotency_key text primary key,
    step_key        text not null,
    run_id          text not null,
    executions      int not null default 1
  )`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Five steps. Each one records a side effect under its idempotency key *before* a 10% chance of
 * failing, so a retry (or a re-execution after a crash) repeats an effect that already happened.
 * Each step also returns a random number, so a replay that re-ran a completed step instead of
 * using its stored result would produce a different final output and be caught by the audit.
 */
export function createChaosWorkflow(pool: pg.Pool) {
  return workflow(
    { name: "chaos-transfer", retry: { maxAttempts: 25, initialDelayMs: 20, maxDelayMs: 200 } },
    async (ctx) => {
      const outputs: number[] = [];
      for (let i = 1; i <= STEPS; i += 1) {
        const name = `step-${i}`;
        outputs.push(
          await ctx.step(name, async () => {
            await sleep(10 + Math.random() * 90);
            await pool.query(
              `insert into chaos_effects (idempotency_key, step_key, run_id) values ($1, $2, $3)
               on conflict (idempotency_key) do update set executions = chaos_effects.executions + 1`,
              [ctx.idempotencyKey(name), name, ctx.runId],
            );
            if (Math.random() < 0.1) throw new Error("injected failure after the effect");
            return Math.random();
          }),
        );
      }
      return { outputs };
    },
  );
}
