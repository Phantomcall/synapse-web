#!/usr/bin/env node
/**
 * Builds the static documentation site from `docs/*.md` into `docs-dist/`.
 *
 *   node scripts/docs/build.mjs [--out docs-dist] [--base /]
 *
 * No bundler, no framework, no new dependencies. The output is plain HTML plus
 * one stylesheet and one script, suitable for GitHub Pages, S3, or any static
 * host. See PR #175 for why an SSG was not adopted here.
 *
 * `docs/contract-abi.md` carries a `<!-- generated:abi-reference -->` marker
 * that is replaced with HTML produced by `abi-reference.mjs`, which reads
 * `lib/constants.ts`. The ABI reference therefore has exactly one source of
 * truth; see that file for the details.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname, basename, extname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { escapeHtml, parseFrontMatter, renderMarkdown } from "./markdown.mjs";
import { generateAbiReference, ABI_MARKER } from "./abi-reference.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DOCS_DIR = join(REPO_ROOT, "docs");

/**
 * Bare origin of the published site, for canonical URLs. The path part is
 * `--base`, so the two do not overlap: GitHub Pages serves this project at
 * https://synapse-bridgez.github.io/synapse-web/, which is
 * origin + base.
 */
const DEFAULT_SITE = "https://synapse-bridgez.github.io";

/** Brand tokens mirror lib/constants.ts so the site looks like the app. */
const THEME = {
  bg0: "#0A0B0D",
  bg1: "#0F1115",
  bg2: "#14171D",
  bg3: "#1A1E26",
  amber: "#F5A623",
  dim: "rgba(255,255,255,0.45)",
};

function parseArgs(argv) {
  const options = { out: "docs-dist", base: "/", docs: DOCS_DIR, site: DEFAULT_SITE };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") options.out = argv[++i];
    else if (argv[i] === "--base") options.base = argv[++i];
    else if (argv[i] === "--docs") options.docs = resolve(argv[++i]);
    else if (argv[i] === "--site") options.site = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!options.base.startsWith("/")) options.base = `/${options.base}`;
  if (!options.base.endsWith("/")) options.base += "/";
  options.site = options.site.replace(/\/+$/, "");
  return options;
}

/** Reads `docs/*.md`, rejecting anything that would produce a broken nav. */
export function loadPages(directory) {
  if (!existsSync(directory)) throw new Error(`no docs directory at ${directory}`);

  const pages = readdirSync(directory)
    .filter((name) => extname(name) === ".md")
    .filter((name) => statSync(join(directory, name)).isFile())
    .map((name) => {
      const file = join(directory, name);
      const { attributes, body } = parseFrontMatter(readFileSync(file, "utf8"), name);
      for (const key of ["title", "order"]) {
        if (!attributes[key]) throw new Error(`docs/${name} is missing front matter "${key}"`);
      }
      return {
        source: name,
        slug: basename(name, ".md"),
        title: attributes.title,
        description: attributes.description ?? "",
        order: Number(attributes.order),
        // "abi-reference" opts the page into build-time generation from
        // lib/constants.ts. See abi-reference.mjs.
        generated: attributes.generated,
        body,
      };
    });

  pages.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));

  const slugs = new Set();
  for (const page of pages) {
    if (slugs.has(page.slug)) throw new Error(`duplicate docs slug "${page.slug}"`);
    slugs.add(page.slug);
  }
  if (!pages.some((page) => page.slug === "index")) {
    throw new Error("docs/index.md is required");
  }
  return pages;
}

function renderToc(headings) {
  const items = headings.filter((h) => h.level === 2 || h.level === 3);
  if (items.length < 2) return "";
  return (
    '<nav class="toc" aria-label="On this page"><p class="toc-title">ON THIS PAGE</p><ul>' +
    items
      .map(
        (h) =>
          `<li class="toc-h${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`
      )
      .join("") +
    "</ul></nav>"
  );
}

function renderNav(pages, current, base) {
  return (
    '<nav class="sidebar" aria-label="Documentation"><p class="sidebar-title">SYNAPSE CORE · DOCS</p><ul>' +
    pages
      .map((page) => {
        const active = page.slug === current;
        return `<li><a href="${base}${escapeHtml(page.slug)}/"${
          active ? ' aria-current="page"' : ""
        } class="${active ? "active" : ""}">${escapeHtml(page.title)}</a></li>`;
      })
      .join("") +
    "</ul>" +
    '<p class="sidebar-foot">Built from <code>docs/</code> in the repository.<br />' +
    "The interactive ABI playground lives in the app, not here.</p></nav>"
  );
}

function layout({ page, base, site, allPages }) {
  const canonical = new URL(base + page.slug + "/", `${site}/`).href;
  const prev = allPages[page.index - 1];
  const next = allPages[page.index + 1];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(page.title)} · Synapse Core Docs</title>
<meta name="description" content="${escapeHtml(page.description || `Synapse Core documentation: ${page.title}.`)}" />
<link rel="canonical" href="${escapeHtml(canonical)}" />
<link rel="stylesheet" href="${base}assets/site.css" />
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<div class="wrap">
${renderNav(allPages, page.slug, base)}
<main id="content" class="content">
<article>
<p class="eyebrow">SYNAPSE CORE · TESTNET</p>
<h1 class="page-title">${escapeHtml(page.title)}</h1>
${page.description ? `<p class="lede">${escapeHtml(page.description)}</p>` : ""}
${renderToc(page.headings)}
${page.html}
</article>
<nav class="pager" aria-label="Pagination">
${
  prev
    ? `<a href="${base}${escapeHtml(prev.slug)}/" rel="prev">&larr; ${escapeHtml(prev.title)}</a>`
    : "<span></span>"
}
${
  next
    ? `<a href="${base}${escapeHtml(next.slug)}/" rel="next">${escapeHtml(next.title)} &rarr;</a>`
    : "<span></span>"
}
</nav>
</main>
</div>
<footer class="site-foot">
<span>SYNAPSE CORE DOCS · v0.1.0 · TESTNET</span>
<span>Source: <a href="https://github.com/Synapse-bridgez/synapse-web">Synapse-bridgez/synapse-web</a></span>
</footer>
<script src="${base}assets/site.js" defer></script>
</body>
</html>
`;
}

const STYLESHEET = `/* Synapse Core docs. Tokens mirror lib/constants.ts. */
:root {
  --bg0: ${THEME.bg0};
  --bg1: ${THEME.bg1};
  --bg2: ${THEME.bg2};
  --bg3: ${THEME.bg3};
  --amber: ${THEME.amber};
  --dim: ${THEME.dim};
  --border: rgba(245, 166, 35, 0.15);
  --mono: ui-monospace, "IBM Plex Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg0);
  color: #fff;
  font-family: var(--mono);
  font-size: 14px;
  line-height: 1.7;
}
.skip { position: absolute; left: -9999px; }
.skip:focus { left: 8px; top: 8px; background: var(--amber); color: #000; padding: 8px; z-index: 10; }
a { color: var(--amber); }
a:hover { color: #ffd27a; }
.wrap { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 32px; max-width: 1180px; margin: 0 auto; padding: 24px; }
@media (max-width: 860px) { .wrap { grid-template-columns: 1fr; } }
.sidebar { position: sticky; top: 24px; align-self: start; border: 1px solid var(--border); background: var(--bg1); padding: 16px; }
.sidebar-title, .toc-title { font-size: 10px; letter-spacing: 0.16em; color: var(--dim); margin: 0 0 10px; }
.sidebar ul { list-style: none; margin: 0; padding: 0; }
.sidebar li { margin: 0; }
.sidebar a { display: block; padding: 7px 10px; text-decoration: none; color: var(--dim); font-size: 12px; }
.sidebar a:hover { background: var(--bg3); color: #fff; }
.sidebar a.active { background: rgba(245, 166, 35, 0.1); color: var(--amber); border-left: 2px solid var(--amber); }
.sidebar-foot { font-size: 10px; color: var(--dim); line-height: 1.6; margin: 14px 0 0; border-top: 1px solid var(--border); padding-top: 12px; }
.content { min-width: 0; }
.eyebrow { font-size: 10px; letter-spacing: 0.18em; color: var(--dim); margin: 0 0 6px; }
.page-title { font-size: 30px; margin: 0 0 8px; letter-spacing: -0.01em; }
.lede { color: var(--dim); margin: 0 0 20px; }
article h1, article h2, article h3, article h4 { letter-spacing: 0.01em; }
article h2 { font-size: 19px; margin: 34px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
article h3 { font-size: 15px; margin: 24px 0 8px; }
article h4 { font-size: 13px; margin: 18px 0 6px; color: var(--dim); }
article p, article li { color: rgba(255, 255, 255, 0.78); }
article ul, article ol { padding-left: 20px; }
article li { margin: 4px 0; }
article hr { border: 0; border-top: 1px solid var(--border); margin: 28px 0; }
code { font-family: var(--mono); background: var(--bg3); border: 1px solid var(--border); padding: 1px 5px; font-size: 12px; }
pre { background: var(--bg1); border: 1px solid var(--border); padding: 14px 16px; overflow-x: auto; position: relative; }
pre code { background: none; border: 0; padding: 0; font-size: 12px; line-height: 1.6; }
.copy { position: absolute; top: 8px; right: 8px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; color: var(--dim); background: var(--bg2); border: 1px solid var(--border); padding: 3px 8px; cursor: pointer; }
.copy:hover { color: var(--amber); border-color: var(--amber); }
a.external::after { content: " ↗"; font-size: 0.85em; }
blockquote { margin: 16px 0; padding: 10px 16px; border-left: 2px solid var(--amber); background: rgba(245, 166, 35, 0.05); }
blockquote p { margin: 0; }
.toc { border: 1px solid var(--border); background: var(--bg1); padding: 14px 16px; margin: 0 0 24px; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc a { text-decoration: none; font-size: 12px; }
.toc-h3 { padding-left: 14px; }
.table-wrap { overflow-x: auto; margin: 14px 0; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { border: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; }
th { background: var(--bg2); color: var(--amber); font-weight: 600; letter-spacing: 0.04em; }
tbody tr:nth-child(even) { background: rgba(255, 255, 255, 0.02); }
.abi-name { color: var(--amber); }
.abi-sig { white-space: nowrap; }
.generated { border: 1px solid var(--border); background: var(--bg1); padding: 18px; }
.generated-note { border-left: 2px solid var(--amber); padding-left: 12px; color: var(--dim); font-size: 12px; }
.pager { display: flex; justify-content: space-between; gap: 12px; margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--border); }
.pager a { text-decoration: none; font-size: 12px; }
.site-foot { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; max-width: 1180px; margin: 0 auto; padding: 18px 24px 40px; border-top: 1px solid var(--border); color: var(--dim); font-size: 10px; letter-spacing: 0.1em; }
@media (max-width: 640px) { .wrap { padding: 16px; } .site-foot { padding: 16px; } }
`;

const SCRIPT = `// The only behaviour the docs need: a copy button on code blocks, and
// marking outbound links. Kept dependency-free on purpose.
(function () {
  "use strict";

  function markExternal() {
    var links = document.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i += 1) {
      var href = links[i].getAttribute("href") || "";
      if (href.indexOf("http") !== 0) continue;
      links[i].classList.add("external");
      links[i].setAttribute("rel", "noopener noreferrer");
      links[i].setAttribute("target", "_blank");
    }
  }

  function addCopyButtons() {
    if (!navigator.clipboard) return;
    var blocks = document.querySelectorAll("pre");
    for (var i = 0; i < blocks.length; i += 1) {
      (function (block) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "copy";
        button.textContent = "Copy";
        button.addEventListener("click", function () {
          navigator.clipboard.writeText(block.textContent).then(function () {
            button.textContent = "Copied";
            setTimeout(function () {
              button.textContent = "Copy";
            }, 1500);
          });
        });
        block.appendChild(button);
      })(blocks[i]);
    }
  }

  markExternal();
  addCopyButtons();
})();
`;

/**
 * Rewrites Markdown-authored page links to base-absolute hrefs.
 *
 * `docs/getting-started.md` links to `./architecture/`, which is correct and
 * readable in the source. It is also wrong in the output: a page served at
 * `/getting-started/` resolves `./architecture/` to `/getting-started/architecture/`.
 * Resolving every intra-site link here means the nesting depth of a page never
 * matters, and the same output is correct at any `--base`.
 *
 * A relative link that names no page is a build error rather than a silent 404.
 */
function rewritePageLinks(html, fromSlug, base, slugs) {
  return html.replace(/href="([^"]*)"/g, (match, href) => {
    if (/^(https?:|mailto:|data:|#|\/)/i.test(href)) return match;
    const [pathPart, hash] = href.split("#");
    if (!pathPart) return match;
    const target = pathPart
      .replace(/^\.\//, "")
      .replace(/^\.\.\//, "")
      .replace(/\/$/, "");
    if (!slugs.has(target)) {
      throw new Error(
        `docs/${fromSlug}: link "${href}" does not name a page in this site. ` +
          `Known pages: ${[...slugs].join(", ")}.`
      );
    }
    return `href="${base}${target}/${hash ? `#${hash}` : ""}"`;
  });
}

function writeFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

async function main() {
  const { out, base, docs, site } = parseArgs(process.argv.slice(2));
  const outDir = resolve(REPO_ROOT, out);
  const pages = loadPages(docs);

  const abiHtml = await generateAbiReference();
  let generated = 0;

  // The generated fragment is HTML, not Markdown, so it cannot go through the
  // renderer (which escapes everything). It is swapped in for a placeholder
  // before rendering and substituted into the finished output after, so the
  // two pipelines cannot interfere.
  const PLACEHOLDER = "\u0000GENERATED:ABI\u0000";

  const built = pages.map((page) => {
    let body = page.body;
    if (page.generated === "abi-reference") {
      if (!body.includes(ABI_MARKER)) {
        throw new Error(
          `docs/${page.source} declares "generated: abi-reference" but no longer ` +
            `contains the ${ABI_MARKER} anchor.`
        );
      }
      body = body.replace(ABI_MARKER, PLACEHOLDER);
      generated += 1;
    }
    const { html, headings } = renderMarkdown(body, `docs/${page.source}`);

    if (page.generated !== "abi-reference") return { ...page, html, headings };

    // The anchor is a standalone line, so the renderer wraps it in a single
    // <p>. Swap the whole element for the fragment; a block-level <div> inside a
    // <p> is invalid HTML and browsers would silently re-parent it.
    const anchored = `<p>${PLACEHOLDER}</p>`;
    if (!html.includes(anchored)) {
      throw new Error(
        `docs/${page.source}: the ${ABI_MARKER} anchor must be on a line of its own, ` +
          `surrounded by blank lines.`
      );
    }
    return { ...page, html: html.split(anchored).join(abiHtml), headings };
  });

  if (generated !== 1) {
    throw new Error(
      `expected exactly one page with "generated: abi-reference" in its front matter, ` +
        `found ${generated}. docs/contract-abi.md must keep it so the ABI stays generated ` +
        `from lib/constants.ts rather than being hand-written.`
    );
  }

  const slugs = new Set(built.map((page) => page.slug));
  for (const page of built) {
    page.html = rewritePageLinks(page.html, page.source, base, slugs);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  built.forEach((page, index) => {
    const html = layout({ page: { ...page, index }, base, site, allPages: built });
    writeFile(join(outDir, page.slug, "index.html"), html);
  });

  // The index page must also be reachable as the site root.
  writeFile(join(outDir, "index.html"), readFileSync(join(outDir, "index", "index.html"), "utf8"));

  writeFile(join(outDir, "404.html"), readFileSync(join(outDir, "index", "index.html"), "utf8"));
  writeFile(join(outDir, "assets", "site.css"), STYLESHEET);
  writeFile(join(outDir, "assets", "site.js"), SCRIPT);

  const endpoints = (abiHtml.match(/abi-name">([^<]+)</g) ?? []).length;
  process.stdout.write(
    `docs: built ${built.length} page(s) -> ${outDir.startsWith(REPO_ROOT) ? relative(REPO_ROOT, outDir) : outDir}/ (base ${base})\n` +
      `      pages: ${built.map((p) => p.slug).join(", ")}\n` +
      `      generated ABI reference: ${endpoints} endpoints from lib/constants.ts\n` +
      `      canonical origin: ${site}${base}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`docs build failed: ${error.message}\n`);
    process.exit(1);
  });
}
