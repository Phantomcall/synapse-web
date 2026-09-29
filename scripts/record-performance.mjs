import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const reportDirectory = resolve(".lighthouseci");
const reportFiles = readdirSync(reportDirectory).filter((file) => /^lhr-.*\.json$/.test(file));
const report = reportFiles
  .map((file) => JSON.parse(readFileSync(resolve(reportDirectory, file), "utf8")))
  .find((item) => item.categories?.performance && item.audits?.["largest-contentful-paint"]);

if (!report) {
  throw new Error("No Lighthouse report with performance and Web Vitals metrics was found.");
}

const manifest = JSON.parse(readFileSync(resolve(".next/build-manifest.json"), "utf8"));
const initialFiles = [
  ...new Set([...(manifest.rootMainFiles ?? []), ...(manifest.pages?.["/"] ?? [])]),
].filter((file) => file.endsWith(".js"));
const bundleJsBytes = initialFiles.reduce(
  (total, file) => total + readFileSync(resolve(".next", file)).byteLength,
  0
);
const commit = (process.env.PERFORMANCE_COMMIT ?? process.env.GITHUB_SHA ?? "local").slice(0, 12);
const historyPath = resolve("public/performance/history.json");
const history = JSON.parse(readFileSync(historyPath, "utf8"));
const record = {
  date: new Date().toISOString(),
  commit,
  bundleJsBytes,
  lighthouseScore: Math.round(report.categories.performance.score * 100),
  lcpMs: Math.round(report.audits["largest-contentful-paint"].numericValue),
  cls: Number(report.audits["cumulative-layout-shift"].numericValue.toFixed(3)),
  tbtMs: Math.round(report.audits["total-blocking-time"].numericValue),
};
const updated = [...history.filter((item) => item.commit !== commit), record]
  .sort((left, right) => left.date.localeCompare(right.date))
  .slice(-100);

writeFileSync(historyPath, `${JSON.stringify(updated, null, 2)}\n`);
console.log(`Recorded Lighthouse and bundle metrics for ${commit}.`);
