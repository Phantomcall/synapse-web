import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFocusTrap } from "./useFocusTrap";

describe("useFocusTrap Hook Suite", () => {
  let container: HTMLDivElement;
  let btn1: HTMLButtonElement;
  let input: HTMLInputElement;
  let btn2: HTMLButtonElement;

  beforeEach(() => {
    container = document.createElement("div");
    btn1 = document.createElement("button");
    btn1.textContent = "First";
    input = document.createElement("input");
    btn2 = document.createElement("button");
    btn2.textContent = "Last";

    container.appendChild(btn1);
    container.appendChild(input);
    container.appendChild(btn2);
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  it("auto-focuses first element on mount", () => {
    const ref = { current: container };
    renderHook(() => useFocusTrap(ref));

    expect(document.activeElement).toBe(btn1);
  });

  it("triggers onEscape when Escape key is pressed", () => {
    const onEscape = vi.fn();
    const ref = { current: container };
    renderHook(() => useFocusTrap(ref, { onEscape }));

    const event = new KeyboardEvent("keydown", { key: "Escape" });
    window.dispatchEvent(event);

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("cycles focus from last to first on Tab press", () => {
    const ref = { current: container };
    renderHook(() => useFocusTrap(ref));

    btn2.focus();
    expect(document.activeElement).toBe(btn2);

    const event = new KeyboardEvent("keydown", { key: "Tab" });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(document.activeElement).toBe(btn1);
  });

  it("cycles focus from first to last on Shift+Tab press", () => {
    const ref = { current: container };
    renderHook(() => useFocusTrap(ref));

    btn1.focus();
    expect(document.activeElement).toBe(btn1);

    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(document.activeElement).toBe(btn2);
  });

  it("restores focus to previously active element on unmount", () => {
    const externalButton = document.createElement("button");
    document.body.appendChild(externalButton);
    externalButton.focus();

    const ref = { current: container };
    const { unmount } = renderHook(() => useFocusTrap(ref, { returnFocus: true }));

    unmount();
    expect(document.activeElement).toBe(externalButton);
    document.body.removeChild(externalButton);
  });
});
