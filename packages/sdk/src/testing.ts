/**
 * Helpers for testing code built on Strand: an isolated, migrated Postgres schema per test file,
 * so suites can run in parallel against one database.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";

import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";

export const TEST_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://localhost/strand_test";

/** Whether the test database is reachable; use with `describe.skipIf(!await databaseAvailable())`. */
export async function databaseAvailable(url: string = TEST_DATABASE_URL): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
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

export interface TestDatabase {
  pool: pg.Pool;
  schema: string;
  connectionString: string;
  /** Options to pass to extra connections so they see the same schema. */
  searchPathOptions: string;
  cleanup(): Promise<void>;
}

export async function createTestDatabase(url: string = TEST_DATABASE_URL): Promise<TestDatabase> {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema ${schema}`);

  const searchPathOptions = `-c search_path=${schema}`;
  const pool = createPool(url, { options: searchPathOptions });
  await migrate(pool);

  return {
    pool,
    schema,
    connectionString: url,
    searchPathOptions,
    async cleanup() {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
}
