import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTransport, helpClient, trimBody, type HelpHttp, type HelpTransport } from "../src/features/help/helpApi.ts";
import { onSignedOut } from "../src/lib/auth.ts";

const answer = { known: true, text: "Tap **Keep**.", steps: [], actions: [], sources: ["review-keep"] };
const ok = (body: unknown, status = 200, retryAfter: number | null = null): HelpHttp => ({ status, retryAfter, body });
const authOf = (tokens: (string | null)[]) => {
  let i = 0;
  return { accessToken: vi.fn(async () => tokens[Math.min(i++, tokens.length - 1)] ?? null) };
};

describe("fetchTransport", () => {
  it("sends the token, never keepalive, never cached, and reads Retry-After", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429, headers: { "retry-after": "17" } }),
    );
    const t = fetchTransport("https://api.example", fetcher as unknown as typeof fetch);
    const ctrl = new AbortController();
    const res = await t("POST", "/help/answers", { question: "hi" }, "tok", ctrl.signal);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.example/v1/help/answers");
    expect(init?.keepalive).toBe(false);
    expect(init?.cache).toBe("no-store");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(init?.signal).toBe(ctrl.signal);
    expect(res).toEqual({ status: 429, retryAfter: 17, body: { error: { code: "rate_limited" } } });
  });
});

describe("helpClient.ask", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the answer with its mode and request id", async () => {
    const transport: HelpTransport = vi.fn(async () => ok({ answer, mode: "model", requestId: "r-1" }));
    const r = await helpClient({ transport, auth: authOf(["t"]) }).ask({ question: "  What does Keep do?  " });
    expect(r).toEqual({ kind: "answer", answer, mode: "model", requestId: "r-1" });
    expect(vi.mocked(transport).mock.calls[0]![2]).toEqual({ question: "What does Keep do?" });
  });

  it("refreshes the token once on 401", async () => {
    const auth = authOf(["old", "fresh"]);
    const transport = vi.fn<HelpTransport>(async (_m, _p, _b, token) => (token === "fresh" ? ok({ answer, mode: "kb", requestId: "r" }) : ok(null, 401)));
    const r = await helpClient({ transport, auth }).ask({ question: "hi" });
    expect(r.kind).toBe("answer");
    expect(auth.accessToken).toHaveBeenLastCalledWith(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("announces the sign-out when the refresh does not help", async () => {
    const seen = vi.fn();
    const off = onSignedOut(seen);
    const r = await helpClient({ transport: async () => ok(null, 401), auth: authOf(["a", "b"]) }).ask({ question: "hi" });
    off();
    expect(r.kind).toBe("signed_out");
    expect(seen).toHaveBeenCalled();
  });

  it("turns a 429 into a calm wait with Retry-After, and never retries by itself", async () => {
    const transport = vi.fn<HelpTransport>(async () =>
      ok({ error: { code: "rate_limited", message: "x", retryAfter: 40 }, requestId: "r-9" }, 429, 12),
    );
    const r = await helpClient({ transport, auth: authOf(["t"]) }).ask({ question: "hi" });
    expect(r).toEqual({ kind: "rate_limited", retryAfter: 12, requestId: "r-9" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("reads help_off as off, a 400 as its plain message", async () => {
    const off = await helpClient({ transport: async () => ok({ error: { code: "help_off" }, requestId: "r" }, 403), auth: authOf(["t"]) }).ask({ question: "hi" });
    expect(off.kind).toBe("off");
    const bad = await helpClient({
      transport: async () => ok({ error: { code: "bad_request", message: "Ask a question with up to 300 letters." }, requestId: "r" }, 400),
      auth: authOf(["t"]),
    }).ask({ question: "hi" });
    expect(bad).toEqual({ kind: "bad_request", message: "Ask a question with up to 300 letters.", requestId: "r" });
  });

  it("falls back on any 5xx, a network error or a bad body, with a code to copy", async () => {
    const s503 = await helpClient({ transport: async () => ok({ error: { code: "unavailable" }, requestId: "r-503" }, 503), auth: authOf(["t"]) }).ask({ question: "hi" });
    expect(s503).toEqual({ kind: "fallback", reason: "server", status: 503, requestId: "r-503" });
    const net = await helpClient({
      transport: async () => {
        throw new TypeError("Failed to fetch");
      },
      auth: authOf(["t"]),
      now: () => 1234,
    }).ask({ question: "hi" });
    expect(net).toEqual({ kind: "fallback", reason: "network", status: 0, requestId: "c-1234" });
    const weird = await helpClient({ transport: async () => ok({ nope: true }), auth: authOf(["t"]) }).ask({ question: "hi" });
    expect(weird.kind).toBe("fallback");
  });

  it("gives up after the timeout and answers locally", async () => {
    vi.useFakeTimers();
    const transport: HelpTransport = (_m, _p, _b, _t, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const pending = helpClient({ transport, auth: authOf(["t"]), timeoutMs: 27_000 }).ask({ question: "hi" });
    await vi.advanceTimersByTimeAsync(27_001);
    const r = await pending;
    expect(r.kind).toBe("fallback");
    expect(r.kind === "fallback" && r.reason).toBe("timeout");
  });

  it("cuts questions and history to the API's limits", () => {
    const long = "x".repeat(400);
    const body = trimBody({
      question: long,
      history: Array.from({ length: 7 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: long }) as const),
    });
    expect(body.question).toHaveLength(300);
    expect(body.history).toHaveLength(4);
    expect(body.history!.every((t) => t.text.length === 300)).toBe(true);
  });
});

describe("helpClient.status", () => {
  it("reads on, off and trouble", async () => {
    const on = await helpClient({ transport: async () => ok({ enabled: true, mode: "model", corpusVersion: "abc" }), auth: authOf(["t"]) }).status();
    expect(on).toEqual({ kind: "ok", status: { enabled: true, mode: "model", corpusVersion: "abc", pictures: false, assistant: { on: false, web: "off", files: false } } });
    // §27: the assistant's state comes through as it is; anything odd counts as off.
    const smart = await helpClient({
      transport: async () => ok({ enabled: true, mode: "model", corpusVersion: "abc", assistant: { on: true, web: "no_key", files: true, limits: {} } }),
      auth: authOf(["t"]),
    }).status();
    expect(smart.kind === "ok" && smart.status.assistant).toEqual({ on: true, web: "no_key", files: true });
    const odd = await helpClient({ transport: async () => ok({ enabled: true, mode: "model", corpusVersion: "abc", assistant: { on: "yes" } }), auth: authOf(["t"]) }).status();
    expect(odd.kind === "ok" && odd.status.assistant?.on).toBe(false);
    const withPictures = await helpClient({ transport: async () => ok({ enabled: true, mode: "model", corpusVersion: "abc", pictures: true }), auth: authOf(["t"]) }).status();
    expect(withPictures.kind === "ok" && withPictures.status.pictures).toBe(true);
    // Pictures need the model: a kb answer never says yes.
    const kbPictures = await helpClient({ transport: async () => ok({ enabled: true, mode: "kb", corpusVersion: "abc", pictures: true }), auth: authOf(["t"]) }).status();
    expect(kbPictures.kind === "ok" && kbPictures.status.pictures).toBe(false);
    const off = await helpClient({ transport: async () => ok({ enabled: false, mode: "off", corpusVersion: "" }), auth: authOf(["t"]) }).status();
    expect(off.kind === "ok" && off.status.enabled).toBe(false);
    const forbidden = await helpClient({ transport: async () => ok({ error: { code: "help_off" } }, 403), auth: authOf(["t"]) }).status();
    expect(forbidden.kind === "ok" && forbidden.status.enabled).toBe(false);
    const broken = await helpClient({ transport: async () => ok(null, 502), auth: authOf(["t"]) }).status();
    expect(broken.kind).toBe("error");
  });
});
