#!/usr/bin/env node
// Dependency vulnerability gate (#153).
//
// Reads two `npm audit --json` reports — one for the production tree
// (`--omit=dev`) and one for the full tree — and fails when an advisory at or
// above the severity threshold for its scope is present and not covered by an
// unexpired entry in .github/audit-allowlist.json.
//
//   production dependencies (shipped in the bundle)  fail at >= high
//   dev-only dependencies (build/test tooling)        fail at >= critical
//
// Usage:
//   node scripts/ci/audit-gate.mjs --prod prod.json --full full.json \
//     [--allowlist .github/audit-allowlist.json] [--summary "$GITHUB_STEP_SUMMARY"]
//
// See docs/ci/dependency-audit.md for the threshold rationale and the
// exception process.

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

export const DEFAULT_THRESHOLDS = { production: "high", development: "critical" };

/**
 * Extracts the individual advisories from an `npm audit --json` (v2) report.
 * A vulnerability's `via` mixes advisory objects (the package is itself
 * vulnerable) with package-name strings (it only depends on a vulnerable
 * package); only the objects are advisories, and each is reported exactly once
 * against the package that carries it.
 *
 * @param {any} report
 * @returns {{ id: string, source: number | null, packageName: string, severity: string, title: string, url: string, range: string }[]}
 */
export function extractAdvisories(report) {
  if (!report || typeof report !== "object") return [];
  if (report.auditReportVersion !== 2) {
    throw new Error(
      `Unsupported npm audit report (auditReportVersion=${report.auditReportVersion}); expected 2`
    );
  }
  const seen = new Map();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      const id = advisoryId(via);
      const key = `${id}::${via.name ?? vuln.name}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        id,
        source: typeof via.source === "number" ? via.source : null,
        packageName: via.name ?? vuln.name,
        severity: via.severity ?? vuln.severity,
        title: via.title ?? "",
        url: via.url ?? "",
        range: via.range ?? "",
      });
    }
  }
  return [...seen.values()];
}

/** GHSA id from the advisory URL, falling back to the npm advisory number. */
export function advisoryId(via) {
  const match = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(via.url ?? "");
  if (match) return `GHSA${match[0].slice(4).toLowerCase()}`;
  return via.source != null ? `npm:${via.source}` : "unknown";
}

/**
 * Validates allowlist entries and splits them into active and expired.
 *
 * @param {any} allowlist
 * @param {Date} now
 */
export function parseAllowlist(allowlist, now) {
  const entries = Array.isArray(allowlist?.exceptions) ? allowlist.exceptions : [];
  const active = [];
  const expired = [];
  const invalid = [];
  for (const entry of entries) {
    const problems = [];
    if (typeof entry?.id !== "string" || !entry.id) problems.push("missing `id`");
    if (typeof entry?.reason !== "string" || !entry.reason.trim())
      problems.push("missing `reason`");
    if (typeof entry?.tracking !== "string" || !entry.tracking.trim())
      problems.push("missing `tracking` (issue/PR link)");
    const expires = new Date(entry?.expires);
    if (typeof entry?.expires !== "string" || Number.isNaN(expires.getTime()))
      problems.push("missing or invalid `expires` date");
    if (problems.length) {
      invalid.push({ entry, problems });
      continue;
    }
    (expires.getTime() < now.getTime() ? expired : active).push(entry);
  }
  return { active, expired, invalid };
}

/** An allowlist entry matches by advisory id, optionally narrowed to one package. */
function isCovered(advisory, activeEntries) {
  return activeEntries.find(
    (e) =>
      e.id.toUpperCase() === advisory.id.toUpperCase() &&
      (!e.package || e.package === advisory.packageName)
  );
}

/**
 * The gate decision. Pure: all I/O happens in the CLI wrapper below.
 *
 * @param {{ prodReport: any, fullReport: any, allowlist?: any, now?: Date, thresholds?: typeof DEFAULT_THRESHOLDS }} input
 */
export function evaluateAudit({
  prodReport,
  fullReport,
  allowlist = { exceptions: [] },
  now = new Date(),
  thresholds = DEFAULT_THRESHOLDS,
}) {
  const prod = extractAdvisories(prodReport);
  const prodKeys = new Set(prod.map((a) => `${a.id}::${a.packageName}`));
  const devOnly = extractAdvisories(fullReport).filter(
    (a) => !prodKeys.has(`${a.id}::${a.packageName}`)
  );
  const { active, expired, invalid } = parseAllowlist(allowlist, now);

  const findings = [
    ...prod.map((a) => ({ ...a, scope: "production" })),
    ...devOnly.map((a) => ({ ...a, scope: "development" })),
  ].map((a) => {
    const threshold = thresholds[a.scope];
    const blocking = (SEVERITY_RANK[a.severity] ?? 0) >= SEVERITY_RANK[threshold];
    const exception = blocking ? isCovered(a, active) : undefined;
    return { ...a, blocking, allowlisted: Boolean(exception), exception };
  });

  const failures = findings.filter((f) => f.blocking && !f.allowlisted);
  const matchedIds = new Set(findings.filter((f) => f.allowlisted).map((f) => f.exception.id));
  const unused = active.filter((e) => !matchedIds.has(e.id));

  return {
    ok: failures.length === 0 && invalid.length === 0,
    failures,
    allowlisted: findings.filter((f) => f.allowlisted),
    belowThreshold: findings.filter((f) => !f.blocking),
    expired,
    invalid,
    unused,
  };
}

export function formatSummary(result, thresholds = DEFAULT_THRESHOLDS) {
  const lines = [];
  lines.push(`## Dependency audit ${result.ok ? "passed ✅" : "failed ❌"}`);
  lines.push("");
  lines.push(
    `Thresholds: production dependencies fail at **${thresholds.production}**+, dev-only dependencies fail at **${thresholds.development}**+.`
  );
  const row = (f) =>
    `| ${f.severity} | ${f.scope} | \`${f.packageName}\` | [${f.id}](${f.url}) | ${f.title.replace(/\|/g, "\\|")} |`;
  const table = (title, rows) => {
    if (!rows.length) return;
    lines.push(
      "",
      `### ${title}`,
      "",
      "| Severity | Scope | Package | Advisory | Title |",
      "| --- | --- | --- | --- | --- |"
    );
    lines.push(...rows.map(row));
  };
  table("Blocking", result.failures);
  table("Allowed by exception", result.allowlisted);
  if (result.invalid.length) {
    lines.push("", "### Invalid allowlist entries", "");
    for (const { entry, problems } of result.invalid)
      lines.push(`- \`${entry?.id ?? "?"}\`: ${problems.join(", ")}`);
  }
  if (result.expired.length) {
    lines.push("", "### Expired exceptions (no longer applied)", "");
    for (const e of result.expired)
      lines.push(`- \`${e.id}\` expired ${e.expires} — ${e.tracking}`);
  }
  if (result.unused.length) {
    lines.push("", "### Unused exceptions (safe to delete)", "");
    for (const e of result.unused) lines.push(`- \`${e.id}\``);
  }
  lines.push(
    "",
    `${result.belowThreshold.length} advisories below threshold (reported by Dependabot, not blocking).`
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prod || !args.full) {
    console.error(
      "usage: audit-gate.mjs --prod <prod.json> --full <full.json> [--allowlist <file>] [--summary <file>]"
    );
    process.exit(2);
  }
  const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
  const result = evaluateAudit({
    prodReport: readJson(args.prod),
    fullReport: readJson(args.full),
    allowlist: readJson(args.allowlist ?? ".github/audit-allowlist.json"),
  });
  const summary = formatSummary(result);
  console.log(summary);
  if (args.summary) appendFileSync(args.summary, summary + "\n");
  for (const f of result.failures)
    console.log(
      `::error title=Vulnerable ${f.scope} dependency::${f.severity} ${f.id} in ${f.packageName}: ${f.title}`
    );
  for (const e of result.expired)
    console.log(`::warning title=Expired audit exception::${e.id} expired on ${e.expires}`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
