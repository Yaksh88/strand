export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "Error", message: String(error) };
}

export class StrandError extends Error {
  override get name(): string {
    return this.constructor.name;
  }
}

export class InvalidDurationError extends StrandError {}

/** A fenced write affected no rows: this worker no longer holds the run's lease. */
export class LeaseLostError extends StrandError {}

/** A step used all its attempts. Thrown into workflow code so it can compensate. */
export class StepFailedError extends StrandError {
  constructor(
    readonly stepKey: string,
    override readonly cause: SerializedError,
  ) {
    super(`Step "${stepKey}" failed: ${cause.message}`);
  }
}

export class WorkflowNotFoundError extends StrandError {}
export class RunNotFoundError extends StrandError {}
/** The run is in a state that doesn't allow the operation, e.g. retrying a run that hasn't failed. */
export class InvalidStateError extends StrandError {}

export class InvalidCronError extends StrandError {}

/** `waitForResult` gave up before the run reached a final state. */
export class WaitTimeoutError extends StrandError {}

export class RunFailedError extends StrandError {
  constructor(
    readonly runId: string,
    readonly failure: SerializedError,
  ) {
    super(`Run ${runId} failed: ${failure.message}`);
  }
}

export class RunCancelledError extends StrandError {
  constructor(readonly runId: string) {
    super(`Run ${runId} was cancelled`);
  }
}
