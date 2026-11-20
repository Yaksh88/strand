import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type pg from "pg";

// Taken for the whole migration run, so concurrent workers starting together can't race.
const MIGRATION_LOCK = 7_243_001;

// Resolves next to this file in src/ and, because the build copies the SQL files, next to the
// bundle in dist/.
const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

/** Apply pending `NNNN_name.sql` migrations in order. Returns the versions applied. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      `create table if not exists strand_migrations (
         version text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const done = new Set(
      (await client.query<{ version: string }>("select version from strand_migrations")).rows.map(
        (row) => row.version,
      ),
    );

    const files = (await readdir(fileURLToPath(MIGRATIONS_DIR)))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    if (files.length === 0) {
      // A broken build that lost the SQL files would otherwise "succeed" and leave no tables.
      throw new Error(`No migration files found in ${fileURLToPath(MIGRATIONS_DIR)}`);
    }
    const applied: string[] = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (done.has(version)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into strand_migrations (version) values ($1)", [version]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      applied.push(version);
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
