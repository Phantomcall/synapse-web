import { expect, test } from "@playwright/test";

const walletAddress = "GBJAD5SD5JZEEQLSXJIKT3HQILMB24SM7WAQ3Z4U4Y5WA6HLNARMVHTD";
const adminAddress = "GDGIJNUB3XZCYVE3ABIRDHF4CKHFZD2UAW5Q3T7D6DAZYUSGF7TKG2VG";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((address) => {
    window.__SYNAPSE_E2E__ = {
      wallet: {
        authModal: async () => {},
        getAddress: async () => ({ address }),
        disconnect: async () => {},
        selectedModule: { productId: "playwright-mock" },
      },
      simulateContractCall: async (method) => (method === "version" ? "e2e-version" : "healthy"),
      invokeContract: async () => ({ status: "SUCCESS", hash: "e2e-transaction-hash" }),
    };
  }, walletAddress);
});

test("loads mock fallback data and navigates between tabs", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("mock data", { exact: true })).toBeVisible();
  await expect(page.getByText("TOTAL TXS", { exact: true })).toBeVisible();

  const transactionsTab = page.getByRole("tab", { name: "transactions" });
  await transactionsTab.click();
  await expect(transactionsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("ALL TRANSACTIONS (4)")).toBeVisible();
  await expect(page.getByText("5.00", { exact: true })).toBeVisible();

  const dashboardTab = page.getByRole("tab", { name: "dashboard" });
  await dashboardTab.click();
  await expect(dashboardTab).toHaveAttribute("aria-selected", "true");
});

test("connects and disconnects the mocked wallet", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "connect wallet" }).click();
  const connectedButton = page.getByRole("button", { name: /^GBJAD5SD5JZE/ });
  await expect(connectedButton).toBeVisible();

  await connectedButton.click();
  await expect(page.getByRole("button", { name: "connect wallet" })).toBeVisible();
});

test("simulates an admin diagnostic and confirms a protected action", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "connect wallet" }).click();
  await page.getByRole("tab", { name: "admin" }).click();

  await page.getByRole("button", { name: "health()" }).click();
  await expect(page.getByText('health() → "healthy"')).toBeVisible();

  await page.getByPlaceholder("G… new admin address").fill(adminAddress);
  await page.getByRole("button", { name: "TRANSFER →" }).click();

  const confirmation = page.getByRole("dialog");
  await expect(confirmation.getByText("TRANSFER ADMIN — IRREVERSIBLE")).toBeVisible();
  await confirmation.locator("input").fill(adminAddress);
  await confirmation.getByRole("button", { name: "CONFIRM →" }).click();

  await expect(page.getByText(/transfer_admin\(\) succeeded/)).toBeVisible();
});
