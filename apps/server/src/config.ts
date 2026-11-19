export interface ServerConfig {
  databaseUrl: string;
  port: number;
  host: string;
  /** When set, every /v1 request must carry `Authorization: Bearer <token>`. */
  apiToken: string | undefined;
  dashboardDir: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const port = Number(env["PORT"] ?? 4000);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid PORT: ${env["PORT"]}`);
  return {
    databaseUrl,
    port,
    host: env["HOST"] ?? "0.0.0.0",
    apiToken: env["STRAND_API_TOKEN"] || undefined,
    dashboardDir: env["DASHBOARD_DIR"] || undefined,
  };
}
