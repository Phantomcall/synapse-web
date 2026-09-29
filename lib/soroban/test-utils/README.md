# `lib/soroban/test-utils`

Shared testing helpers for hooks and utilities under `lib/soroban/`. The goal is
to avoid re-inventing fixture setup in every test file.

## Usage

```ts
import {
  buildMockTx,
  buildMockEvent,
  buildMockSorobanContext,
  withMockSorobanProvider,
} from "./test-utils";

// Transactions
const tx = buildMockTx({ ledger: 42, successful: false });

// Events
const event = buildMockEvent({ topic: ["mint"] });

// Provider context
const ctx = buildMockSorobanContext({ network: "PUBLIC" });

// Scoped provider usage
withMockSorobanProvider({ address: "G..." }, (ctx) => {
  expect(ctx.address).toBe("G...");
});
```

## Keeping mocks in sync with `lib/types.ts`

The module exports an `AssertAssignable<T, U>` type-level guard. If the canonical
types in `lib/types.ts` drift from the mock shapes, the type check fails and CI
catches the mismatch before it reaches `main`.

## Scope

Unit/component-test helpers only. End-to-end/Playwright helpers are intentionally
out of scope.
