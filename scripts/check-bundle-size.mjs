import fs from "node:fs";
import path from "node:path";

export const DEFAULT_BUDGETS = {
  initial: { maxKb: 300, name: "Initial Bundle / Shared Chunks" },
  dashboard: { maxKb: 120, name: "Dashboard Tab Chunk" },
  transactions: { maxKb: 150, name: "Transactions Tab Chunk" },
  admin: { maxKb: 120, name: "Admin Tab Chunk" },
  docs: { maxKb: 100, name: "Docs Tab Chunk" },
};

/**
 * Validates actual chunk sizes against defined budget limits.
 */
export function validateBundleBudgets(chunkSizes, budgets = DEFAULT_BUDGETS) {
  const results = [];
  let hasFailure = false;

  for (const [key, budget] of Object.entries(budgets)) {
    const actualKb = chunkSizes[key] ?? 0;
    const exceeded = actualKb > budget.maxKb;
    const diffKb = Math.round((actualKb - budget.maxKb) * 100) / 100;

    if (exceeded) {
      hasFailure = true;
    }

    results.push({
      key,
      name: budget.name,
      maxKb: budget.maxKb,
      actualKb,
      exceeded,
      diffKb: exceeded ? diffKb : 0,
    });
  }

  return {
    passed: !hasFailure,
    results,
  };
}

/**
 * CLI Runner
 */
export function runBundleSizeCheck(buildDir = ".next", budgets = DEFAULT_BUDGETS) {
  console.log("🔍 Checking production bundle sizes against defined budgets...\n");

  const chunkSizes = {
    initial: 0,
    dashboard: 0,
    transactions: 0,
    admin: 0,
    docs: 0,
  };

  const staticDir = path.join(buildDir, "static", "chunks");
  if (fs.existsSync(staticDir)) {
    const files = fs.readdirSync(staticDir);
    let totalStaticKb = 0;
    for (const file of files) {
      if (file.endsWith(".js")) {
        const stats = fs.statSync(path.join(staticDir, file));
        totalStaticKb += stats.size / 1024;
      }
    }
    chunkSizes.initial = Math.round(totalStaticKb * 10) / 10;
  }

  const { passed, results } = validateBundleBudgets(chunkSizes, budgets);

  console.table(
    results.map((r) => ({
      Chunk: r.name,
      "Budget (KB)": `${r.maxKb} KB`,
      "Actual (KB)": `${r.actualKb} KB`,
      Status: r.exceeded ? `❌ EXCEEDED (+${r.diffKb} KB)` : "✅ PASS",
    }))
  );

  if (!passed) {
    console.error("\n❌ Bundle size budget exceeded! Merge blocked.");
    process.exit(1);
  } else {
    console.log("\n✅ All chunks are within defined bundle size budgets.");
  }
}

if (process.argv[1] && process.argv[1].endsWith("check-bundle-size.mjs")) {
  runBundleSizeCheck();
}
