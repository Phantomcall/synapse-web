import { describe, it, expect } from "vitest";
import { validateBundleBudgets, DEFAULT_BUDGETS } from "./check-bundle-size.mjs";

describe("Bundle Size Budget Enforcement Suite", () => {
  it("passes when all chunks are strictly within budget limits", () => {
    const mockSizes = {
      initial: 180,
      dashboard: 45,
      transactions: 60,
      admin: 50,
      docs: 30,
    };

    const { passed, results } = validateBundleBudgets(mockSizes);
    expect(passed).toBe(true);
    expect(results.every((r) => !r.exceeded)).toBe(true);
  });

  it("deliberately fails and identifies when initial bundle exceeds budget limit", () => {
    const oversizedSizes = {
      initial: 350, // exceeds 300 maxKb
      dashboard: 45,
      transactions: 60,
      admin: 50,
      docs: 30,
    };

    const { passed, results } = validateBundleBudgets(oversizedSizes);
    expect(passed).toBe(false);

    const initialResult = results.find((r) => r.key === "initial");
    expect(initialResult?.exceeded).toBe(true);
    expect(initialResult?.diffKb).toBe(50);
  });

  it("deliberately fails when a lazy tab chunk exceeds its budget limit", () => {
    const oversizedTabSizes = {
      initial: 200,
      dashboard: 140, // exceeds 120 maxKb
      transactions: 60,
      admin: 50,
      docs: 30,
    };

    const { passed, results } = validateBundleBudgets(oversizedTabSizes);
    expect(passed).toBe(false);

    const dashboardResult = results.find((r) => r.key === "dashboard");
    expect(dashboardResult?.exceeded).toBe(true);
    expect(dashboardResult?.diffKb).toBe(20);
  });
});
