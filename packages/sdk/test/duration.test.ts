import { describe, expect, it } from "vitest";

import { parseDuration } from "../src/duration.js";
import { InvalidDurationError } from "../src/errors.js";

describe("parseDuration", () => {
  it("treats numbers as milliseconds", () => {
    expect(parseDuration(500)).toBe(500);
    expect(parseDuration(0)).toBe(0);
  });

  it.each([
    ["500ms", 500],
    ["30s", 30_000],
    ["10m", 600_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
  ] as const)("parses %s", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(["10x", "-5s", "", "s", "1.5h", "10 s", "PT5S"])("rejects %j", (input) => {
    expect(() => parseDuration(input as never)).toThrow(InvalidDurationError);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects the number %s", (input) => {
    expect(() => parseDuration(input)).toThrow(InvalidDurationError);
  });
});
