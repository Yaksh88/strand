import type { Logger } from "pino";

import { backoffDelay } from "./backoff.js";
import type { Duration } from "./duration.js";
import { parseDuration } from "./duration.js";
import { LeaseLostError, serializeError, StepFailedError } from "./errors.js";
import { toJson, type Store } from "./store.js";
import type { Lease, RetryPolicy, RunRecord, SignalRecord, StepRecord } from "./types.js";

export interface StepOptions {
  retry?: Partial<RetryPolicy>;
}

export type SignalResult<T> = { timedOut: false; payload: T } | { timedOut: true };

export interface WorkflowContext {
  readonly runId: string;
  readonly workflow: string;
  /** How many times a worker has claimed this run (1 on the first execution). */
  readonly attempt: number;
  /** Aborted when the worker loses the run's lease or shuts down. */
  readonly signal: AbortSignal;
  readonly log: Logger;

  /**
   * Run `fn` once and remember its result. When the workflow is resumed after a crash, a sleep
   * or a signal, a completed step returns its stored result instead of running again.
   *
   * Results are stored as JSON: `undefined` becomes `null` and a `Date` becomes an ISO string,
   * on the first run as well as on replays, so both see the same value.
   */
  step<T>(name: string, fn: () => Promise<T> | T, opts?: StepOptions): Promise<T>;

  /** Sleep without holding a worker. The wake-up time is fixed the first time it is reached. */
  sleep(name: string, duration: Duration): Promise<void>;

  /** Wait for a signal sent with `client.signal`. Signals sent early are buffered. */
  waitForSignal<T = unknown>(name: string, opts?: { timeout?: Duration }): Promise<SignalResult<T>>;

  /**
   * A key that is the same on every retry and replay of this step, for passing to external
   * services as an idempotency key. Inside a step's `fn`, pass that step's own name.
   */
  idempotencyKey(stepName: string): string;

  /** The current time, recorded as a step so a resumed run sees the same value. */
  now(): Promise<Date>;
}

/**
 * Thrown inside the engine to unwind a workflow function after the run has been parked
 * (retrying, sleeping or waiting). It never reaches user code unless user code swallows errors
 * indiscriminately, in which case the run still resumes correctly.
 */
export class Suspend extends Error {
  constructor() {
    super("run suspended");
  }
}

export interface ContextInit {
  run: RunRecord;
  lease: Lease;
  history: { steps: StepRecord[]; signals: SignalRecord[] };
  store: Store;
  defaults: RetryPolicy;
  signal: AbortSignal;
  logger: Logger;
  clock?: () => Date;
  random?: () => number;
}

export type EngineContext = WorkflowContext & {
  /** Step keys this execution has reached, to detect workflow code that changed between runs. */
  visitedKeys(): Set<string>;
};

/** Value a step returns, after a JSON round trip, so the first run matches every replay. */
function normalise(value: unknown): unknown {
  return (JSON.parse(toJson({ v: value === undefined ? null : value })) as { v: unknown }).v;
}

export function createContext(init: ContextInit): EngineContext {
  const { run, lease, store, defaults, signal, logger } = init;
  const clock = init.clock ?? (() => new Date());
  const random = init.random ?? Math.random;

  const stored = new Map(init.history.steps.map((s) => [s.stepKey, s]));
  const occurrences = new Map<string, number>();
  const running = new Map<string, string>(); // step name -> key of the step executing right now
  const visited = new Set<string>();

  const keyFor = (name: string, n: number) => (n === 1 ? name : `${name}#${n}`);

  function nextKey(name: string): string {
    const n = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, n);
    const key = keyFor(name, n);
    visited.add(key);
    return key;
  }

  function assertHeld(): void {
    if (signal.aborted) throw new LeaseLostError(`Run ${run.id} is no longer held by this worker`);
  }

  async function step<T>(name: string, fn: () => Promise<T> | T, opts?: StepOptions): Promise<T> {
    assertHeld();
    const key = nextKey(name);
    const previous = stored.get(key);
    if (previous?.status === "completed") return previous.output as T;
    if (previous?.status === "failed") {
      throw new StepFailedError(key, previous.error ?? { name: "Error", message: "step failed" });
    }

    const policy = { ...defaults, ...opts?.retry };
    const attempt = (previous?.attempts ?? 0) + 1;
    const startedAt = clock();

    let output: T;
    running.set(name, key);
    try {
      output = await fn();
    } catch (error) {
      // The worker lost the run while fn was in flight: whatever fn threw is moot.
      assertHeld();
      const failure = serializeError(error);
      if (attempt < policy.maxAttempts) {
        const retryAt = new Date(clock().getTime() + backoffDelay(attempt, policy, random));
        await store.scheduleStepRetry(lease, {
          stepKey: key,
          error: failure,
          attempts: attempt,
          retryAt,
        });
        throw new Suspend();
      }
      await store.failStep(lease, { stepKey: key, error: failure, attempts: attempt });
      throw new StepFailedError(key, failure);
    } finally {
      running.delete(name);
    }

    // A result that arrives after the lease was lost must not be committed (the store would
    // refuse it anyway, but there is no point trying).
    assertHeld();

    let result: unknown;
    try {
      result = normalise(output);
    } catch (error) {
      // Retrying would produce the same unserialisable value, so fail the step outright.
      const failure = serializeError(
        new TypeError(
          `Step "${key}" returned a value that is not JSON-serialisable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
      await store.failStep(lease, { stepKey: key, error: failure, attempts: attempt });
      throw new StepFailedError(key, failure);
    }

    await store.completeStep(lease, { stepKey: key, output: result, attempts: attempt, startedAt });
    return result as T;
  }

  async function sleep(name: string, duration: Duration): Promise<void> {
    assertHeld();
    const key = nextKey(name);
    const previous = stored.get(key);
    if (previous?.status === "completed") return;

    const first = previous === undefined;
    const wakeAt = first
      ? new Date(clock().getTime() + parseDuration(duration))
      : new Date((previous.output as { wakeAt: string }).wakeAt);

    if (clock() >= wakeAt) {
      await store.completeStep(lease, {
        stepKey: key,
        output: { wakeAt: wakeAt.toISOString() },
        attempts: 0,
        startedAt: clock(),
      });
      return;
    }
    await store.suspendSleeping(lease, { stepKey: key, wakeAt, firstTime: first });
    throw new Suspend();
  }

  async function waitForSignal<T = unknown>(
    name: string,
    opts: { timeout?: Duration } = {},
  ): Promise<SignalResult<T>> {
    assertHeld();
    const key = nextKey(name);
    const previous = stored.get(key);
    if (previous?.status === "completed") return previous.output as SignalResult<T>;

    const first = previous === undefined;
    const deadline = first
      ? opts.timeout === undefined
        ? null
        : new Date(clock().getTime() + parseDuration(opts.timeout))
      : ((d) => (d ? new Date(d) : null))(
          (previous.output as { deadline: string | null }).deadline,
        );

    for (;;) {
      const found = await store.findSignal(run.id, name);
      if (found) {
        const output: SignalResult<T> = { timedOut: false, payload: found.payload as T };
        await store.consumeSignal(lease, { stepKey: key, signalId: found.id, output });
        return output;
      }
      if (deadline && clock() >= deadline) {
        const output: SignalResult<T> = { timedOut: true };
        await store.completeStep(lease, {
          stepKey: key,
          output,
          attempts: 0,
          startedAt: clock(),
        });
        return output;
      }
      const parked = await store.suspendWaiting(lease, {
        stepKey: key,
        signal: name,
        deadline,
        firstTime: first,
      });
      if (parked) throw new Suspend();
      // A signal arrived between the look above and parking: loop to pick it up.
    }
  }

  return {
    runId: run.id,
    workflow: run.workflow,
    attempt: run.claimCount,
    signal,
    log: logger.child({ runId: run.id, workflow: run.workflow }),
    step,
    sleep,
    waitForSignal,
    idempotencyKey(stepName) {
      const key = running.get(stepName) ?? keyFor(stepName, (occurrences.get(stepName) ?? 0) + 1);
      return `${run.id}:${key}`;
    },
    async now() {
      return new Date(await step("__now", () => clock().toISOString()));
    },
    visitedKeys: () => visited,
  };
}
