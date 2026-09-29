#!/usr/bin/env node
// Cross-checks a CycloneDX SBOM against package-lock.json (#154).
//
// Schema validity is checked separately by the CycloneDX CLI. This script checks
// *accuracy*: the SBOM must list exactly the production packages that are
// installed, at the lockfile's versions, and no dev-only package.
//
//   expected = lockfile packages that are not `dev: true`
//              (devOptional stays: npm keeps it in an --omit=dev install
//               because a production package declares it as an optional peer)
//              and that exist on disk (platform-specific optional binaries
//              for other OSes are in the lockfile but never installed)
//
// Usage: node scripts/ci/verify-sbom.mjs <sbom.cdx.json> [package-lock.json] [--summary file]

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PATH_PROPERTY = "cdx:npm:package:path";

/** Every component in the BOM, including ones nested under other components. */
export function flattenComponents(bom) {
  const out = [];
  const walk = (components) => {
    for (const c of components ?? []) {
      out.push(c);
      walk(c.components);
    }
  };
  walk(bom.components);
  return out;
}

const propertyValue = (component, name) =>
  component.properties?.find((p) => p.name === name)?.value;

/**
 * @param {any} bom CycloneDX JSON
 * @param {any} lock package-lock.json (lockfileVersion 2 or 3)
 * @param {(lockPath: string) => boolean} isInstalled
 */
export function compareSbom(bom, lock, isInstalled) {
  const errors = [];
  const warnings = [];

  if (bom?.bomFormat !== "CycloneDX")
    errors.push(`bomFormat is ${bom?.bomFormat}, expected CycloneDX`);
  if (!lock?.packages) {
    errors.push("package-lock.json has no `packages` map (lockfileVersion >= 2 required)");
    return { ok: false, errors, warnings, componentCount: 0, expectedCount: 0 };
  }

  const expected = new Map();
  for (const [lockPath, meta] of Object.entries(lock.packages)) {
    if (!lockPath || meta.link || meta.dev) continue;
    if (!isInstalled(lockPath)) continue;
    expected.set(lockPath, meta);
  }

  const components = flattenComponents(bom);
  const seen = new Set();
  for (const c of components) {
    const lockPath = propertyValue(c, PATH_PROPERTY);
    const id = c.purl ?? `${c.group ? `${c.group}/` : ""}${c.name}@${c.version}`;
    if (!lockPath) {
      errors.push(`${id}: missing ${PATH_PROPERTY} property`);
      continue;
    }
    if (seen.has(lockPath)) errors.push(`${lockPath}: listed more than once`);
    seen.add(lockPath);

    const meta = lock.packages[lockPath];
    if (!meta) {
      errors.push(`${lockPath} (${id}) is in the SBOM but not in package-lock.json`);
      continue;
    }
    if (meta.dev) {
      errors.push(
        `${lockPath} (${id}) is a dev-only dependency and must not be in the production SBOM`
      );
      continue;
    }
    if (meta.version && c.version !== meta.version)
      errors.push(`${lockPath}: SBOM version ${c.version} != lockfile ${meta.version}`);
    if (!expected.has(lockPath))
      errors.push(`${lockPath} (${id}) is in the SBOM but not installed`);
    if (propertyValue(c, "cdx:npm:package:extraneous") === "true")
      warnings.push(
        `${lockPath} is reported extraneous by npm (installed, in the lockfile, but not reachable from package.json)`
      );
  }

  for (const lockPath of expected.keys()) {
    if (!seen.has(lockPath))
      errors.push(
        `${lockPath}@${expected.get(lockPath).version} is a production dependency missing from the SBOM`
      );
  }

  const root = lock.packages[""] ?? {};
  const rootName = bom?.metadata?.component?.name;
  if (root.name && rootName && root.name !== rootName)
    errors.push(`metadata.component.name is ${rootName}, expected ${root.name}`);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    componentCount: components.length,
    expectedCount: expected.size,
  };
}

function main() {
  const positional = [];
  let summaryFile;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--summary") summaryFile = argv[++i];
    else positional.push(argv[i]);
  }
  const [sbomFile, lockFile = "package-lock.json"] = positional;
  if (!sbomFile) {
    console.error("usage: verify-sbom.mjs <sbom.cdx.json> [package-lock.json] [--summary file]");
    process.exit(2);
  }
  const root = path.dirname(path.resolve(lockFile));
  const bom = JSON.parse(readFileSync(sbomFile, "utf8"));
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  const result = compareSbom(bom, lock, (p) => existsSync(path.join(root, p)));

  const lines = [
    `## SBOM accuracy ${result.ok ? "verified ✅" : "check failed ❌"}`,
    "",
    `- Format: ${bom.bomFormat} ${bom.specVersion}`,
    `- Components in SBOM: **${result.componentCount}**`,
    `- Installed production packages in package-lock.json: **${result.expectedCount}**`,
    ...result.errors.map((e) => `- ❌ ${e}`),
    ...result.warnings.map((w) => `- ⚠️ ${w}`),
  ];
  console.log(lines.join("\n"));
  if (summaryFile) appendFileSync(summaryFile, lines.join("\n") + "\n");
  for (const e of result.errors) console.log(`::error title=SBOM mismatch::${e}`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
