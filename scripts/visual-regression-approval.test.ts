import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  APPROVAL_COMMAND,
  APPROVAL_MARKER,
  BLOCK_REASONS,
  evaluateBaselineApproval,
  formatApprovalReport,
  isApprovalSignal,
  resolvePermission,
} from "./visual-regression-approval.mjs";

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);

interface Review {
  user: string;
  state: string;
  body: string;
  commitId: string;
}

interface ApprovalPayload {
  author?: string;
  headSha?: string;
  reviews?: Review[];
  permissions?: Record<string, string>;
  associations?: Record<string, string>;
  required?: boolean;
}

function approval(user: string, overrides: Partial<Review> = {}): Review {
  return {
    user,
    state: "APPROVED",
    body: `Intentional restyle.\n${APPROVAL_MARKER}`,
    commitId: HEAD,
    ...overrides,
  };
}

function payload(reviews: Review[], overrides: ApprovalPayload = {}): ApprovalPayload {
  return {
    author: "pr-author",
    headSha: HEAD,
    reviews,
    permissions: { "design-lead": "write", outsider: "read", "pr-author": "admin" },
    associations: { "design-lead": "MEMBER" },
    required: true,
    ...overrides,
  };
}

/** The single blocking reason, asserted explicitly so an empty list fails loudly. */
function onlyBlockReason(decision: ReturnType<typeof evaluateBaselineApproval>): string {
  expect(decision.blocked).toHaveLength(1);
  const [entry] = decision.blocked;
  if (!entry) throw new Error("expected exactly one blocked review");
  return entry.reason;
}

describe("Visual Regression Baseline Approval Gate", () => {
  it("recognises every supported baseline approval signal", () => {
    expect(isApprovalSignal(APPROVAL_MARKER)).toBe(true);
    expect(isApprovalSignal(`looks good ${APPROVAL_COMMAND}`)).toBe(true);
    expect(isApprovalSignal("Baseline approved after design review.")).toBe(true);
    expect(isApprovalSignal("baseline-approved")).toBe(true);
  });

  it("does not treat an ordinary review as a baseline approval", () => {
    expect(isApprovalSignal("LGTM, nice cleanup")).toBe(false);
    expect(isApprovalSignal("")).toBe(false);
    expect(isApprovalSignal(undefined)).toBe(false);
  });

  it("refuses to let the PR author approve their own baseline update", () => {
    const decision = evaluateBaselineApproval(payload([approval("pr-author")]));

    expect(decision.approved).toBe(false);
    expect(decision.code).toBe("no-valid-approval");
    expect(decision.blocked).toHaveLength(1);
    expect(decision.blocked[0]?.user).toBe("pr-author");
    expect(onlyBlockReason(decision)).toBe(BLOCK_REASONS.AUTHOR_SELF_APPROVAL);
  });

  it("refuses a plain approval from the author that merely looks like a sign-off", () => {
    const decision = evaluateBaselineApproval(
      payload([approval("pr-author", { body: "Baseline approved." })])
    );

    expect(decision.approved).toBe(false);
    expect(onlyBlockReason(decision)).toBe(BLOCK_REASONS.AUTHOR_SELF_APPROVAL);
  });

  it("refuses a baseline approval from a user without write access", () => {
    const decision = evaluateBaselineApproval(payload([approval("outsider")]));

    expect(decision.approved).toBe(false);
    expect(onlyBlockReason(decision)).toBe(BLOCK_REASONS.INSUFFICIENT_PERMISSION);
  });

  it("refuses a baseline approval left on a stale commit", () => {
    const decision = evaluateBaselineApproval(
      payload([approval("design-lead", { commitId: OLD_HEAD })])
    );

    expect(decision.approved).toBe(false);
    expect(onlyBlockReason(decision)).toBe(BLOCK_REASONS.STALE_COMMIT);
  });

  it("refuses a review that approves but omits the baseline signal", () => {
    const decision = evaluateBaselineApproval(
      payload([approval("design-lead", { body: "Looks good to me." })])
    );

    expect(decision.approved).toBe(false);
    expect(onlyBlockReason(decision)).toBe(BLOCK_REASONS.MISSING_SIGNAL);
  });

  it("revokes an earlier approval when the same reviewer requests changes", () => {
    const decision = evaluateBaselineApproval(
      payload([
        approval("design-lead"),
        {
          user: "design-lead",
          state: "CHANGES_REQUESTED",
          body: "Revert the colour token.",
          commitId: HEAD,
        },
      ])
    );

    expect(decision.approved).toBe(false);
    expect(onlyBlockReason(decision)).toBe(BLOCK_REASONS.REVOKED);
  });

  it("accepts a baseline approval from a different user with write access", () => {
    const decision = evaluateBaselineApproval(payload([approval("design-lead")]));

    expect(decision.approved).toBe(true);
    expect(decision.code).toBe("approved");
    expect(decision.approvers).toEqual(["design-lead"]);
  });

  it("still fails when the author approves and nobody else does", () => {
    const decision = evaluateBaselineApproval(
      payload([approval("pr-author"), approval("outsider")])
    );

    expect(decision.approved).toBe(false);
    expect(decision.approvers).toEqual([]);
    expect(decision.blocked.map((entry) => entry.reason)).toEqual([
      BLOCK_REASONS.AUTHOR_SELF_APPROVAL,
      BLOCK_REASONS.INSUFFICIENT_PERMISSION,
    ]);
  });

  it("does not require an approval when no baseline was changed", () => {
    const decision = evaluateBaselineApproval(payload([], { required: false }));

    expect(decision.approved).toBe(true);
    expect(decision.code).toBe("not-required");
    expect(formatApprovalReport(decision)).toContain("not required");
  });

  it("falls back to author_association when the permission API is unavailable", () => {
    expect(resolvePermission("design-lead", {}, { "design-lead": "COLLABORATOR" })).toBe("write");
    expect(resolvePermission("design-lead", {}, { "design-lead": "OWNER" })).toBe("admin");
    expect(resolvePermission("outsider", {}, { outsider: "CONTRIBUTOR" })).toBe("none");
    expect(resolvePermission("nobody", {}, {})).toBe("none");
    expect(resolvePermission("design-lead", { "design-lead": "WRITE" })).toBe("write");
  });

  it("renders a report that names the blocked reviewer and the remedy", () => {
    const report = formatApprovalReport(evaluateBaselineApproval(payload([approval("pr-author")])));

    expect(report).toContain("@pr-author");
    expect(report).toContain("authors can never satisfy the baseline gate");
    expect(report).toContain(APPROVAL_MARKER);
    expect(report).toContain(APPROVAL_COMMAND);
  });

  it("exits non-zero from the CLI when the baseline is unapproved", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-approval-"));
    const payloadPath = path.join(dir, "approval-payload.json");
    const outPath = path.join(dir, "approval-decision.json");
    fs.writeFileSync(
      payloadPath,
      JSON.stringify(payload([approval("pr-author")], { headSha: HEAD }))
    );

    const scriptPath = path.resolve(__dirname, "./visual-regression-approval.mjs");
    let status = 0;
    try {
      execFileSync(process.execPath, [scriptPath, "--payload", payloadPath, "--out", outPath], {
        stdio: "pipe",
      });
    } catch (error) {
      // execFileSync throws a non-zero exit as an exception; only the status
      // matters here, and `unknown` needs narrowing before use.
      status = (error as { status?: number }).status ?? 0;
    }

    expect(status).toBe(1);
    expect(JSON.parse(fs.readFileSync(outPath, "utf8")).approved).toBe(false);
  });

  it("exits zero from the CLI once an independent approver signs off", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-approval-"));
    const payloadPath = path.join(dir, "approval-payload.json");
    const outPath = path.join(dir, "approval-decision.json");
    fs.writeFileSync(
      payloadPath,
      JSON.stringify(payload([approval("pr-author"), approval("design-lead")]))
    );

    const scriptPath = path.resolve(__dirname, "./visual-regression-approval.mjs");
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, "--payload", payloadPath, "--out", outPath],
      { stdio: "pipe", encoding: "utf8" }
    );

    const decision = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(decision.approved).toBe(true);
    expect(decision.approvers).toEqual(["design-lead"]);
    expect(stdout).toContain("Baseline approved by design-lead");
  });
});
