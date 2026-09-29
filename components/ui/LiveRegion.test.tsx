import React from "react";
import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveRegion } from "./LiveRegion";
import { announce } from "@/lib/a11y/announce";

describe("LiveRegion Component & Announcement System", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces assertive messages immediately in the alert region", () => {
    render(<LiveRegion />);

    act(() => {
      announce("Critical error occurred", "assertive");
    });

    const assertiveRegion = screen.getByTestId("live-region-assertive");
    expect(assertiveRegion.textContent).toBe("Critical error occurred");
  });

  it("batches polite announcements after debounce window", () => {
    render(<LiveRegion />);

    act(() => {
      announce("Transaction tx-1 status: PROCESSING", "polite");
      announce("Transaction tx-2 status: COMPLETED", "polite");
    });

    const politeRegion = screen.getByTestId("live-region-polite");
    expect(politeRegion.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(politeRegion.textContent).toContain("2 updates");
    expect(politeRegion.textContent).toContain("tx-1");
    expect(politeRegion.textContent).toContain("tx-2");
  });
});
