#!/usr/bin/env node
/**
 * Dependabot triage entrypoint, run by .github/workflows/dependabot-automerge.yml.
 *
 * Reads the PR from the GitHub API, derives the exact dependency changes from
 * the manifests the PR actually modified, hands those facts to the pure policy
 * in ./policy.mjs, and then acts: label, comment, and (only if the policy says
 * so) enable auto-merge.
 *
 * Deliberate non-goals:
 *
 *   - It never executes anything from the PR. Files are fetched as *text* and
 *     parsed as JSON or scanned for `uses:` lines. Running `pull_request_target`
 *     with a write token and then executing PR-supplied code would hand anyone
 *     who can open a PR the repository's write token.
 *   - It never guesses. Every unknown funnels into a hold. `process.exitCode` is
 *     non-zero only for infrastructure failures; a legitimate "hold" is a
 *     successful run of the policy, not a workflow failure.
 *
 * Required environment:
 *   GITHUB_TOKEN            - token with `contents: read`, `pull-requests: write`,
 *                              `issues: write`
 *   GITHUB_REPOSITORY       - "owner/repo"
 *   GITHUB_EVENT_PATH       - path to the event payload (supplied by Actions)
 *   EXPECTED_CI_CHECK       - comma-separated check names that must have reported
 *                              green. Mirrors the `name:` of the CI job in
 *                              .github/workflows/ci.yml.
 */
import { appendFile, readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import {
  decideTriage,
  diffActionRefs,
  diffDependencyMaps,
  isClassifiableFile,
  NEVER_AUTO_MERGE,
  WORKFLOW_FILE_RE,
  readActionRefs,
  readDependencyMap,
} from "./policy.mjs";

const API = "https://api.github.com";
const COMMENT_MARKER = "<!-- synapse-dependabot-triage -->";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN is not set; refusing to continue (fail closed).");
  process.exit(2);
}

async function api(path, { method = "GET", body, raw = false } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(
      `GitHub API ${method} ${path} -> ${response.status}: ${detail.slice(0, 300)}`
    );
    error.status = response.status;
    throw error;
  }
  return raw ? response.text() : response.json();
}

async function graphql(query, variables) {
  const response = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(
      `GitHub GraphQL rejected the request: ${JSON.stringify(payload.errors ?? payload).slice(0, 300)}`
    );
  }
  return payload.data;
}

// ---------------------------------------------------------------------------
// Fact gathering
//
// All the parsing and comparison lives in ./policy.mjs, where it is unit-tested.
// This section only moves bytes.
// ---------------------------------------------------------------------------

async function fetchFileAtRef(repo, ref, path) {
  return api(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, { raw: true });
}

/**
 * Derive the dependency change set from the files the PR actually touched.
 *
 * On any read failure the result is a synthetic `unknown -> unknown` change
 * rather than a short change list. `bumpLevel` classifies that as `unknown`,
 * which forces a hold - so an unreadable manifest is fail-closed by
 * construction instead of by remembering to check an error code.
 */
async function collectChanges(repo, baseSha, headSha, changedFiles) {
  const unreadable = (path) => {
    console.error(`Could not read ${path}; holding the PR.`);
    return [{ packageName: path, from: "unknown", to: "unknown", isDevDependency: true }];
  };

  const changes = [];

  if (changedFiles.includes("package.json")) {
    let base;
    let head;
    try {
      [base, head] = await Promise.all([
        fetchFileAtRef(repo, baseSha, "package.json"),
        fetchFileAtRef(repo, headSha, "package.json"),
      ]);
    } catch (error) {
      return unreadable(`package.json (${error.message})`);
    }
    let before;
    let after;
    try {
      before = readDependencyMap(JSON.parse(base));
      after = readDependencyMap(JSON.parse(head));
    } catch (error) {
      return unreadable(`package.json (unparseable: ${error.message})`);
    }
    changes.push(...diffDependencyMaps(before, after));
  }

  for (const file of changedFiles.filter((name) => WORKFLOW_FILE_RE.test(name))) {
    let baseText;
    let headText;
    try {
      [baseText, headText] = await Promise.all([
        fetchFileAtRef(repo, baseSha, file),
        fetchFileAtRef(repo, headSha, file),
      ]);
    } catch (error) {
      return [...changes, ...unreadable(`${file} (${error.message})`)];
    }
    changes.push(...diffActionRefs(readActionRefs(baseText), readActionRefs(headText)));
  }

  return changes;
}

async function collectRequiredContexts(repo) {
  try {
    const protection = await api(`/repos/${repo}/branches/main/protection`);
    const contexts = (protection.required_status_checks?.contexts ?? []).map((entry) =>
      typeof entry === "string" ? entry : entry.context
    );
    return { contexts, error: null };
  } catch (error) {
    // 404 means "branch is not protected", which is a real, knowable state: there
    // is no required-check list. Anything else is an unknown we cannot rule out,
    // so surface it and let the policy hold.
    if (error.status === 404) return { contexts: [], error: null };
    return { contexts: [], error: `${error.status ?? "error"}` };
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const LEVEL_LABEL = {
  patch: "patch",
  minor: "minor",
  major: "major",
  prerelease: "prerelease",
  downgrade: "downgrade",
  none: "no-op",
  unknown: "unknown",
};

/** A removal has no "to" version worth printing, so say what actually happened. */
function renderTo(change) {
  return change.kind === "removed" ? "**removed**" : `\`${change.to}\``;
}

function buildComment(decision, pr) {
  const lines = [COMMENT_MARKER, "## Synapse dependency triage", ""];

  if (decision.action === "auto-merge") {
    lines.push(
      `**Auto-merge enabled.** ${decision.changes.length} patch-level update(s), all green, none on the exception list.`,
      "",
      "| Package | From | To | Bump |",
      "| --- | --- | --- | --- |",
      ...decision.changes.map(
        (c) => `| \`${c.packageName}\` | \`${c.from}\` | ${renderTo(c)} | ${LEVEL_LABEL[c.level]} |`
      ),
      ""
    );
  } else {
    lines.push("**Held for human review.** This PR will not be auto-merged.", "");
    lines.push("### Why");
    lines.push("");
    for (const reason of decision.reasons) lines.push(`- ${reason}`);
    lines.push("");

    if (decision.changes.length > 0) {
      lines.push("### Dependency changes", "");
      lines.push(
        "| Package | From | To | Bump | Exception list |",
        "| --- | --- | --- | --- | --- |"
      );
      for (const change of decision.changes) {
        lines.push(
          `| \`${change.packageName}\` | \`${change.from}\` | ${renderTo(change)} | ${LEVEL_LABEL[change.level]} | ${change.exempt ? `yes (${change.category})` : "no"} |`
        );
      }
      lines.push("");
    }

    if (decision.riskNotes.length > 0) {
      lines.push("### Breaking-change / changelog risk", "");
      for (const note of decision.riskNotes) lines.push(`- ${note}`);
      lines.push("");
    }

    if (decision.ci.observed.length > 0) {
      lines.push("### CI state on this commit", "");
      lines.push("| Check | Status | Conclusion |", "| --- | --- | --- |");
      for (const run of decision.ci.observed) {
        lines.push(`| ${run.name} | ${run.status} | ${run.conclusion ?? "—"} |`);
      }
      lines.push("");
    }
  }

  lines.push(
    "<details><summary>Exception list (never auto-merged, any semver level)</summary>",
    "",
    ...NEVER_AUTO_MERGE.map(
      (rule) => `- \`${rule.packageName}\` — **${rule.category}**: ${rule.why}`
    ),
    "",
    "</details>",
    "",
    `_Policy: \`scripts/dependabot-automerge/policy.mjs\` (unit-tested). PR #${pr.number}._`
  );

  return lines.join("\n");
}

async function upsertComment(repo, prNumber, body) {
  const comments = await api(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`);
  const existing = comments.find((comment) => comment.body?.includes(COMMENT_MARKER));
  if (existing) {
    await api(`/repos/${repo}/issues/comments/${existing.id}`, { method: "PATCH", body: { body } });
    return "updated";
  }
  await api(`/repos/${repo}/issues/${prNumber}/comments`, { method: "POST", body: { body } });
  return "created";
}

async function setLabels(repo, prNumber, labels) {
  await api(`/repos/${repo}/issues/${prNumber}/labels`, {
    method: "POST",
    body: { labels },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  const repo = process.env.GITHUB_REPOSITORY;
  const expectedContexts = (process.env.EXPECTED_CI_CHECK ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const [filesResponse, checksResponse, protection] = await Promise.all([
    api(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`),
    api(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`),
    collectRequiredContexts(repo),
  ]);

  const changedFiles = filesResponse.map((file) => file.filename);
  const changes = await collectChanges(repo, pr.base.sha, pr.head.sha, changedFiles);
  const unclassifiable = changedFiles.filter((file) => !isClassifiableFile(file));

  const decision = decideTriage({
    author: pr.user?.login,
    isDraft: Boolean(pr.draft),
    changes,
    changedFiles,
    checkRuns: checksResponse.check_runs,
    requiredContexts: protection.contexts,
    requiredContextsError: protection.error,
    expectedContexts,
  });

  const log = [];
  const say = (line = "") => {
    log.push(line);
    console.log(line);
  };

  say("=== Synapse dependency triage ===");
  say(`PR            #${pr.number} ${pr.title}`);
  say(`head          ${pr.head.sha}`);
  say(`files         ${changedFiles.join(", ") || "(none)"}`);
  if (unclassifiable.length > 0) say(`unclassified  ${unclassifiable.join(", ")}`);
  for (const change of decision.changes) {
    say(
      `  ${change.packageName}: ${change.from} -> ${change.to} [${change.level}${change.exempt ? `, EXEMPT:${change.category}` : ""}]`
    );
  }
  for (const run of decision.ci.observed) {
    say(`  check ${run.name}: ${run.status}/${run.conclusion ?? "-"}`);
  }
  say(`decision      ${decision.action.toUpperCase()} (worst level: ${decision.level})`);
  for (const reason of decision.reasons) say(`  - ${reason}`);

  const commentResult = await upsertComment(repo, pr.number, buildComment(decision, pr));
  say(`comment       ${commentResult}`);
  await setLabels(repo, pr.number, decision.labels);
  say(`labels        ${decision.labels.join(", ")}`);

  let result;
  if (decision.action === "auto-merge") {
    // GitHub's REST API can only merge *immediately*; "enable auto-merge" is a
    // GraphQL mutation. `expectedHeadOid` is the load-bearing argument:
    // Dependabot can push a new commit between the moment we read the check runs
    // and the moment we ask GitHub to arm the merge. Pinning the SHA means GitHub
    // refuses the request if the head moved, and the next `synchronize` event
    // re-runs this triage against the new commit instead of merging a state we
    // never inspected. If the mutation is rejected this throws, the workflow goes
    // red, and a human looks - rather than the PR sitting in limbo with no
    // decision recorded.
    const response = await graphql(
      `
        mutation EnableAutoMerge(
          $prId: ID!
          $headOid: GitObjectID!
          $method: PullRequestMergeMethod!
        ) {
          enablePullRequestAutoMerge(
            input: { pullRequestId: $prId, expectedHeadOid: $headOid, mergeMethod: $method }
          ) {
            clientMutationId
          }
        }
      `,
      { prId: pr.node_id, headOid: pr.head.sha, method: "SQUASH" }
    );
    result = `auto-merge armed (squash, pinned to \`${pr.head.sha}\`)`;
    say(`graphql       ${JSON.stringify(response)}`);
  } else {
    result = "held for human review; no merge attempted";
  }
  say(`result        ${result}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      ["### Dependabot triage", "", "```text", ...log, "```", ""].join("\n"),
      "utf8"
    );
  }
}

main().catch((error) => {
  console.error(`triage failed: ${error.stack ?? error.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    // Best effort. The workflow's `if: failure()` step emits the annotation.
    try {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Dependabot triage\n\n**Could not complete:** \`${error.message}\`. Nothing was merged.\n`,
        "utf8"
      );
    } catch {}
  }
  process.exit(1);
});
