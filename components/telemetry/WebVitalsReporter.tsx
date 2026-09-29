"use client";

import { useReportWebVitals } from "next/navigation";
import { sendWebVitalsMetric } from "@/lib/telemetry/webVitals";

export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    sendWebVitalsMetric(metric);
  });

  return null;
}
