import { InvalidDurationError } from "./errors.js";

export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const PATTERN = /^(\d+)(ms|s|m|h|d)$/;

/** Milliseconds for a number (already ms) or a string like "500ms", "30s", "10m", "2h", "1d". */
export function parseDuration(duration: Duration): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new InvalidDurationError(`Invalid duration: ${duration}`);
    }
    return duration;
  }
  const match = PATTERN.exec(duration);
  if (!match) {
    throw new InvalidDurationError(
      `Invalid duration "${duration}": use a number of milliseconds or a value like "30s", "10m", "2h"`,
    );
  }
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}
