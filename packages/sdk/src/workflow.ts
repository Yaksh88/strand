import type { WorkflowContext } from "./context.js";
import type { RetryPolicy } from "./types.js";
import { DEFAULT_RETRY } from "./types.js";

export interface WorkflowOptions {
  name: string;
  /** Default retry policy for this workflow's steps; individual steps can override it. */
  retry?: Partial<RetryPolicy>;
}

export interface WorkflowDefinition<I, O> {
  readonly name: string;
  readonly retry: RetryPolicy;
  readonly fn: (ctx: WorkflowContext, input: I) => Promise<O>;
}

/** Any workflow, for APIs that accept a mixed list of them. */
export type AnyWorkflow = WorkflowDefinition<never, unknown>;

export function workflow<I, O>(
  options: WorkflowOptions | string,
  fn: (ctx: WorkflowContext, input: I) => Promise<O>,
): WorkflowDefinition<I, O> {
  const opts = typeof options === "string" ? { name: options } : options;
  return { name: opts.name, retry: { ...DEFAULT_RETRY, ...opts.retry }, fn };
}
