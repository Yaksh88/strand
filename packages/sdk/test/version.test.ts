import { describe, expect, it } from "vitest";

import { VERSION } from "../src/index.js";

describe("package", () => {
  it("exposes its version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
