import pg from "pg";
import type { Logger } from "pino";

const MIN_RETRY_MS = 250;
const MAX_RETRY_MS = 5000;

/**
 * Listens on a Postgres NOTIFY channel over a dedicated connection and reconnects with backoff
 * if it drops. Notifications are only a latency optimisation: workers also poll, so a missed
 * one costs at most a poll interval. After every reconnect `onWake("")` fires once, since
 * notifications sent while disconnected are lost.
 */
export class WakeListener {
  private client: pg.Client | null = null;
  private stopped = false;
  private retryMs = MIN_RETRY_MS;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: pg.ClientConfig,
    private readonly channel: string,
    private readonly onWake: (payload: string) => void,
    private readonly logger: Logger,
  ) {}

  /** Never rejects: if the first connection fails it retries in the background. */
  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => {});
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client(this.config);
    try {
      client.on("notification", (message) => {
        if (message.channel === this.channel) this.onWake(message.payload ?? "");
      });
      client.on("error", () => this.reconnect(client));
      client.on("end", () => this.reconnect(client));
      await client.connect();
      await client.query(`listen ${this.channel}`);
      if (this.stopped) {
        await client.end().catch(() => {});
        return;
      }
      this.client = client;
      this.retryMs = MIN_RETRY_MS;
      this.onWake("");
    } catch (error) {
      this.logger.warn({ err: error }, "wake-up listener could not connect; will retry");
      await client.end().catch(() => {});
      this.scheduleRetry();
    }
  }

  private reconnect(failed: pg.Client): void {
    if (this.stopped || this.client !== failed) return;
    this.client = null;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
  }
}
