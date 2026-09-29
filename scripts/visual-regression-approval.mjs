#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APPROVAL_MARKER = "<!-- baseline-approved -->";
export const APPROVAL_COMMAND = "/baseline-approve";
export const APPROVAL_PHRASE = /\bbaseline[\s-]approved\b/i;
export const WRITE_PERMISSIONS = ["admin", "maintain", "write"];

export const ASSOCIATION_PERMISSIONS = {
  owner: "admin",
  member: "write",
  collaborator: "write",
  contributor: "none",
  none: "none",
};

export const BLOCK_REASONS = {
  AUTHOR_SELF_APPROVAL: "author-self-approval",
  NOT_APPROVING: "not-an-approving-review",
  MISSING_SIGNAL: "missing-baseline-approval-signal",
  INSUFFICIENT_PERMISSION: "insufficient-permission",
  STALE_COMMIT: "stale-approval-commit",
  REVOKED: "revoked-by-changes-requested",
};

/** True when a review/comment body carries an explicit baseline-approval signal. */
export function isApprovalSignal(body) {
  if (typeof body !== "string" || body.trim() === "") return false;
  return (
    body.includes(APPROVAL_MARKER) || body.includes(APPROVAL_COMMAND) || APPROVAL_PHRASE.test(body)
  );
}

/** Resolves a login to a normalised permission, preferring the API and falling back to author_association. */
export function resolvePermission(login, permissions = {}, associations = {}) {
  const fromApi = permissions?.[login];
  if (typeof fromApi === "string" && fromApi !== "") return fromApi.toLowerCase();
  const association = associations?.[login];
  if (typeof association === "string" && association !== "") {
    return ASSOCIATION_PERMISSIONS[association.toLowerCase()] ?? "none";
  }
  return "none";
}

function latestReviewPerUser(reviews) {
  const latest = new Map();
  for (const review of reviews) {
    if (review?.user) latest.set(review.user, review);
  }
  return latest;
}

/**
 * Decides whether a baseline update is independently approved.
 *
 * A valid approval is an APPROVED review that (a) carries an explicit baseline
 * approval signal, (b) comes from someone other than the PR author, (c) comes
 * from a collaborator with write access, and (d) targets the current head
 * commit. The PR author is never allowed to satisfy the gate.
 */
export function evaluateBaselineApproval(payload = {}) {
  const {
    author = "",
    headSha = "",
    reviews = [],
    permissions = {},
    associations = {},
    required = true,
  } = payload;

  const validApprovals = [];
  const blocked = [];

  for (const [user, review] of latestReviewPerUser(reviews)) {
    const permission = resolvePermission(user, permissions, associations);
    const state = review.state;
    const signal = isApprovalSignal(review.body);
    const onHead = review.commitId === headSha;
    const entry = { user, permission, state, signal, onHead, commitId: review.commitId };

    if (user === author) {
      blocked.push({ ...entry, reason: BLOCK_REASONS.AUTHOR_SELF_APPROVAL });
      continue;
    }
    if (state === "CHANGES_REQUESTED") {
      blocked.push({ ...entry, reason: BLOCK_REASONS.REVOKED });
      continue;
    }
    if (state !== "APPROVED") {
      blocked.push({ ...entry, reason: BLOCK_REASONS.NOT_APPROVING });
      continue;
    }
    if (!signal) {
      blocked.push({ ...entry, reason: BLOCK_REASONS.MISSING_SIGNAL });
      continue;
    }
    if (!WRITE_PERMISSIONS.includes(permission)) {
      blocked.push({ ...entry, reason: BLOCK_REASONS.INSUFFICIENT_PERMISSION });
      continue;
    }
    if (!onHead) {
      blocked.push({ ...entry, reason: BLOCK_REASONS.STALE_COMMIT });
      continue;
    }
    validApprovals.push(entry);
  }

  const approved = !required || validApprovals.length > 0;
  const code = !required ? "not-required" : approved ? "approved" : "no-valid-approval";

  return {
    approved,
    required,
    code,
    author,
    headSha,
    validApprovals,
    blocked,
    approvers: validApprovals.map((approval) => approval.user),
  };
}

const REASON_COPY = {
  [BLOCK_REASONS.AUTHOR_SELF_APPROVAL]:
    "self-approval by the PR author — authors can never satisfy the baseline gate",
  [BLOCK_REASONS.NOT_APPROVING]: "review is not an approval",
  [BLOCK_REASONS.MISSING_SIGNAL]: `review is missing the "${APPROVAL_MARKER}" signal`,
  [BLOCK_REASONS.INSUFFICIENT_PERMISSION]: "reviewer does not have write access",
  [BLOCK_REASONS.STALE_COMMIT]: "approval targets an older commit — re-approve the current head",
  [BLOCK_REASONS.REVOKED]: "approval was revoked by a later changes-requested review",
};

/** Renders a human readable markdown verdict for CI logs and the PR comment. */
export function formatApprovalReport(decision) {
  const lines = [];
  if (!decision.required) {
    lines.push("Baseline approval not required: no snapshot baseline was changed by this PR.");
    return lines.join("\n");
  }
  if (decision.approved) {
    lines.push(
      `Baseline approved by ${decision.approvers.join(", ")} (write access, on head ${decision.headSha.slice(0, 7)}).`
    );
  } else {
    lines.push(`Baseline update is NOT approved for ${decision.headSha.slice(0, 7)}.`);
    lines.push("");
    for (const entry of decision.blocked) {
      lines.push(`- @${entry.user} — ${REASON_COPY[entry.reason] ?? entry.reason}`);
    }
    if (decision.blocked.length === 0) {
      lines.push("- No review on this pull request carries a baseline approval signal yet.");
    }
  }
  lines.push("");
  lines.push(
    `A valid approval is an **Approve** review from someone other than @${decision.author} who has write access to the repository, left on the current head commit, whose body contains \`${APPROVAL_MARKER}\` (or \`${APPROVAL_COMMAND}\`).`
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const payloadPath = args.payload ?? "approval-payload.json";
  if (!fs.existsSync(payloadPath)) {
    process.stderr.write(`approval payload not found: ${payloadPath}\n`);
    process.exit(2);
  }

  const raw = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  const decision = evaluateBaselineApproval({ ...raw, required: args.required !== "false" });

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(decision, null, 2)}\n`);
  }

  const report = formatApprovalReport(decision);
  if (args.report) {
    fs.writeFileSync(args.report, `${report}\n`);
  }
  process.stdout.write(`${report}\n`);

  if (process.env.GITHUB_OUTPUT) {
    const rows = [
      `approved=${decision.approved}`,
      `code=${decision.code}`,
      `approvers=${decision.approvers.join(",")}`,
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${rows.join("\n")}\n`);
  }

  process.exit(decision.approved ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
