import { afterEach, describe, expect, it } from "vitest";

import { migrate } from "../src/db/migrate.js";
import { dbAvailable, emptySchema } from "./helpers/db.js";

describe.skipIf(!dbAvailable)("migrate", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  async function schema() {
    const s = await emptySchema();
    cleanups.push(s.cleanup);
    return s;
  }

  it("applies the initial migration once", async () => {
    const { makePool } = await schema();
    const pool = makePool();

    expect(await migrate(pool)).toEqual(["0001_init"]);
    expect(await migrate(pool)).toEqual([]);

    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = current_schema() order by table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        "strand_events",
        "strand_migrations",
        "strand_runs",
        "strand_schedules",
        "strand_signals",
        "strand_steps",
        "strand_workers",
      ]),
    );
  });

  it("is safe when several processes migrate at the same time", async () => {
    const { makePool } = await schema();
    const results = await Promise.all([
      migrate(makePool()),
      migrate(makePool()),
      migrate(makePool()),
    ]);

    expect(results.flat()).toEqual(["0001_init"]); // applied exactly once across all three
  });

  it("rolls a failing migration back and reports the error", async () => {
    const { makePool } = await schema();
    const pool = makePool();
    await migrate(pool);
    // A stale half-applied table would make a re-run of 0001 fail; the version row must be what
    // stops it, so deleting the version row proves the migration really is transactional.
    await pool.query("delete from strand_migrations");
    await expect(migrate(pool)).rejects.toThrow(/already exists/);
    expect((await pool.query("select count(*)::int as n from strand_migrations")).rows[0].n).toBe(
      0,
    );
  });
});
