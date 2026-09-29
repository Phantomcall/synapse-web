export interface WebVitalsMetric {
  id: string;
  name: "FCP" | "LCP" | "CLS" | "FID" | "TTFB" | "INP" | string;
  value: number;
  rating?: "good" | "needs-improvement" | "poor";
  delta?: number;
  navigationType?: string;
  entries?: PerformanceEntry[];
}

export interface TelemetryConfig {
  endpoint?: string;
  sampleRate?: number;
  enabled?: boolean;
  debug?: boolean;
}

export const WEB_VITALS_THRESHOLDS = {
  LCP: { good: 2500, poor: 4000 }, // Largest Contentful Paint (ms)
  INP: { good: 200, poor: 500 }, // Interaction to Next Paint (ms)
  CLS: { good: 0.1, poor: 0.25 }, // Cumulative Layout Shift (unitless)
  FCP: { good: 1800, poor: 3000 }, // First Contentful Paint (ms)
  TTFB: { good: 800, poor: 1800 }, // Time to First Byte (ms)
  FID: { good: 100, poor: 300 }, // First Input Delay (ms)
} as const;

/**
 * Classifies a Web Vital metric value against defined Core Web Vitals thresholds.
 */
export function getMetricRating(
  name: string,
  value: number
): "good" | "needs-improvement" | "poor" {
  const threshold = WEB_VITALS_THRESHOLDS[name as keyof typeof WEB_VITALS_THRESHOLDS];
  if (!threshold) return "good";

  if (value <= threshold.good) {
    return "good";
  }
  if (value <= threshold.poor) {
    return "needs-improvement";
  }
  return "poor";
}

/**
 * Determines whether the current session should report telemetry based on sampling rate.
 */
export function shouldSample(
  sampleRate: number = 1.0,
  randomGenerator: () => number = Math.random
): boolean {
  if (sampleRate >= 1.0) return true;
  if (sampleRate <= 0.0) return false;
  return randomGenerator() < sampleRate;
}

/**
 * Formats and dispatches a Web Vital metric to the configured telemetry endpoint.
 */
export function sendWebVitalsMetric(
  metric: WebVitalsMetric,
  config: TelemetryConfig = {}
): boolean {
  const {
    endpoint = process.env.NEXT_PUBLIC_TELEMETRY_ENDPOINT ?? "/api/telemetry/vitals",
    sampleRate = Number(process.env.NEXT_PUBLIC_TELEMETRY_SAMPLE_RATE ?? "1.0"),
    enabled = process.env.NODE_ENV !== "test" ? true : true,
    debug = Boolean(process.env.NEXT_PUBLIC_TELEMETRY_DEBUG),
  } = config;

  if (!enabled) return false;
  if (!shouldSample(sampleRate)) return false;

  const rating = metric.rating || getMetricRating(metric.name, metric.value);
  const payload = {
    id: metric.id,
    name: metric.name,
    value: Math.round(metric.value * 100) / 100,
    rating,
    delta: metric.delta,
    navigationType: metric.navigationType,
    url: typeof window !== "undefined" ? window.location.pathname : "",
    timestamp: Date.now(),
  };

  if (debug && typeof console !== "undefined") {
    console.log(
      `[Telemetry:WebVitals] ${payload.name}=${payload.value} (${payload.rating})`,
      payload
    );
  }

  // Use Navigator.sendBeacon if available, fallback to fetch with keepalive
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      const sent = navigator.sendBeacon(endpoint, blob);
      if (sent) return true;
    } catch {
      // Beacon failed, proceed to fetch fallback
    }
  }

  if (typeof fetch === "function") {
    try {
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {
        // Non-blocking telemetry error suppression
      });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}
