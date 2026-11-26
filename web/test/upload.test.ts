import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { mockApi, type MockFaults } from "../src/api/mock/index.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import type { Api, Clip, Post } from "../src/api/types.ts";
import { defaultUploadTo, needsUploadAgain, placeList, STILL_WORKING, uploadClip, uploadedMessage, uploadLabel } from "../src/lib/upload.ts";
import { sentFirstLine } from "../src/lib/autopost.ts";

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

describe("needsUploadAgain", () => {
  const clip = { clipId: "c1", status: "confirmed" } as Clip;
  const post = { postId: "p1", clipId: "c1", platform: "x", status: "pending_integration" } as Post;

  it("is true only for an uploaded clip with no posts", () => {
    expect(needsUploadAgain(clip, [])).toBe(true);
    expect(needsUploadAgain(clip, [{ ...post, clipId: "other" }])).toBe(true);
    expect(needsUploadAgain(clip, [post])).toBe(false);
    expect(needsUploadAgain({ ...clip, status: "posted" }, [])).toBe(false);
    expect(needsUploadAgain({ ...clip, status: "review" }, [])).toBe(false);
  });
});

describe("uploadClip against the mock API", () => {
  it("uploads a clip in review (an old client: Where clips go decides)", async () => {
    const { store, api } = setup();
    const out = await uploadClip(api, reviewClip(store).clipId);
    expect(out.kind).toBe("uploading");
    if (out.kind === "uploading") expect(out.posts).toHaveLength(store.settings.platforms.length);
  });

  it("the seeded stuck clip has no posts and Upload again finishes it", async () => {
    const { store, api } = setup();
    const stuck = store.clips.filter((c) => needsUploadAgain(c, store.posts));
    expect(stuck).toHaveLength(1);
    const out = await uploadClip(api, stuck[0]!.clipId);
    expect(out.kind).toBe("uploading");
    if (out.kind === "uploading") expect(out.posts.map((p) => p.platform)).toEqual(store.settings.platforms);
    // A third tap is a plain "already decided" with posts: still reported as uploading, no duplicate posts.
    const again = await uploadClip(api, stuck[0]!.clipId);
    expect(again.kind).toBe("uploading");
    expect(store.posts.filter((p) => p.clipId === stuck[0]!.clipId)).toHaveLength(store.settings.platforms.length);
  });

  it("an Upload that stopped half way answers 409 for a minute, then finishes", async () => {
    const { store, faults, api } = setup({ keepStopsAfterSave: 1 });
    const c = reviewClip(store);
    await expect(api.confirmClip(c.clipId)).rejects.toMatchObject({ code: "network" });
    expect(store.clips.find((x) => x.clipId === c.clipId)?.status).toBe("confirmed");

    await expect(api.confirmClip(c.clipId)).rejects.toMatchObject({ status: 409 });
    expect(await uploadClip(api, c.clipId)).toEqual({ kind: "busy" });

    faults.resumeAfterMs = 0;
    const out = await uploadClip(api, c.clipId);
    expect(out.kind).toBe("uploading");
  });

  it("a thrown-away clip cannot be uploaded", async () => {
    const { store, api } = setup();
    const c = reviewClip(store);
    await api.declineClip(c.clipId);
    const out = await uploadClip(api, c.clipId);
    expect(out.kind).toBe("gone");
  });

  it("other failures are thrown", async () => {
    const failing = { confirmClip: () => Promise.reject(new ApiError(500, "internal", "boom")) } as unknown as Api;
    await expect(uploadClip(failing, "x")).rejects.toMatchObject({ status: 500 });
  });

  it("a 409 it cannot look into reads as still working", async () => {
    const api = {
      confirmClip: () => Promise.reject(new ApiError(409, "conflict", "no")),
      getClip: () => Promise.reject(new ApiError(0, "network", "offline")),
      listPosts: () => Promise.resolve([]),
    } as unknown as Api;
    expect(await uploadClip(api, "x")).toEqual({ kind: "busy" });
  });
});

describe("a Review Upload after auto-posting took the clip (§46.13)", () => {
  const auto = { runId: "2026-11-22T11:00:00.000Z#scheduled", at: "2026-11-22T11:00:00.000Z" };
  const posts = [{ postId: "p1", clipId: "c1", platform: "youtube", status: "queued", auto: true }] as Post[];

  it("the 200 answer (Upload on a clip a run already sent) brings back its auto clip, and the words say so", async () => {
    const api = { confirmClip: () => Promise.resolve({ clip: { clipId: "c1", status: "confirmed", auto }, posts }) } as unknown as Api;
    const out = await uploadClip(api, "c1", undefined, undefined, ["youtube"]);
    expect(out).toMatchObject({ kind: "uploading", clip: { auto } });
    if (out.kind === "uploading") expect(sentFirstLine(out.clip)).toBe("Auto-posting sent this clip first.");
  });

  it("the 409 answer reads the clip again: its auto (a Private test too) says so", async () => {
    const api = {
      confirmClip: () => Promise.reject(new ApiError(409, "conflict", "This clip has already been confirmed or declined.")),
      getClip: () => Promise.resolve({ clipId: "c1", status: "publishing", auto: { ...auto, test: "private" } }),
      listPosts: () => Promise.resolve(posts),
    } as unknown as Api;
    const out = await uploadClip(api, "c1", undefined, undefined, ["youtube"]);
    expect(out).toMatchObject({ kind: "uploading", posts });
    if (out.kind === "uploading") expect(sentFirstLine(out.clip)).toBe("Auto-posting sent this clip first, as a private test.");
  });

  it("against the mock: a run sends the clip first, then his Upload answers with it", async () => {
    sessionStorage.clear();
    const { store, api } = setup();
    for (const p of ["youtube", "instagram", "facebook"]) (window as unknown as { __cfMock: { setup: { finish(p: string): void } } }).__cfMock.setup.finish(p);
    const run = await api.autoPostRun("private");
    const c = store.clips.find((x) => x.clipId === run.clips[0]!.clipId)!;
    expect(c.auto).toBeDefined();
    const out = await uploadClip(api, c.clipId, undefined, undefined, ["youtube"]);
    expect(out.kind).toBe("uploading");
    if (out.kind === "uploading") expect(sentFirstLine(out.clip)).toBe("Auto-posting sent this clip first, as a private test.");
    // His own Upload never marks a clip auto.
    const mine = await uploadClip(api, reviewClip(store).clipId, undefined, undefined, ["youtube"]);
    if (mine.kind === "uploading") expect(sentFirstLine(mine.clip)).toBeNull();
    expect(mine.kind).toBe("uploading");
  });
});

describe("copy", () => {
  it("uses the friendly still-working sentence", () => {
    expect(STILL_WORKING).toBe("Still working on it. Try again in a minute.");
  });

  it("says where it is uploading, and when posts wait for setup", () => {
    const p = (status: Post["status"], platform: Post["platform"] = "youtube") => ({ status, platform }) as Post;
    expect(uploadedMessage([p("pending_integration")])).toMatch(/as soon as your accounts are set up/);
    expect(uploadedMessage([p("queued"), p("pending_integration")])).toBe("Uploading to YouTube!");
    expect(uploadedMessage([p("queued"), p("queued", "tiktok"), p("queued", "x"), p("queued", "facebook")])).toBe("Uploading to 4 places!");
  });

  it("names the button after the places", () => {
    expect(uploadLabel(["youtube", "tiktok", "instagram", "facebook"])).toBe("Upload to 4");
    expect(uploadLabel(["youtube"])).toBe("Upload to YouTube");
    expect(uploadLabel([])).toBe("Upload");
    expect(placeList(["facebook", "youtube", "tiktok", "instagram"])).toBe("YouTube, TikTok, Instagram and Facebook");
  });
});

describe("which places start on (§33)", () => {
  it("starts with every ready place, in order", () => {
    expect(defaultUploadTo(["facebook", "youtube", "instagram", "tiktok"])).toEqual(["youtube", "tiktok", "instagram", "facebook"]);
  });
  it("nothing ready, nothing on", () => {
    expect(defaultUploadTo([])).toEqual([]);
  });
});

describe("Upload to the chosen places (mock, like the API)", () => {
  it("posts to exactly the chosen places and stores uploadTo", async () => {
    sessionStorage.clear();
    const { store, api } = setup();
    (window as unknown as { __cfMock: { setup: { finish(p: string): void } } }).__cfMock.setup.finish("youtube");
    const c = reviewClip(store);
    const out = await uploadClip(api, c.clipId, undefined, undefined, ["youtube"]);
    expect(out.kind).toBe("uploading");
    if (out.kind !== "uploading") return;
    expect(out.posts.map((p) => p.platform)).toEqual(["youtube"]);
    expect(out.clip.uploadTo).toEqual(["youtube"]);
  });

  it("refuses a place that is not set up", async () => {
    sessionStorage.clear();
    const { store, api } = setup();
    await expect(api.confirmClip(reviewClip(store).clipId, undefined, undefined, ["x"])).rejects.toMatchObject({
      status: 400,
      message: "X is not set up yet. Turn it off, then tap Upload.",
    });
  });

  it("refuses an empty list", async () => {
    const { store, api } = setup();
    await expect(api.confirmClip(reviewClip(store).clipId, undefined, undefined, [])).rejects.toMatchObject({ status: 400 });
  });
});

describe("waiting posts go out once their place is connected (§17.6, §33.6)", () => {
  type Controls = { finish(p: string): void };
  const controls = () => (window as unknown as { __cfMock: { setup: Controls } }).__cfMock.setup;
  /** A seeded uploaded clip whose every post waits for an account. */
  const waitingClip = (store: ReturnType<typeof seed>) =>
    store.clips.find((c) => c.status === "confirmed" && store.posts.some((p) => p.clipId === c.clipId && p.status === "pending_integration"))!;
  const statusOf = (store: ReturnType<typeof seed>, clipId: string, platform: string) =>
    store.posts.find((p) => p.clipId === clipId && p.platform === platform)?.status;

  it("connecting a place sends the posts waiting for it, and leaves the others waiting", () => {
    sessionStorage.clear();
    const { store } = setup();
    const c = waitingClip(store);
    controls().finish("instagram");
    expect(statusOf(store, c.clipId, "instagram")).toBe("queued");
    expect(statusOf(store, c.clipId, "facebook")).toBe("pending_integration");
    // TikTok waits for the owner's choice of who can see it (Post now opens the sheet).
    controls().finish("tiktok");
    expect(statusOf(store, c.clipId, "tiktok")).toBe("pending_integration");
  });

  it("Post now sends a waiting place that is set up, and says so plainly when it is not", async () => {
    sessionStorage.clear();
    setup();
    controls().finish("instagram");
    // A new page: the place was connected before, so its posts are still waiting (an older clip).
    const { store, api } = setup();
    const c = waitingClip(store);
    expect(statusOf(store, c.clipId, "instagram")).toBe("pending_integration");
    const out = await api.confirmClip(c.clipId, undefined, undefined, ["instagram"]);
    expect(out.posts.find((p) => p.platform === "instagram")?.status).toBe("queued");
    expect(out.posts.find((p) => p.platform === "facebook")?.status).toBe("pending_integration");
    await expect(api.confirmClip(c.clipId, undefined, undefined, ["facebook"])).rejects.toMatchObject({
      status: 400,
      message: "Facebook is not set up yet. Turn it off, then tap Upload.",
    });
  });
});

describe("the new Upload styles (§33)", () => {
  it("set no cursor and draw no visible edge", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(import.meta.dirname, "..", "src", "styles", "screens.css"), "utf8");
    const ours = css.slice(css.indexOf("/* ---------- Review › Upload to many places (§33)"));
    expect(ours.length).toBeGreaterThan(500);
    expect(ours).not.toMatch(/cursor\s*:/);
    for (const m of ours.matchAll(/(?:^|[\s;{])(border(?:-[a-z]+)?)\s*:\s*([^;]+);/g)) {
      if (m[1] === "border-radius") continue;
      expect(m[2]!.trim()).toMatch(/^(0|none)$/);
    }
    expect(ours).not.toMatch(/outline\s*:(?!\s*none)/);
  });
});

describe("the Set up hint under the chips never names a skipped place (rule S)", () => {
  it("names every place that is not set up when nothing is skipped", async () => {
    const { missingPlaces, notReadyLine } = await import("../src/screens/review/UploadTo.tsx");
    expect(notReadyLine(["youtube", "tiktok", "instagram", "facebook"])).toBe("Set up X to upload there too.");
    expect(notReadyLine(["youtube", "tiktok"])).toBe("Set up Instagram, Facebook and X to upload there too.");
    expect(missingPlaces(["youtube", "tiktok"])).toEqual(["instagram", "facebook", "x"]);
    expect(notReadyLine(["youtube", "tiktok", "instagram", "facebook", "x"])).toBeNull();
  });

  it("leaves skipped places out, and says nothing when only skipped places are missing", async () => {
    const { missingPlaces, notReadyLine } = await import("../src/screens/review/UploadTo.tsx");
    // The owner's case: four set up and X skipped.
    expect(notReadyLine(["youtube", "tiktok", "instagram", "facebook"], ["x"])).toBeNull();
    expect(missingPlaces(["youtube", "tiktok", "instagram", "facebook"], ["x"])).toEqual([]);
    // Two missing, one skipped: only the other is named, and it is the one the hint opens.
    expect(notReadyLine(["youtube", "tiktok", "instagram"], ["x"])).toBe("Set up Facebook to upload there too.");
    expect(missingPlaces(["youtube", "tiktok", "instagram"], ["x"])).toEqual(["facebook"]);
    expect(notReadyLine(["youtube"], ["tiktok", "facebook"])).toBe("Set up Instagram and X to upload there too.");
    expect(notReadyLine(["youtube"], ["tiktok", "facebook"])).not.toMatch(/TikTok|Facebook/);
    // A stale skip of a place that is set up changes nothing: it is not missing.
    expect(notReadyLine(["youtube", "tiktok", "instagram", "facebook"], ["youtube"])).toBe("Set up X to upload there too.");
  });
});
