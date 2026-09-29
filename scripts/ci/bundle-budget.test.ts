import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkBudget,
  formatSummary,
  gzipSize,
  initialAssets,
  measureBuild,
  routeHtmlPath,
} from "./bundle-budget.mjs";

describe("initialAssets", () => {
  it("collects unique static JS and CSS referenced by the HTML", () => {
    const html = `
      <link rel="stylesheet" href="/_next/static/chunks/a.css" data-precedence="next"/>
      <link rel="preload" as="script" href="/_next/static/chunks/main.js"/>
      <script src="/_next/static/chunks/main.js" async=""></script>
      <script src="/_next/static/chunks/page.js?dpl=abc"></script>
      <img src="/_next/static/media/logo.png"/>
      <script src="https://cdn.example.com/x.js"></script>`;
    expect(initialAssets(html)).toEqual([
      "/_next/static/chunks/a.css",
      "/_next/static/chunks/main.js",
      "/_next/static/chunks/page.js",
    ]);
  });
});

describe("routeHtmlPath", () => {
  it("maps routes onto prerendered HTML files", () => {
    expect(routeHtmlPath(".next", "/")).toBe(path.join(".next", "server", "app", "index.html"));
    expect(routeHtmlPath(".next", "/transactions")).toBe(
      path.join(".next", "server", "app", "transactions.html")
    );
  });
});

describe("measureBuild", () => {
  function fakeBuild() {
    const dir = mkdtempSync(path.join(tmpdir(), "bundle-budget-"));
    mkdirSync(path.join(dir, "server", "app"), { recursive: true });
    mkdirSync(path.join(dir, "static", "chunks", "app"), { recursive: true });
    const main = "console.log('main');".repeat(50);
    const lazy = "console.log('lazy');".repeat(500);
    const css = "body{color:red}";
    writeFileSync(path.join(dir, "static", "chunks", "main.js"), main);
    writeFileSync(path.join(dir, "static", "chunks", "app", "lazy.js"), lazy);
    writeFileSync(path.join(dir, "static", "chunks", "a.css"), css);
    writeFileSync(
      path.join(dir, "server", "app", "index.html"),
      `<link rel="stylesheet" href="/_next/static/chunks/a.css"/><script src="/_next/static/chunks/main.js"></script>`
    );
    return { dir, main, lazy, css };
  }

  it("sums initial assets per route and all chunks for the total", () => {
    const { dir, main, lazy, css } = fakeBuild();
    const measured = measureBuild(dir, ["/"]);
    expect(measured.routes["/"]).toEqual({
      js: gzipSize(Buffer.from(main)),
      css: gzipSize(Buffer.from(css)),
    });
    expect(measured.totalJs).toBe(gzipSize(Buffer.from(main)) + gzipSize(Buffer.from(lazy)));
    expect(measured.largestChunk.file).toBe(path.join("chunks", "app", "lazy.js"));
  });

  it("fails loudly when a budgeted route was not prerendered", () => {
    const { dir } = fakeBuild();
    expect(() => measureBuild(dir, ["/missing"])).toThrow(
      /No prerendered HTML for route \/missing/
    );
  });
});

describe("checkBudget", () => {
  const measured = {
    routes: { "/": { js: 1000, css: 100 } },
    totalJs: 1500,
    largestChunk: { file: "chunks/x.js", size: 800 },
  };

  it("passes when every metric is within budget", () => {
    const result = checkBudget(measured, {
      routes: { "/": { js: 1000, css: 200 } },
      totalJs: 2000,
      largestChunk: 800,
    });
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(4);
  });

  it("fails on any single metric over budget", () => {
    const result = checkBudget(measured, { routes: { "/": { js: 999 } }, totalJs: 2000 });
    expect(result.ok).toBe(false);
    expect(result.rows.filter((r) => !r.ok).map((r) => r.metric)).toEqual(["/ initial JS"]);
  });

  it("fails when a budgeted route has no measurement", () => {
    expect(checkBudget(measured, { routes: { "/other": { js: 10 } } }).ok).toBe(false);
  });

  it("renders a markdown table with negative headroom on failure", () => {
    const summary = formatSummary(checkBudget(measured, { totalJs: 1024 }));
    expect(summary).toContain("exceeded");
    expect(summary).toContain("| Total client JS | 1.5 KB | 1.0 KB | −0.5 KB | ❌ |");
  });
});
