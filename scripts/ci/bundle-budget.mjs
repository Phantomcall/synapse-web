#!/usr/bin/env node
// Bundle-size budget gate (#155).
//
// Measures a finished `next build` and fails when any budget in
// bundle-budget.json is exceeded. Sizes are gzip (level 9) bytes: that is
// close to what browsers download, and unlike raw sizes it doesn't
// punish minifier-friendly repetition.
//
// Measured:
//   routes.<route>.js / .css  JS/CSS the route's prerendered HTML loads up front
//                             (every <script src> / stylesheet under /_next/static)
//   totalJs                   all client JS chunks, including lazy ones
//   largestChunk              the single largest client JS chunk
//
// Reading the prerendered HTML instead of a build manifest keeps this working
// across webpack and Turbopack, whose manifest formats differ.
//
// Usage: node scripts/ci/bundle-budget.mjs [--budget bundle-budget.json]
//          [--dir .next] [--json out.json] [--summary file]

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const gzipSize = (buf) => gzipSync(buf, { level: 9 }).length;

/** Route "/" → server/app/index.html, "/foo" → server/app/foo.html */
export function routeHtmlPath(distDir, route) {
  const name = route === "/" ? "index" : route.replace(/^\//, "");
  return path.join(distDir, "server", "app", `${name}.html`);
}

/** Unique /_next/static JS and CSS assets referenced by an HTML document. */
export function initialAssets(html) {
  const assets = new Set();
  for (const m of html.matchAll(
    /(?:src|href)="(\/_next\/static\/[^"?#]+\.(?:js|css))(?:[?#][^"]*)?"/g
  )) {
    assets.add(m[1]);
  }
  return [...assets];
}

/**
 * @param {string} distDir
 * @param {string[]} routes
 */
export function measureBuild(distDir, routes) {
  const staticDir = path.join(distDir, "static");
  const cache = new Map();
  const sizeOf = (asset) => {
    if (!cache.has(asset)) {
      const file = path.join(staticDir, asset.replace(/^\/_next\/static\//, ""));
      cache.set(asset, gzipSize(readFileSync(file)));
    }
    return cache.get(asset);
  };

  /** @type {Record<string, { js: number, css: number }>} */
  const routeSizes = {};
  for (const route of routes) {
    const htmlFile = routeHtmlPath(distDir, route);
    if (!existsSync(htmlFile)) {
      throw new Error(
        `No prerendered HTML for route ${route} at ${htmlFile}. Is the route static, and was \`next build\` run?`
      );
    }
    const assets = initialAssets(readFileSync(htmlFile, "utf8"));
    routeSizes[route] = {
      js: assets.filter((a) => a.endsWith(".js")).reduce((n, a) => n + sizeOf(a), 0),
      css: assets.filter((a) => a.endsWith(".css")).reduce((n, a) => n + sizeOf(a), 0),
    };
  }

  let totalJs = 0;
  let largestChunk = { file: "", size: 0 };
  const chunksDir = path.join(staticDir, "chunks");
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) {
        const size = gzipSize(readFileSync(full));
        totalJs += size;
        if (size > largestChunk.size) largestChunk = { file: path.relative(staticDir, full), size };
      }
    }
  };
  walk(chunksDir);

  return { routes: routeSizes, totalJs, largestChunk };
}

/**
 * Compares measurements with the budget. Pure.
 *
 * @param {ReturnType<typeof measureBuild>} measured
 * @param {{ routes?: Record<string, { js?: number, css?: number }>, totalJs?: number, largestChunk?: number }} budget
 */
export function checkBudget(measured, budget) {
  /** @type {{ metric: string, actual: number, limit: number, ok?: boolean }[]} */
  const rows = [];
  for (const [route, limits] of Object.entries(budget.routes ?? {})) {
    for (const kind of /** @type {const} */ (["js", "css"])) {
      if (limits[kind] == null) continue;
      rows.push({
        metric: `${route} initial ${kind.toUpperCase()}`,
        actual: measured.routes[route]?.[kind] ?? NaN,
        limit: limits[kind],
      });
    }
  }
  if (budget.totalJs != null)
    rows.push({ metric: "Total client JS", actual: measured.totalJs, limit: budget.totalJs });
  if (budget.largestChunk != null)
    rows.push({
      metric: `Largest chunk (${measured.largestChunk.file})`,
      actual: measured.largestChunk.size,
      limit: budget.largestChunk,
    });

  for (const row of rows) row.ok = Number.isFinite(row.actual) && row.actual <= row.limit;
  return { ok: rows.every((r) => r.ok), rows };
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

export function formatSummary(result) {
  const lines = [
    `## Bundle-size budget ${result.ok ? "passed ✅" : "exceeded ❌"}`,
    "",
    "Gzipped sizes. Budgets live in `bundle-budget.json`.",
    "",
    "| Metric | Size | Budget | Headroom | |",
    "| --- | ---: | ---: | ---: | --- |",
  ];
  for (const r of result.rows) {
    const headroom = r.limit - r.actual;
    lines.push(
      `| ${r.metric} | ${kb(r.actual)} | ${kb(r.limit)} | ${headroom >= 0 ? "" : "−"}${kb(Math.abs(headroom))} | ${r.ok ? "✅" : "❌"} |`
    );
  }
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  };
  const budget = JSON.parse(readFileSync(opt("budget", "bundle-budget.json"), "utf8"));
  const measured = measureBuild(opt("dir", ".next"), Object.keys(budget.routes ?? {}));
  const result = checkBudget(measured, budget);
  const summary = formatSummary(result);
  console.log(summary);
  const jsonOut = opt("json");
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ measured, result }, null, 2));
  const summaryFile = opt("summary");
  if (summaryFile) appendFileSync(summaryFile, summary + "\n");
  for (const r of result.rows.filter((row) => !row.ok))
    console.log(
      `::error title=Bundle budget exceeded::${r.metric}: ${kb(r.actual)} > ${kb(r.limit)}`
    );
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
