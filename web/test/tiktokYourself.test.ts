// Posted on TikTok by the owner himself (docs/CONTRACTS.md §42): the pure helpers that stay after the manual sheet
// went (ADR-86) and the mock's rules for the routes that stay (I posted it with its link or the finder, Undo, the file).
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { mockApi, type MockFaults } from "../src/api/mock/index.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import type { Clip, PlatformSetup, Post } from "../src/api/types.ts";
import { calmCopy } from "../src/lib/metrics.ts";
import {
  canPostYourself,
  failedForPublicAccount,
  postError,
  TIKTOK_PRIVATE_ONLY,
  TIKTOK_PUBLIC_HINT,
  TIKTOK_PUBLIC_REFUSED,
  tiktokAudited,
  looksLikeTikTokLink,
  tiktokState,
  videoFileName,
} from "../src/lib/tiktokYourself.ts";

beforeAll(() => {
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
});

const clip = (status: Clip["status"], extra: Partial<Clip> = {}) => ({ clipId: "c1", status, hook: "He lost it", ...extra }) as Clip;
const post = (extra: Partial<Post>) => ({ postId: "p1", clipId: "c1", platform: "tiktok", status: "posted", ...extra }) as Post;

describe("which clips are not on TikTok yet (the Mac can take them, §47.2)", () => {
  it("no TikTok post, a waiting, failed or private one", () => {
    expect(tiktokState([])).toBe("offer");
    expect(tiktokState([post({ status: "pending_integration" })])).toBe("offer");
    expect(tiktokState([post({ status: "failed" })])).toBe("offer");
    expect(tiktokState([post({ privacy: "private" })])).toBe("offer");
  });

  it("not while uploading, when public already, and once he posted it", () => {
    expect(tiktokState([post({ status: "queued" })])).toBe("uploading");
    expect(tiktokState([post({ privacy: "public" })])).toBe("public");
    expect(tiktokState([post({ by: "you", privacy: "public" })])).toBe("yours");
  });

  it("only on uploaded clips whose posts exist", () => {
    const other = post({ platform: "youtube" });
    expect(canPostYourself(clip("posted"), [other])).toBe(true);
    expect(canPostYourself(clip("failed"), [other])).toBe(true);
    expect(canPostYourself(clip("publishing"), [other])).toBe(true);
    expect(canPostYourself(clip("confirmed"), [])).toBe(false);
    expect(canPostYourself(clip("review"), [])).toBe(false);
    expect(canPostYourself(clip("declined"), [])).toBe(false);
  });
});

describe("TikTok's approval", () => {
  const tiktok = (audit: "ok" | "limited" | "unknown", review: "ok" | "waiting" = audit === "ok" ? "ok" : "waiting") =>
    [
      {
        platform: "tiktok",
        ready: true,
        gates: [
          { key: "app_review", state: review },
          { key: "posting_audit", state: audit },
        ],
      },
    ] as unknown as PlatformSetup[];

  it("an audit gate that says ok while the app is still in review is not an approval", () => {
    expect(tiktokAudited(tiktok("ok", "waiting"))).toBe(false);
    expect(tiktokAudited(tiktok("ok", "ok"))).toBe(true);
    expect(tiktokAudited(tiktok("limited"))).toBe(false);
    expect(tiktokAudited(undefined)).toBe(false);
  });

  it("Review's hint points to Your Mac posts TikTok, never to posting it yourself", () => {
    expect(TIKTOK_PUBLIC_HINT).toBe("TikTok: turn on Your Mac posts TikTok so it posts for everyone.");
    expect(TIKTOK_PUBLIC_HINT).not.toMatch(/yourself|untick/i);
  });
});

describe("an account that is public on purpose", () => {
  const OLD = "Make your TikTok account private (Setup step 3), then press Try again.";

  it("never tells him to make it private or to post it himself, also on posts that failed before", () => {
    // The sentence stored on failed posts stays word for word: they are matched against it.
    expect(TIKTOK_PRIVATE_ONLY).toBe(
      "TikTok only takes Clip Factory's uploads on a private account until it approves the app. Tap Post it yourself to post it for everyone.",
    );
    // What he reads is today's: his Mac posts it.
    expect(postError(OLD)).toBe(TIKTOK_PUBLIC_REFUSED);
    expect(postError(TIKTOK_PRIVATE_ONLY)).toBe(TIKTOK_PUBLIC_REFUSED);
    // The server stores today's sentence since 23 Nov (platforms/errors.TIKTOK_PRIVATE_ONLY): it reads as itself.
    expect(TIKTOK_PUBLIC_REFUSED).toBe("TikTok only takes Clip Factory's own uploads on a private account for now, so your Mac posts it for everyone.");
    expect(postError(TIKTOK_PUBLIC_REFUSED)).toBe(TIKTOK_PUBLIC_REFUSED);
    expect(TIKTOK_PUBLIC_REFUSED).not.toMatch(/Make your TikTok account private|yourself|I posted it/i);
    expect(postError("Facebook said the video was too long for a Reel.")).toBe("Facebook said the video was too long for a Reel.");
  });

  it("is not offered a Try again that would fail again", () => {
    expect(failedForPublicAccount(post({ status: "failed", error: OLD }))).toBe(true);
    expect(failedForPublicAccount(post({ status: "failed", error: TIKTOK_PRIVATE_ONLY }))).toBe(true);
    expect(failedForPublicAccount(post({ status: "failed", error: TIKTOK_PUBLIC_REFUSED }))).toBe(true);
    expect(failedForPublicAccount(post({ status: "failed", error: "TikTok did not answer." }))).toBe(false);
    expect(failedForPublicAccount(post({ platform: "youtube", status: "failed", error: OLD }))).toBe(false);
  });

  it("the clip page says the same", () => {
    const row = { platform: "tiktok", status: "failed", metrics: null, error: OLD } as const;
    expect(calmCopy(row)?.text).toBe(TIKTOK_PUBLIC_REFUSED);
  });
});

describe("small words", () => {
  it("names the file after the hook", () => {
    expect(videoFileName("He lost it! 😱")).toBe("clip-factory-He-lost-it.mp4");
    expect(videoFileName("!!!")).toBe("clip-factory-clip.mp4");
  });

  it("recognises TikTok links in pasted text", () => {
    expect(looksLikeTikTokLink("https://vm.tiktok.com/ZMabc/")).toBe(true);
    expect(looksLikeTikTokLink("look www.tiktok.com/@a/video/1")).toBe(true);
    expect(looksLikeTikTokLink("https://eviltiktok.com/@a/video/1")).toBe(false);
    expect(looksLikeTikTokLink("hello")).toBe(false);
  });

  it("the clip page asks for the link of a post he made without one", () => {
    const row = { platform: "tiktok", status: "posted", metrics: null } as const;
    expect(calmCopy({ ...row, by: "you" })?.text).toBe("Posted by you. Add its TikTok link in Library to count views.");
    expect(calmCopy({ ...row, by: "you", url: "https://www.tiktok.com/@a/video/1" })?.text).toBe("Numbers are on the way. Check back in a few minutes.");
  });
});

describe("the mock follows the API", () => {
  function setup() {
    const store = seed();
    const faults: MockFaults = { keepStopsAfterSave: 0, resumeAfterMs: 60_000 };
    return { store, api: mockApi(store, faults) };
  }
  const uploaded = (store: ReturnType<typeof seed>) =>
    store.clips.find((c) => c.status === "posted" && tiktokState(store.posts.filter((p) => p.clipId === c.clipId)) === "offer")!;

  it("marks a clip posted by you, reads a link, and Undo puts it back", async () => {
    const { store, api } = setup();
    const c = uploaded(store);
    const live = store.posts.find((p) => p.clipId === c.clipId && p.platform === "tiktok");
    const before = live ? structuredClone(live) : undefined;
    const out = await api.markTikTokPosted(c.clipId, "https://www.tiktok.com/@lamo.clips/video/7710644811602169121");
    const tiktok = out.posts.find((p) => p.platform === "tiktok")!;
    expect(tiktok).toMatchObject({ status: "posted", by: "you", privacy: "public", url: "https://www.tiktok.com/@lamo.clips/video/7710644811602169121" });
    const back = await api.undoTikTokPosted(c.clipId);
    const again = back.posts.find((p) => p.platform === "tiktok");
    if (before) expect(again).toEqual(before);
    else expect(again).toBeUndefined();
  });

  it("refuses a clip in Review and a text that is not a TikTok link", async () => {
    const { store, api } = setup();
    const review = store.clips.find((c) => c.status === "review")!;
    await expect(api.markTikTokPosted(review.clipId)).rejects.toBeInstanceOf(ApiError);
    await expect(api.markTikTokPosted(uploaded(store).clipId, "hello")).rejects.toThrow("That is not a TikTok link.");
  });

  it("gives a file to save", async () => {
    const { store, api } = setup();
    const file = await api.clipFile(uploaded(store).clipId);
    expect(file.filename).toMatch(/^clip-factory-.+\.mp4$/);
    expect(file.url).toBeTruthy();
  });
});
