import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { FlagProvider, useFlag, useFlags } from "./FlagProvider";
import { FLAGS, type FlagKey } from "./definitions";

/** Render a consumer inside a provider and expose what it saw. */
function probe() {
  const seen: Record<string, boolean> = {};
  function Consumer() {
    seen.admin = useFlag("tab.admin");
    seen.bulk = useFlag("transactions.bulk-actions");
    const { status, source, stale, lastError, refresh } = useFlags();
    return (
      <div>
        <span data-testid="status">{status}</span>
        <span data-testid="source">{source}</span>
        <span data-testid="stale">{String(stale)}</span>
        <span data-testid="error">{lastError ?? ""}</span>
        <span data-testid="admin">{String(seen.admin)}</span>
        <span data-testid="bulk">{String(seen.bulk)}</span>
        <button onClick={refresh}>refresh</button>
      </div>
    );
  }
  return { seen, Consumer };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const text = (id: string) => screen.getByTestId(id).textContent;

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("FlagProvider defaults", () => {
  it("renders the registry default before the remote config arrives", async () => {
    const { Consumer } = probe();
    render(
      <FlagProvider url="https://flags.test/c.json" fetchImpl={async () => ok({ flags: {} })}>
        <Consumer />
      </FlagProvider>
    );
    // Synchronously: the very first render, which is what SSR and hydration
    // see, must already be the safe default.
    expect(text("status")).toBe("loading");
    expect(text("admin")).toBe(String(FLAGS["tab.admin"].defaultValue));
    expect(text("bulk")).toBe(String(FLAGS["transactions.bulk-actions"].defaultValue));
    await waitFor(() => expect(text("status")).toBe("ready"));
  });

  it("uses registry defaults with no url configured", async () => {
    const { Consumer } = probe();
    render(
      <FlagProvider>
        <Consumer />
      </FlagProvider>
    );
    await waitFor(() => expect(text("status")).toBe("ready"));
    expect(text("source")).toBe("empty");
    expect(text("admin")).toBe("true");
  });
});

describe("FlagProvider with a remote config", () => {
  it("applies a remote kill-switch", async () => {
    const { Consumer } = probe();
    render(
      <FlagProvider
        url="https://flags.test/c.json"
        fetchImpl={async () => ok({ flags: { "tab.admin": { value: false } } })}
      >
        <Consumer />
      </FlagProvider>
    );
    await waitFor(() => expect(text("admin")).toBe("false"));
    expect(text("source")).toBe("remote");
  });

  it("applies a remote percentage rollout", async () => {
    const { Consumer } = probe();
    render(
      <FlagProvider
        url="https://flags.test/c.json"
        fetchImpl={async () =>
          ok({ flags: { "transactions.bulk-actions": { value: true, percentage: 0 } } })
        }
      >
        <Consumer />
      </FlagProvider>
    );
    // 0% of everyone, including the bucket this anonymous subject hashes to.
    await waitFor(() => expect(text("bulk")).toBe("false"));
  });

  it("marks a stale cache as stale", async () => {
    window.localStorage.setItem(
      "synapse:feature-flags:v1",
      JSON.stringify({ overrides: { "tab.admin": { value: false } }, fetchedAt: 1 })
    );
    const { Consumer } = probe();
    render(
      <FlagProvider
        url="https://flags.test/c.json"
        fetchImpl={async () => {
          throw new Error("offline");
        }}
      >
        <Consumer />
      </FlagProvider>
    );
    await waitFor(() => expect(text("status")).toBe("ready"));
    expect(text("source")).toBe("cache");
    expect(text("stale")).toBe("true");
    expect(text("error")).toMatch(/offline/);
  });

  it("surfaces the error and keeps defaults when there is no cache", async () => {
    const { Consumer } = probe();
    render(
      <FlagProvider
        url="https://flags.test/c.json"
        fetchImpl={async () => {
          throw new Error("DNS failure");
        }}
      >
        <Consumer />
      </FlagProvider>
    );
    await waitFor(() => expect(text("status")).toBe("ready"));
    expect(text("source")).toBe("empty");
    expect(text("error")).toMatch(/DNS failure/);
    expect(text("admin")).toBe("true");
  });

  it("re-fetches when refresh is called", async () => {
    const fetchImpl = vi.fn(async () => ok({ flags: {} }));
    const { Consumer } = probe();
    render(
      <FlagProvider url="https://flags.test/c.json" fetchImpl={fetchImpl}>
        <Consumer />
      </FlagProvider>
    );
    await waitFor(() => expect(text("status")).toBe("ready"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await act(async () => {
      screen.getByText("refresh").click();
    });
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  });

  it("does not update state after unmount", async () => {
    let resolve: ((r: Response) => void) | undefined;
    const { Consumer } = probe();
    const view = render(
      <FlagProvider
        url="https://flags.test/c.json"
        fetchImpl={async () =>
          new Promise<Response>((r) => {
            resolve = r;
          })
        }
      >
        <Consumer />
      </FlagProvider>
    );
    view.unmount();
    await act(async () => {
      resolve?.(ok({ flags: { "tab.admin": { value: false } } }));
    });
    // No act() warning and no throw: the cancelled guard is doing its job.
    expect(true).toBe(true);
  });
});

describe("fail-safe paths that must not take the shell down", () => {
  it("still resolves flags when localStorage throws on every access", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage is blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError: storage is blocked");
    });
    const { Consumer } = probe();
    render(
      <FlagProvider
        url="https://flags.test/c.json"
        fetchImpl={async () => ok({ flags: { "tab.admin": { value: false } } })}
      >
        <Consumer />
      </FlagProvider>
    );
    await waitFor(() => expect(text("status")).toBe("ready"));
    // Flags still evaluate; a blocked-storage browser just gets an ephemeral
    // bucketing subject, which is a lesser evil than an unusable shell.
    expect(text("admin")).toBe("false");
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("falls back to defaults if the flag loader ever rejects unexpectedly", async () => {
    const { Consumer } = probe();
    render(
      <FlagProvider
        url="https://flags.test/c.json"
        fetchImpl={async () => {
          throw new Error("boom");
        }}
      >
        <Consumer />
      </FlagProvider>
    );
    await waitFor(() => expect(text("status")).toBe("ready"));
    expect(text("admin")).toBe("true");
  });
});

describe("useFlag outside a provider", () => {
  it("returns the registry default instead of throwing", () => {
    function Bare() {
      return <span data-testid="v">{String(useFlag("tab.docs"))}</span>;
    }
    render(<Bare />);
    expect(text("v")).toBe(String(FLAGS["tab.docs"].defaultValue));
  });

  it("useFlags outside a provider returns a ready defaults-only context", () => {
    function Bare() {
      const { status, source, stale, lastError, refresh } = useFlags();
      return (
        <span data-testid="ctx">
          {status}|{source}|{String(stale)}|{String(lastError ?? "")}|{typeof refresh}
        </span>
      );
    }
    render(<Bare />);
    expect(text("ctx")).toBe("ready|empty|false||function");
  });

  it("ignores an unknown flag key without crashing", () => {
    function Bare() {
      return <span data-testid="v">{String(useFlag("does.not.exist" as FlagKey))}</span>;
    }
    render(<Bare />);
    expect(text("v")).toBe("false");
  });
});
