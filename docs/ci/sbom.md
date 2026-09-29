# Software Bill of Materials (SBOM)

Workflow: [`.github/workflows/sbom.yml`](../../.github/workflows/sbom.yml)
Accuracy check: [`scripts/ci/verify-sbom.mjs`](../../scripts/ci/verify-sbom.mjs) (unit tests alongside)

Every production build of `main` produces a [CycloneDX 1.6](https://cyclonedx.org/docs/1.6/json/)
JSON SBOM listing each npm package that ships, with its exact version, purl,
license, and integrity hash. Use it to answer "exactly what code is running in
this deployed build?" when an advisory lands.

## Where to find it

| Trigger                                              | Output                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Push to `main`                                       | Workflow artifact `sbom-cyclonedx-<sha>` (kept 90 days)                    |
| GitHub release published                             | The same file attached to the release as `synapse-web-<tag>.cdx.json`      |
| PR that changes `package.json` / `package-lock.json` | Artifact on the PR run, so reviewers can see what a dependency change adds |
| Manual (`workflow_dispatch`)                         | Artifact                                                                   |

The workflow deliberately doesn't touch `package.json` or the lockfile. It runs
a pinned `@cyclonedx/cyclonedx-npm` through `npx`.

## How it stays accurate

1. **Build first, then prune.** The app builds with the full tree, then
   `npm prune --omit=dev` strips dev tooling from `node_modules`, and
   `cyclonedx-npm --omit dev` reads what remains. Without the prune step,
   optional dev-only packages (Tailwind's wasm fallbacks, for example) stay on
   disk and leak into the SBOM. The accuracy check catches exactly that.
2. **Schema validation** with the official CycloneDX CLI, pinned by version and
   SHA-256 (`--fail-on-errors`).
3. **Cross-check against `package-lock.json`.** The SBOM must contain every
   installed non-dev lockfile package, at the lockfile's version, and nothing
   else. It fails on:
   - a dev-only package in the SBOM
   - a production package missing from the SBOM
   - a version mismatch
   - a package that isn't in the lockfile at all

   Two lockfile details are handled on purpose:
   - `devOptional` packages (e.g. `typescript`, which Solana's codecs declare
     as an optional peer) are expected. npm keeps them in an `--omit=dev`
     install.
   - Platform-specific optional binaries for other operating systems (e.g.
     `@img/sharp-darwin-arm64` on a Linux runner) are in the lockfile but are
     never installed, so they aren't expected.

At introduction, the check reported **470 components against 470 installed
production packages**, with no mismatches.

## Scope

- Covers npm dependencies only. The Next.js build output itself (our own
  code) is the `metadata.component`.
- Signing and attestation are out of scope for #154. Generation and
  publication only.

## Reproducing locally

```bash
npm ci && npm run build
npm prune --omit=dev
npx @cyclonedx/cyclonedx-npm@6.0.1 --omit dev --spec-version 1.6 \
  --output-reproducible --mc-type application --output-file sbom.cdx.json
node scripts/ci/verify-sbom.mjs sbom.cdx.json
npm ci   # restore dev dependencies
```
