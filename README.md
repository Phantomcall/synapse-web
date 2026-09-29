# Synapse Core

A Soroban transaction-lifecycle dashboard built with Next.js 16 and React 19.
Synapse Core lets you inspect, trace, and drive transactions through a Soroban
smart contract deployed on Stellar Testnet — from registration through
completion or failure.

> **Current state: real wallet + contract calls, mock data as fallback.**
> Connect a Freighter or xBull wallet and every action (admin functions, transaction
> lifecycle actions, callback registration, diagnostics) submits a real signed
> transaction or read-only simulation against `NEXT_PUBLIC_CONTRACT_ID`. Without a
> connected wallet or a configured contract, the dashboard and transaction list fall
> back to `lib/mock-data.ts` so the UI is still explorable. A standalone backend relay
> service is still tracked in the open issues below.

---

## What's inside

```
synapse-web/
├── app/
│   ├── layout.tsx          # Root layout — metadata, ToastProvider, global CSS
│   ├── page.tsx            # Entry point — renders <Shell />
│   ├── globals.css         # Base styles, scanline overlay, utility classes
│   └── error.tsx / not-found.tsx
├── components/
│   ├── Shell.tsx           # Top-level shell: header, tab bar, footer
│   ├── dashboard/
│   │   ├── DashboardTab.tsx        # Composes the dashboard view
│   │   ├── StatCards.tsx           # PENDING / PROCESSING / COMPLETED / FAILED counts
│   │   ├── Pipeline.tsx            # Visual pipeline of tx status flow
│   │   ├── ContractInfoPanel.tsx   # Contract address, admin, relay signer, health
│   │   └── RecentTxTable.tsx       # Last-N transactions with click-to-detail
│   ├── transactions/
│   │   ├── TransactionsTab.tsx     # Full transaction list with filters
│   │   ├── TxTable.tsx             # Sortable/paginated tx table
│   │   └── TxDetailModal.tsx       # Overlay with full tx fields
│   ├── admin/
│   │   └── AdminTab.tsx    # initialize / transfer_admin / set_relay_signer / diagnostics
│   ├── docs/
│   │   └── DocsTab.tsx     # ABI reference rendered from lib/constants.ABI_ENDPOINTS
│   └── ui/
│       ├── ActionButton.tsx
│       ├── Badge.tsx
│       ├── ConfirmDialog.tsx
│       ├── CopyButton.tsx
│       ├── Field.tsx
│       ├── Panel.tsx
│       ├── SorobanTip.tsx
│       ├── TabErrorBoundary.tsx
│       └── Toast.tsx
├── lib/
│   ├── mock-data.ts        # Fallback data: MOCK_TXS + MOCK_CONTRACT_INFO
│   ├── types.ts            # Transaction, ContractInfo, TxStatus, CallbackPayload
│   ├── constants.ts        # STATUS_META, colour tokens, ABI_ENDPOINTS
│   ├── utils.ts            # Shared helpers (shortId, elapsed, formatAmount)
│   ├── wallet/
│   │   ├── kit.ts              # StellarWalletsKit init (Freighter + xBull)
│   │   ├── storage.ts          # Selected-wallet-id localStorage helpers
│   │   └── WalletProvider.tsx  # useWallet() context: address/connect/disconnect
│   └── soroban/
│       ├── args.ts               # addressArg/stringArg/structArg ScVal encoders
│       ├── contract.ts           # invokeContract / simulateContractCall
│       ├── events.ts             # RPC event poller (TransactionRegistered/StatusChanged)
│       ├── SorobanProvider.tsx   # useSorobanEvents()/useSorobanHealth() context
│       ├── transactionMerge.ts   # Merges mock baseline with live events
│       ├── useLiveTransactions.ts
│       └── useLiveContractInfo.ts
└── public/                 # Static assets
```

### Mock data as fallback

`lib/mock-data.ts` exports the baseline data every tab renders when no wallet is
connected or `NEXT_PUBLIC_CONTRACT_ID` isn't configured:

| Export               | Used by                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `MOCK_TXS`           | `useLiveTransactions` baseline (stat cards, pipeline, tables)                  |
| `MOCK_CONTRACT_INFO` | `useLiveContractInfo` baseline (address, admin, relay_signer, health, version) |

Once a wallet is connected and a contract is configured, live RPC events and reads
take over — see `lib/soroban/transactionMerge.ts` and `lib/soroban/useLiveContractInfo.ts`.

---

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app starts on the
**dashboard** tab showing mock data. Connect a Freighter or xBull wallet and set
`NEXT_PUBLIC_CONTRACT_ID` (plus optionally `NEXT_PUBLIC_SOROBAN_RPC_URL`) to switch
to live contract data instead.

Other scripts:

```bash
npm run build        # Production build
npm run lint         # ESLint
npm run test         # Run the test suite once
npm run test:watch   # Run the test suite in watch mode
npm run perf:budget  # Enforce the initial JavaScript bundle budget after build
npm run perf:record  # Append Lighthouse metrics to the committed history file
npm run format       # Prettier (writes)
npm run format:check # Prettier (CI check)
npx tsc --noEmit     # Type-check without emitting
```

npm run release # Cut a release from conventional commits
npm run release:dry # Report the version/notes without publishing

```

### Releases

Versions, the changelog, and GitHub releases are generated from conventional
commits by semantic-release on merge to `main`. See
[docs/release-process.md](docs/release-process.md) for the commit format, the
pre-1.0 versioning rules, and the one-time tag step the repository still needs.

## Deployments and performance

GitHub Actions runs lint, typecheck, tests, build, and the initial-route JavaScript budget before deployment. PRs from branches in this repository receive an automatically updated Vercel preview comment; external-fork PRs run the quality gates but do not receive deployment credentials or an automated preview. Preview builds use Stellar Testnet and an empty contract ID, so they render mock data by default.

Configure `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` as GitHub environment secrets for `preview`, `staging`, and `production`. Pushes to a `staging` branch run the full quality gate and deploy using the `staging` environment's `NEXT_PUBLIC_CONTRACT_ID` and `NEXT_PUBLIC_SOROBAN_RPC_URL` variables. To promote a verified staging revision, manually dispatch the deployment workflow from `staging`; it reruns the quality gate and waits at the `production` environment. Add required reviewers to that GitHub environment to enforce approval; keep production contract and RPC values scoped to it. Set the staging contract to a Testnet deployment, never a production contract. Enable read/write workflow permissions for `GITHUB_TOKEN` so the performance workflow can update its history file.

The [performance history](/performance) page charts Lighthouse score, LCP, and initial-route JavaScript size, and lists CLS and TBT for the latest 30 successful main-branch CI runs. `public/performance/history.json` is appended automatically after each successful run. TBT is a lab proxy, not field INP; field INP requires real-user monitoring. The chart remains empty until a successful main-branch run records the first sample.

---

## CI gates and deploys

| Gate / pipeline            | Workflow                                  | Docs                                                           |
| -------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| Dependency vulnerabilities | `.github/workflows/dependency-audit.yml`  | [docs/ci/dependency-audit.md](docs/ci/dependency-audit.md)     |
| SBOM (CycloneDX)           | `.github/workflows/sbom.yml`              | [docs/ci/sbom.md](docs/ci/sbom.md)                             |
| Bundle size + Lighthouse   | `.github/workflows/performance.yml`       | [docs/ci/performance-gates.md](docs/ci/performance-gates.md)   |
| Canary production deploy   | `.github/workflows/deploy-production.yml` | [docs/deploy/canary-rollout.md](docs/deploy/canary-rollout.md) |

---

## Adding a new tab

1. Create `components/<name>/<Name>Tab.tsx` and export a `<NameTab />` component.
2. Add the tab key to the `TABS` array in `components/Shell.tsx`.
3. Add a matching `{tab === "<name>" && <NameTab />}` render block in `Shell.tsx`.
4. Wrap it in `<TabErrorBoundary>` like the existing tabs.

---

## Roadmap / open issues

Remaining backend and contract-ABI work is tracked in the upstream repo's issue
tracker:

- [Synapse-bridgez/synapse-web — open issues](https://github.com/Synapse-bridgez/synapse-web/issues)

Notable milestones on the path to a working testnet client:

- [x] Replace `alert()` stubs across `AdminTab`, `TxDetailModal`, and `TransactionsTab` with real
      `TransactionBuilder` + sign + submit calls (`lib/soroban/contract.ts`)
- [x] Wire `MOCK_TXS` / `MOCK_CONTRACT_INFO` to live `rpc.Server` reads (`useLiveTransactions`,
      `useLiveContractInfo`), falling back to mock data when no wallet/contract is configured
- [x] Integrate `@creit.tech/stellar-wallets-kit` (Freighter / xBull) for wallet connection
      (`lib/wallet/`)
- [ ] Backend relay service for `register_transaction`, `start_processing`, `complete_transaction`,
      `fail_transaction`, and `register_callback` webhooks
- [ ] Fetch `admin` / `relay_signer` from the deployed contract once it exposes a getter for them
      (currently sourced from `lib/mock-data.ts` / env, since the ABI has none)

---

## Tech stack

|                |                                                                  |
| -------------- | ---------------------------------------------------------------- |
| Framework      | Next.js 16 (App Router)                                          |
| UI             | React 19, inline styles + Tailwind CSS v4                        |
| Font           | IBM Plex Mono                                                    |
| Language       | TypeScript 5                                                     |
| Linting        | ESLint + Prettier + Husky pre-commit                             |
| Testing        | Vitest + Testing Library                                         |
| CI             | GitHub Actions (lint → typecheck → test → build → bundle budget) |
| Quality gates  | Dependency audit, SBOM, bundle budget, Lighthouse                |
| Deploys        | Vercel Rolling Releases canary + auto-rollback                   |
| Target network | Stellar Testnet (Soroban)                                        |
```
