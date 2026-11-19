import type { RetryPolicy } from "./types.js";

/**
 * Delay before retry number `attempt` (1 for the first retry): exponential growth capped at
 * `maxDelayMs`, then jittered to between half and all of that so retries from many runs that
 * failed together don't all land at the same instant.
 */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = policy.initialDelayMs * policy.backoffCoefficient ** (attempt - 1);
  const capped = Math.min(policy.maxDelayMs, exponential);
  return Math.round(capped * (0.5 + random() * 0.5));
}
