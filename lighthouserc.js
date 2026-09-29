/**
 * @lhci/cli configuration — browsable per-PR Lighthouse reports.
 *
 * Scope note: this file is the *reporting* layer. The pass/fail gate that
 * decides whether a PR is blocked lives in the earlier Lighthouse CI gate issue;
 * `assert` here is deliberately minimal (see the comment on that block).
 *
 * The audited route list is restated from `lib/tabs.ts` rather than imported,
 * because `@lhci/cli` loads this file through Node's `require` and cannot
 * resolve the TypeScript module. `lib/tabs.test.ts` reads this file and fails
 * CI if the two ever disagree, so a new tab cannot ship without being audited.
 */

/** Port the audited server is expected on. Matches the workflow and compose file. */
const PORT = Number(process.env.LIGHTHOUSE_PORT || 3000);
const ORIGIN = process.env.LIGHTHOUSE_ORIGIN || `http://localhost:${PORT}`;

/**
 * One entry per tab route. These are real, separately-prerendered routes
 * (`app/[tab]/page.tsx`), not four labels over the same document — auditing a
 * single-URL app four times produces four identical measurements wearing four
 * different names.
 */
const ROUTES = ["/dashboard", "/transactions", "/admin", "/docs"];

const url = ROUTES.map((route) => `${ORIGIN}${route}`);

module.exports = {
  ci: {
    collect: {
      // LHCI boots the app itself so a developer does not have to keep a server
      // alive alongside the run. `next start` is the production build, which is
      // the only honest thing to measure — `next dev` ships unminified React and
      // on-demand compilation, so its performance numbers are not comparable to
      // what users get.
      startServerCommand: `npm run start -- --port ${PORT}`,
      startServerReadyPattern: "Ready in|ready started server|Local:",
      startServerReadyTimeout: 120_000,

      url,

      // Three runs per route. One run is dominated by cold-cache and CI
      // scheduling noise; the median of three is what makes a "score changed"
      // row in the PR comment mean something. Cost is linear in routes, so this
      // is the main knob to turn down if the job gets slow.
      numberOfRuns: 3,

      // Chrome in CI has no GPU and throttled-by-default flags vary by version;
      // pinning them keeps scores comparable between runs. `desktop` is the
      // default preset; mobile emulation is what Core Web Vitals actually cares
      // about, and it is left commented out below because it needs Lighthouse's
      // throttling, which makes every run ~4x slower. Flip both together if the
      // team decides to track field-like conditions in CI.
      settings: {
        preset: "desktop",
        onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
        chromeFlags: "--headless --no-sandbox --disable-gpu --disable-dev-shm-usage",
        formFactor: "desktop",
        screenEmulation: {
          mobile: false,
          width: 1350,
          height: 940,
          deviceScaleFactor: 1,
          disabled: false,
        },
      },

      // The wallet-adjacent tabs render a connect-wallet affordance rather than
      // requiring an extension, so the app is fully auditable with no secrets.
      // If a future tab needs a configured contract to render, add it here as a
      // `defaultUrl` query or an `--extra-headers` pass, not as a new secret in
      // the repo.
    },

    upload: {
      /**
       * `filesystem` is the default and is deliberate.
       *
       * The alternative is `upload.target: "temporary-public-storage"` or a
       * self-hosted LHCI server, and both were rejected here:
       *
       *  - temporary-public-storage publishes the report to a public URL on a
       *    third-party service. These reports contain the audited route names
       *    and build metadata; publishing them is a decision for the team, not
       *    for this file.
       *  - a self-hosted LHCI server gives cross-run history for free, but needs
       *    infrastructure this repo does not own.
       *
       * `filesystem` keeps the run self-contained: `.lighthouseci/` is uploaded
       * as a workflow artifact and linked from the PR comment, so the report is
       * browsable and versioned with the commit. Historical comparison across
       * PRs is instead computed per-run by `scripts/lighthouse-report.mjs`, which
       * audits the base branch in a sibling job and diffs the two manifests.
       *
       * TO MOVE TO A PERSISTENT LHCI SERVER LATER, when the team has one:
       *   1. Set `LHCI_TOKEN` as a repository secret.
       *   2. Replace this block with:
       *        upload: {
       *          target: "lhci-server",
       *          serverBaseUrl: "https://lhci.internal.example.com",
       *          serverToken: process.env.LHCI_TOKEN,
       *          uploadUrl: "http://localhost:3000",   // where to audit
       *        }
       *   3. Drop the `base` job and the `manifest` download in
       *      `.github/workflows/lighthouse.yml`; the server's own history
       *      endpoint replaces the base-branch comparison.
       * Nothing else in the workflow depends on the upload target: the report
       * script reads `manifest.json` out of the output directory either way.
       */
      target: "filesystem",
      outputDir: process.env.LHCI_OUTPUT_DIR || ".lighthouseci",

      // `reportFilenamePattern` is deliberately left at its default,
      // `%%HOSTNAME%%-%%PATHNAME%%-%%DATETIME%%.report.%%EXTENSION%%`.
      //
      // The supported tokens are HOSTNAME, PATHNAME, DATETIME and EXTENSION —
      // there is no `%%SLUG%%`. Setting a pattern with an unsupported token
      // silently resolves every run to the single name `unknown-report.*`, which
      // means all four routes overwrite one HTML file and the per-route "open
      // full report" links all point at the last run. PATHNAME is what
      // distinguishes /dashboard from /docs here, so the default is exactly
      // what this multi-route app needs.
    },

    /**
     * Deliberately minimal — the gate is the earlier issue's job.
     *
     * No `preset` is set on purpose. `preset: "lighthouse:recommended"` looks
     * harmless but it contributes assertions at `error` level, so a single
     * unrelated audit (max-potential-fid, viewport, …) fails the job even with
     * every score assertion set to `warn`. That silently turns a reporting
     * workflow into a blocking gate, which is explicitly the other issue's
     * scope. Everything below is spelled out instead of inherited.
     *
     * The two `error`/`warn` guards below are not score gates; they exist so the
     * job cannot report success while having measured nothing useful:
     *   - `http-status-code` — a non-2xx route still renders a scorable page, so
     *     without this a broken route would post a plausible-looking score and a
     *     delta against whatever the base served. This is not hypothetical: it
     *     is exactly what happens on the PR that first introduces the tab routes,
     *     since the base branch has no `/[tab]` segment and would 404 on all
     *     four URLs.
     *   - `errors-in-console` — this app does its rendering, wallet wiring and
     *     RPC polling on the client, so an uncaught error in the console is the
     *     most likely real-world failure and does not necessarily change any
     *     score.
     *
     * Every assertion name here is a real Lighthouse audit id. A name that is
     * not (for example `lhr-runtime-error`) is rejected by `lhci assert` with
     * '"<name>" is not a known audit' rather than being ignored, so a typo
     * fails the job loudly — which is why the list is short and explicit.
     *
     * Flip the four score assertions to `error` when the team is ready to gate.
     */
    assert: {
      assertions: {
        "categories:performance": ["warn", { minScore: 0.9 }],
        "categories:accessibility": ["warn", { minScore: 0.9 }],
        "categories:best-practices": ["warn", { minScore: 0.9 }],
        "categories:seo": ["warn", { minScore: 0.9 }],
        "http-status-code": "error",
        "errors-in-console": ["warn", { maxLength: 0 }],
      },
    },
  },
};
