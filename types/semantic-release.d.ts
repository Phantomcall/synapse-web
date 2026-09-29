/**
 * Type declarations for the semantic-release plugins used in
 * `scripts/release-config.test.ts`.
 *
 * Neither `@semantic-release/commit-analyzer` nor
 * `@semantic-release/release-notes-generator` ships type definitions, so
 * TypeScript would infer `any` for them. Declaring the shapes used here keeps the
 * test type-checked under the repo's strict settings instead of disabling
 * `noImplicitAny`.
 *
 * These mirror the real signatures: both plugins take a plugin-config object
 * first, then a single context object.
 */

declare module "@semantic-release/commit-analyzer" {
  interface LastRelease {
    version: string;
    gitTag: string;
    channels: (string | null)[];
  }

  interface Commit {
    hash: string;
    message: string;
    subject: string;
  }

  interface AnalyzerContext {
    commits: Commit[];
    lastRelease: LastRelease;
    options: { repositoryUrl: string };
    cwd: string;
    logger: unknown;
  }

  interface ReleaseTypeConfig {
    type: string;
    release: "major" | "minor" | "patch" | false;
  }

  interface AnalyzerOptions {
    preset?: string;
    presetConfig?: { types?: ReleaseTypeConfig[] };
  }

  export function analyzeCommits(
    pluginConfig: AnalyzerOptions,
    context: AnalyzerContext
  ): Promise<"major" | "minor" | "patch" | null>;
}

declare module "@semantic-release/release-notes-generator" {
  interface Commit {
    hash: string;
    message: string;
    subject: string;
  }

  interface LastRelease {
    version: string;
    gitTag: string;
    channels: (string | null)[];
  }

  interface NextRelease {
    version: string;
    gitTag: string;
    channels: (string | null)[];
    name: string;
    notes: string;
  }

  interface NotesContext {
    commits: Commit[];
    lastRelease: LastRelease;
    nextRelease: NextRelease;
    options: { repositoryUrl: string };
    cwd: string;
    logger: unknown;
  }

  interface SectionConfig {
    type: string;
    section: string;
  }

  export function generateNotes(
    pluginConfig: { presetConfig?: { types?: SectionConfig[] } },
    context: NotesContext
  ): Promise<string>;
}
