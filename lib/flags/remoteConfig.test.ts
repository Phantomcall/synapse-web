import { describe, expect, it, vi } from "vitest";
import {
  CACHE_KEY,
  FRESHNESS_WINDOW_MS,
  loadFlags,
  parseRemoteFlags,
  readCache,
  validateRemoteFlags,
  writeCache,
} from "./remoteConfig";
import { FLAG_KEYS } from "./definitions";

const keys = FLAG_KEYS;
const ok = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

/** In-memory Storage, with optional failure injection. */
function memStorage(opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => {
      if (opts.throwOnGet) throw new Error("SecurityError: storage blocked");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    _dump: () => Object.fromEntries(map),
  } as unknown as Storage & { _dump: () => Record<string, string> };
}

describe("validateRemoteFlags", () => {
  it("accepts a well-formed payload", () => {
    expect(validateRemoteFlags({ flags: { "tab.admin": { value: false } } })).toEqual({
      "tab.admin": { value: false },
    });
  });

  it("accepts a bare flags map without the wrapper", () => {
    expect(validateRemoteFlags({ "tab.docs": { value: true } })).toEqual({
      "tab.docs": { value: true },
    });
  });

  it("accepts an empty payload as 'no overrides'", () => {
    expect(validateRemoteFlags({ flags: {} })).toEqual({});
    expect(validateRemoteFlags({})).toEqual({});
  });

  it("drops keys that are not declared in the registry", () => {
    const result = validateRemoteFlags(
      { flags: { "tab.admin": { value: true }, "evil.flag": { value: true } } },
      keys
    );
    expect(result).toEqual({ "tab.admin": { value: true } });
  });

  it("drops a stringified boolean rather than guessing", () => {
    // "true" is the classic hand-edited-JSON mistake; the flag must stay on its
    // default instead of being enabled by a truthy string.
    expect(validateRemoteFlags({ flags: { "tab.admin": { value: "true" } } })).toEqual({});
  });

  it("keeps a valid value when a sibling field is malformed", () => {
    expect(
      validateRemoteFlags({ flags: { "tab.admin": { value: true, percentage: "half" } } })
    ).toEqual({
      "tab.admin": { value: true },
    });
  });

  it("drops an entry with no usable field at all", () => {
    // A valid payload whose entries carry nothing usable reads as "no
    // overrides", not as a transport failure.
    expect(validateRemoteFlags({ flags: { "tab.admin": { note: "hi" } } })).toEqual({});
  });

  it("drops a non-object entry", () => {
    expect(validateRemoteFlags({ flags: { "tab.admin": 5, "tab.docs": { value: true } } })).toEqual(
      {
        "tab.docs": { value: true },
      }
    );
  });

  it("treats a fully unusable payload as an empty override set, not a failure", () => {
    // Deliberate: clearing all overrides must take effect rather than being
    // masked by last-known-good cache.
    expect(validateRemoteFlags({ flags: { "tab.admin": { value: "yes" } } })).toEqual({});
  });

  it("rejects non-object payloads", () => {
    for (const bad of [null, 42, "on", true, [], [{ value: true }]]) {
      expect(validateRemoteFlags(bad)).toBeNull();
    }
  });

  it("rejects a payload whose flags field is not an object", () => {
    expect(validateRemoteFlags({ flags: "nope" })).toBeNull();
    expect(validateRemoteFlags({ flags: [] })).toBeNull();
  });

  it("rejects a payload where every entry is a non-object", () => {
    expect(validateRemoteFlags({ flags: 5 })).toBeNull();
  });

  it("keeps out-of-range percentages for the resolver to clamp", () => {
    expect(validateRemoteFlags({ flags: { "tab.admin": { percentage: 150 } } })).toEqual({
      "tab.admin": { percentage: 150 },
    });
  });

  it("drops non-finite percentages", () => {
    expect(validateRemoteFlags({ flags: { "tab.admin": { percentage: NaN } } })).toEqual({});
  });
});

describe("parseRemoteFlags", () => {
  it("parses JSON", () => {
    expect(parseRemoteFlags('{"flags":{"tab.admin":{"value":false}}}')).toEqual({
      "tab.admin": { value: false },
    });
  });

  it("returns null on invalid JSON", () => {
    expect(parseRemoteFlags("<html>502</html>")).toBeNull();
    expect(parseRemoteFlags("")).toBeNull();
  });

  it("enforces the known-key list", () => {
    expect(parseRemoteFlags('{"flags":{"nope":{"value":true}}}', keys)).toEqual({});
  });
});

describe("readCache / writeCache", () => {
  it("round-trips an override", () => {
    const storage = memStorage();
    writeCache(storage, {
      overrides: { "tab.admin": { value: false } },
      fetchedAt: 1000,
      etag: "W/abc",
    });
    const restored = readCache(storage);
    expect(restored?.overrides).toEqual({ "tab.admin": { value: false } });
    expect(restored?.fetchedAt).toBe(1000);
    expect(restored?.etag).toBe("W/abc");
  });

  it("returns null when nothing is cached", () => {
    expect(readCache(memStorage())).toBeNull();
    expect(readCache(null)).toBeNull();
  });

  it("discards and drops a corrupt entry", () => {
    const storage = memStorage();
    storage.setItem(CACHE_KEY, "{not json");
    expect(readCache(storage)).toBeNull();
    expect(storage._dump()[CACHE_KEY]).toBeUndefined();
  });

  it("sanitises a hand-edited cache entry", () => {
    const storage = memStorage();
    storage.setItem(
      CACHE_KEY,
      JSON.stringify({
        overrides: { "tab.admin": { value: false }, evil: { value: true } },
        fetchedAt: 1,
      })
    );
    expect(readCache(storage, keys)?.overrides).toEqual({ "tab.admin": { value: false } });
  });

  it("survives storage that throws on access", () => {
    expect(readCache(memStorage({ throwOnGet: true }))).toBeNull();
  });

  it("survives storage that throws on write", () => {
    expect(() =>
      writeCache(memStorage({ throwOnSet: true }), { overrides: {}, fetchedAt: 1 })
    ).not.toThrow();
  });

  it("accepts null storage", () => {
    expect(() => writeCache(null, { overrides: {}, fetchedAt: 1 })).not.toThrow();
    expect(readCache(null)).toBeNull();
  });
});

describe("loadFlags — happy path", () => {
  it("returns remote overrides and caches them", async () => {
    const storage = memStorage();
    const fetchImpl = vi.fn(async () => ok({ flags: { "tab.admin": { value: false } } }));
    const result = await loadFlags({
      url: "https://flags.test/c.json",
      storage,
      fetchImpl,
      knownKeys: keys,
    });
    expect(result.source).toBe("remote");
    expect(result.overrides).toEqual({ "tab.admin": { value: false } });
    expect(result.stale).toBe(false);
    expect(readCache(storage)?.overrides).toEqual({ "tab.admin": { value: false } });
  });

  it("sends If-None-Match when an etag is cached", async () => {
    const storage = memStorage();
    writeCache(storage, { overrides: {}, fetchedAt: 1, etag: "W/xyz" });
    // Typed as a two-arg mock so the recorded RequestInit is visible to tsc.
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return ok({ flags: {} });
    });
    await loadFlags({ url: "https://flags.test/c.json", storage, fetchImpl, knownKeys: keys });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string> | undefined)?.["if-none-match"]).toBe("W/xyz");
  });

  it("treats 304 as authoritative cache", async () => {
    const storage = memStorage();
    writeCache(storage, { overrides: { "tab.admin": { value: false } }, fetchedAt: Date.now() });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 }));
    const result = await loadFlags({
      url: "https://flags.test/c.json",
      storage,
      fetchImpl,
      knownKeys: keys,
    });
    expect(result.source).toBe("cache");
    expect(result.overrides).toEqual({ "tab.admin": { value: false } });
    expect(result.stale).toBe(false);
  });
});

describe("loadFlags — degraded paths, the ones that matter", () => {
  const cached = () => {
    const storage = memStorage();
    writeCache(storage, { overrides: { "tab.admin": { value: false } }, fetchedAt: Date.now() });
    return storage;
  };

  it("uses last-known-good cache when the network is down", async () => {
    const storage = cached();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await loadFlags({
      url: "https://flags.test/c.json",
      storage,
      fetchImpl,
      knownKeys: keys,
    });
    expect(result.source).toBe("cache");
    expect(result.overrides).toEqual({ "tab.admin": { value: false } });
    expect(result.error).toMatch(/remote fetch failed/);
  });

  it("keeps serving an expired cache rather than reverting to defaults", async () => {
    // The whole point of last-known-good: an outage must not switch off a
    // feature that is already live for some users.
    const storage = memStorage();
    writeCache(storage, { overrides: { "tab.admin": { value: true } }, fetchedAt: 1 });
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await loadFlags({
      url: "https://flags.test/c.json",
      storage,
      fetchImpl,
      knownKeys: keys,
      now: 1 + FRESHNESS_WINDOW_MS * 10,
    });
    expect(result.source).toBe("cache");
    expect(result.overrides).toEqual({ "tab.admin": { value: true } });
    expect(result.stale).toBe(true);
  });

  it("falls back to defaults with no cache and no network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await loadFlags({
      url: "https://flags.test/c.json",
      storage: memStorage(),
      fetchImpl,
    });
    expect(result.source).toBe("empty");
    expect(result.overrides).toEqual({});
  });

  it("falls back to cache on a 5xx", async () => {
    const result = await loadFlags({
      url: "https://flags.test/c.json",
      storage: cached(),
      fetchImpl: async () => new Response("nope", { status: 503 }),
      knownKeys: keys,
    });
    expect(result.source).toBe("cache");
    expect(result.error).toMatch(/503/);
  });

  it("falls back to cache on a 404 config endpoint", async () => {
    const result = await loadFlags({
      url: "https://flags.test/c.json",
      storage: cached(),
      fetchImpl: async () => new Response("", { status: 404 }),
      knownKeys: keys,
    });
    expect(result.source).toBe("cache");
  });

  it("falls back to cache when the endpoint returns an HTML error page", async () => {
    const result = await loadFlags({
      url: "https://flags.test/c.json",
      storage: cached(),
      fetchImpl: async () => new Response("<html>502 Bad Gateway</html>", { status: 200 }),
      knownKeys: keys,
    });
    expect(result.source).toBe("cache");
    expect(result.error).toMatch(/not a usable flag config/);
  });

  it("does not throw when fetch rejects with a non-Error", async () => {
    const result = await loadFlags({
      url: "https://flags.test/c.json",
      storage: cached(),
      fetchImpl: async () => {
        throw "string failure";
      },
      knownKeys: keys,
    });
    expect(result.source).toBe("cache");
    expect(result.error).toMatch(/string failure/);
  });

  it("aborts a hanging endpoint and falls back to cache", async () => {
    vi.useFakeTimers();
    try {
      const promise = loadFlags({
        url: "https://flags.test/c.json",
        storage: cached(),
        knownKeys: keys,
        timeoutMs: 50,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("The operation was aborted"))
            );
          }),
      });
      await vi.advanceTimersByTimeAsync(60);
      const result = await promise;
      expect(result.source).toBe("cache");
      expect(result.error).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the network entirely when no url is configured", async () => {
    const fetchImpl = vi.fn();
    const result = await loadFlags({
      storage: cached(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      knownKeys: keys,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.source).toBe("cache");
  });

  it("works with no storage and no url", async () => {
    const result = await loadFlags({});
    expect(result.source).toBe("empty");
    expect(result.overrides).toEqual({});
  });

  it("survives a fetchImpl that is not callable", async () => {
    const result = await loadFlags({
      url: "https://flags.test/c.json",
      storage: cached(),
      fetchImpl: undefined as unknown as typeof fetch,
    });
    expect(["cache", "empty"]).toContain(result.source);
  });
});
