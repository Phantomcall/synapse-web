import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkInstalledExtensions } from "./detection";

describe("Wallet Extension Detection Utility", () => {
  const originalWindow = { ...globalThis.window };

  beforeEach(() => {
    // Reset window object properties
    delete (window as any).freighterApi;
    delete (window as any).freighter;
    delete (window as any).xBull;
    delete (window as any).xbull;
    delete (window as any).xBullWallet;
    delete (window as any).stellar;
    delete (window as any).albedo;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns all false when no extension is present in window", () => {
    const result = checkInstalledExtensions();
    expect(result.freighter).toBe(false);
    expect(result.xbull).toBe(false);
    expect(result.albedo).toBe(false);
    expect(result.hasAny).toBe(false);
  });

  it("detects Freighter via freighterApi", () => {
    (window as any).freighterApi = { isAllowed: () => true };
    const result = checkInstalledExtensions();
    expect(result.freighter).toBe(true);
    expect(result.hasAny).toBe(true);
  });

  it("detects Freighter via window.freighter", () => {
    (window as any).freighter = { isConnected: () => true };
    const result = checkInstalledExtensions();
    expect(result.freighter).toBe(true);
    expect(result.hasAny).toBe(true);
  });

  it("detects xBull via window.xBull", () => {
    (window as any).xBull = {};
    const result = checkInstalledExtensions();
    expect(result.xbull).toBe(true);
    expect(result.hasAny).toBe(true);
  });

  it("detects xBull via window.xbull or xBullWallet", () => {
    (window as any).xBullWallet = {};
    const result = checkInstalledExtensions();
    expect(result.xbull).toBe(true);
    expect(result.hasAny).toBe(true);
  });

  it("detects Albedo via window.albedo", () => {
    (window as any).albedo = {};
    const result = checkInstalledExtensions();
    expect(result.albedo).toBe(true);
    expect(result.hasAny).toBe(true);
  });

  it("detects multiple extensions installed simultaneously", () => {
    (window as any).freighter = {};
    (window as any).xBull = {};
    const result = checkInstalledExtensions();
    expect(result.freighter).toBe(true);
    expect(result.xbull).toBe(true);
    expect(result.hasAny).toBe(true);
  });
});
