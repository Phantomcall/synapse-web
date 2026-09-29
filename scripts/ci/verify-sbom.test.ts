import { describe, expect, it } from "vitest";
import { compareSbom, flattenComponents } from "./verify-sbom.mjs";

const lock = {
  lockfileVersion: 3,
  packages: {
    "": { name: "synapse-core", version: "0.1.0" },
    "node_modules/next": { version: "16.2.6" },
    "node_modules/next/node_modules/postcss": { version: "8.4.31" },
    "node_modules/typescript": { version: "5.9.3", devOptional: true },
    "node_modules/vitest": { version: "3.2.7", dev: true },
    "node_modules/@img/sharp-darwin-arm64": { version: "0.34.5", optional: true },
  },
};

const installed = (p: string) => p !== "node_modules/@img/sharp-darwin-arm64";

function component(lockPath: string, version: string, extra: object = {}) {
  const name = lockPath.split("node_modules/").pop();
  return {
    name,
    version,
    purl: `pkg:npm/${name}@${version}`,
    properties: [{ name: "cdx:npm:package:path", value: lockPath }],
    ...extra,
  };
}

function bom(components: object[]) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: { component: { name: "synapse-core" } },
    components,
  };
}

const accurate = bom([
  component("node_modules/next", "16.2.6", {
    components: [component("node_modules/next/node_modules/postcss", "8.4.31")],
  }),
  component("node_modules/typescript", "5.9.3"),
]);

describe("flattenComponents", () => {
  it("walks nested components", () => {
    expect(flattenComponents(accurate).map((c: { name: string }) => c.name)).toEqual([
      "next",
      "postcss",
      "typescript",
    ]);
  });
});

describe("compareSbom", () => {
  it("accepts an SBOM matching the installed production tree", () => {
    const result = compareSbom(accurate, lock, installed);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.componentCount).toBe(3);
    expect(result.expectedCount).toBe(3);
  });

  it("rejects a dev-only dependency leaking into the SBOM", () => {
    const leaked = bom([...accurate.components, component("node_modules/vitest", "3.2.7")]);
    const result = compareSbom(leaked, lock, installed);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/vitest.*dev-only/);
  });

  it("rejects a production dependency missing from the SBOM", () => {
    const result = compareSbom(bom([component("node_modules/next", "16.2.6")]), lock, installed);
    expect(result.errors).toEqual([
      "node_modules/next/node_modules/postcss@8.4.31 is a production dependency missing from the SBOM",
      "node_modules/typescript@5.9.3 is a production dependency missing from the SBOM",
    ]);
  });

  it("rejects a version that differs from the lockfile", () => {
    const drifted = bom([
      component("node_modules/next", "16.3.0", {
        components: [component("node_modules/next/node_modules/postcss", "8.4.31")],
      }),
      component("node_modules/typescript", "5.9.3"),
    ]);
    expect(compareSbom(drifted, lock, installed).errors).toEqual([
      "node_modules/next: SBOM version 16.3.0 != lockfile 16.2.6",
    ]);
  });

  it("does not expect optional binaries for other platforms", () => {
    const result = compareSbom(accurate, lock, installed);
    expect(result.errors.join("\n")).not.toContain("sharp-darwin");
  });

  it("rejects packages that are not in the lockfile at all", () => {
    const extra = bom([...accurate.components, component("node_modules/left-pad", "1.3.0")]);
    expect(compareSbom(extra, lock, installed).errors).toEqual([
      "node_modules/left-pad (pkg:npm/left-pad@1.3.0) is in the SBOM but not in package-lock.json",
    ]);
  });

  it("warns, but does not fail, on npm-extraneous packages", () => {
    const withFlag = bom([
      component("node_modules/next", "16.2.6", {
        components: [component("node_modules/next/node_modules/postcss", "8.4.31")],
      }),
      {
        ...component("node_modules/typescript", "5.9.3"),
        properties: [
          { name: "cdx:npm:package:path", value: "node_modules/typescript" },
          { name: "cdx:npm:package:extraneous", value: "true" },
        ],
      },
    ]);
    const result = compareSbom(withFlag, lock, installed);
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });

  it("rejects a non-CycloneDX document", () => {
    expect(compareSbom({ ...accurate, bomFormat: "SPDX" }, lock, installed).ok).toBe(false);
  });
});
