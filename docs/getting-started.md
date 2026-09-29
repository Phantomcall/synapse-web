---
title: Getting started
description: Run Synapse Core locally, configure it, and understand the mock-data fallback.
order: 2
---

## Run it locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app starts on the
**dashboard** tab with mock data, so there is nothing to configure before you
can click around.

## Configuration

Everything is optional. With no environment set, the dashboard renders
`lib/mock-data.ts`; with a wallet connected and a contract ID set, live RPC
reads and signed transactions take over.

| Variable                      | Purpose                                                               |
| ----------------------------- | --------------------------------------------------------------------- |
| `NEXT_PUBLIC_CONTRACT_ID`     | The deployed Soroban contract. Absent → mock data, read-only disabled |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | RPC endpoint. Defaults to `https://soroban-testnet.stellar.org`       |
| `NEXT_PUBLIC_SITE_URL`        | Canonical origin used for metadata. Falls back to `VERCEL_URL`        |

All three are `NEXT_PUBLIC_*`, so they are inlined into the client bundle at
build time. Never put a secret in one.

## Mock data as fallback

`lib/mock-data.ts` exports the baseline every tab renders when no wallet is
connected or `NEXT_PUBLIC_CONTRACT_ID` is not configured:

| Export               | Used by                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `MOCK_TXS`           | `useLiveTransactions` baseline (stat cards, pipeline, tables)                  |
| `MOCK_CONTRACT_INFO` | `useLiveContractInfo` baseline (address, admin, relay_signer, health, version) |

Once a wallet is connected and a contract is configured, live RPC events and
reads take over. The merge happens in
[architecture](./architecture/#mock-data-and-the-live-path).

## Scripts

```bash
npm run build        # Production build
npm run lint         # ESLint
npm run test         # Unit + component suite, once
npm run test:watch   # Unit + component suite, watch mode
npm run e2e:install  # One-time: download the Playwright browsers
npm run e2e          # E2E suite across Chromium, Firefox and WebKit
npm run format       # Prettier (writes)
npm run format:check # Prettier (check)
npx tsc --noEmit     # Type-check without emitting
npm run docs:build   # Build this documentation site into docs-dist/
```

`npm run build` prerenders every route: the app has no server component that
needs a request, so the dashboard is a fully static artifact.

## Building the documentation site

The site you are reading is built from the `docs/` directory in this repository:

```bash
npm run docs:build
```

Output lands in `docs-dist/`, which is gitignored. `--base` sets the path prefix
for deployments under a sub-path:

```bash
node scripts/docs/build.mjs --out docs-dist --base /synapse-web/
```

See [contributing](./contributing/#documentation-site) for how the ABI reference
stays in sync with the code.
