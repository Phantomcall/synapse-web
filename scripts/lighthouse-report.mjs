/**
 * Builds the browsable per-PR Lighthouse report and the base-branch comparison.
 *
 * Inputs (both are `lhci upload --target filesystem` output directories):
 *   argv[2]  head manifest path, or "-" to compare against nothing
 *   argv[3]  base manifest path, optional
 *
 * Outputs, under argv[4] (default `.lighthouseci/report`):
 *   index.html    browsable index: per-route cards, per-category deltas, links
 *                 into the full Lighthouse HTML reports
 *   summary.md    the same table, for pasting into a PR comment
 *
 * Written as a dependency-free ESM script on purpose: it runs inside a CI job
 * that has just done `npm ci`, and a report generator that can itself fail to
 * install is a bad trade for something whose only job is to format numbers.
 *
 * Manifest shape, as actually emitted by `@lhci/cli` 0.14 (verified by running
 * it, not assumed):
 *
 *   { runs: [ { url, isRepresentativeRun, htmlPath, jsonPath,
 *               summary: { performance, accessibility, best-practices, seo } } ] }
 *
 * Three things differ from the older/looser shape and are read defensively:
 *   - scores live under `summary`, not at the top level of the run;
 *   - the representative flag is `isRepresentativeRun`, not `isRepresentative`;
 *   - `htmlPath` is a plain absolute path, not a `file://` URL.
 * Older LHCI releases used the alternatives, so both are accepted. Getting this
 * wrong is not a crash — it renders a report full of em dashes, which is
 * exactly the kind of quietly-empty report this script exists to prevent.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

const CATEGORY_LABELS = {
  performance: "Performance",
  accessibility: "Accessibility",
  "best-practices": "Best Practices",
  seo: "SEO",
};

const COLORS = { up: "#1a7f37", down: "#cf222e", flat: "#656d76" };

/** `path.sep`, so a generated href is always forward-slashed. */
const pathSeparator = sep;

/** Reads an LHCI manifest in either supported shape. */
function readManifest(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const runs = Array.isArray(raw) ? raw : raw.runs;
  if (!Array.isArray(runs)) {
    throw new Error(`${path}: expected an array of runs or an object with a "runs" array`);
  }
  return runs;
}

/**
 * Turns an audited URL into a route label.
 *
 * Labels come from the URL path, never from a hard-coded list, so a route the
 * app adds shows up under its own name without editing this file.
 */
function labelFor(url) {
  const path = String(url).replace(/^https?:\/\/[^/]+/, "") || "/";
  const segment = path.split("?")[0].replace(/\/+$/, "");
  return segment === "" || segment === "/" ? "/ (root)" : segment;
}

function keyFor(url) {
  return labelFor(url);
}

/** Category score for a run, tolerating both known manifest shapes. */
function scoreOf(run, category) {
  const fromSummary = run.summary ? run.summary[category] : undefined;
  if (typeof fromSummary === "number") return fromSummary;
  return typeof run[category] === "number" ? run[category] : null;
}

function isRepresentative(run) {
  return run.isRepresentativeRun === true || run.isRepresentative === true;
}

/** Representative run per route: LHCI marks it, or fall back to the median. */
function representativeRuns(runs) {
  const byRoute = new Map();
  for (const run of runs) {
    const key = keyFor(run.url);
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key).push(run);
  }

  const out = [];
  for (const [route, routeRuns] of byRoute) {
    const usable = routeRuns.filter((r) => scoreOf(r, "performance") !== null);
    const usableByScore = [...usable].sort(
      (a, b) => (scoreOf(a, "performance") ?? 0) - (scoreOf(b, "performance") ?? 0)
    );

    let chosen = routeRuns.find(isRepresentative);
    if (!chosen) {
      // No representative flag (older LHCI, or every run errored). The median
      // of the runs that produced a score is the least-noisy pick available.
      chosen = usableByScore[Math.floor(usableByScore.length / 2)] ?? routeRuns[0];
    }
    out.push({ route, run: chosen, total: routeRuns.length });
  }
  return out;
}

function formatDelta(delta) {
  if (delta === null || Number.isNaN(delta)) return "—";
  const points = Math.round(delta * 100);
  if (points === 0) return "±0";
  return `${points > 0 ? "+" : ""}${points}`;
}

function deltaColor(delta) {
  if (delta === null || Number.isNaN(delta) || Math.round(delta * 100) === 0) return COLORS.flat;
  return delta > 0 ? COLORS.up : COLORS.down;
}

/** Resolves an LHCI `htmlPath` to a path on disk. Accepts a bare path or a `file://` URL. */
function htmlPathFor(run) {
  const raw = run.htmlPath;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const withoutScheme = raw.replace(/^file:\/\//, "");
  let abs;
  try {
    abs = resolve(decodeURI(withoutScheme));
  } catch {
    return null;
  }
  return existsSync(abs) ? abs : null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A run that errored has no scores; surface that instead of showing 0.
 *
 * @lhci/cli 0.14 puts the failure in `lhrRuntimeError`; older releases omit the
 * run entirely and newer ones use `runtimeError`. A run that produced no
 * category score at all is also treated as failed, which catches a malformed
 * manifest that would otherwise render as a row of confident zeroes.
 */
function runError(run) {
  const err = run.lhrRuntimeError || run.runtimeError;
  if (err) return err.message || "Lighthouse runtime error";
  if (scoreOf(run, "performance") === null) return "no scores in manifest";
  return null;
}

function scoreClass(score) {
  if (typeof score !== "number") return "na";
  if (score >= 0.9) return "good";
  if (score >= 0.5) return "ok";
  return "bad";
}

function buildSummary(head, base) {
  const baseByRoute = new Map(base.map((b) => [b.route, b.run]));

  const lines = [];
  lines.push("### Lighthouse — per-route scores vs base branch");
  lines.push("");
  lines.push("| Route | " + CATEGORIES.map((c) => CATEGORY_LABELS[c]).join(" | ") + " | Runs |");
  lines.push("| --- | " + CATEGORIES.map(() => "---").join(" | ") + " | --- |");

  for (const { route, run, total } of head) {
    const previous = baseByRoute.get(route);
    const error = runError(run);
    if (error) {
      lines.push(`| \`${route}\` | **audit failed**: ${escapeHtml(error)} | ${total} |`);
      continue;
    }
    const cells = CATEGORIES.map((category) => {
      const score = scoreOf(run, category);
      if (score === null) return "—";
      const pct = Math.round(score * 100);
      const before = previous ? scoreOf(previous, category) : null;
      if (before === null) return `${pct}`;
      return `${pct} (${formatDelta(score - before)})`;
    });
    lines.push(`| \`${route}\` | ${cells.join(" | ")} | ${total} |`);
  }

  if (base.length > 0) {
    const headRoutes = new Set(head.map((h) => h.route));
    const onlyInBase = base.filter((b) => !headRoutes.has(b.route));
    if (onlyInBase.length > 0) {
      lines.push("");
      lines.push(
        `> Routes present on the base branch but not in this build: ${onlyInBase
          .map((b) => `\`${b.route}\``)
          .join(", ")}. That usually means a route was removed or renamed.`
      );
    }
  } else {
    lines.push("");
    lines.push("> No base-branch baseline available for this run; scores are absolute.");
  }

  lines.push("");
  lines.push(
    base.length > 0
      ? "Deltas are this PR against the merge base, in Lighthouse score points (100 = perfect)."
      : "Scores are 0–100 per category."
  );
  return lines.join("\n");
}

function buildHtml(head, base, outDir) {
  const baseByRoute = new Map(base.map((b) => [b.route, b.run]));

  const cards = head
    .map(({ route, run, total }) => {
      const error = runError(run);
      const previous = baseByRoute.get(route);
      const html = htmlPathFor(run);

      const scoreCells = CATEGORIES.map((category) => {
        const score = scoreOf(run, category);
        const label = CATEGORY_LABELS[category];
        if (score === null) {
          return `<div class="score na"><span class="n">—</span><span class="l">${label}</span></div>`;
        }
        const pct = Math.round(score * 100);
        const before = previous ? scoreOf(previous, category) : null;
        const delta = before === null ? null : score - before;
        return `<div class="score ${scoreClass(score)}">
            <span class="n">${pct}</span>
            <span class="l">${label}</span>
            <span class="d" style="color:${deltaColor(delta)}">${
              delta === null ? "new" : formatDelta(delta)
            }</span>
          </div>`;
      }).join("");

      return `<section class="card">
        <header>
          <h2>${escapeHtml(route)}</h2>
          <span class="meta">${total} run${total === 1 ? "" : "s"}</span>
        </header>
        ${
          error
            ? `<p class="err">Audit failed: ${escapeHtml(error)}</p>`
            : `<div class="scores">${scoreCells}</div>`
        }
        ${
          html
            ? // Relative to the directory index.html itself is written into, so
              // the link works when the whole tree is served from the artifact
              // root. Anchoring on process.cwd() instead silently breaks the
              // link whenever the report is written outside the cwd.
              `<a class="full" href="${escapeHtml(
                relative(outDir, html).split(pathSeparator).join("/")
              )}">Open full Lighthouse report &rarr;</a>`
            : `<p class="meta">Full report not found in the artifact.</p>`
        }
      </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lighthouse report — per-route</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0; padding: 32px; background: #f6f8fa; color: #1f2328; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #656d76; margin: 0 0 28px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; max-width: 1200px; }
  .card { background: #fff; border: 1px solid #d1d9e0; border-radius: 8px; padding: 16px 18px; }
  .card header { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 1px solid #eaeef2; padding-bottom: 10px; margin-bottom: 14px; }
  .card h2 { font-size: 15px; margin: 0; font-family: ui-monospace, monospace; }
  .meta { color: #656d76; font-size: 12px; }
  .scores { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .score { text-align: center; border-radius: 6px; padding: 10px 4px; }
  .score .n { display: block; font-size: 22px; font-weight: 700; }
  .score .l { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; opacity: .8; }
  .score .d { display: block; font-size: 11px; margin-top: 4px; }
  .score.good { background: #dafbe1; color: #0a5228; }
  .score.ok { background: #fff8c5; color: #6a4b00; }
  .score.bad { background: #ffebe9; color: #82071e; }
  .score.na { background: #eaeef2; color: #656d76; }
  .full { display: inline-block; margin-top: 14px; color: #0969da; text-decoration: none; font-weight: 600; }
  .full:hover { text-decoration: underline; }
  .err { color: #82071e; background: #ffebe9; border-radius: 6px; padding: 10px 12px; }
  footer { margin-top: 28px; color: #656d76; font-size: 12px; max-width: 1200px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    .card { background: #161b22; border-color: #30363d; }
    .card header { border-color: #21262d; }
    .full { color: #4493f8; }
  }
</style>
</head>
<body>
  <h1>Lighthouse — per-route scores</h1>
  <p class="sub">${
    base.length > 0
      ? "Deltas compare this build against the PR merge base, in score points (100 = perfect)."
      : "No base-branch baseline for this run; scores are absolute."
  }</p>
  <div class="grid">
${cards}
  </div>
  <footer>
    Audited with <code>@lhci/cli</code> against a production <code>next start</code> build.
    Each route is a separately prerendered page, so these are distinct measurements.
    Score bands: &ge;90 good, &ge;50 needs improvement, below 50 poor.
  </footer>
</body>
</html>
`;
}

function main() {
  const headPath = process.argv[2];
  const basePath = process.argv[3];
  const outDir = process.argv[4] || join(".lighthouseci", "report");

  if (!headPath) {
    throw new Error("usage: lighthouse-report.mjs <head-manifest> [base-manifest] [out-dir]");
  }

  const head = representativeRuns(readManifest(headPath));
  const base = basePath && existsSync(basePath) ? representativeRuns(readManifest(basePath)) : [];

  mkdirSync(outDir, { recursive: true });

  const summary = buildSummary(head, base);
  const html = buildHtml(head, base, resolve(outDir));

  writeFileSync(join(outDir, "index.html"), html);
  writeFileSync(join(outDir, "summary.md"), `${summary}\n`);

  // The PR-comment step reads this file rather than parsing the HTML.
  const meta = {
    routes: head.map(({ route, total }) => ({ route, runs: total })),
    hasBaseline: base.length > 0,
    comparedRoutes: base.map((b) => b.route),
    failedRuns: head.filter((h) => runError(h.run)).map((h) => h.route),
  };
  writeFileSync(join(outDir, "report-meta.json"), JSON.stringify(meta, null, 2));

  const artifacts = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => f.endsWith(".html"))
    : [];
  console.log(
    `lighthouse-report: ${head.length} route(s) audited, baseline ${base.length}, ` +
      `${artifacts.length} HTML file(s) written to ${outDir}`
  );
  for (const route of meta.failedRuns)
    console.log(`lighthouse-report: WARNING failed route ${route}`);
  if (meta.failedRuns.length > 0) process.exitCode = 2;
}

main();
