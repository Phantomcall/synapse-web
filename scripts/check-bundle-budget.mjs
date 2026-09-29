import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve(".next/build-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const initialFiles = [
  ...new Set([...(manifest.rootMainFiles ?? []), ...(manifest.pages?.["/"] ?? [])]),
].filter((file) => file.endsWith(".js"));
const totalBytes = initialFiles.reduce(
  (total, file) => total + statSync(resolve(".next", file)).size,
  0
);
const budgetBytes = 750 * 1024;

console.log(`Initial route JavaScript: ${(totalBytes / 1024).toFixed(1)} KiB / 750 KiB`);
if (totalBytes > budgetBytes) {
  console.error("Initial route JavaScript exceeds the configured budget.");
  process.exitCode = 1;
}
