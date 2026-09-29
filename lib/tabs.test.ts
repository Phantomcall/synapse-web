import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TAB, TAB_ROUTES, TABS, isTab, tabFromPathname, tabPath } from "./tabs";

const REPO_ROOT = join(__dirname, "..");

describe("isTab", () => {
  it("accepts every declared tab", () => {
    for (const tab of TABS) expect(isTab(tab)).toBe(true);
  });

  it("rejects undeclared strings and non-strings", () => {
    for (const value of ["settings", "Dashboard", "", "../admin", "toString", "__proto__"]) {
      expect(isTab(value)).toBe(false);
    }
    for (const value of [undefined, null, 0, {}, [], Symbol("dashboard")]) {
      expect(isTab(value)).toBe(false);
    }
  });
});

describe("tabFromPathname", () => {
  it("resolves a single-segment tab route", () => {
    expect(tabFromPathname("/transactions")).toBe("transactions");
    expect(tabFromPathname("/admin")).toBe("admin");
  });

  it("returns the default tab for the root", () => {
    expect(tabFromPathname("/")).toBe(DEFAULT_TAB);
    expect(tabFromPathname("")).toBe(DEFAULT_TAB);
  });

  it("tolerates a trailing slash", () => {
    expect(tabFromPathname("/docs/")).toBe("docs");
  });

  it("falls back to the default for unknown or over-deep paths", () => {
    expect(tabFromPathname("/nope")).toBe(DEFAULT_TAB);
    expect(tabFromPathname("/dashboard/extra")).toBe(DEFAULT_TAB);
    expect(tabFromPathname("/a/b/c")).toBe(DEFAULT_TAB);
  });

  it("falls back to the default for missing or non-string input", () => {
    expect(tabFromPathname(undefined)).toBe(DEFAULT_TAB);
    expect(tabFromPathname(null)).toBe(DEFAULT_TAB);
  });
});

describe("tabPath / TAB_ROUTES", () => {
  it("maps each tab to its canonical path", () => {
    expect(tabPath("docs")).toBe("/docs");
    expect(TAB_ROUTES).toEqual(["/dashboard", "/transactions", "/admin", "/docs"]);
  });

  it("round-trips every tab route back to itself", () => {
    for (const route of TAB_ROUTES) {
      expect(tabFromPathname(route)).toBe(route.slice(1));
    }
  });

  it("declares the dashboard as the default tab", () => {
    expect(DEFAULT_TAB).toBe("dashboard");
    expect(TAB_ROUTES).toContain(tabPath(DEFAULT_TAB));
  });

  it("keeps the registry free of duplicates", () => {
    expect(new Set(TABS).size).toBe(TABS.length);
  });
});

describe("lighthouserc.js route list", () => {
  // lighthouserc.js is loaded by @lhci/cli through Node's require, so it cannot
  // import this module. It restates the routes in plain JS instead, and this
  // test is the only thing stopping the audited routes from drifting away from
  // the tabs the app actually ships — the failure mode being a green Lighthouse
  // run that silently stopped auditing a tab.
  const config = readFileSync(join(REPO_ROOT, "lighthouserc.js"), "utf8");

  it("declares an audited URL for every tab route", () => {
    for (const route of TAB_ROUTES) {
      expect(config, `lighthouserc.js is missing ${route}`).toContain(`"${route}"`);
    }
  });

  it("audits no route outside the tab registry", () => {
    const audited = [...config.matchAll(/"(\/[a-z-]*)"/g)].map((m) => m[1]!);
    const unexpected = audited.filter((path) => path !== "" && !TAB_ROUTES.includes(path));
    expect(unexpected).toEqual([]);
  });
});
