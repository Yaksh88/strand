import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StrandClient } from "@strand/sdk";
import { createTestDatabase } from "@strand/sdk/testing";

import { EFFECTS_DDL, STEPS } from "./workflow.js";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "500" },
    workers: { type: "string", default: "4" },
    "kill-every": { type: "string", default: "1000" },
    duration: { type: "string", default: "60" },
    "lease-ms": { type: "string", default: "2000" },
    // Share of incidents that freeze a worker past its lease instead of killing it.
    "freeze-ratio": { type: "string", default: "0.4" },
  },
});
const runs = Number(values.runs);
const workerCount = Number(values.workers);
const killEveryMs = Number(values["kill-every"]);
const deadline = Date.now() + Number(values.duration) * 1000;
const leaseMs = Number(values["lease-ms"]);
const freezeRatio = Number(values["freeze-ratio"]);

const db = await createTestDatabase();
await db.pool.query(EFFECTS_DDL);
const client = new StrandClient({ pool: db.pool });
const workerPath = fileURLToPath(new URL("./chaos-worker.js", import.meta.url));

// ---- worker processes that get killed and replaced -----------------------------------------

const alive = new Set<ChildProcess>();
let finishing = false;
let kills = 0;
let freezes = 0;
let incidents = 0;
const frozen = new Set<ChildProcess>();
let spawned = 0;

function spawnWorker(): void {
  spawned += 1;
  const child = fork(workerPath, [], {
    env: {
      ...process.env,
      DATABASE_URL: db.connectionString,
      SEARCH_PATH_OPTIONS: db.searchPathOptions,
      WORKER_ID: `chaos-${spawned}`,
      LEASE_MS: String(leaseMs),
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  alive.add(child);
  child.on("exit", () => {
    alive.delete(child);
    if (!finishing) spawnWorker(); // a crashed or killed worker is replaced at once
  });
}

console.log(
  `Chaos: ${runs} runs of ${STEPS} steps, ${workerCount} workers, SIGKILL one every ${killEveryMs}ms, lease ${leaseMs}ms`,
);
for (let i = 0; i < workerCount; i += 1) spawnWorker();
const started = Date.now();
await Promise.all(Array.from({ length: runs }, () => client.start("chaos-transfer", null)));

const killer = setInterval(() => {
  const victims = [...alive].filter((child) => !frozen.has(child));
  const victim = victims[Math.floor(Math.random() * victims.length)];
  if (!victim || finishing) return;

  // Deterministic spread (a freeze first, then evenly) so runs are comparable and never lucky.
  const freeze = Math.ceil((incidents + 1) * freezeRatio) > Math.ceil(incidents * freezeRatio);
  incidents += 1;
  if (freeze) {
    // A frozen worker (a long GC pause, a VM stall) keeps its in-flight steps. Its lease expires
    // and another worker takes the run; when it thaws, it must not be able to commit anything.
    freezes += 1;
    frozen.add(victim);
    victim.kill("SIGSTOP");
    setTimeout(() => {
      frozen.delete(victim);
      if (!finishing) victim.kill("SIGCONT");
    }, leaseMs * 1.5);
  } else {
    kills += 1;
    victim.kill("SIGKILL");
  }
}, killEveryMs);

async function unfinished(): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(
    "select count(*) as n from strand_runs where status not in ('completed', 'failed', 'cancelled')",
  );
  return Number(rows[0]?.n);
}
while ((await unfinished()) > 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
finishing = true;
clearInterval(killer);
const elapsedS = (Date.now() - started) / 1000;
for (const child of alive) child.kill("SIGKILL");
await new Promise((resolve) => setTimeout(resolve, 300));

// ---- the audit -------------------------------------------------------------------------------

const count = async (sql: string): Promise<number> =>
  Number((await db.pool.query<{ n: string }>(sql)).rows[0]?.n ?? 0);

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

const statuses = (
  await db.pool.query<{ status: string; n: string }>(
    "select status, count(*) as n from strand_runs group by status order by status",
  )
).rows;
const completed = Number(statuses.find((s) => s.status === "completed")?.n ?? 0);
check(completed === runs, `${runs - completed} of ${runs} runs did not complete (lost or failed)`);

const badStepCounts = await count(
  `select count(*) as n from (
     select run_id from strand_steps group by run_id
     having count(*) <> ${STEPS} or count(*) filter (where status = 'completed') <> ${STEPS}
   ) bad`,
);
const runsWithoutSteps = await count(
  "select count(*) as n from strand_runs r where not exists (select 1 from strand_steps s where s.run_id = r.id)",
);
check(
  badStepCounts === 0 && runsWithoutSteps === 0,
  `${badStepCounts + runsWithoutSteps} runs don't have exactly ${STEPS} completed steps`,
);

const effects = await count("select count(*) as n from chaos_effects");
const stepsWithoutEffect = await count(
  `select count(*) as n from strand_steps s
    where not exists (select 1 from chaos_effects e where e.idempotency_key = s.run_id::text || ':' || s.step_key)`,
);
check(effects === runs * STEPS, `expected ${runs * STEPS} effect rows, found ${effects}`);
check(stepsWithoutEffect === 0, `${stepsWithoutEffect} completed steps have no recorded effect`);

// Memoisation: a run's final output must be made of exactly the stored step results.
const stepOutputs = await db.pool.query<{
  run_id: string;
  step_key: string;
  output: { v: number };
}>(
  "select run_id, step_key, output from strand_steps where status = 'completed' order by run_id, step_key",
);
const byRun = new Map<string, number[]>();
for (const row of stepOutputs.rows)
  byRun.set(row.run_id, [...(byRun.get(row.run_id) ?? []), row.output.v]);
const finalOutputs = await db.pool.query<{ id: string; output: { outputs: number[] } | null }>(
  "select id, output from strand_runs where status = 'completed'",
);
const mismatched = finalOutputs.rows.filter(
  (run) => JSON.stringify(run.output?.outputs) !== JSON.stringify(byRun.get(run.id)),
).length;
check(
  mismatched === 0,
  `${mismatched} runs have a final output that differs from their stored step results`,
);

const reexecuted = await count("select count(*) as n from chaos_effects where executions > 1");
const extraExecutions = await count(
  "select coalesce(sum(executions - 1), 0) as n from chaos_effects",
);
const leaseExpired = await count(
  "select count(*) as n from strand_events where type = 'lease_expired'",
);
const retries = await count(
  "select count(*) as n from strand_events where type = 'step_retry_scheduled'",
);

console.log(`
Result after ${elapsedS.toFixed(1)}s
  runs completed                      ${completed} / ${runs}
  runs with 5 completed steps         ${runs - badStepCounts - runsWithoutSteps} / ${runs}
  effect rows (expected ${runs * STEPS})          ${effects}
  final outputs matching stored steps ${finalOutputs.rows.length - mismatched} / ${finalOutputs.rows.length}
  workers killed (SIGKILL)            ${kills}
  workers frozen past their lease     ${freezes}
  leases that expired and were taken over  ${leaseExpired}
  step retries (injected failures)    ${retries}
  steps whose effect ran more than once    ${reexecuted} (${extraExecutions} extra executions, absorbed by idempotency keys)`);

check(kills > 0, "no workers were killed, so the test exercised nothing");
check(
  freezeRatio === 0 || freezes > 0,
  "no worker was frozen, so zombie commits were not exercised",
);
check(reexecuted > 0, "no step was re-executed, so the test exercised nothing");
check(leaseExpired > 0, "no lease expired and was taken over, so crash recovery was not exercised");

await client.close();
await db.cleanup();
if (failures.length > 0) {
  console.error(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nPASSED: no run lost, no step committed twice, every replay used stored results.");
process.exit(0);
