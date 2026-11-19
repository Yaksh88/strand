import { randomBytes } from "node:crypto";
import pg from "pg";

import { migrate } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/pool.js";
import { Store } from "../../src/store.js";

export const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://localhost/strand_test";

async function reachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Use with `describe.skipIf(!dbAvailable)` so suites skip when Postgres isn't running. */
export const dbAvailable: boolean = await reachable();

export interface TestDb {
  pool: pg.Pool;
  store: Store;
  schema: string;
  /** A second pool on the same schema, e.g. to simulate another worker process. */
  extraPool(): pg.Pool;
  cleanup(): Promise<void>;
}

/** A migrated, isolated schema, so test files can run in parallel against one database. */
export async function testDb(): Promise<TestDb> {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  await admin.query(`create schema ${schema}`);

  const options = `-c search_path=${schema}`;
  const pools: pg.Pool[] = [];
  const makePool = () => {
    const pool = createPool(DATABASE_URL, { options });
    pools.push(pool);
    return pool;
  };
  const pool = makePool();
  await migrate(pool);

  return {
    pool,
    store: new Store(pool),
    schema,
    extraPool: makePool,
    async cleanup() {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
}

/** A schema with nothing applied, for testing the migrator itself. */
export async function emptySchema(): Promise<{
  makePool(): pg.Pool;
  cleanup(): Promise<void>;
}> {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  await admin.query(`create schema ${schema}`);
  const pools: pg.Pool[] = [];
  return {
    makePool() {
      const pool = createPool(DATABASE_URL, { options: `-c search_path=${schema}` });
      pools.push(pool);
      return pool;
    },
    async cleanup() {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
}
