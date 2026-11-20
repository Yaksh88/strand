import pg from "pg";

export interface PoolOptions {
  max?: number;
  /** Extra Postgres startup options, e.g. `-c search_path=my_schema`. */
  options?: string;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10, options: opts.options });
  // An idle client erroring (e.g. the server restarting) must not crash the process.
  pool.on("error", () => {});
  return pool;
}
