# Pin Node and npm, and verify the install is reproducible

Structurally fixes the class of problem this repo's own history records twice:
`91e5082 fix(test): downgrade jsdom to ^25.0.1 for Node 20 compatibility` and
`910fd81 fix: regenerate package-lock.json with npm 10.8.2 to match CI`.

## What

| File                          | Change                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.nvmrc`                      | **New.** `20.20.2`.                                                                                                                               |
| `package.json`                | `engines: { node: "20.20.2", npm: "10.8.2" }` + a `check:toolchain` script.                                                                       |
| `scripts/check-toolchain.mjs` | **New.** Asserts the running Node and npm against the pin, and that the pin has not drifted.                                                      |
| `.github/workflows/ci.yml`    | `node-version-file: .nvmrc` instead of `node-version: 20`; assert the toolchain _before_ installing; assert `npm ci` left the lockfile untouched. |
| `README.md`                   | Documents Node `20.20.2` as the required local version, `nvm use`, `npm ci`, and how to bump it.                                                  |

`package-lock.json` is **not** modified. That is the point of one of the two new CI
steps, and it is verified below.

## The pin, and why these exact versions

- **Node `20.20.2`** is the newest release in the 20.x line, which is what CI's
  `node-version: 20` resolves to today. Pinning it changes nothing about what CI
  runs today while removing the "whatever 20.x is, this month" behaviour that makes
  a runner change your dependency tree without a commit.
- **npm `10.8.2`** is what Node 20.20.2 bundles, and is the exact version
  `910fd81` used to regenerate the lockfile. So the pinned npm and the committed
  lockfile already agree, which is why this PR needs no lockfile churn.

I confirmed both against the Node release index rather than assuming:

```
$ curl -s https://nodejs.org/dist/index.json | node -e '...'
latest 20.x: v20.20.2 npm: 10.8.2
```

and against a real run of the pinned toolchain:

```
$ nvm use 20.20.2 && node -v && npm -v
v20.20.2
10.8.2
```

The entire gate — `npm ci`, all 31 tests, lint, typecheck, and a production build —
was run on that toolchain. It all passes, so the pin describes a toolchain that
actually works, not one that merely exists in a file.

## Single source of truth

`package.json` → `engines` is canonical: machine-readable, already read by npm and
every engines-aware tool, and it cannot drift from the manifest it lives in.

`.nvmrc` is a one-line mirror, because nvm/fnm/asdf and `actions/setup-node` all read
that file. Two files can drift, so the guarantee is **enforced rather than asserted**:
`check-toolchain.mjs` fails if `.nvmrc` and `engines.node` disagree. CI now uses
`node-version-file: ".nvmrc"` instead of a hardcoded `20`, so the runner, `nvm use`
and the Docker dev environment all resolve to the same version.

The Docker dev environment (issue #165, another contributor) is the third consumer
of the same pin, and it is covered by the same script: any `Dockerfile` in the repo
must have `FROM node:20.20.2`, or the check fails. Until that Dockerfile exists the
check reports a skip rather than guessing where it will land, and the README states
the contract so the #165 author inherits it.

## Why exact versions and not ranges

A range is not a pin. `>=20 <21` still admits 20.0.0 and 20.20.2, and those differ
in exactly the ways this repository has already been bitten. So `engines` must be an
exact `major.minor.patch`, and the script rejects a range outright with an
explanation rather than silently half-honouring it.

**`engine-strict` is deliberately not set.** npm treats `engines` as advisory by
default, and flipping it on would make `npm install` hard-fail for anyone whose
system Node is a different patch version — turning a helpful warning into a wall
before the contributor has read the README. Enforcement lives in CI, where it fails
fast with a message that names the fix, plus `npm run check:toolchain` locally.
That is a real trade and it is a deliberate one.

## Verification

### The CI check fails on a mismatched Node

Run exactly as CI runs it, on a deliberately mismatched toolchain (Node 24 / npm 11):

```
$ node scripts/check-toolchain.mjs
Toolchain check FAILED — 2 problems.
Pinned: node 20.20.2, npm 10.8.2.

- node 24.18.1 does not match the pinned 20.20.2.
  The pin lives in package.json "engines" and is mirrored in .nvmrc.
  Fix it with:
    nvm install && nvm use      # reads .nvmrc
    corepack enable && corepack prepare npm@20.20.2 --activate   # for npm
  Local: install the pinned Node and re-run `nvm use`.
- npm 11.16.0 does not match the pinned 10.8.2.
  The pin lives in package.json "engines" and is mirrored in .nvmrc.
  Fix it with:
    nvm install && nvm use      # reads .nvmrc
    corepack enable && corepack prepare npm@10.8.2 --activate   # for npm
- .nvmrc (20.20.2) agrees with engines.node
- docker dev image: no Dockerfile in the repo yet, skipping
$ echo $?
1
```

That is the first step in the job, before `npm ci`, so it costs seconds rather than
surfacing twenty minutes later as an opaque `EBADENGINE` or a rewritten lockfile.

### The same check passes on the pinned toolchain

```
$ nvm use 20.20.2 && npm run check:toolchain
> synapse-core@0.1.0 check:toolchain
> node scripts/check-toolchain.mjs

Toolchain OK — node 20.20.2, npm 10.8.2.

- node 20.20.2 matches the pin
- npm 10.8.2 matches the pin
- .nvmrc (20.20.2) agrees with engines.node
- docker dev image: no Dockerfile in the repo yet, skipping
$ echo $?
0
```

### The drift checks, each shown failing on a deliberate break

`.nvmrc` disagreeing with `engines` — the exact drift the single-source-of-truth
claim is about:

```
- .nvmrc says "20.20.1" but package.json "engines.node" says "20.20.2".
  These are the same pin written down twice; update .nvmrc to 20.20.2.
$ echo $?
1
```

A Dockerfile pinned to a different Node — the #165 drift the issue calls out:

```
$ printf 'FROM node:24-bookworm\nWORKDIR /app\n' > Dockerfile && node scripts/check-toolchain.mjs
- Dockerfile pins Node 24-bookworm but package.json "engines.node" is 20.20.2.
  Change the base image to node:20.20.2 so the Docker dev environment and CI use one Node.
$ echo $?
1

$ printf 'FROM node:20.20.2-bookworm\nWORKDIR /app\n' > Dockerfile && node scripts/check-toolchain.mjs
Toolchain OK — node 20.20.2, npm 10.8.2.
- Dockerfile pins node:20.20.2-bookworm (matches 20.20.2)
$ echo $?
0
```

The distro suffix is not a version: `node:20.20.2-bookworm` passes,
`node:24-bookworm` fails. Getting that wrong would make the check unusable the moment
someone picks a base image, so it is called out here.

A range instead of a pin:

```
$ node -e '...p.engines.node=">=20"...'
Toolchain check failed:
  package.json "engines.node" is ">=20", which is not an exact version. Pin it as "<major>.<minor>.<patch>" (e.g. "20.20.2"); a range defeats the point of pinning.
$ echo $?
1
```

### `npm ci` produces a lockfile-consistent install with no unexpected changes

Run on the pinned toolchain, exactly as the new CI step does:

```
$ nvm use 20.20.2 && npm ci
added 890 packages, and audited 891 packages in 3m

$ git diff --exit-code -- package-lock.json && echo "package-lock.json unchanged by npm ci"
package-lock.json unchanged by npm ci
```

This is worth stating plainly, because it is not a given: on the _unpinned_ toolchain
in this same workspace, `npm install` with npm 11.16.0 rewrites the committed
lockfile — it strips 45 lines of optional peer-dependency entries. That is precisely
the churn behind `910fd81 fix: regenerate package-lock.json with npm 10.8.2 to match
CI`, and it is why the lockfile check is in CI rather than trusted.

## Files and decisions, in detail

**`scripts/check-toolchain.mjs`** is a plain ES module with no dependencies, run with
`node` so it works on the pinned Node without a build step or a loader. It is the
first CI step precisely because the whole point is to fail before anything is
installed or cached. Its four checks — running node, running npm, `.nvmrc` agreement,
Dockerfile agreement — are independent, so the failure output says exactly which one
is wrong. It writes one block per stream so the check list and the summary cannot
interleave out of order when CI merges stdout and stderr into one log.

It exports its check functions but I did not add unit tests for them: each is a
two-line comparison, and a test asserting `a === b` fails or passes with the
implementation, which proves nothing. The meaningful verification is the one above —
the actual script, the actual mismatch, the actual exit code — and that is in the
PR.

**`.github/workflows/ci.yml`** gains two steps and changes one line. The order is
deliberate: `Verify pinned Node and npm versions` runs _before_ `npm ci` (a wrong
toolchain should not get to install anything), and `Verify npm ci left the lockfile
untouched` runs _after_ it (it can only be checked once the install has happened). The
lockfile step uses `git diff --exit-code -- package-lock.json` and prints a
`::error::` naming the cause and the fix, rather than a bare `git diff`.

## Definition of done

- [x] `.nvmrc` and `package.json` `engines` both present.
- [x] Enforced: CI fails if the running Node/npm does not match, as the first step,
      with a message that names the fix. Shown failing above on Node 24 / npm 11 and
      passing on Node 20.20.2 / npm 10.8.2.
- [x] Single source of truth: `engines` is canonical, `.nvmrc` is a verified mirror,
      CI resolves its Node from `.nvmrc`, and a Dockerfile pinned to a different Node
      fails the same check.
- [x] CI verification that `npm ci` produces a lockfile-consistent install with no
      unexpected changes: `npm ci` then `git diff --exit-code package-lock.json`.
- [x] Documented in the README as the required local Node version, with the upgrade
      procedure.
- [x] The whole gate re-run on the pinned toolchain, not just on whatever happened to
      be installed.
- [ ] **The Docker dev environment (#165) actually referencing this pin.** The check
      is written, documented, and demonstrated to fail and pass against a Dockerfile,
      but that Dockerfile belongs to another contributor's PR and does not exist in
      this branch. The moment it lands the check enforces the version; until then it
      reports a skip, and the README states the contract.

## Out of scope

Cross-version compatibility testing, per the issue. One Node version is pinned, and
supporting several majors simultaneously is tracked separately.

`packageManager: "npm@10.8.2"` was also considered as a third declaration of the pin
and left out: with Corepack enabled it makes npm fetch the version over the network
on every install, which turns a working offline build into a network dependency, and
the `engines` assertion already fails fast if npm is wrong. Not worth the failure
mode for a redundant third copy of the same string.

## Full gate

Run on the pinned toolchain (`node v20.20.2`, `npm 10.8.2`):

```
$ npm ci              # 890 packages
$ npm run test        # 5 files, 31 tests passed
$ npm run lint        # clean
$ npx tsc --noEmit    # clean
$ npm run build       # ✓ Compiled successfully in 11.8s
$ git status --short  # only the files listed above; no lockfile churn
```

closes #172
