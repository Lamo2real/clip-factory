import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { mockApi, type MockFaults } from "../src/api/mock/index.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import type { Api, Clip, Post } from "../src/api/types.ts";
import { defaultUploadTo, needsUploadAgain, placeList, STILL_WORKING, uploadClip, uploadedMessage, uploadLabel } from "../src/lib/upload.ts";

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
  const ready = ["youtube", "tiktok", "instagram", "facebook"] as const;
  it("all ready places when nothing is saved and Where clips go has them all", () => {
    expect(defaultUploadTo([...ready], null, ["youtube", "instagram", "facebook", "tiktok", "x"])).toEqual(["youtube", "tiktok", "instagram", "facebook"]);
  });
  it("this device's last choice, minus places no longer set up", () => {
    expect(defaultUploadTo([...ready], ["x", "tiktok"], undefined)).toEqual(["tiktok"]);
  });
  it("every ready place when the saved choice and Where clips go leave nothing", () => {
    expect(defaultUploadTo(["youtube"], ["x"], ["x"])).toEqual(["youtube"]);
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
