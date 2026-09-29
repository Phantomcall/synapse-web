import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Font-Loading & Layout-Shift Optimization Suite", () => {
  it("verifies app/layout.tsx configures next/font with display: swap and subsetting", () => {
    const layoutPath = path.resolve(process.cwd(), "app/layout.tsx");
    const layoutContent = fs.readFileSync(layoutPath, "utf-8");

    expect(layoutContent).toContain("next/font/google");
    expect(layoutContent).toContain('subsets: ["latin"]');
    expect(layoutContent).toContain('display: "swap"');
    expect(layoutContent).toContain("adjustFontFallback: true");
    expect(layoutContent).toContain("preload: true");
  });

  it("verifies next.config.ts enables compression", () => {
    const configPath = path.resolve(process.cwd(), "next.config.ts");
    const configContent = fs.readFileSync(configPath, "utf-8");

    expect(configContent).toContain("compress: true");
  });
});
