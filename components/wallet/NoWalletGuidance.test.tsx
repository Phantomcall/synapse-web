import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NoWalletGuidance } from "./NoWalletGuidance";
import * as detectionModule from "@/lib/wallet/detection";

describe("NoWalletGuidance Component", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders header and guidance information when no wallet is detected", () => {
    vi.spyOn(detectionModule, "useWalletExtensionDetection").mockReturnValue({
      freighter: false,
      xbull: false,
      albedo: false,
      hasAny: false,
      checked: true,
      recheck: vi.fn(),
    });

    render(<NoWalletGuidance />);

    expect(screen.getByText(/NO STELLAR WALLET DETECTED/i)).toBeDefined();
    expect(screen.getByText(/Freighter/i)).toBeDefined();
    expect(screen.getByText(/xBull Wallet/i)).toBeDefined();
    expect(screen.getByText(/Ledger/i)).toBeDefined();
    expect(screen.getByText(/WalletConnect/i)).toBeDefined();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(<NoWalletGuidance onClose={onClose} />);

    const closeBtn = screen.getByLabelText("Close guidance");
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onProceedAnyway when alternative connect link is clicked", () => {
    const onProceedAnyway = vi.fn();
    render(<NoWalletGuidance onProceedAnyway={onProceedAnyway} />);

    const proceedBtn = screen.getByText(/Connect via QR\/Hardware instead/i);
    fireEvent.click(proceedBtn);
    expect(onProceedAnyway).toHaveBeenCalledTimes(1);
  });

  it("calls recheck when re-check button is clicked", () => {
    const recheckMock = vi.fn();
    vi.spyOn(detectionModule, "useWalletExtensionDetection").mockReturnValue({
      freighter: false,
      xbull: false,
      albedo: false,
      hasAny: false,
      checked: true,
      recheck: recheckMock,
    });

    render(<NoWalletGuidance />);
    const recheckBtn = screen.getByText(/Re-check Extensions/i);
    fireEvent.click(recheckBtn);
    expect(recheckMock).toHaveBeenCalled();
  });
});
