// Your Mac posts TikTok (docs/CONTRACTS.md §47.2): a row's Post with my Mac and Try again send `now: true`, so the Mac
// posts that clip at once, as an Upload tap (source "upload"). Without it every call is exactly as before. The mock's
// rules mirror the API's routes/tiktok_mac.py, and the http client adds each key only when it is true.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { httpApi } from "../src/api/http.ts";
import { mockApi } from "../src/api/mock/index.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import type { TikTokMacControls } from "../src/api/mock/tiktokMac.ts";
import type { Post } from "../src/api/types.ts";
import { canSendToMac, MAC_MAY_HAVE_POSTED, MAC_WORKING } from "../src/lib/tiktokMac.ts";

beforeAll(() => {
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
});

const knobs = () => (window as unknown as { __cfMock: { mac: TikTokMacControls } }).__cfMock.mac;
const tiktokOf = (out: { posts: Post[] }) => out.posts.find((p) => p.platform === "tiktok");

async function start() {
  const store = seed();
  const api = mockApi(store);
  await api.putSettings({ tiktokMac: { on: true } });
  const sendable = store.clips.filter((x) => canSendToMac(x, store.posts.filter((p) => p.clipId === x.clipId)));
  return { store, api, sendable };
}

describe("the mock's now rules", () => {
  it("Post with my Mac (now) makes an Upload tap's post, which goes first; Send these (no now) stays the backlog", async () => {
    const { api, sendable } = await start();
    const [backlog, tapped] = sendable;
    expect(backlog && tapped).toBeTruthy();
    expect(await api.sendToMac([backlog!.clipId])).toEqual([{ clipId: backlog!.clipId, sent: true }]);
    expect(await api.sendToMac([tapped!.clipId], true)).toEqual([{ clipId: tapped!.clipId, sent: true }]);
    expect(knobs().post(backlog!.clipId)?.mac).toMatchObject({ state: "waiting", source: "sent" });
    expect(knobs().post(tapped!.clipId)?.mac).toMatchObject({ state: "waiting", source: "upload" });
    const queue = (await api.tiktokMacStatus()).queue;
    expect(queue[0]).toMatchObject({ clipId: tapped!.clipId, source: "upload" });
    expect(queue.find((j) => j.clipId === backlog!.clipId)?.source).toBe("sent");
  });

  it("now false is the same as no now", async () => {
    const { api, sendable } = await start();
    await api.sendToMac([sendable[0]!.clipId], false);
    expect(knobs().post(sendable[0]!.clipId)?.mac?.source).toBe("sent");
  });

  it("a send with now makes a waiting post an Upload tap's in place; every other refusal stays", async () => {
    const { api, sendable } = await start();
    const c = sendable[0]!;
    await api.sendToMac([c.clipId]);
    const since = knobs().post(c.clipId)!.mac!.since;
    // Without now a waiting post is still refused (Settings' Send these is unchanged).
    expect((await api.sendToMac([c.clipId]))[0]).toMatchObject({ sent: false, reason: "Your Mac already has this clip." });
    // The waiting row's own Post with my Mac (now): the same post, now an Upload tap's, first in the queue.
    expect(await api.sendToMac([c.clipId], true)).toEqual([{ clipId: c.clipId, sent: true }]);
    expect(knobs().post(c.clipId)?.mac).toEqual({ state: "waiting", since, source: "upload" });
    expect((await api.tiktokMacStatus()).queue[0]).toMatchObject({ clipId: c.clipId, source: "upload" });
    // Once the Mac has it, a send with now is refused again: Try again is its way.
    knobs().claim(c.clipId);
    expect((await api.sendToMac([c.clipId], true))[0]).toMatchObject({ sent: false, reason: "Your Mac already has this clip." });
  });

  it("now must be true or false, on send and on Try again", async () => {
    const { api, sendable } = await start();
    const c = sendable[0]!;
    const bad = api.sendToMac([c.clipId], "yes" as never);
    await expect(bad).rejects.toBeInstanceOf(ApiError);
    await expect(bad).rejects.toMatchObject({ status: 400, message: "now must be true or false." });
    expect(knobs().post(c.clipId)?.status).not.toBe("mac"); // nothing went
    await api.sendToMac([c.clipId]);
    await expect(api.retryMac(c.clipId, false, 1 as never)).rejects.toMatchObject({ status: 400, message: "now must be true or false." });
  });

  it("Try again with now turns a sent post into an Upload tap's, keeping its place", async () => {
    const { api, sendable } = await start();
    const c = sendable[0]!;
    await api.sendToMac([c.clipId]);
    const since = knobs().post(c.clipId)!.mac!.since;
    knobs().claim(c.clipId);
    knobs().stopped(c.clipId, "TikTok did not load.");
    const back = await api.retryMac(c.clipId, false, true);
    expect(tiktokOf(back)?.mac).toEqual({ state: "waiting", since, source: "upload" });
  });

  it("Try again with now lets an auto-posting run's post go while auto-posting is off: he tapped it", async () => {
    const { store, api, sendable } = await start();
    const c = sendable[0]!;
    await api.sendToMac([c.clipId]);
    const p = store.posts.find((x) => x.clipId === c.clipId && x.platform === "tiktok")!;
    p.mac = { ...p.mac!, state: "stopped", source: "auto", reason: "TikTok did not load.", stoppedAt: "2026-11-22T13:05:00.000Z" };
    expect(store.settings.autoPost?.on).toBe(false);
    // Without now it stays the run's, so it waits for auto-posting.
    const kept = await api.retryMac(c.clipId);
    expect(tiktokOf(kept)?.mac?.source).toBe("auto");
    expect(() => knobs().claim(c.clipId)).toThrow("Auto-posting is off, so this one waits.");
    p.mac = { ...p.mac!, state: "stopped", reason: "TikTok did not load." };
    const tapped = await api.retryMac(c.clipId, false, true);
    expect(tiktokOf(tapped)?.mac?.source).toBe("upload");
    expect((await api.tiktokMacStatus()).queue.map((j) => j.clipId)).toContain(c.clipId);
    expect(knobs().claim(c.clipId).state).toBe("working");
  });

  it("Try again without now leaves a waiting post as it is, with now makes it an Upload tap's, and keeps the working and pressed refusals", async () => {
    const { api, sendable } = await start();
    const c = sendable[0]!;
    await api.sendToMac([c.clipId]);
    expect(tiktokOf(await api.retryMac(c.clipId))?.mac?.source).toBe("sent");
    expect(tiktokOf(await api.retryMac(c.clipId, false, true))?.mac?.source).toBe("upload");
    knobs().claim(c.clipId);
    await expect(api.retryMac(c.clipId, false, true)).rejects.toThrow(MAC_WORKING);
    knobs().step(c.clipId, "pressing");
    knobs().stopped(c.clipId, "Timed out.");
    await expect(api.retryMac(c.clipId, false, true)).rejects.toThrow(MAC_MAY_HAVE_POSTED);
    expect(knobs().post(c.clipId)?.mac?.state).toBe("stopped");
    const back = await api.retryMac(c.clipId, true, true);
    expect(tiktokOf(back)?.mac).toEqual({ state: "waiting", since: expect.any(String), source: "upload" });
  });
});

describe("the http bodies", () => {
  function client() {
    const fetcher = vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.endsWith("/send") ? { results: [] } : { clip: {}, posts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const api = httpApi({ baseUrl: "https://api.test", auth: { accessToken: async () => "tok" }, fetcher: fetcher as unknown as typeof fetch });
    const sent = () => fetcher.mock.calls.map((c) => {
      const [url, init] = c as unknown as [string, RequestInit];
      return { url, method: init.method, body: JSON.parse(init.body as string) as unknown };
    });
    return { api, sent };
  }

  it("send adds now only when it is true", async () => {
    const { api, sent } = client();
    await api.sendToMac(["c1", "c2"]);
    await api.sendToMac(["c1"], false);
    await api.sendToMac(["c1"], true);
    expect(sent()).toEqual([
      { url: "https://api.test/v1/tiktok/mac/send", method: "POST", body: { clipIds: ["c1", "c2"] } },
      { url: "https://api.test/v1/tiktok/mac/send", method: "POST", body: { clipIds: ["c1"] } },
      { url: "https://api.test/v1/tiktok/mac/send", method: "POST", body: { clipIds: ["c1"], now: true } },
    ]);
  });

  it("Try again adds notOnTikTok and now only when each is true", async () => {
    const { api, sent } = client();
    await api.retryMac("c1");
    await api.retryMac("c1", true);
    await api.retryMac("c1", false, true);
    await api.retryMac("c1", true, true);
    const url = "https://api.test/v1/clips/c1/tiktok/mac/retry";
    expect(sent()).toEqual([
      { url, method: "POST", body: {} },
      { url, method: "POST", body: { notOnTikTok: true } },
      { url, method: "POST", body: { now: true } },
      { url, method: "POST", body: { notOnTikTok: true, now: true } },
    ]);
  });
});
