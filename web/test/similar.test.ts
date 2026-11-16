import { describe, expect, it, vi } from "vitest";
import { httpApi } from "../src/api/http.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import { similar } from "../src/api/mock/index.ts";
import { alike } from "../src/components/SimilarClips.tsx";
import { loadConfig } from "../src/lib/config.ts";

const base = { region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test/" };
const fetchJson = (body: unknown) => async () => new Response(JSON.stringify(body));

describe("config wsUrl", () => {
  it("reads the WebSocket URL from /config.json", async () => {
    const c = await loadConfig(fetchJson({ ...base, wsUrl: "wss://abc.execute-api.eu-north-1.amazonaws.com/live/" }));
    expect(c.wsUrl).toBe("wss://abc.execute-api.eu-north-1.amazonaws.com/live");
    expect(c.apiUrl).toBe("https://api.test");
  });

  it("treats a missing or odd wsUrl as absent (polling only)", async () => {
    expect((await loadConfig(fetchJson(base))).wsUrl).toBeUndefined();
    expect((await loadConfig(fetchJson({ ...base, wsUrl: "http://abc/live" }))).wsUrl).toBeUndefined();
    expect((await loadConfig(fetchJson({ ...base, wsUrl: "wss://abc/live?token=x" }))).wsUrl).toBeUndefined();
    expect((await loadConfig(fetchJson({ ...base, wsUrl: 7 }))).wsUrl).toBeUndefined();
  });
});

describe("similarClips over HTTP", () => {
  it("calls GET /v1/clips/{id}/similar and returns the list", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ clips: [{ clipId: "A", similarity: 0.9 }] })));
    const api = httpApi({ baseUrl: "https://api.test", auth: { accessToken: async () => "t" }, fetcher });
    expect(await api.similarClips("C 1")).toEqual([{ clipId: "A", similarity: 0.9 }]);
    expect(fetcher).toHaveBeenCalledWith("https://api.test/v1/clips/C%201/similar", expect.objectContaining({ method: "GET" }));
  });
});

describe("mock similar clips", () => {
  const store = seed();
  const review = store.clips.find((c) => c.status === "review")!;

  it("lists measured clips only, never the clip itself, at most five, most alike first", () => {
    const out = similar(store, review);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.some((s) => s.clipId === review.clipId)).toBe(false);
    for (const s of out) {
      expect(store.clips.find((c) => c.clipId === s.clipId)?.status).toBe("posted");
      expect(s.performance?.views).toBeGreaterThan(0);
      expect(s.similarity).toBeGreaterThan(0);
      expect(s.similarity).toBeLessThanOrEqual(1);
    }
    expect(out.map((s) => s.similarity)).toEqual([...out.map((s) => s.similarity)].sort((a, b) => b - a));
  });

  it("finds nothing when no clip has numbers yet", () => {
    const empty = { ...store, posts: store.posts.map((p) => ({ ...p, metrics: undefined })) };
    expect(similar(empty, review)).toEqual([]);
  });
});

describe("alike", () => {
  it("says how alike in whole percent", () => {
    expect(alike(0.864)).toBe("86% alike");
    expect(alike(1.2)).toBe("100% alike");
    expect(alike(-1)).toBe("0% alike");
  });
});
