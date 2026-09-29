---
title: Contract ABI reference
description: Every Synapse Core contract endpoint, generated from lib/constants.ts at build time.
order: 4
generated: abi-reference
---

<!-- generated:abi-reference -->

## How to read this

**Access** says who can meaningfully call the endpoint from the dashboard:

- `public` — read-only simulation. No wallet signature is requested, and the
  transaction is never submitted. Safe to call at any time.
- `relay_signer` — requires a signature from the account configured as the
  contract's relay signer. The dashboard prompts for it; the extension decides
  whether to grant it.
- `admin` — requires the current admin address. Irreversible if you pick the
  wrong value, which is why the admin tab requires you to retype the target
  address before confirming.
- `one-time` — bootstrap only. Reverts once the contract is initialized, so
  calling it a second time is harmless but pointless.

On-chain reads all go through
`SorobanRpc.Server.simulateTransaction()`. Writes go through
`TransactionBuilder` → sign → `submitTransaction()`. The wallet integration is
`@creit-tech/stellar-wallets-kit` (Freighter / xBull).

## Try them

The reference here is static. To actually invoke these endpoints, run the
dashboard — see [getting started](./getting-started/). The **Admin** tab runs
the `admin` and `one-time` endpoints, the **Transactions** tab runs
`register_callback` and the read-only lookups, and the transaction detail modal
runs the lifecycle transitions.
