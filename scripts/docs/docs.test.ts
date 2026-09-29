import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ABI_ENDPOINTS } from "../../lib/constants";
import { renderAbiHtml } from "./abi-reference.mjs";
import { renderMarkdown, safeHref } from "./markdown.mjs";

/**
 * The docs site (PR #175) generates its ABI reference from `lib/constants.ts`.
 * The failure modes worth testing are not "the generator broke" — the build
 * would throw — but the two quieter ones:
 *
 *   1. someone pastes a copy of the table into `docs/` and it starts drifting
 *      from the constant the app actually calls, and
 *   2. the renderer quietly mangles prose, or lets a bad href through.
 *
 * The generator's entry point is exercised as a subprocess so the test runs the
 * same code path the build does, `ts.transpileModule` round trip included,
 * rather than a parallel path that could diverge from it.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const BUILD = join(REPO_ROOT, "scripts", "docs", "build.mjs");
const ABI_CLI = join(REPO_ROOT, "scripts", "docs", "abi-reference.mjs");
const DOCS_DIR = join(REPO_ROOT, "docs");

function buildInto(out: string): void {
  execFileSync(process.execPath, [BUILD, "--out", out], { encoding: "utf8", cwd: REPO_ROOT });
}

/** Reads the generated table back as data, so it can be compared to the source. */
function parseRows(html: string) {
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => {
    const row = match[1] ?? "";
    const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((cellMatch) =>
      (cellMatch[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .trim()
    );
    return { name: cells[0], sig: cells[1], access: cells[2], desc: cells[3] };
  });
}

describe("docs ABI reference", () => {
  it("generates one row per endpoint, in source order", () => {
    const html = execFileSync(process.execPath, [ABI_CLI], { encoding: "utf8" });

    expect(parseRows(html).map((r) => r.name)).toEqual(ABI_ENDPOINTS.map((e) => e.name));
  });

  it("reproduces every field of every endpoint exactly", () => {
    const html = execFileSync(process.execPath, [ABI_CLI], { encoding: "utf8" });

    expect(parseRows(html)).toEqual(
      ABI_ENDPOINTS.map((e) => ({ name: e.name, sig: e.sig, access: e.access, desc: e.desc }))
    );
  });

  it("escapes endpoint content instead of letting it become markup", () => {
    const html = renderAbiHtml([
      { name: "<script>", sig: "f()", access: "public", desc: 'a "quoted" value & more' },
    ]);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).toContain("&amp;");
    // The table's own markup is real markup, not escaped text.
    expect(html).toContain('<table class="abi">');
  });
});

describe("docs/ stays generated", () => {
  it("keeps no hand-written copy of the table in contract-abi.md", () => {
    // The structural guarantee. Endpoint *names* appear in prose legitimately
    // ("the Transactions tab runs register_callback"), but a pasted copy of the
    // reference would bring signatures and a table with it.
    const source = readFileSync(join(DOCS_DIR, "contract-abi.md"), "utf8");

    const pasted = ABI_ENDPOINTS.filter((e) => source.includes(e.sig)).map((e) => e.sig);
    expect(pasted).toEqual([]);

    expect(source).not.toMatch(/^\s*\|/m);
    expect(source).not.toContain("<td>");
  });

  it("keeps the generation opt-in and the anchor", () => {
    const source = readFileSync(join(DOCS_DIR, "contract-abi.md"), "utf8");

    expect(source).toContain("generated: abi-reference");
    expect(source).toContain("<!-- generated:abi-reference -->");
  });

  it("renders every page and the generated table into static output", () => {
    const out = mkdtempSync(join(tmpdir(), "synapse-docs-"));
    try {
      buildInto(out);
      const pages = readdirSync(DOCS_DIR).filter((n) => n.endsWith(".md"));

      for (const name of pages) {
        const slug = name.replace(/\.md$/, "");
        const html = readFileSync(join(out, slug, "index.html"), "utf8");
        expect(html, `${slug} did not render`).toContain("<h1");
      }

      const abi = readFileSync(join(out, "contract-abi", "index.html"), "utf8");
      for (const endpoint of ABI_ENDPOINTS) {
        expect(abi).toContain(endpoint.name);
        expect(abi).toContain(endpoint.sig);
      }

      // Static hosts need the index reachable at the root as well.
      expect(readFileSync(join(out, "index.html"), "utf8")).toBe(
        readFileSync(join(out, "index", "index.html"), "utf8")
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("emits base-absolute links so page depth cannot break navigation", () => {
    const out = mkdtempSync(join(tmpdir(), "synapse-docs-"));
    try {
      buildInto(out);
      const page = readFileSync(join(out, "getting-started", "index.html"), "utf8");
      const hrefs = [...page.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? "");

      // A page served at /getting-started/ resolves "./architecture/" to
      // /getting-started/architecture/, which 404s. Nothing relative may survive.
      expect(hrefs.filter((h) => /^\.\.?\//.test(h))).toEqual([]);
      expect(hrefs).toContain("/architecture/");
      expect(hrefs).toContain("/architecture/#mock-data-and-the-live-path");
      expect(hrefs).toContain("/assets/site.css");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("honours --base for a sub-path deployment", () => {
    const out = mkdtempSync(join(tmpdir(), "synapse-docs-"));
    try {
      execFileSync(
        process.execPath,
        [BUILD, "--out", out, "--base", "/synapse-web/", "--site", "https://example.github.io"],
        { encoding: "utf8", cwd: REPO_ROOT }
      );
      const page = readFileSync(join(out, "index.html"), "utf8");

      expect(page).toContain('href="/synapse-web/assets/site.css"');
      expect(page).toContain('src="/synapse-web/assets/site.js"');
      expect(page).toContain('href="/synapse-web/contract-abi/"');
      expect(page).toContain('rel="canonical" href="https://example.github.io/synapse-web/index/"');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("fails the build on a link that names no page", () => {
    const out = mkdtempSync(join(tmpdir(), "synapse-docs-"));
    const copy = join(out, "docs");
    mkdirSync(copy);
    for (const name of readdirSync(DOCS_DIR).filter((n) => n.endsWith(".md"))) {
      writeFileSync(join(copy, name), readFileSync(join(DOCS_DIR, name), "utf8"));
    }
    try {
      const index = join(copy, "index.md");
      writeFileSync(
        index,
        readFileSync(index, "utf8").replace("./getting-started/", "./getting-startedd/")
      );

      expect(() =>
        execFileSync(process.execPath, [BUILD, "--docs", copy, "--out", join(out, "site")], {
          encoding: "utf8",
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        })
      ).toThrow(/does not name a page/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("fails the build rather than emitting stale or missing generated content", () => {
    const out = mkdtempSync(join(tmpdir(), "synapse-docs-"));
    const copy = join(out, "docs");
    mkdirSync(copy);
    for (const name of readdirSync(DOCS_DIR).filter((n) => n.endsWith(".md"))) {
      writeFileSync(join(copy, name), readFileSync(join(DOCS_DIR, name), "utf8"));
    }
    try {
      const run = () =>
        execFileSync(process.execPath, [BUILD, "--docs", copy, "--out", join(out, "site")], {
          encoding: "utf8",
          cwd: REPO_ROOT,
          // The next two cases are meant to fail; the build writes its error to
          // stderr and this test asserts on the thrown exit status.
          stdio: ["ignore", "pipe", "pipe"],
        });

      expect(run).not.toThrow();

      // The anchor was deleted: the table would silently disappear.
      const abi = join(copy, "contract-abi.md");
      writeFileSync(abi, readFileSync(abi, "utf8").replace("<!-- generated:abi-reference -->", ""));
      expect(run).toThrow(/generated:abi-reference/);

      // The opt-in was deleted: a hand-pasted table could take its place.
      writeFileSync(
        abi,
        readFileSync(abi, "utf8").replace("generated: abi-reference", "generated: none")
      );
      expect(run).toThrow(/expected exactly one page/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("markdown renderer", () => {
  it("leaves bare numbers in prose alone", () => {
    // Guards the inline placeholder: with a ` N ` sentinel, "31" and "0" here
    // would have been swallowed as code spans.
    const { html } = renderMarkdown("There were 31 tests and 0 failures.\n");

    expect(html).toBe("<p>There were 31 tests and 0 failures.</p>");
  });

  it("renders code spans literally", () => {
    const { html } = renderMarkdown("Use `npm run docs:build` and `<b>`.\n");

    expect(html).toBe("<p>Use <code>npm run docs:build</code> and <code>&lt;b&gt;</code>.</p>");
  });

  it("joins a wrapped list item instead of splitting it", () => {
    const { html } = renderMarkdown(
      "- `public` — read-only simulation. No wallet signature is\n  requested, ever.\n- `admin` — needs the admin.\n"
    );

    expect(html).toBe(
      "<ul>" +
        "<li><code>public</code> — read-only simulation. No wallet signature is requested, ever.</li>" +
        "<li><code>admin</code> — needs the admin.</li>" +
        "</ul>"
    );
  });

  it("gives headings ids and collects them for a table of contents", () => {
    const { html, headings } = renderMarkdown("## First section\n\n### Nested\n");

    expect(html).toContain('<h2 id="first-section">First section</h2>');
    expect(html).toContain('<h3 id="nested">Nested</h3>');
    expect(headings).toEqual([
      { level: 2, id: "first-section", text: "First section" },
      { level: 3, id: "nested", text: "Nested" },
    ]);
  });

  it("escapes text that looks like markup", () => {
    const { html } = renderMarkdown("A <script>alert(1)</script> tag.\n");

    expect(html).toBe("<p>A &lt;script&gt;alert(1)&lt;/script&gt; tag.</p>");
  });

  it("allows relative and absolute link targets", () => {
    expect(safeHref("./getting-started/", "t", 1)).toBe("./getting-started/");
    expect(safeHref("getting-started/", "t", 1)).toBe("getting-started/");
    expect(safeHref("#anchor", "t", 1)).toBe("#anchor");
    expect(safeHref("https://example.com/", "t", 1)).toBe("https://example.com/");
  });

  it("refuses link targets that would execute or escape the origin", () => {
    expect(() => safeHref("javascript:alert(1)", "t", 1)).toThrow(/refusing non-http/);
    expect(() => safeHref("data:text/html,<script>", "t", 1)).toThrow(/refusing non-http/);
    expect(() => safeHref("//evil.example", "t", 1)).toThrow(/protocol-relative/);
  });
});
