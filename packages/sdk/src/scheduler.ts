import { CronExpressionParser } from "cron-parser";
import pg from "pg";
import type { Logger } from "pino";

import { InvalidCronError } from "./errors.js";
import type { Store } from "./store.js";

/** The first time after `after` that `cron` fires in `timezone`. Throws `InvalidCronError`. */
export function nextFireAfter(cron: string, timezone: string, after: Date): Date {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new InvalidCronError(`Unknown time zone "${timezone}"`);
  }
  try {
    return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
  } catch (error) {
    throw new InvalidCronError(
      `Invalid cron expression "${cron}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface SchedulerOptions {
  pool: pg.Pool;
  store: Store;
  logger: Logger;
  /** How often the leader looks for due schedules. Default 1s. */
  tickMs?: number;
  /** How often a non-leader retries to take over. Default 5s. */
  electionMs?: number;
  clock?: () => Date;
}

/**
 * Fires cron schedules. Any number of workers may run one, but only the holder of a Postgres
 * advisory lock acts; the lock belongs to a dedicated connection, so it is released the moment
 * that connection (or its process) dies and another scheduler takes over.
 */
export class Scheduler {
  private readonly tickMs: number;
  private readonly electionMs: number;
  private readonly clock: () => Date;
  private lockClient: pg.Client | null = null;
  private timer: NodeJS.Timeout | undefined;
  private lastElection = 0;
  private stopped = false;
  private ticking = false;

  constructor(private readonly options: SchedulerOptions) {
    this.tickMs = options.tickMs ?? 1000;
    this.electionMs = options.electionMs ?? 5000;
    this.clock = options.clock ?? (() => new Date());
  }

  get isLeader(): boolean {
    return this.lockClient !== null;
  }

  async start(): Promise<void> {
    await this.tick(); // settle leadership before returning
    if (!this.stopped) this.timer = setInterval(() => void this.tick(), this.tickMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.release();
  }

  /** One scheduling pass: take leadership if free, and fire due schedules if leader. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      if (!this.lockClient && Date.now() - this.lastElection >= this.electionMs) {
        this.lastElection = Date.now();
        await this.tryLead();
      }
      if (this.lockClient) await this.fire();
    } catch (error) {
      this.options.logger.error({ err: error }, "scheduler tick failed");
    } finally {
      this.ticking = false;
    }
  }

  private async tryLead(): Promise<void> {
    const client = new pg.Client(this.options.pool.options);
    try {
      await client.connect();
      // Scoped to the schema, so separate Strand installs in one database elect separately.
      const { rows } = await client.query<{ got: boolean }>(
        "select pg_try_advisory_lock(hashtext(current_schema() || ':strand:scheduler')) as got",
      );
      if (!rows[0]?.got) {
        await client.end();
        return;
      }
      client.on("error", () => this.lose(client));
      client.on("end", () => this.lose(client));
      this.lockClient = client;
      this.options.logger.info("became the scheduler leader");
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }

  private lose(client: pg.Client): void {
    if (this.lockClient === client) {
      this.lockClient = null;
      this.options.logger.warn("lost the scheduler lock");
    }
  }

  private async release(): Promise<void> {
    const client = this.lockClient;
    this.lockClient = null;
    await client?.end().catch(() => {});
  }

  private async fire(): Promise<void> {
    const fired = await this.options.store.fireDueSchedules(this.clock(), (schedule, after) =>
      nextFireAfter(schedule.cron, schedule.timezone, after),
    );
    if (fired > 0) this.options.logger.info({ fired }, "started scheduled runs");
  }
}
