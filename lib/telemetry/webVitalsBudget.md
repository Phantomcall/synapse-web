# Core Web Vitals Monitoring & Regression Budget

This document establishes the real-user performance thresholds, regression budget, and investigation procedures for Synapse Web.

## Target Core Web Vitals Budgets (75th Percentile)

| Metric   | Full Name                 | Good (Target) | Needs Improvement | Poor (Failing) | Primary Driver in Dashboard                         |
| :------- | :------------------------ | :-----------: | :---------------: | :------------: | :-------------------------------------------------- |
| **LCP**  | Largest Contentful Paint  |  **≤ 2.5s**   |    2.5s – 4.0s    |   **> 4.0s**   | Dashboard hero / StatCards render & font loading    |
| **INP**  | Interaction to Next Paint |  **≤ 200ms**  |   200ms – 500ms   |  **> 500ms**   | Transaction table sorting/filtering & modal opening |
| **CLS**  | Cumulative Layout Shift   |   **≤ 0.1**   |    0.1 – 0.25     |   **> 0.25**   | Dynamic transaction list updates & banner alerts    |
| **FCP**  | First Contentful Paint    |  **≤ 1.8s**   |    1.8s – 3.0s    |   **> 3.0s**   | Server HTML parsing & initial stylesheet parse      |
| **TTFB** | Time to First Byte        |  **≤ 800ms**  |   800ms – 1.8s    |   **> 1.8s**   | Edge routing & testnet RPC initialization           |

---

## Sampling Strategy

To balance real-user telemetry visibility against network overhead and cloud costs:

- **Production Environment**: Default 10% sampling rate (`NEXT_PUBLIC_TELEMETRY_SAMPLE_RATE=0.1`).
- **Staging / QA Deployments**: 100% sampling rate (`NEXT_PUBLIC_TELEMETRY_SAMPLE_RATE=1.0`).
- **Local Development**: Enabled in debug console mode (`NEXT_PUBLIC_TELEMETRY_DEBUG=true`).

---

## Regression Investigation & Escalation Procedure

When 75th percentile measurements in production exceed target budgets over a 24-hour rolling window:

1. **LCP Regressions (> 2.5s)**:
   - Check bundle chunk sizes for newly introduced heavy dependencies.
   - Verify self-hosted font preloading in `app/layout.tsx`.
   - Ensure dynamic imports (`next/dynamic`) are active for non-dashboard tabs.

2. **INP Regressions (> 200ms)**:
   - Profile React re-renders in `TransactionsTab` and `TxTable`.
   - Ensure contract lookup simulations and transaction submissions are non-blocking with asynchronous UI feedback.

3. **CLS Regressions (> 0.1)**:
   - Verify explicit min-heights on loading fallbacks and async panels (`StatCards`, `TxTable`).
   - Prevent layout reflows when wallet state changes from disconnected to connected.
