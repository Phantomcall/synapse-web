import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getMetricRating,
  shouldSample,
  sendWebVitalsMetric,
  type WebVitalsMetric,
} from "./webVitals";

describe("Core Web Vitals Telemetry Suite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getMetricRating Thresholds", () => {
    it("evaluates LCP correctly", () => {
      expect(getMetricRating("LCP", 2000)).toBe("good");
      expect(getMetricRating("LCP", 3200)).toBe("needs-improvement");
      expect(getMetricRating("LCP", 4500)).toBe("poor");
    });

    it("evaluates INP correctly", () => {
      expect(getMetricRating("INP", 150)).toBe("good");
      expect(getMetricRating("INP", 350)).toBe("needs-improvement");
      expect(getMetricRating("INP", 600)).toBe("poor");
    });

    it("evaluates CLS correctly", () => {
      expect(getMetricRating("CLS", 0.05)).toBe("good");
      expect(getMetricRating("CLS", 0.18)).toBe("needs-improvement");
      expect(getMetricRating("CLS", 0.35)).toBe("poor");
    });
  });

  describe("shouldSample", () => {
    it("always samples when sampleRate is 1.0", () => {
      expect(shouldSample(1.0)).toBe(true);
    });

    it("never samples when sampleRate is 0.0", () => {
      expect(shouldSample(0.0)).toBe(false);
    });

    it("evaluates deterministic random values", () => {
      expect(shouldSample(0.5, () => 0.4)).toBe(true);
      expect(shouldSample(0.5, () => 0.6)).toBe(false);
    });
  });

  describe("sendWebVitalsMetric Dispatch", () => {
    it("dispatches metric via navigator.sendBeacon when available", () => {
      const mockSendBeacon = vi.fn().mockReturnValue(true);
      (globalThis as any).navigator = { sendBeacon: mockSendBeacon };

      const metric: WebVitalsMetric = {
        id: "v1-12345",
        name: "LCP",
        value: 2100,
      };

      const result = sendWebVitalsMetric(metric, {
        endpoint: "/api/telemetry/vitals",
        sampleRate: 1.0,
      });

      expect(result).toBe(true);
      expect(mockSendBeacon).toHaveBeenCalled();
    });

    it("falls back to fetch when sendBeacon is not available", () => {
      delete (globalThis as any).navigator;
      const mockFetch = vi.fn().mockResolvedValue(new Response());
      globalThis.fetch = mockFetch;

      const metric: WebVitalsMetric = {
        id: "v1-67890",
        name: "CLS",
        value: 0.08,
      };

      const result = sendWebVitalsMetric(metric, {
        endpoint: "/api/telemetry/vitals",
        sampleRate: 1.0,
      });

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalled();
    });

    it("skips dispatch when disabled or sampled out", () => {
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      const metric: WebVitalsMetric = {
        id: "v1-00000",
        name: "FCP",
        value: 1200,
      };

      const result = sendWebVitalsMetric(metric, {
        enabled: false,
      });

      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
