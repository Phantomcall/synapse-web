/**
 * Generates the documentation site's contract-ABI reference *from the source*.
 *
 * The problem this exists to solve (#175): the in-app `DocsTab` already renders
 * its ABI reference straight from `lib/constants.ts :: ABI_ENDPOINTS`, so it
 * cannot drift. A separate documentation site, written in Markdown, could
 * easily have become a hand-copied second copy of that array — and hand copies
 * of ABI tables rot silently, which is the worst failure mode for a reference
 * integrator might sign against.
 *
 * So there is no second copy. `docs/contract-abi.md` contains a single
 * `<!-- generated:abi-reference -->` marker and nothing else; this script
 * transpiles the real `lib/constants.ts` and emits the section. Delete an
 * endpoint from the array and the docs site loses it on the next build, with no
 * one having to remember to update a document.
 *
 * Why transpile instead of `import`?
 * ----------------------------------
 * The file is TypeScript and the docs build must run as plain `node` (including
 * on the pinned Node 20 in the deploy workflow), with no build step and no new
 * dependency. `typescript` is already a devDependency, so `ts.transpileModule`
 * gives us the real constant for free. `lib/constants.ts` only uses
 * `import type`, which erases to nothing — so the emitted module has no imports
 * at all and can be loaded from a data: URL. The shape is asserted below rather
 * than assumed, so a future runtime import in that file fails the docs build
 * loudly instead of silently producing an empty table.
 *
 * Runnable as a CLI (prints the HTML fragment) so the drift test can exercise
 * this exact code path:
 *
 *     node scripts/docs/abi-reference.mjs
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import { escapeHtml, MarkdownError } from "./markdown.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
const CONSTANTS_PATH = join(REPO_ROOT, "lib", "constants.ts");
export const ABI_MARKER = "<!-- generated:abi-reference -->";

/** Colour tokens mirroring `ACCESS_COLORS` in components/docs/DocsTab.tsx. */
const ACCESS_LABELS = {
  "one-time": "one-time bootstrap",
  relay_signer: "relay signer",
  admin: "admin",
  public: "public read",
};

/**
 * Loads `ABI_ENDPOINTS` out of the real `lib/constants.ts`.
 *
 * Throws (loudly, at docs build time) if anything about the shape is not what
 * the renderer below expects. A docs page that renders fewer endpoints than the
 * app has is a correctness bug, not a cosmetic one.
 */
export async function loadAbiEndpoints() {
  const require = createRequire(import.meta.url);
  const ts = require("typescript");

  const source = readFileSync(CONSTANTS_PATH, "utf8");
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: "constants.ts",
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });

  const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new Error(
      `Failed to transpile ${CONSTANTS_PATH}: ${errors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
        .join("; ")}`
    );
  }

  // A runtime (non-type) import would make the emitted module unresolvable
  // standalone. Catch it here rather than at `import()` with a bare "Cannot
  // find module" that gives no hint about the cause.
  if (/^\s*import\s+[^(]/m.test(outputText) || /^\s*export\s+\*\s+from/m.test(outputText)) {
    throw new Error(
      `${CONSTANTS_PATH} gained a runtime import. The docs build loads it in ` +
        `isolation, so keep it dependency-free or teach this script how to ` +
        `resolve its imports.`
    );
  }

  const directory = mkdtempSync(join(tmpdir(), "synapse-docs-abi-"));
  const modulePath = join(directory, "constants.mjs");
  try {
    writeFileSync(modulePath, outputText, "utf8");
    // Named `constants`, not `module`: assigning to `module` is a Next.js lint
    // error because it breaks the CommonJS global in transpiled output.
    const constants = await import(pathToFileURL(modulePath).href);
    const endpoints = constants.ABI_ENDPOINTS;
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      throw new Error("lib/constants.ts no longer exports a non-empty ABI_ENDPOINTS array");
    }
    endpoints.forEach((endpoint, i) => {
      for (const key of ["name", "sig", "access", "desc"]) {
        if (typeof endpoint?.[key] !== "string" || endpoint[key].length === 0) {
          throw new Error(`ABI_ENDPOINTS[${i}] is missing a string "${key}"`);
        }
      }
      if (!(endpoint.access in ACCESS_LABELS)) {
        throw new Error(
          `ABI_ENDPOINTS[${i}].access is "${endpoint.access}", which has no ` +
            `presentation defined. Add it to ACCESS_LABELS in this script.`
        );
      }
    });
    return endpoints;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Renders the ABI reference as an HTML fragment. */
export function renderAbiHtml(endpoints) {
  const legend = Object.entries(ACCESS_LABELS)
    .map(([key, label]) => `<li><code>${escapeHtml(key)}</code> — ${escapeHtml(label)}</li>`)
    .join("");

  const rows = endpoints
    .map(
      (endpoint) => `      <tr>
        <td><code class="abi-name">${escapeHtml(endpoint.name)}</code></td>
        <td><code class="abi-sig">${escapeHtml(endpoint.sig)}</code></td>
        <td><code>${escapeHtml(endpoint.access)}</code></td>
        <td>${escapeHtml(endpoint.desc)}</td>
      </tr>`
    )
    .join("\n");

  return `<div class="generated" id="abi-reference">
  <p class="generated-note"><strong>Generated.</strong> This table is produced at
  docs build time by <code>scripts/docs/abi-reference.mjs</code>, which transpiles
  and reads <code>lib/constants.ts</code> directly. There is no hand-maintained
  copy of it anywhere in this repository, so it cannot drift from the contract
  interface the app actually calls.</p>
  <div class="table-wrap">
    <table class="abi">
      <thead>
        <tr><th>Endpoint</th><th>Signature</th><th>Access</th><th>Notes</th></tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
  <h3 id="access-levels">Access levels</h3>
  <ul>${legend}</ul>
</div>`;
}

/** The HTML that replaces the `<!-- generated:abi-reference -->` marker. */
export async function generateAbiReference() {
  return renderAbiHtml(await loadAbiEndpoints());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateAbiReference()
    .then((html) => process.stdout.write(html + "\n"))
    .catch((error) => {
      process.stderr.write(`${error instanceof MarkdownError ? error.message : error.stack}\n`);
      process.exit(1);
    });
}
