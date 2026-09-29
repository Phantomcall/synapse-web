import { describe, it, expect } from "vitest";
import { validateAssets } from "./check-asset-optimization.mjs";

describe("Static Asset Optimization Pipeline", () => {
  it("passes asset check for existing public assets", () => {
    const { passed, results } = validateAssets("public");
    expect(passed).toBe(true);
    expect(results.every((r) => r.passed)).toBe(true);
  });
});
