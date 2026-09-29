import fs from "node:fs";
import path from "node:path";

export const MAX_IMAGE_SIZE_KB = 150;
export const ALLOWED_FORMATS = [".svg", ".png", ".webp", ".ico", ".jpg", ".jpeg"];

export function validateAssets(publicDir = "public") {
  const results = [];
  let hasFailure = false;

  if (!fs.existsSync(publicDir)) {
    return { passed: true, results: [] };
  }

  const files = fs.readdirSync(publicDir);
  for (const file of files) {
    const fullPath = path.join(publicDir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isFile()) {
      const ext = path.extname(file).toLowerCase();
      const sizeKb = Math.round((stat.size / 1024) * 100) / 100;

      const formatValid = ALLOWED_FORMATS.includes(ext);
      const sizeValid = sizeKb <= MAX_IMAGE_SIZE_KB;

      if (!formatValid || !sizeValid) {
        hasFailure = true;
      }

      results.push({
        file,
        sizeKb,
        formatValid,
        sizeValid,
        passed: formatValid && sizeValid,
      });
    }
  }

  return {
    passed: !hasFailure,
    results,
  };
}

if (process.argv[1] && process.argv[1].endsWith("check-asset-optimization.mjs")) {
  const { passed, results } = validateAssets();
  console.table(results);
  if (!passed) {
    console.error("❌ Asset optimization check failed!");
    process.exit(1);
  } else {
    console.log("✅ All static assets are optimized.");
  }
}
