/**
 * A deliberately small Markdown renderer for the documentation site.
 *
 * WHY THIS EXISTS INSTEAD OF Docusaurus / VitePress / marked
 * --------------------------------------------------------------
 * See the "Static-site generator: options considered" section of PR #175 for
 * the full comparison. The short version: the docs site is ~6 pages of
 * reference material with no interactivity, so the entire cost of a real SSG
 * here is dependency weight, a second build config to keep in sync, and
 * version-churn risk — with no offsetting benefit. `marked` would be the
 * honest middle ground (one dependency, zero transitive deps) and is a
 * one-line swap if the subset below stops being sufficient.
 *
 * SCOPE — this is a *subset*, and it fails loudly outside it rather than
 * silently emitting raw Markdown:
 *   front matter      `---\nkey: value\n---`
 *   headings          `#` … `####` (auto-slugged ids)
 *   paragraphs
 *   fenced code       ```lang … ```
 *   tables            GFM pipe tables with `---` alignment row
 *   lists             `-`/`*` bullets, `1.` ordered (one level, no nesting)
 *   blockquotes       `> …`
 *   rules             `***`
 *   inline            `code`, **bold**, *italic*, [text](href)
 *
 * Deliberately unsupported: nested lists, HTML passthrough, images, footnotes,
 * setext headings, reference links. Every one of those throws.
 */

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FENCE_RE = /^```([A-Za-z0-9_+-]*)\s*$/;
const TABLE_DELIM_RE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const UL_RE = /^\s*[-*]\s+(.*)$/;
const OL_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const RULE_RE = /^\s*(\*\s*){3,}$|^\s*(-\s*){3,}$|^\s*(_\s*){3,}$/;

export class MarkdownError extends Error {
  constructor(message, file, line) {
    super(`${file}:${line}: ${message}`);
    this.name = "MarkdownError";
  }
}

/** Escapes text for interpolation into HTML element content or an attribute. */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes for a URL context and refuses anything that could turn a docs link
 * into script execution. The docs site is built from repo-local Markdown, so
 * this is defence in depth rather than a fix for a live bug — but a docs
 * pipeline is exactly the place where a `javascript:` href from a bad merge
 * would become a stored XSS on a documentation origin.
 */
export function safeHref(href, file, line) {
  const trimmed = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:/i.test(trimmed)) {
    throw new MarkdownError(`refusing non-http(s) link target "${trimmed}"`, file, line);
  }
  if (trimmed.startsWith("//")) {
    throw new MarkdownError(`refusing protocol-relative link target "${trimmed}"`, file, line);
  }
  // Absolute site paths, page anchors, explicitly relative paths, and http(s).
  if (/^(https?:\/\/|#|\/|\.{1,2}\/)/i.test(trimmed)) return escapeHtml(trimmed);
  // Bare relative paths such as `getting-started/` or `README.md`, so links
  // still resolve when the site is served from a sub-path (GitHub Pages).
  if (/^[\w@][\w@.+-]*(\/[\w@.+-]*)*(#[\w-]+)?$/.test(trimmed)) return escapeHtml(trimmed);
  throw new MarkdownError(`unrecognised link target "${trimmed}"`, file, line);
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parses the `---\nkey: value\n---` header. Only flat string values. */
export function parseFrontMatter(source, file) {
  const match = FRONT_MATTER_RE.exec(source);
  if (!match) return { attributes: {}, body: source };

  const attributes = {};
  match[1].split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const sep = trimmed.indexOf(":");
    if (sep === -1) {
      throw new MarkdownError(`front matter line ${index + 1} is not "key: value"`, file, 1);
    }
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    attributes[key] = value;
  });

  return { attributes, body: source.slice(match[0].length) };
}

/** Inline spans. Code spans are extracted first so their contents stay literal. */
export function renderInline(text, file, line) {
  // NUL is used as the placeholder delimiter: it cannot occur in a Markdown
  // source file, so a literal number in prose can never be mistaken for a
  // code span the way a ` N ` sentinel could.
  const SENTINEL = "\u0000";

  const codeSpans = [];
  let working = text.replace(/`([^`]+)`/g, (_match, code) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `${SENTINEL}${codeSpans.length - 1}${SENTINEL}`;
  });

  working = escapeHtml(working);

  // [text](href)
  working = working.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
    const external = /^https?:\/\//i.test(href);
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${safeHref(href, file, line)}"${attrs}>${label}</a>`;
  });

  // **bold** before *italic* so ** is not eaten by the single-star rule.
  working = working.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  working = working.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  return working.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"),
    (_m, i) => codeSpans[Number(i)]
  );
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function alignmentsFrom(delimiterCells) {
  return delimiterCells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
}

function collectTable(lines, start, file) {
  const header = splitTableRow(lines[start]);
  if (start + 1 >= lines.length || !TABLE_DELIM_RE.test(lines[start + 1])) return null;

  const alignments = alignmentsFrom(splitTableRow(lines[start + 1]));
  const rows = [];
  let index = start + 2;
  while (index < lines.length && lines[index].trim().startsWith("|")) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }

  if (alignments.length !== header.length) {
    throw new MarkdownError(
      `table has ${header.length} columns but ${alignments.length} alignment cells`,
      file,
      start + 2
    );
  }

  const cell = (tag, value, align) => {
    const style = align ? ` style="text-align:${align}"` : "";
    return `<${tag}${style}>${renderInline(value, file, start + 1)}</${tag}>`;
  };

  const html = [
    '<div class="table-wrap"><table>',
    "<thead><tr>",
    header.map((value, i) => cell("th", value, alignments[i])).join(""),
    "</tr></thead><tbody>",
    rows
      .map(
        (row) =>
          "<tr>" + header.map((_, i) => cell("td", row[i] ?? "", alignments[i])).join("") + "</tr>"
      )
      .join(""),
    "</tbody></table></div>",
  ].join("");

  return { html, next: index };
}

/**
 * Renders Markdown to an HTML fragment. `file` only appears in error messages.
 * Returns `{ html, headings }` where `headings` feeds the per-page table of
 * contents.
 */
export function renderMarkdown(source, file = "<inline>") {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const headings = [];
  let index = 0;

  const pushBlank = () => {
    if (out.length && out[out.length - 1] !== "") out.push("");
  };

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const language = fence[1] || "";
      const body = [];
      index += 1;
      while (index < lines.length && !FENCE_RE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      if (index >= lines.length) throw new MarkdownError("unclosed code fence", file, index);
      index += 1; // consume closing fence
      pushBlank();
      const cls = language ? ` class="language-${escapeHtml(language)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      pushBlank();
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (level > 4)
        throw new MarkdownError(`h${level} headings are not supported`, file, index + 1);
      const text = heading[2];
      const id = slugify(text);
      if (headings.some((h) => h.id === id)) {
        throw new MarkdownError(`duplicate heading id "${id}"`, file, index + 1);
      }
      headings.push({ level, id, text });
      out.push(
        `<h${level} id="${escapeHtml(id)}">${renderInline(text, file, index + 1)}</h${level}>`
      );
      index += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      pushBlank();
      out.push("<hr />");
      pushBlank();
      index += 1;
      continue;
    }

    if (line.trim().startsWith("|")) {
      const table = collectTable(lines, index, file);
      if (!table) {
        throw new MarkdownError("table row found without a header/alignment pair", file, index + 1);
      }
      pushBlank();
      out.push(table.html);
      pushBlank();
      index = table.next;
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const body = [];
      while (index < lines.length && BLOCKQUOTE_RE.test(lines[index])) {
        body.push(BLOCKQUOTE_RE.exec(lines[index])[1]);
        index += 1;
      }
      pushBlank();
      out.push(`<blockquote><p>${renderInline(body.join(" "), file, index)}</p></blockquote>`);
      pushBlank();
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const pattern = ordered ? OL_RE : UL_RE;
      const items = [];
      while (index < lines.length && pattern.test(lines[index])) {
        const match = pattern.exec(lines[index]);
        items.push(ordered ? match[2] : match[1]);
        index += 1;
        // Continuation lines: a wrapped bullet is indented in the source, and
        // the source is hand-wrapped for readability. Without this every
        // wrapped line would silently become its own list item.
        while (
          index < lines.length &&
          lines[index].trim() &&
          !pattern.test(lines[index]) &&
          !HEADING_RE.test(lines[index]) &&
          !FENCE_RE.test(lines[index]) &&
          !UL_RE.test(lines[index]) &&
          !OL_RE.test(lines[index]) &&
          !BLOCKQUOTE_RE.test(lines[index]) &&
          !RULE_RE.test(lines[index]) &&
          !lines[index].trim().startsWith("|")
        ) {
          items[items.length - 1] += " " + lines[index].trim();
          index += 1;
        }
      }
      pushBlank();
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag}>` +
          items.map((item) => `<li>${renderInline(item, file, index)}</li>`).join("") +
          `</${tag}>`
      );
      pushBlank();
      continue;
    }

    // A line indented by four spaces would be a code block in CommonMark. This
    // renderer has no block-level indentation support, so refuse rather than
    // emit a paragraph containing stray whitespace.
    if (/^ {4,}\S/.test(line)) {
      throw new MarkdownError(
        "indented code blocks are not supported; use a ``` fence",
        file,
        index + 1
      );
    }

    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !HEADING_RE.test(lines[index]) &&
      !FENCE_RE.test(lines[index]) &&
      !UL_RE.test(lines[index]) &&
      !OL_RE.test(lines[index]) &&
      !BLOCKQUOTE_RE.test(lines[index]) &&
      !RULE_RE.test(lines[index]) &&
      !lines[index].trim().startsWith("|")
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    pushBlank();
    out.push(`<p>${renderInline(paragraph.join(" "), file, index)}</p>`);
    pushBlank();
  }

  return {
    html: out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    headings,
  };
}
