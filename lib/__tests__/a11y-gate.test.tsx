import React from "react";
import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Shell } from "@/components/Shell";
import { DashboardTab } from "@/components/dashboard/DashboardTab";
import { TransactionsTab } from "@/components/transactions/TransactionsTab";
import { AdminTab } from "@/components/admin/AdminTab";
import { DocsTab } from "@/components/docs/DocsTab";
import { ToastProvider } from "@/components/ui/Toast";

vi.mock("@/lib/wallet/WalletProvider", () => ({
  useWallet: () => ({
    address: "GBZXN7PIRZGNMHGA728RGRYA72R6UGRM6X8J73V2S8L7D2Z5V5P8K3M4",
    connecting: false,
    error: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
  WalletProvider: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/lib/soroban/useSorobanStatus", () => ({
  useSorobanStatus: () => ({
    status: "connected",
    lastEventAge: "1s",
    health: { status: "ok" },
  }),
}));

vi.mock("@/lib/soroban/useLiveContractInfo", () => ({
  useLiveContractInfo: () => ({
    info: {
      contract_id: "CA3D5KRYMCM...",
      admin: "GBZXN7PIRZGNMHGA...",
      relay_signer: "GA2C5RFPE6GC...",
      paused: false,
      fee_recipient: "GBZXN7PIRZGNMHGA...",
    },
    loading: false,
    error: null,
  }),
}));

vi.mock("@/lib/soroban/useLiveTransactions", () => ({
  useLiveTransactions: () => [],
}));

/**
 * Validates WCAG 2.1 AA accessibility invariants across rendered container.
 */
function auditAccessibilityInvariants(container: HTMLElement) {
  const violations: string[] = [];

  // 1. All buttons must have an accessible name or label
  const buttons = container.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((btn, idx) => {
    const accessibleName =
      btn.getAttribute("aria-label") ||
      btn.getAttribute("aria-labelledby") ||
      btn.textContent?.trim();
    if (!accessibleName) {
      violations.push(`Button at index ${idx} missing accessible name`);
    }
  });

  // 2. All inputs must have associated labels or aria-label
  const inputs = container.querySelectorAll<HTMLInputElement>("input, textarea, select");
  inputs.forEach((input, idx) => {
    const hasLabel = input.id && container.querySelector(`label[for="${input.id}"]`);
    const hasAriaLabel = input.getAttribute("aria-label") || input.getAttribute("aria-labelledby");
    if (!hasLabel && !hasAriaLabel && input.type !== "hidden") {
      violations.push(
        `Input at index ${idx} (${input.tagName.toLowerCase()}) missing associated label`
      );
    }
  });

  // 3. Tablist must have role="tab" children with aria-selected
  const tablists = container.querySelectorAll('[role="tablist"]');
  tablists.forEach((tablist) => {
    const tabs = tablist.querySelectorAll('[role="tab"]');
    if (tabs.length === 0) {
      violations.push('Found role="tablist" with no role="tab" elements');
    }
    tabs.forEach((tab) => {
      if (!tab.hasAttribute("aria-selected")) {
        violations.push('Tab missing required "aria-selected" attribute');
      }
    });
  });

  return violations;
}

describe("Automated WCAG 2.1 AA Accessibility Gate Suite", () => {
  it("passes accessibility gate for Main Shell and Navigation", () => {
    const { container } = render(
      <ToastProvider>
        <Shell />
      </ToastProvider>
    );
    const violations = auditAccessibilityInvariants(container);
    expect(violations).toEqual([]);
  });

  it("passes accessibility gate for DashboardTab", () => {
    const { container } = render(
      <ToastProvider>
        <DashboardTab />
      </ToastProvider>
    );
    const violations = auditAccessibilityInvariants(container);
    expect(violations).toEqual([]);
  });

  it("passes accessibility gate for TransactionsTab", () => {
    const { container } = render(
      <ToastProvider>
        <TransactionsTab />
      </ToastProvider>
    );
    const violations = auditAccessibilityInvariants(container);
    expect(violations).toEqual([]);
  });

  it("passes accessibility gate for AdminTab", () => {
    const { container } = render(
      <ToastProvider>
        <AdminTab />
      </ToastProvider>
    );
    const violations = auditAccessibilityInvariants(container);
    expect(violations).toEqual([]);
  });

  it("passes accessibility gate for DocsTab", () => {
    const { container } = render(
      <ToastProvider>
        <DocsTab />
      </ToastProvider>
    );
    const violations = auditAccessibilityInvariants(container);
    expect(violations).toEqual([]);
  });

  it("deliberately fails on unlabelled button regression", () => {
    const testContainer = document.createElement("div");
    const badButton = document.createElement("button");
    testContainer.appendChild(badButton);

    const violations = auditAccessibilityInvariants(testContainer);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("missing accessible name");
  });
});
