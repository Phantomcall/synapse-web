---
title: Synapse Core
description: A Soroban transaction-lifecycle dashboard for Stellar Testnet.
order: 1
---

A Soroban transaction-lifecycle dashboard built with Next.js 16 and React 19.
Synapse Core lets you inspect, trace, and drive transactions through a Soroban
smart contract deployed on Stellar Testnet — from registration through
completion or failure.

> **Current state: real wallet + contract calls, mock data as fallback.**
> Connect a Freighter or xBull wallet and every action (admin functions,
> transaction lifecycle actions, callback registration, diagnostics) submits a
> real signed transaction or read-only simulation against
> `NEXT_PUBLIC_CONTRACT_ID`. Without a connected wallet or a configured
> contract, the dashboard and transaction list fall back to
> `lib/mock-data.ts` so the UI is still explorable.

## What it does

- **Dashboard** — status counts, a visual status pipeline, live contract info,
  and the most recent transactions with click-through detail.
- **Transactions** — the full list with filtering, a read-only
  `get_transaction` lookup, and `register_callback` webhook registration.
- **Admin** — `initialize`, `transfer_admin` and `set_relay_signer`, each behind
  a confirmation step, plus read-only `health`/`version` diagnostics.
- **Docs** — the in-app contract ABI reference, rendered straight from the same
  constant the app calls, so the playground and this site never disagree.

## Tech stack

|                |                                              |
| -------------- | -------------------------------------------- |
| Framework      | Next.js 16 (App Router)                      |
| UI             | React 19, inline styles + Tailwind CSS v4    |
| Font           | IBM Plex Mono (self-hosted via `next/font`)  |
| Language       | TypeScript 5                                 |
| Linting        | ESLint + Prettier + Husky pre-commit         |
| Testing        | Vitest + Testing Library, Playwright for E2E |
| CI             | GitHub Actions, Node 20 and 22 test matrix   |
| Target network | Stellar Testnet (Soroban)                    |

## Where to next

- [Getting started](./getting-started/) — run it locally in two commands.
- [Architecture](./architecture/) — how the pieces fit and why.
- [Contract ABI reference](./contract-abi/) — generated from the source, never
  hand-copied.
- [Contributing](./contributing/) — tests, CI expectations, and PR conventions.

The interactive ABI playground is deliberately **not** reproduced here. The
reference below is static reference material; run the app for the live
simulations.
