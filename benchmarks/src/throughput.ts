import { cpus, totalmem } from "node:os";
import { parseArgs } from "node:util";
import { createPool, Worker, workflow } from "@strand/sdk";
import { createTestDatabase } from "@strand/sdk/testing";
import { pino } from "pino";

const { values } = parseArgs({
  options: {
    workers: { type: "string", default: "1,2,4,8" },
    runs: { type: "string", default: "5000" },
    steps: { type: "string", default: "3" },
    concurrency: { type: "string", default: "10" },
  },
});
const workerCounts = values.workers.split(",").map(Number);
const runs = Number(values.runs);
const steps = Number(values.steps);
const concurrency = Number(values.concurrency);

const bench = workflow("bench", async (ctx) => {
  for (let i = 1; i <= steps; i += 1) await ctx.step(`s${i}`, () => i);
  return null;
});

console.log(`${runs} runs of ${steps} no-op steps, ${concurrency} concurrent runs per worker\n`);
console.log("| Workers | Runs/s | Steps/s | Service p50 | p95 | p99 |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: |");

let pgVersion = "";
for (const count of workerCounts) {
  const db = await createTestDatabase();
  pgVersion ||=
    (await db.pool.query<{ version: string }>("select version()")).rows[0]?.version ?? "";

  // The backlog is created up front, so the measurement is how fast workers can drain it.
  await db.pool.query(
    `insert into strand_runs (id, workflow, status, input)
     select gen_random_uuid(), 'bench', 'queued', 'null'::jsonb from generate_series(1, $1)`,
    [runs],
  );

  const workers = Array.from({ length: count }, (_, i) => {
    const pool = createPool(db.connectionString, { max: 6, options: db.searchPathOptions });
    return new Worker({
      pool,
      workflows: [bench],
      id: `bench-${i}`,
      concurrency,
      pollIntervalMs: 50,
      scheduler: false,
      logger: pino({ level: "silent" }),
    });
  });
  await Promise.all(workers.map((w) => w.start()));

  const startedAt = performance.now();
  for (;;) {
    const { rows } = await db.pool.query<{ n: string }>(
      "select count(*) as n from strand_runs where status = 'completed'",
    );
    if (Number(rows[0]?.n) >= runs) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const seconds = (performance.now() - startedAt) / 1000;

  // Service time: from a worker claiming a run to the run completing. Queue wait is excluded,
  // because with a preloaded backlog it only measures how long the backlog is.
  const { rows } = await db.pool.query<{ p50: number; p95: number; p99: number }>(
    `select percentile_cont(0.50) within group (order by ms) as p50,
            percentile_cont(0.95) within group (order by ms) as p95,
            percentile_cont(0.99) within group (order by ms) as p99
       from (select extract(epoch from (r.completed_at - e.at)) * 1000 as ms
               from strand_runs r
               join strand_events e on e.run_id = r.id and e.type = 'run_claimed'
              where r.status = 'completed') t`,
  );
  const l = rows[0];
  const fmt = (n: number | undefined) => `${(n ?? 0).toFixed(0)} ms`;
  console.log(
    `| ${count} | ${(runs / seconds).toFixed(0)} | ${((runs * steps) / seconds).toFixed(0)} ` +
      `| ${fmt(l?.p50)} | ${fmt(l?.p95)} | ${fmt(l?.p99)} |`,
  );

  await Promise.all(workers.map((w) => w.stop({ graceMs: 2000 })));
  await db.cleanup();
}

const cpu = cpus();
console.log(
  `\nMachine: ${cpu[0]?.model}, ${cpu.length} cores, ${(totalmem() / 2 ** 30).toFixed(0)} GB RAM; ` +
    `Node ${process.version}; ${pgVersion.split(" on ")[0]} on the same machine`,
);
process.exit(0);
