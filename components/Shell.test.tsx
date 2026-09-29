import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Shell } from "./Shell";
import { ToastProvider } from "@/components/ui/Toast";

vi.mock("@/lib/wallet/WalletProvider", () => ({
  useWallet: () => ({
    address: null,
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
    lastEventAge: "2s",
    health: { status: "ok" },
  }),
}));

vi.mock("@/lib/wallet/detection", () => ({
  useWalletExtensionDetection: () => ({
    freighter: true,
    xbull: false,
    albedo: false,
    hasAny: true,
    checked: true,
    recheck: vi.fn(),
  }),
}));

describe("Shell Code-Splitting & Navigation Suite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders default dashboard tab correctly", () => {
    render(
      <ToastProvider>
        <Shell />
      </ToastProvider>
    );
    const activeTab = screen.getByRole("tab", { name: /DASHBOARD/i });
    expect(activeTab.getAttribute("aria-selected")).toBe("true");
  });

  it("supports direct linking / initialTab prop to load non-default tab", () => {
    render(
      <ToastProvider>
        <Shell initialTab="transactions" />
      </ToastProvider>
    );
    const activeTab = screen.getByRole("tab", { name: /TRANSACTIONS/i });
    expect(activeTab.getAttribute("aria-selected")).toBe("true");
  });

  it("navigates between tabs via click", () => {
    render(
      <ToastProvider>
        <Shell />
      </ToastProvider>
    );
    const adminTab = screen.getByRole("tab", { name: /ADMIN/i });
    fireEvent.click(adminTab);
    expect(adminTab.getAttribute("aria-selected")).toBe("true");
  });

  it("navigates between tabs via keyboard arrow keys", () => {
    render(
      <ToastProvider>
        <Shell />
      </ToastProvider>
    );
    const dashboardTab = screen.getByRole("tab", { name: /DASHBOARD/i });
    fireEvent.keyDown(dashboardTab, { key: "ArrowRight" });
    const transactionsTab = screen.getByRole("tab", { name: /TRANSACTIONS/i });
    expect(transactionsTab.getAttribute("aria-selected")).toBe("true");
  });
});
