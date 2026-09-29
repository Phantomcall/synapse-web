import { expect, test } from "@playwright/test";

/**
 * These two specs exist to give the cross-engine matrix something meaningful to
 * exercise, and to keep the matrix itself honest.
 *
 * They deliberately do not claim to demonstrate an engine-specific behavioural
 * difference in Synapse Core — no such difference is known today. What they do
 * assert is that each leg is genuinely running in a different engine, and that
 * the browser-facing network surface is identical across engines. A violation of
 * either is exactly the class of environment-specific regression #174 exists to
 * catch, and neither is observable from a single-engine run.
 */

const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

/**
 * Disjoint engine fingerprints.
 *
 * Naive `Safari/` matching is useless here: all three engines send
 * `AppleWebKit/<v>`, and Chromium additionally sends a trailing `Safari/<v>`
 * compatibility token. So each engine is identified by the token that only it
 * emits, and the `exclude` patterns make the buckets provably disjoint — a UA
 * that matched two engines would fail rather than pass by accident.
 */
const ENGINES = {
  chromium: {
    include: /\b(?:Chrome|Chromium|Edg)\/\d/,
    exclude: /\b(?:Firefox|FxiOS)\/\d/,
  },
  firefox: {
    include: /\b(?:Firefox|FxiOS)\/\d/,
    exclude: /\b(?:Chrome|Chromium|Edg)\/\d/,
  },
  webkit: {
    // Only WebKit sends both "Version/<x>" and "Safari/" — Chromium has the
    // latter without the former, and Firefox has neither.
    include: /\bVersion\/\d[\d.]*\s+Safari\//,
    exclude: /\b(?:Chrome|Chromium|Edg|Firefox|FxiOS)\/\d/,
  },
} as const;

type EngineName = keyof typeof ENGINES;

function isEngineName(name: string): name is EngineName {
  return Object.hasOwn(ENGINES, name);
}

test("runs in the engine the selected project targets", async ({ page }, testInfo) => {
  const project = testInfo.project.name;

  // Fails loudly if a project is added to playwright.config.ts without a
  // matching fingerprint here, rather than silently passing.
  expect(
    Object.hasOwn(ENGINES, project),
    `no UA fingerprint defined for Playwright project "${project}"`
  ).toBe(true);
  if (!isEngineName(project)) return;

  await page.goto("/");
  const ua = await page.evaluate(() => navigator.userAgent);

  const engine = ENGINES[project];
  expect(ua, `project "${project}" did not run in ${project}`).toMatch(engine.include);
  expect(ua, `project "${project}" also looks like another engine`).not.toMatch(engine.exclude);
});

test("only contacts its own origin and the configured Soroban RPC", async ({ page, baseURL }) => {
  const allowed = new Set([baseURL, new URL(RPC_URL).origin]);

  const offOrigin: string[] = [];
  page.on("request", (request) => {
    const { origin } = new URL(request.url());
    if (!allowed.has(origin)) offOrigin.push(request.url());
  });

  // Idle on the dashboard long enough for the SorobanProvider event poller to
  // fire at least once.
  await page.goto("/");
  await expect(page.getByText("TOTAL TXS").first()).toBeVisible();
  await page.waitForTimeout(3_000);

  expect(offOrigin, "the app issued requests to hosts outside its declared dependencies").toEqual(
    []
  );
});
