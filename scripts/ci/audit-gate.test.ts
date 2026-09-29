import { describe, expect, it } from "vitest";
import {
  advisoryId,
  evaluateAudit,
  extractAdvisories,
  formatSummary,
  parseAllowlist,
} from "./audit-gate.mjs";

type Via = {
  source: number;
  name: string;
  severity: string;
  title: string;
  url: string;
  range: string;
};

function advisory(name: string, severity: string, ghsa: string, source = 1): Via {
  return {
    source,
    name,
    severity,
    title: `${name} ${severity} issue`,
    url: `https://github.com/advisories/${ghsa}`,
    range: "<9.9.9",
  };
}

function report(vulns: Record<string, { severity: string; via: (Via | string)[] }>) {
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(
      Object.entries(vulns).map(([name, v]) => [name, { name, ...v, effects: [], nodes: [] }])
    ),
  };
}

const NOW = new Date("2026-09-29T00:00:00Z");

// Shape matches a real `npm audit --json` run after adding lodash@4.17.11.
const lodash = report({
  lodash: {
    severity: "critical",
    via: [
      advisory("lodash", "critical", "GHSA-jf85-cpcp-j695", 1),
      advisory("lodash", "high", "GHSA-p6mc-m468-83gw", 2),
    ],
  },
});

describe("extractAdvisories", () => {
  it("returns only advisory objects, not transitive package-name edges", () => {
    const r = report({
      "wallet-kit": { severity: "high", via: ["axios"] },
      axios: { severity: "high", via: [advisory("axios", "high", "GHSA-gcfj-64vw-6mp9")] },
    });
    expect(extractAdvisories(r).map((a) => a.packageName)).toEqual(["axios"]);
  });

  it("de-duplicates an advisory that npm lists under several vulnerabilities", () => {
    const via = advisory("axios", "high", "GHSA-gcfj-64vw-6mp9");
    const r = report({
      axios: { severity: "high", via: [via] },
      "axios-retry": { severity: "high", via: [via, "axios"] },
    });
    expect(extractAdvisories(r)).toHaveLength(1);
  });

  it("rejects the legacy v1 report format instead of silently passing", () => {
    expect(() => extractAdvisories({ advisories: {} })).toThrow(/auditReportVersion/);
  });
});

describe("advisoryId", () => {
  it("normalises GHSA ids and falls back to the npm advisory number", () => {
    expect(advisoryId({ url: "https://github.com/advisories/ghsa-JF85-cpcp-j695" })).toBe(
      "GHSA-jf85-cpcp-j695"
    );
    expect(advisoryId({ source: 42, url: "" })).toBe("npm:42");
  });
});

describe("evaluateAudit", () => {
  it("fails on a newly introduced vulnerable production dependency", () => {
    const result = evaluateAudit({ prodReport: lodash, fullReport: lodash, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.id)).toEqual([
      "GHSA-jf85-cpcp-j695",
      "GHSA-p6mc-m468-83gw",
    ]);
  });

  it("does not block production advisories below high", () => {
    const r = report({
      pkg: { severity: "moderate", via: [advisory("pkg", "moderate", "GHSA-aaaa-bbbb-cccc")] },
    });
    const result = evaluateAudit({ prodReport: r, fullReport: r, now: NOW });
    expect(result.ok).toBe(true);
    expect(result.belowThreshold).toHaveLength(1);
  });

  it("only blocks dev-only advisories at critical", () => {
    const prod = report({});
    const full = report({
      tooling: {
        severity: "critical",
        via: [
          advisory("tooling", "high", "GHSA-hhhh-hhhh-hhhh"),
          advisory("tooling", "critical", "GHSA-cccc-cccc-cccc"),
        ],
      },
    });
    const result = evaluateAudit({ prodReport: prod, fullReport: full, now: NOW });
    expect(result.failures.map((f) => [f.id, f.scope])).toEqual([
      ["GHSA-cccc-cccc-cccc", "development"],
    ]);
  });

  it("classifies an advisory present in the production report as production, not dev", () => {
    const result = evaluateAudit({ prodReport: lodash, fullReport: lodash, now: NOW });
    expect(new Set(result.failures.map((f) => f.scope))).toEqual(new Set(["production"]));
  });

  it("lets an unexpired allowlist entry through and reports it", () => {
    const allowlist = {
      exceptions: [
        { id: "GHSA-jf85-cpcp-j695", reason: "no fix", tracking: "#1", expires: "2026-12-01" },
        { id: "GHSA-p6mc-m468-83gw", reason: "no fix", tracking: "#1", expires: "2026-12-01" },
      ],
    };
    const result = evaluateAudit({ prodReport: lodash, fullReport: lodash, allowlist, now: NOW });
    expect(result.ok).toBe(true);
    expect(result.allowlisted).toHaveLength(2);
  });

  it("stops honouring an exception once it expires", () => {
    const allowlist = {
      exceptions: [
        { id: "GHSA-jf85-cpcp-j695", reason: "no fix", tracking: "#1", expires: "2026-09-01" },
        { id: "GHSA-p6mc-m468-83gw", reason: "no fix", tracking: "#1", expires: "2026-12-01" },
      ],
    };
    const result = evaluateAudit({ prodReport: lodash, fullReport: lodash, allowlist, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.id)).toEqual(["GHSA-jf85-cpcp-j695"]);
    expect(result.expired.map((e) => e.id)).toEqual(["GHSA-jf85-cpcp-j695"]);
  });

  it("scopes a package-qualified exception to that package only", () => {
    const shared = advisory("a", "high", "GHSA-ssss-ssss-ssss");
    const r = report({
      a: { severity: "high", via: [shared] },
      b: { severity: "high", via: [{ ...shared, name: "b" }] },
    });
    const allowlist = {
      exceptions: [
        {
          id: "GHSA-ssss-ssss-ssss",
          package: "a",
          reason: "x",
          tracking: "#1",
          expires: "2027-01-01",
        },
      ],
    };
    const result = evaluateAudit({ prodReport: r, fullReport: r, allowlist, now: NOW });
    expect(result.failures.map((f) => f.packageName)).toEqual(["b"]);
  });

  it("fails the gate on malformed exceptions rather than ignoring them", () => {
    const allowlist = { exceptions: [{ id: "GHSA-jf85-cpcp-j695", expires: "2027-01-01" }] };
    const clean = report({});
    const result = evaluateAudit({ prodReport: clean, fullReport: clean, allowlist, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.invalid[0]?.problems).toEqual([
      "missing `reason`",
      "missing `tracking` (issue/PR link)",
    ]);
  });

  it("flags exceptions that no longer match anything", () => {
    const allowlist = {
      exceptions: [
        { id: "GHSA-gone-gone-gone", reason: "x", tracking: "#1", expires: "2027-01-01" },
      ],
    };
    const clean = report({});
    const result = evaluateAudit({ prodReport: clean, fullReport: clean, allowlist, now: NOW });
    expect(result.ok).toBe(true);
    expect(result.unused.map((e) => e.id)).toEqual(["GHSA-gone-gone-gone"]);
  });
});

describe("parseAllowlist", () => {
  it("treats a missing exceptions array as empty", () => {
    expect(parseAllowlist({}, NOW)).toEqual({ active: [], expired: [], invalid: [] });
  });
});

describe("formatSummary", () => {
  it("lists blocking advisories in a markdown table", () => {
    const summary = formatSummary(
      evaluateAudit({ prodReport: lodash, fullReport: lodash, now: NOW })
    );
    expect(summary).toContain("failed");
    expect(summary).toContain("| critical | production | `lodash` |");
  });
});
