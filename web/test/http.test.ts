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
      json(501, { error: { code: "not_implemented", message: "Connecting accounts arrives in the next phase." } }),
    );
    const api = httpApi({ baseUrl: "https://api.test", auth: auth(["tok"]), fetcher });
    await expect(api.connectAccount("youtube")).rejects.toMatchObject({
      code: "not_implemented",
      status: 501,
      message: "Connecting accounts arrives in the next phase.",
    });
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
