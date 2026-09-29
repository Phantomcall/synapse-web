/**
 * Records a promotion into the persisted deploy state.
 *
 * The deploy pipeline (or a human) calls this the moment a new build becomes the
 * one production serves. That is what gives the rollback path something to reason
 * about: `lastPromotedAt` starts the observation window, and `lastKnownGoodRef`
 * becomes the artifact a rollback would restore.
 *
 *     node scripts/deploy/record-promotion.mjs \
 *       --state-file state.json --ref "$GITHUB_SHA" --previous-ref "$PREVIOUS_SHA" \
 *       --at 2026-03-04T12:00:00.000Z
 *
 * Kept separate from `decide()` on purpose: recording what happened and judging it
 * are different acts, and the deploy pipeline should never be able to skip the
 * judgement by recording a promotion.
 */

import { parseState, recordPromotion } from "./rollback-policy.mjs";
import { readFile, writeFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const stateFile = flag("--state-file");
const ref = flag("--ref");
const previousRef = flag("--previous-ref");
const at = flag("--at") ?? new Date().toISOString();
const message = flag("--message") ?? "";

if (!stateFile) throw new Error("--state-file is required");
if (!ref) throw new Error("--ref is required");

const raw = await readFile(stateFile, "utf8");
const state = parseState(raw.trim() ? JSON.parse(raw) : {});
const next = recordPromotion(state, { ref, previousRef, at, reason: message });

await writeFile(stateFile, `${JSON.stringify(next, null, 2)}\n`);
process.stdout.write(
  `recorded promotion of ${next.currentRef} at ${next.lastPromotedAt}; ` +
    `rollback target is ${next.lastKnownGoodRef ?? "(none recorded)"}\n`
);
