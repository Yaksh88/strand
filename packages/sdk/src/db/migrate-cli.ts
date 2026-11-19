import { migrate } from "./migrate.js";
import { createPool } from "./pool.js";

const url = process.env["DATABASE_URL"] ?? process.argv[2];
if (!url) {
  console.error("Usage: DATABASE_URL=postgres://... strand-migrate");
  process.exit(1);
}

const pool = createPool(url, { max: 1 });
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
} finally {
  await pool.end();
}
