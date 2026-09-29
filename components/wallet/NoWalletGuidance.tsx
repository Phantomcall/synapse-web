"use client";

import React from "react";
import { AMBER, BG1, BG2, BORDER, DIM, MONO } from "@/lib/constants";
import { SUPPORTED_WALLETS } from "@/lib/wallet/kit";
import { useWalletExtensionDetection } from "@/lib/wallet/detection";

interface NoWalletGuidanceProps {
  onClose?: () => void;
  onProceedAnyway?: () => void;
}

export function NoWalletGuidance({ onClose, onProceedAnyway }: NoWalletGuidanceProps) {
  const { freighter, xbull, recheck } = useWalletExtensionDetection();

  return (
    <div
      role="region"
      aria-label="No Wallet Detected Guidance"
      style={{
        background: BG1,
        border: `1px solid ${BORDER}`,
        padding: "24px",
        maxWidth: "600px",
        width: "100%",
        boxSizing: "border-box",
        fontFamily: MONO,
        color: "#fff",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: AMBER,
                display: "inline-block",
              }}
            />
            <h2
              style={{
                fontSize: "14px",
                fontWeight: 700,
                letterSpacing: "0.08em",
                margin: 0,
                color: "#fff",
              }}
            >
              NO STELLAR WALLET DETECTED
            </h2>
          </div>
          <p
            style={{
              fontSize: "11px",
              color: DIM,
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            To interact with Synapse Core and Soroban contracts on Testnet, you will need a supported wallet.
            Install one of the recommended extensions below, then refresh or return here.
          </p>
        </div>

        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close guidance"
            style={{
              background: "transparent",
              border: `1px solid ${BORDER}`,
              color: DIM,
              cursor: "pointer",
              padding: "4px 8px",
              fontSize: "11px",
            }}
          >
            ✕
          </button>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "12px",
          margin: "20px 0",
        }}
      >
        {SUPPORTED_WALLETS.map((wallet) => {
          const isInstalled =
            (wallet.id === "freighter" && freighter) ||
            (wallet.id === "xbull" && xbull);

          return (
            <div
              key={wallet.id}
              style={{
                background: BG2,
                border: `1px solid ${isInstalled ? AMBER : BORDER}`,
                padding: "14px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: "10px",
              }}
            >
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                  <span style={{ fontWeight: 600, fontSize: "12px", color: "#fff" }}>
                    {wallet.name}
                  </span>
                  <span
                    style={{
                      fontSize: "9px",
                      textTransform: "uppercase",
                      padding: "2px 6px",
                      border: `1px solid ${isInstalled ? AMBER : BORDER}`,
                      color: isInstalled ? AMBER : DIM,
                    }}
                  >
                    {isInstalled ? "Detected" : wallet.type}
                  </span>
                </div>
                <p style={{ fontSize: "10px", color: DIM, margin: 0, lineHeight: 1.4 }}>
                  {wallet.description}
                </p>
              </div>

              <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                <a
                  href={wallet.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-block",
                    background: "rgba(245,166,35,0.08)",
                    border: `1px solid ${AMBER}`,
                    color: AMBER,
                    fontSize: "10px",
                    fontWeight: 600,
                    padding: "5px 12px",
                    textDecoration: "none",
                    textAlign: "center",
                    letterSpacing: "0.04em",
                  }}
                >
                  {wallet.type === "extension" ? "Install Extension ↗" : "Get Wallet ↗"}
                </a>
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderTop: `1px solid ${BORDER}`,
          paddingTop: "14px",
        }}
      >
        <button
          onClick={() => recheck()}
          style={{
            background: "transparent",
            border: `1px solid ${BORDER}`,
            color: "#fff",
            fontSize: "10px",
            padding: "6px 14px",
            cursor: "pointer",
            fontFamily: MONO,
          }}
        >
          ↻ Re-check Extensions
        </button>

        {onProceedAnyway && (
          <button
            onClick={onProceedAnyway}
            style={{
              background: "transparent",
              border: "none",
              color: DIM,
              fontSize: "10px",
              cursor: "pointer",
              fontFamily: MONO,
              textDecoration: "underline",
            }}
          >
            Connect via QR/Hardware instead
          </button>
        )}
      </div>
    </div>
  );
}
