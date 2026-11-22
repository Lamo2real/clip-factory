import { describe, expect, it, vi } from "vitest";
import { ApiError, errorFromResponse, friendlyMessage, networkError } from "../src/api/errors.ts";
import { httpApi } from "../src/api/http.ts";
import { onSignedOut } from "../src/lib/auth.ts";

function json(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("errorFromResponse", () => {
  it("uses the server's plain sentence and code", () => {
    const e = errorFromResponse(409, { error: { code: "conflict", message: "This clip was already decided." } });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("conflict");
    expect(e.message).toBe("This clip was already decided.");
  });

  it("falls back to a friendly sentence when the body is not the envelope", () => {
    expect(errorFromResponse(502, "<html>Bad gateway</html>").message).toBe(
      "Something went wrong on our side. Try again in a moment.",
    );
    expect(errorFromResponse(404, null).code).toBe("not_found");
    expect(errorFromResponse(413, {}).code).toBe("too_large");
    expect(errorFromResponse(418, { error: { code: "weird_code" } }).code).toBe("bad_request");
  });

  it("never shows a raw error to the owner", () => {
    expect(friendlyMessage(new TypeError("Failed to fetch"))).toBe("Something went wrong on our side. Try again in a moment.");
  });
});

describe("httpApi", () => {
  const auth = (tokens: (string | null)[]) => {
    let i = 0;
    return { accessToken: vi.fn(async () => tokens[Math.min(i++, tokens.length - 1)] ?? null) };
  };

  it("sends the bearer token and unwraps the body", async () => {
    const fetcher = vi.fn(async () => json(200, { job: { jobId: "J1" } }));
    const api = httpApi({ baseUrl: "https://api.test", auth: auth(["tok"]), fetcher });
    const job = await api.createJob({ source: { type: "link", url: "https://youtu.be/dQw4w9WgXcQ" }, clipTarget: { min: 5, max: 10 } });
    expect(job.jobId).toBe("J1");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/jobs");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toMatchObject({ clipTarget: { min: 5, max: 10 } });
  });

  it("encodes query parameters and path ids", async () => {
    const fetcher = vi.fn(async () => json(200, { clips: [] }));
    const api = httpApi({ baseUrl: "https://api.test", auth: auth(["tok"]), fetcher });
    await api.listClips({ status: "review", jobId: "a/b" });
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe("https://api.test/v1/clips?status=review&jobId=a%2Fb");
  });

  it("refreshes the token once on 401 and retries", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: { code: "unauthorized", message: "Expired." } }))
      .mockResolvedValueOnce(json(200, { skills: [] }));
    const a = auth(["old", "new"]);
    const api = httpApi({ baseUrl: "https://api.test", auth: a, fetcher });
    await expect(api.listSkills()).resolves.toEqual([]);
    expect(a.accessToken).toHaveBeenLastCalledWith(true);
    const second = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect((second[1].headers as Record<string, string>).authorization).toBe("Bearer new");
  });

  it("turns the error envelope into an ApiError with the server's message", async () => {
    const fetcher = vi.fn(async () =>
      json(409, { error: { code: "conflict", message: "Paste your YouTube keys first." } }),
    );
    const api = httpApi({ baseUrl: "https://api.test", auth: auth(["tok"]), fetcher });
    await expect(api.connectAccount("youtube")).rejects.toMatchObject({
      code: "conflict",
      status: 409,
      message: "Paste your YouTube keys first.",
    });
  });

  it("calls the posting setup routes of §17.4 with the right methods and bodies", async () => {
    const setup = { platform: "x", stepsDone: [], ready: false, keys: { saved: false }, account: { platform: "x", status: "not_connected" }, gates: [] };
    const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) =>
      String(url).endsWith("/connect")
        ? json(200, { authorizeUrl: "https://x.com/i/oauth2/authorize?x=1", expiresAt: "2026-11-16T10:10:00Z" })
        : String(url).endsWith("/creator-info")
          ? json(200, { creator: { nickname: "n" } })
          : String(url).endsWith("/check")
            ? json(200, { check: { ok: true }, setup })
            : String(url).endsWith("/v1/setup")
              ? json(200, { platforms: [setup], ready: 0, values: {} })
              : json(200, { setup }),
    );
    const api = httpApi({ baseUrl: "https://api.test", auth: auth(["tok"]), fetcher });
    const sent = () => fetcher.mock.calls.map((c) => {
      const [u, init] = c as unknown as [string, RequestInit];
      return [init.method, u.replace("https://api.test/v1", ""), init.body ? JSON.parse(String(init.body)) : undefined];
    });
    await api.getSetup();
    await api.getPlatformSetup("x");
    await api.setSetupStep("x", "ready-card", true);
    await api.setReviewState("in_review");
    await api.saveSetupKeys("x", { clientId: "a", clientSecret: "b" });
    await api.checkSetup("x");
    await api.uploadVerificationFile("tiktokAbc1.txt", "v");
    expect(await api.connectAccount("x")).toEqual({ authorizeUrl: "https://x.com/i/oauth2/authorize?x=1", expiresAt: "2026-11-16T10:10:00Z" });
    await api.chooseAccount("facebook", "123");
    await api.tiktokCreatorInfo();
    await api.confirmClip("C1", undefined, { privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: true, disableStitch: true, brandContent: false, brandOrganic: false });
    expect(sent()).toEqual([
      ["GET", "/setup", undefined],
      ["GET", "/setup/x", undefined],
      ["PATCH", "/setup/x", { step: "ready-card", done: true }],
      ["PATCH", "/setup/tiktok", { gate: "app_review", state: "in_review" }],
      ["PUT", "/setup/x/keys", { clientId: "a", clientSecret: "b" }],
      ["POST", "/setup/x/check", undefined],
      ["POST", "/setup/tiktok/verification-file", { filename: "tiktokAbc1.txt", content: "v" }],
      ["POST", "/accounts/x/connect", undefined],
      ["POST", "/accounts/facebook/choose", { accountId: "123" }],
      ["GET", "/accounts/tiktok/creator-info", undefined],
      [
        "POST",
        "/clips/C1/confirm",
        { tiktok: { privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: true, disableStitch: true, brandContent: false, brandOrganic: false } },
      ],
    ]);
  });

  it("reports a network failure in plain words", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const api = httpApi({ baseUrl: "https://api.test", auth: auth(["tok"]), fetcher });
    await expect(api.me()).rejects.toMatchObject({
      code: "network",
      message: "Clip Factory cannot be reached. Check your connection and try again.",
    });
  });

  it("skills: read one, write, update with the version, replace a file (§18)", async () => {
    const skill = { skillId: "S1", version: 2 };
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "GET" ? json(200, { skill, content: "x", form: null, files: [] }) : json(200, { skill }),
    );
    const api = httpApi({ baseUrl: "https://api.test", auth: auth(["tok"]), fetcher });
    await expect(api.getSkill("S1")).resolves.toMatchObject({ content: "x" });
    await api.writeSkill({ title: "T", description: "When.", instructions: "Do." });
    await api.updateSkill("S1", { version: 2, title: "T", description: "When.", instructions: "Do." });
    await api.createSkillUpload("a.md", "S1");
    const calls = fetcher.mock.calls.map(([url, init]) => [init?.method, url, init?.body]);
    expect(calls).toEqual([
      ["GET", "https://api.test/v1/skills/S1", undefined],
      ["POST", "https://api.test/v1/skills", JSON.stringify({ title: "T", description: "When.", instructions: "Do." })],
      ["PUT", "https://api.test/v1/skills/S1", JSON.stringify({ version: 2, title: "T", description: "When.", instructions: "Do." })],
      ["POST", "https://api.test/v1/skills/uploads", JSON.stringify({ filename: "a.md", skillId: "S1" })],
    ]);
  });

  it("keeps the server's field hint on an error", async () => {
    const fetcher = vi.fn(async () =>
      json(409, { error: { code: "conflict", message: "You already have a skill called X. Pick another name.", field: "title" } }),
    );
    const api = httpApi({ baseUrl: "https://api.test", auth: auth(["tok"]), fetcher });
    await expect(api.writeSkill({ title: "X", description: "abc", instructions: "y" })).rejects.toMatchObject({ status: 409, field: "title" });
  });

  it("Throw away's hold: POST /hold answers the clip, DELETE /hold the 204 (§46.13)", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => (init?.method === "DELETE" ? new Response(null, { status: 204 }) : json(200, { clip: { clipId: "C/1" } })));
    const api = httpApi({ baseUrl: "https://api.test", auth: auth(["tok"]), fetcher });
    expect((await api.holdClip("C/1")).clipId).toBe("C/1");
    await expect(api.unholdClip("C/1")).resolves.toBeUndefined();
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [init.method, url, init.body])).toEqual([
      ["POST", "https://api.test/v1/clips/C%2F1/hold", undefined],
      ["DELETE", "https://api.test/v1/clips/C%2F1/hold", undefined],
    ]);
    // A run sent it first: the server's sentence.
    const refused = httpApi({ baseUrl: "https://api.test", auth: auth(["tok"]), fetcher: vi.fn(async () => json(409, { error: { code: "conflict", message: "Auto-posting already sent this clip." } })) });
    await expect(refused.holdClip("C1")).rejects.toMatchObject({ status: 409, message: "Auto-posting already sent this clip." });
  });

  it("treats 204 as success with no body", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const api = httpApi({ baseUrl: "https://api.test", auth: auth(["tok"]), fetcher });
    await expect(api.deleteSkill("S1")).resolves.toBeUndefined();
  });

  it("never sends a tokenless request or signs out when the token refresh fails on the network", async () => {
    const fetcher = vi.fn(async () => json(200, {}));
    const signedOut = vi.fn();
    const off = onSignedOut(signedOut);
    const api = httpApi({
      baseUrl: "https://api.test",
      auth: { accessToken: vi.fn(async () => Promise.reject(networkError())) },
      fetcher,
    });
    await expect(api.me()).rejects.toMatchObject({ code: "network" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(signedOut).not.toHaveBeenCalled();
    off();
  });

  it("keeps a small PATCH alive past page unload so a last caption edit is saved", async () => {
    const fetcher = vi.fn(async () => json(200, { clip: { clipId: "C1" } }));
    const api = httpApi({ baseUrl: "https://api.test", auth: auth(["tok"]), fetcher });
    await api.updateClip("C1", { tiktok: "hi" });
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].keepalive).toBe(true);
    await api.me();
    expect((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].keepalive).toBeUndefined();
  });
});
