import { describe, expect, it } from "vitest";

import { backoffDelay } from "../src/backoff.js";
import { DEFAULT_RETRY } from "../src/types.js";

describe("backoffDelay", () => {
  it("grows exponentially from the initial delay", () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => backoffDelay(attempt, DEFAULT_RETRY, () => 1));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  it("never exceeds the maximum delay", () => {
    const policy = { ...DEFAULT_RETRY, maxDelayMs: 5000 };
    expect(backoffDelay(10, policy, () => 1)).toBe(5000);
    expect(backoffDelay(50, policy, () => 1)).toBe(5000);
  });

  it("jitters down to half the delay, never below", () => {
    expect(backoffDelay(3, DEFAULT_RETRY, () => 0)).toBe(2000); // half of 4000
    expect(backoffDelay(3, DEFAULT_RETRY, () => 0.5)).toBe(3000);
  });

  it("honours a custom coefficient", () => {
    const policy = { ...DEFAULT_RETRY, initialDelayMs: 100, backoffCoefficient: 3 };
    expect([1, 2, 3].map((n) => backoffDelay(n, policy, () => 1))).toEqual([100, 300, 900]);
  });
});
