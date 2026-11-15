import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { mockApi, type MockFaults } from "../src/api/mock/index.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import type { Api, Clip, Post } from "../src/api/types.ts";
import { keepClip, keptMessage, needsKeepAgain, STILL_WORKING } from "../src/lib/keep.ts";

beforeAll(() => {
  // The mock answers quickly and holds still under automation.
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
});

function setup(f: Partial<MockFaults> = {}) {
  const store = seed();
  const faults: MockFaults = { keepStopsAfterSave: 0, resumeAfterMs: 60_000, ...f };
  return { store, faults, api: mockApi(store, faults) };
}

const reviewClip = (store: ReturnType<typeof seed>) => store.clips.find((c) => c.status === "review")!;

describe("needsKeepAgain", () => {
  const clip = { clipId: "c1", status: "confirmed" } as Clip;
  const post = { postId: "p1", clipId: "c1", platform: "x", status: "pending_integration" } as Post;

  it("is true only for a kept clip with no posts", () => {
    expect(needsKeepAgain(clip, [])).toBe(true);
    expect(needsKeepAgain(clip, [{ ...post, clipId: "other" }])).toBe(true);
    expect(needsKeepAgain(clip, [post])).toBe(false);
    expect(needsKeepAgain({ ...clip, status: "posted" }, [])).toBe(false);
    expect(needsKeepAgain({ ...clip, status: "review" }, [])).toBe(false);
  });
});

describe("keepClip against the mock API", () => {
  it("keeps a clip in review", async () => {
    const { store, api } = setup();
    const out = await keepClip(api, reviewClip(store).clipId);
    expect(out.kind).toBe("kept");
    if (out.kind === "kept") expect(out.posts).toHaveLength(store.settings.platforms.length);
  });

  it("the seeded stuck clip has no posts and Keep again finishes it", async () => {
    const { store, api } = setup();
    const stuck = store.clips.filter((c) => needsKeepAgain(c, store.posts));
    expect(stuck).toHaveLength(1);
    const out = await keepClip(api, stuck[0]!.clipId);
    expect(out.kind).toBe("kept");
    if (out.kind === "kept") expect(out.posts.map((p) => p.platform)).toEqual(store.settings.platforms);
    // A third tap is a plain "already decided" with posts: still reported as kept, no duplicate posts.
    const again = await keepClip(api, stuck[0]!.clipId);
    expect(again.kind).toBe("kept");
    expect(store.posts.filter((p) => p.clipId === stuck[0]!.clipId)).toHaveLength(store.settings.platforms.length);
  });

  it("a Keep that stopped half way answers 409 for a minute, then finishes", async () => {
    const { store, faults, api } = setup({ keepStopsAfterSave: 1 });
    const c = reviewClip(store);
    await expect(api.confirmClip(c.clipId)).rejects.toMatchObject({ code: "network" });
    expect(store.clips.find((x) => x.clipId === c.clipId)?.status).toBe("confirmed");

    await expect(api.confirmClip(c.clipId)).rejects.toMatchObject({ status: 409 });
    expect(await keepClip(api, c.clipId)).toEqual({ kind: "busy" });

    faults.resumeAfterMs = 0;
    const out = await keepClip(api, c.clipId);
    expect(out.kind).toBe("kept");
  });

  it("a thrown-away clip cannot be kept", async () => {
    const { store, api } = setup();
    const c = reviewClip(store);
    await api.declineClip(c.clipId);
    const out = await keepClip(api, c.clipId);
    expect(out.kind).toBe("gone");
  });

  it("other failures are thrown", async () => {
    const failing = { confirmClip: () => Promise.reject(new ApiError(500, "internal", "boom")) } as unknown as Api;
    await expect(keepClip(failing, "x")).rejects.toMatchObject({ status: 500 });
  });

  it("a 409 it cannot look into reads as still working", async () => {
    const api = {
      confirmClip: () => Promise.reject(new ApiError(409, "conflict", "no")),
      getClip: () => Promise.reject(new ApiError(0, "network", "offline")),
      listPosts: () => Promise.resolve([]),
    } as unknown as Api;
    expect(await keepClip(api, "x")).toEqual({ kind: "busy" });
  });
});

describe("copy", () => {
  it("uses the friendly still-working sentence", () => {
    expect(STILL_WORKING).toBe("Still working on it. Try again in a minute.");
  });

  it("says when posts wait for accounts", () => {
    const p = (status: Post["status"]) => ({ status }) as Post;
    expect(keptMessage([p("pending_integration")])).toMatch(/as soon as your accounts are connected/);
    expect(keptMessage([p("queued"), p("pending_integration")])).toBe("Kept! Posting to 1 platform.");
  });
});
