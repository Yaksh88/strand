import { StrandClient } from "@strand/sdk";

const count = Number(process.argv[2] ?? 20);
const databaseUrl = process.env["DATABASE_URL"] ?? "postgres://localhost/strand";
const client = new StrandClient({ connectionString: databaseUrl });
const batch = Date.now().toString(36);

console.log(`Starting ${count} orders...`);
const runs = await Promise.all(
  Array.from({ length: count }, (_, i) =>
    client.start(
      "fulfill-order",
      { orderId: `o_${batch}_${i}`, amountCents: 1000 + i * 25 },
      { idempotencyKey: `order:${batch}:${i}` },
    ),
  ),
);

// A fraud reviewer approving each order a moment later (one in ten is rejected).
await Promise.all(
  runs.map(async (run, i) => {
    await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 2000));
    await client.signal(run.id, "fraud-review", { ok: i % 10 !== 9 });
  }),
);

const results = await Promise.all(
  runs.map((run) => client.waitForResult<{ status: string }>(run.id, { timeoutMs: 120_000 })),
);
const byStatus: Record<string, number> = {};
for (const result of results)
  byStatus[result.output.status] = (byStatus[result.output.status] ?? 0) + 1;
console.log("Finished:", byStatus);
await client.close();
