/**
 * Assert that the toolchain running this repository matches the pinned one.
 *
 * Run as the very first CI step, before `npm ci`, so a mismatch fails in seconds
 * with a message that names the fix — instead of surfacing twenty minutes later as
 * an obscure `EBADENGINE`, a native-module build error, or a lockfile rewrite.
 *
 *     node scripts/check-toolchain.mjs
 *
 * ── Single source of truth ──────────────────────────────────────────────────────
 * `package.json` → `engines` is canonical: it is machine-readable, it is what npm
 * and every engines-aware tool already read, and it cannot silently drift from the
 * manifest it lives in. `.nvmrc` is a one-line mirror for nvm/fnm/asdf, and
 * `actions/setup-node` reads it to pick the runner's Node. Two files can drift, so
 * this script *fails* if they do — the guarantee is enforced, not just asserted.
 *
 * The Docker dev environment (issue #165) is a third consumer of the same pin; its
 * `FROM node:<version>` is checked here too, and the check no-ops until that
 * Dockerfile exists rather than guessing where it will land.
 *
 * ── Why exact versions and not ranges ───────────────────────────────────────────
 * The whole point is reproducibility, and a range is not one: `>=20 <21` still
 * admits 20.0.0 and 20.20.2, which differ in exactly the ways this repository has
 * already been bitten by. Ranges are rejected outright with an explanation rather
 * than silently half-honoured.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Candidate Docker dev-environment files, in the order they would be introduced. */
const DOCKERFILE_CANDIDATES = [
  "Dockerfile",
  "Dockerfile.dev",
  "docker/Dockerfile",
  "docker/Dockerfile.dev",
  "devcontainer/Dockerfile",
  ".devcontainer/Dockerfile",
];

const stripV = (version) =>
  String(version ?? "")
    .trim()
    .replace(/^v/, "");
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

/**
 * Read the canonical pin out of package.json, refusing anything that is not an
 * exact version.
 *
 * @param {{engines?: Record<string, string>}} pkg
 * @param {Record<string, string>} [now] injected for tests
 * @returns {{node: string, npm: string}}
 */
export function readPinnedEngines(pkg) {
  const engines = pkg?.engines ?? {};
  const problems = [];
  for (const tool of ["node", "npm"]) {
    const value = stripV(engines[tool]);
    if (!value) {
      problems.push(
        `package.json "engines.${tool}" is missing — the pin must live in package.json.`
      );
    } else if (!EXACT_VERSION.test(value)) {
      problems.push(
        `package.json "engines.${tool}" is "${value}", which is not an exact version. ` +
          `Pin it as "<major>.<minor>.<patch>" (e.g. "20.20.2"); a range defeats the point of pinning.`
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`${problems.join("\n  - ")}`);
  }
  return { node: stripV(engines.node), npm: stripV(engines.npm) };
}

/**
 * Compare one running tool against the pin.
 *
 * @param {{label: string, pinned: string, actual: string, hint?: string}} input
 * @returns {{ok: boolean, message: string}}
 */
export function checkPinned({ label, pinned, actual, hint = "" }) {
  const got = stripV(actual);
  if (got === pinned) return { ok: true, message: `${label} ${got} matches the pin` };
  return {
    ok: false,
    message:
      `${label} ${got || "(unknown)"} does not match the pinned ${pinned}.\n` +
      `  The pin lives in package.json "engines" and is mirrored in .nvmrc.\n` +
      `  Fix it with:\n` +
      `    nvm install && nvm use      # reads .nvmrc\n` +
      `    corepack enable && corepack prepare npm@${pinned} --activate   # for npm\n` +
      (hint ? `  ${hint}\n` : ""),
  };
}

/**
 * `.nvmrc` is what `actions/setup-node` and every version manager read, so it has to
 * agree with `engines` or the CI runner is on a different Node than the one the
 * repository claims to support.
 *
 * @param {string} nvmrcContents
 * @param {string} pinned
 */
export function checkNvmrc(nvmrcContents, pinned) {
  const value = stripV(nvmrcContents);
  if (!value) {
    return { ok: false, message: ".nvmrc is empty. It must contain the exact Node version." };
  }
  if (value !== pinned) {
    return {
      ok: false,
      message:
        `.nvmrc says "${value}" but package.json "engines.node" says "${pinned}".\n` +
        `  These are the same pin written down twice; update .nvmrc to ${pinned}.`,
    };
  }
  return { ok: true, message: `.nvmrc (${value}) agrees with engines.node` };
}

/**
 * Keep the Docker dev environment on the same Node as everything else. Issue #165
 * adds the Dockerfile; until it lands there is nothing to check and this returns a
 * skip rather than a failure.
 *
 * @param {string} file relative path, for messages
 * @param {string} contents
 * @param {string} pinned
 */
export function checkDockerfile(file, contents, pinned) {
  const from = /^\s*FROM\s+node:(\S+)/gim;
  const tags = [...contents.matchAll(from)].map((match) => stripV(match[1]));
  if (tags.length === 0) {
    return {
      ok: false,
      message:
        `${file} has no "FROM node:<version>" line, so the dev environment is not pinned to the ` +
        `repo's Node (${pinned}).`,
    };
  }
  // A Docker Hub `node:` tag may carry a base-image suffix (`20.20.2-bookworm`,
  // `20.20.2-alpine`); that is a distro choice, not a version choice.
  const wrong = tags.filter((tag) => tag.split("-")[0] !== pinned);
  if (wrong.length > 0) {
    return {
      ok: false,
      message:
        `${file} pins Node ${wrong.join(", ")} but package.json "engines.node" is ${pinned}.\n` +
        `  Change the base image to node:${pinned} so the Docker dev environment and CI use one Node.`,
    };
  }
  return { ok: true, message: `${file} pins node:${tags.join(", ")} (matches ${pinned})` };
}

function readNpmVersion() {
  try {
    return execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    // Fall back to the user agent npm exports to its own lifecycle scripts.
    const agent = process.env.npm_config_user_agent ?? "";
    const match = /npm\/(\S+)/.exec(agent);
    if (match) return match[1];
    throw new Error(
      "Could not determine the npm version. Is npm on PATH? Run this via `npm run check:toolchain` " +
        "or install Node/npm from the pinned version in .nvmrc."
    );
  }
}

function main() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const pinned = readPinnedEngines(pkg);
  const checks = [
    checkPinned({
      label: "node",
      pinned: pinned.node,
      actual: process.version,
      hint: "Local: install the pinned Node and re-run `nvm use`.",
    }),
    checkPinned({ label: "npm", pinned: pinned.npm, actual: readNpmVersion() }),
  ];

  const nvmrcPath = join(REPO_ROOT, ".nvmrc");
  if (!existsSync(nvmrcPath)) {
    checks.push({
      ok: false,
      message: ".nvmrc is missing. It must contain the exact Node version.",
    });
  } else {
    checks.push(checkNvmrc(readFileSync(nvmrcPath, "utf8"), pinned.node));
  }

  const dockerfiles = DOCKERFILE_CANDIDATES.filter((candidate) =>
    existsSync(join(REPO_ROOT, candidate))
  );
  for (const candidate of dockerfiles) {
    checks.push(
      checkDockerfile(candidate, readFileSync(join(REPO_ROOT, candidate), "utf8"), pinned.node)
    );
  }
  if (dockerfiles.length === 0) {
    checks.push({ ok: true, message: "docker dev image: no Dockerfile in the repo yet, skipping" });
  }

  const failures = checks.filter((check) => !check.ok);
  // One write per stream, so the check list and the summary cannot interleave out
  // of order when stdout and stderr are both redirected to the same place (CI).
  const lines = checks.map((check) => `- ${check.message.trim()}`).join("\n");
  if (failures.length > 0) {
    console.error(
      [
        `Toolchain check FAILED — ${failures.length} problem${failures.length === 1 ? "" : "s"}.`,
        `Pinned: node ${pinned.node}, npm ${pinned.npm}.`,
        "",
        lines,
      ].join("\n")
    );
    process.exit(1);
  }
  console.log([`Toolchain OK — node ${pinned.node}, npm ${pinned.npm}.`, "", lines].join("\n"));
}

if (process.argv[1]?.endsWith("check-toolchain.mjs")) {
  try {
    main();
  } catch (error) {
    console.error(`Toolchain check failed:\n  ${error?.message ?? error}`);
    process.exit(1);
  }
}
