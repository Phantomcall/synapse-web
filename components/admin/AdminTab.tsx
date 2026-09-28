"use client";
import { useState } from "react";
import { scValToNative } from "@stellar/stellar-sdk";
import { Panel } from "@/components/ui/Panel";
import { Field } from "@/components/ui/Field";
import { SorobanTip } from "@/components/ui/SorobanTip";
import { ActionButton } from "@/components/ui/ActionButton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { addressArg, invokeContract, simulateContractCall } from "@/lib/soroban/contract";
import { shortId } from "@/lib/utils";
import { AMBER, BORDER, DIM, MONO, STATUS_META } from "@/lib/constants";
import { appConfig } from "@/lib/config";

// Resolved once, through the validated config module, so the network/RPC
// pairing has already been checked and the testnet endpoint is not hardcoded
// in five places.
const RPC_URL = appConfig.rpcUrl;
const CONTRACT_ID = appConfig.contractId;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FieldDef {
  label: string;
  key: string;
  placeholder: string;
}

interface ConfirmConfig {
  title: string;
  message: string;
  /** If set, user must retype this exact value before confirming */
  retypeKey?: string;
  accentColor?: string;
}

// ---------------------------------------------------------------------------
// AdminCard
// ---------------------------------------------------------------------------

function AdminCard({
  title,
  tip,
  fields,
  onSubmit,
  btnLabel,
  btnColor = AMBER,
  confirm,
}: {
  title: string;
  tip: string;
  fields: FieldDef[];
  onSubmit: (vals: Record<string, string>) => void | Promise<void>;
  btnLabel: string;
  btnColor?: string;
  confirm?: ConfirmConfig;
}) {
  const [vals, setVals] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, ""]))
  );
  const [pendingVals, setPendingVals] = useState<Record<string, string> | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(v: Record<string, string>) {
    setSubmitting(true);
    try {
      await onSubmit(v);
    } finally {
      setSubmitting(false);
    }
  }

  function handleClick() {
    if (confirm) {
      setPendingVals({ ...vals });
    } else {
      submit(vals);
    }
  }

  function handleConfirm() {
    if (pendingVals) submit(pendingVals);
    setPendingVals(null);
  }

  const retypeValue =
    confirm?.retypeKey && pendingVals ? pendingVals[confirm.retypeKey] : undefined;

  return (
    <>
      <Panel title={title}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
          {fields.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              value={vals[f.key] ?? ""}
              onChange={(v) => setVals((p) => ({ ...p, [f.key]: v }))}
              placeholder={f.placeholder}
            />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <ActionButton
            label={submitting ? "SUBMITTING…" : btnLabel}
            color={btnColor}
            onClick={handleClick}
            disabled={submitting}
          />
        </div>
        <SorobanTip>{tip}</SorobanTip>
      </Panel>

      {pendingVals && confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          retypeValue={retypeValue}
          retypePlaceholder={retypeValue ? `paste or type: ${retypeValue}` : undefined}
          accentColor={confirm.accentColor ?? btnColor}
          onConfirm={handleConfirm}
          onCancel={() => setPendingVals(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// AdminTab
// ---------------------------------------------------------------------------

export function AdminTab() {
  const { address, connect } = useWallet();
  const { toast } = useToast();

  async function runAdminCall(method: string, addresses: string[]) {
    if (!CONTRACT_ID) {
      toast("NEXT_PUBLIC_CONTRACT_ID is not configured", "error");
      return;
    }
    if (!address) {
      toast("Connect a wallet before submitting admin transactions", "error");
      await connect();
      return;
    }
    if (addresses.some((a) => !a.trim())) {
      toast("All address fields are required", "error");
      return;
    }
    try {
      const args = addresses.map(addressArg);
      const result = await invokeContract(RPC_URL, CONTRACT_ID, address, method, args);
      toast(
        `${method}() ${result.status === "SUCCESS" ? "succeeded" : "failed"} · tx ${shortId(result.hash)}`,
        result.status === "SUCCESS" ? "success" : "error"
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : `${method}() failed`, "error");
    }
  }

  async function runDiagnostic(method: string) {
    if (!CONTRACT_ID) {
      toast("NEXT_PUBLIC_CONTRACT_ID is not configured", "error");
      return;
    }
    if (!address) {
      toast("Connect a wallet to run read-only diagnostics", "error");
      await connect();
      return;
    }
    try {
      const simulated = await simulateContractCall(RPC_URL, CONTRACT_ID, address, method);
      const value = simulated.result ? scValToNative(simulated.result.retval) : undefined;
      toast(`${method}() → ${JSON.stringify(value)}`, "info");
    } catch (err) {
      toast(err instanceof Error ? err.message : `${method}() failed`, "error");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} className="animate-fade-in">
      {/* Warning banner */}
      <div
        style={{
          background: "rgba(239,83,80,0.06)",
          border: "1px solid rgba(239,83,80,0.3)",
          padding: "10px 16px",
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: "#EF5350",
            fontFamily: MONO,
            letterSpacing: "0.06em",
          }}
        >
          ⚠ PRIVILEGED ZONE — all operations here require admin keypair authorization
        </span>
      </div>

      {/* Initialize */}
      <AdminCard
        title="INITIALIZE CONTRACT"
        tip="initialize(admin: Address, relay_signer: Address) — one-time bootstrap; reverts if already initialized"
        fields={[
          { label: "admin", key: "admin", placeholder: "G… admin address" },
          { label: "relay_signer", key: "relay_signer", placeholder: "G… relay signer address" },
        ]}
        btnLabel="INITIALIZE →"
        onSubmit={(v) => runAdminCall("initialize", [v.admin ?? "", v.relay_signer ?? ""])}
      />

      {/* Transfer admin — requires retype confirmation */}
      <AdminCard
        title="TRANSFER ADMIN"
        tip="transfer_admin(new_admin: Address) — caller must be current admin; irreversible if wrong address"
        fields={[{ label: "new_admin", key: "new_admin", placeholder: "G… new admin address" }]}
        btnLabel="TRANSFER →"
        btnColor={STATUS_META.FAILED.color}
        confirm={{
          title: "TRANSFER ADMIN — IRREVERSIBLE",
          message:
            "You are transferring admin rights to a new address. " +
            "If the address is wrong you will permanently lose access to all admin functions. " +
            "Retype the destination address exactly to continue.",
          retypeKey: "new_admin",
          accentColor: STATUS_META.FAILED.color,
        }}
        onSubmit={(v) => runAdminCall("transfer_admin", [v.new_admin ?? ""])}
      />

      {/* Set relay signer — gated confirm (no retype required) */}
      <AdminCard
        title="SET RELAY SIGNER"
        tip="set_relay_signer(new_signer: Address) — caller must be current admin"
        fields={[
          { label: "new_signer", key: "new_signer", placeholder: "G… new relay signer address" },
        ]}
        btnLabel="SET SIGNER →"
        btnColor={STATUS_META.PROCESSING.color}
        confirm={{
          title: "REPLACE RELAY SIGNER",
          message:
            "You are replacing the relay signer address. " +
            "The current relay signer will immediately lose the ability to submit transactions. " +
            "Confirm only if you have the new signer ready.",
          accentColor: STATUS_META.PROCESSING.color,
        }}
        onSubmit={(v) => runAdminCall("set_relay_signer", [v.new_signer ?? ""])}
      />

      {/* Diagnostics */}
      <Panel title="DIAGNOSTICS">
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => runDiagnostic("health")}
            style={{
              flex: 1,
              padding: "10px 0",
              background: "transparent",
              border: `1px solid ${BORDER}`,
              color: DIM,
              cursor: "pointer",
              fontFamily: MONO,
              fontSize: 11,
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "#fff";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.35)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = DIM;
              e.currentTarget.style.borderColor = BORDER;
            }}
          >
            health()
          </button>
          <button
            onClick={() => runDiagnostic("version")}
            style={{
              flex: 1,
              padding: "10px 0",
              background: "transparent",
              border: `1px solid ${BORDER}`,
              color: DIM,
              cursor: "pointer",
              fontFamily: MONO,
              fontSize: 11,
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "#fff";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.35)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = DIM;
              e.currentTarget.style.borderColor = BORDER;
            }}
          >
            version()
          </button>
        </div>
        <SorobanTip>
          health() + version() → read-only simulations via rpc.Server; no signing required
        </SorobanTip>
      </Panel>
    </div>
  );
}
