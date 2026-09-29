import { expect, test, type Page, type Request, type Response } from "@playwright/test";

/**
 * Staging smoke tests.
 *
 * Every assertion here is about something a broken deploy actually breaks:
 * the page serving, its assets being present, the client bundle hydrating, the
 * live Soroban RPC being reachable, and the wallet picker opening. None of it
 * needs a wallet extension, a funded account, or a mock.
 *
 * What these tests deliberately do NOT do: complete a wallet connection, submit
 * a transaction, or assert on contract data. That needs credentials this gate
 * must not have, and `NEXT_PUBLIC_CONTRACT_ID` may be unset on the target.
 */

/** The app is a single static route; these are the landmarks that must exist. */
const NAV_TABS = ["dashboard", "transactions", "admin", "docs"];

test.describe("staging smoke", () => {
  test("serves the dashboard", async ({ page }) => {
    const response = await page.goto("/");

    expect(response?.status(), "GET / should return 200").toBe(200);
    await expect(page).toHaveTitle(/Synapse Core/);

    // The header, the four section tabs, and the footer version are what a
    // successful render looks like. If the app renders an error boundary or a
    // blank shell, these are the first things to disappear.
    await expect(page.getByRole("tablist", { name: "Sections" })).toBeVisible();
    for (const tab of NAV_TABS) {
      await expect(page.getByRole("tab", { name: tab, exact: true })).toBeVisible();
    }
    await expect(page.locator("footer")).toContainText("SYNAPSE CORE");
  });

  test("ships every asset the page asks for", async ({ page }) => {
    const bad: string[] = [];
    const failed: string[] = [];

    page.on("response", (res: Response) => {
      // Only same-origin: a cross-origin RPC hiccup is the RPC test's job, and
      // mixing it in would make an asset failure and a network failure look alike.
      if (
        new URL(res.url()).origin === new URL(page.url() || "http://x").origin &&
        res.status() >= 400
      ) {
        bad.push(`${res.status()} ${res.url()}`);
      }
    });
    page.on("requestfailed", (req: Request) =>
      failed.push(`${req.url()} (${req.failure()?.errorText})`)
    );

    await page.goto("/", { waitUntil: "load" });
    // Give lazy/deferred asset requests a chance to land before judging them.
    await page.waitForLoadState("networkidle");

    // A stale build id or a partially-copied asset directory shows up here as
    // a 404 on a /_next/static/ chunk, which the page still "renders" around.
    expect(bad, `same-origin responses >= 400:\n${bad.join("\n")}`).toEqual([]);
    expect(failed, `requests that never completed:\n${failed.join("\n")}`).toEqual([]);
  });

  test("hydrates the client bundle without uncaught exceptions", async ({ page }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];

    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/", { waitUntil: "load" });

    // The app is server-rendered, so the interesting question is whether the
    // client bundle takes over. React only attaches its handlers once
    // hydration completes, so a click that changes the DOM is proof.
    const tab = page.getByRole("tab", { name: "transactions", exact: true });
    await tab.click();
    await expect(page.getByRole("tab", { name: "transactions", exact: true })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    expect(pageErrors, `uncaught exceptions:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  });

  test("reaches the live Stellar RPC", async ({ page }) => {
    const rpc: string[] = [];
    const rpcStatuses: number[] = [];

    page.on("response", (res: Response) => {
      const req = res.request();
      if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
        if (/rpc|stellar/i.test(res.url())) {
          rpc.push(res.url());
          rpcStatuses.push(res.status());
        }
      }
    });

    await page.goto("/", { waitUntil: "load" });
    const footer = page.locator("footer");

    // Wait for the app to leave "connecting". Both outcomes are a pass -- a
    // configured-but-wrong contract should read "error: ...", and that is
    // information, not a broken deploy. Being stuck on "connecting" means the
    // request never came back, which is the failure worth catching.
    await expect(footer).toHaveText(/SOROBAN RPC: (connected|error)/, { timeout: 30_000 });

    expect(rpc.length, "the deployed bundle should call the Soroban RPC").toBeGreaterThan(0);
    expect(
      rpcStatuses.filter((s) => s >= 400),
      `RPC responses >= 400:\n${rpc.join("\n")}`
    ).toEqual([]);
  });

  test("opens the wallet picker", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });

    const connectButton = page.getByRole("button", { name: "connect wallet" });
    await expect(connectButton).toBeVisible();
    await connectButton.click();

    // Reaching the wallets-kit modal proves the client bundle initialised the
    // kit and the click handler ran -- the part of "wallet connect" that can
    // be verified without a browser extension. Actually completing a connection
    // needs one, and is out of scope for this gate.
    const modal = page.locator('[class*="stellar-wallets-kit"]').first();
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(/Connect Wallet/i);

    // The button reflects the in-flight state while the modal is up.
    await expect(page.getByRole("button", { name: /connecting/ })).toBeVisible();
  });
});

/** Kept next to the tests that use it so the intent stays readable. */
export type { Page };
