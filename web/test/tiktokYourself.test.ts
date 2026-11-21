// Post it on TikTok yourself (docs/CONTRACTS.md §42): the pure helpers and the mock's rules.
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { mockApi, type MockFaults } from "../src/api/mock/index.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import type { Clip, PlatformPerformance, PlatformSetup, Post } from "../src/api/types.ts";
import { calmCopy } from "../src/lib/metrics.ts";
import {
  canPostYourself,
  canPostYourselfHere,
  failedForPublicAccount,
  handOffFor,
  offerAfterUpload,
  postError,
  TIKTOK_PRIVATE_ONLY,
  tiktokAudited,
  looksLikeTikTokLink,
  steps,
  tiktokState,
  TIKTOK_UPLOAD_URL,
  videoFileName,
} from "../src/lib/tiktokYourself.ts";

beforeAll(() => {
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
});

const clip = (status: Clip["status"], extra: Partial<Clip> = {}) => ({ clipId: "c1", status, hook: "He lost it", ...extra }) as Clip;
const post = (extra: Partial<Post>) => ({ postId: "p1", clipId: "c1", platform: "tiktok", status: "posted", ...extra }) as Post;

describe("which way it goes", () => {
  it("phones that can share a file use the share menu, everything else saves the file", () => {
    expect(handOffFor("ios", true)).toBe("share");
    expect(handOffFor("android", true)).toBe("share");
    expect(handOffFor("ios", false)).toBe("save");
    expect(handOffFor("mac", true)).toBe("save");
    expect(handOffFor("windows", false)).toBe("save");
  });

  it("opens TikTok Studio's uploader on a computer", () => {
    expect(TIKTOK_UPLOAD_URL).toBe("https://www.tiktok.com/tiktokstudio/upload");
  });
});

describe("when Post it yourself shows", () => {
  it("shows for no TikTok post, a waiting, failed or private one", () => {
    expect(tiktokState([])).toBe("offer");
    expect(tiktokState([post({ status: "pending_integration" })])).toBe("offer");
    expect(tiktokState([post({ status: "failed" })])).toBe("offer");
    expect(tiktokState([post({ privacy: "private" })])).toBe("offer");
  });

  it("hides while uploading, when public already, and once he posted it", () => {
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

  it("on the clip page, from its TikTok row", () => {
    const row = (status: PlatformPerformance["status"], by?: "you") => ({ status, ...(by ? { by } : {}) });
    expect(canPostYourselfHere(clip("posted"), row("posted_private"))).toBe(true);
    expect(canPostYourselfHere(clip("posted"), row("not_posted"))).toBe(true);
    expect(canPostYourselfHere(clip("posted"), row("failed"))).toBe(true);
    expect(canPostYourselfHere(clip("posted"), row("posting"))).toBe(false);
    expect(canPostYourselfHere(clip("posted"), row("posted"))).toBe(false);
    expect(canPostYourselfHere(clip("posted"), row("posted", "you"))).toBe(false);
    expect(canPostYourselfHere(clip("review"), row("not_posted"))).toBe(false);
  });
});

describe("right after Upload on Review", () => {
  const tiktok = (ready: boolean, audit: "ok" | "limited" | "unknown", review: "ok" | "waiting" = audit === "ok" ? "ok" : "waiting") =>
    [
      {
        platform: "tiktok",
        ready,
        gates: [
          { key: "app_review", state: review },
          { key: "posting_audit", state: audit },
        ],
      },
    ] as unknown as PlatformSetup[];
  const yt = post({ platform: "youtube", status: "queued" });

  it("offers it when TikTok was not ticked and TikTok has not approved public uploads", () => {
    expect(offerAfterUpload([yt], tiktok(true, "limited"))).toEqual({ offer: true, open: true });
    expect(offerAfterUpload([yt], tiktok(false, "unknown"))).toEqual({ offer: true, open: false });
    expect(offerAfterUpload([yt], undefined)).toEqual({ offer: true, open: false });
    // TikTok not set up yet: its post waits, and he can post it himself meanwhile (the sheet does not open by itself).
    expect(offerAfterUpload([yt, post({ status: "pending_integration" })], tiktok(false, "unknown"))).toEqual({ offer: true, open: false });
  });

  it("not when TikTok is one of the places, nor once TikTok approved, nor with no posts", () => {
    expect(offerAfterUpload([yt, post({ status: "queued" })], tiktok(true, "limited")).offer).toBe(false);
    expect(offerAfterUpload([yt], tiktok(true, "ok")).offer).toBe(false);
    expect(offerAfterUpload([], tiktok(true, "limited")).offer).toBe(false);
  });

  it("an audit gate that says ok while the app is still in review is not an approval", () => {
    expect(tiktokAudited(tiktok(true, "ok", "waiting"))).toBe(false);
    expect(tiktokAudited(tiktok(true, "ok", "ok"))).toBe(true);
    expect(tiktokAudited(undefined)).toBe(false);
  });
});

describe("the steps", () => {
  it("name TikTok's own buttons, Everyone and the three switches", () => {
    const phone = steps("share", false).join(" ");
    expect(phone).toContain("**Save to my phone**");
    expect(phone).toContain("**Save Video**");
    expect(phone).toContain("**+**");
    expect(phone).toContain("**Paste**");
    expect(phone).toContain("**Everyone**");
    expect(phone).toMatch(/\*\*Comments\*\*, \*\*Duet\*\* and \*\*Stitch\*\*/);
    expect(phone).not.toContain("Branded content");
    const computer = steps("save", false).join(" ");
    expect(computer).toContain("**Save the video**");
    expect(computer).toMatch(/\*\*Comment\*\*, \*\*Duet\*\* and \*\*Stitch\*\*/);
  });

  it("a campaign clip turns on Branded content (under Show more on the web)", () => {
    expect(steps("share", true).join(" ")).toContain("**Disclose post content**, then **Branded content**");
    expect(steps("save", true).join(" ")).toContain("**Show more**");
  });
});

describe("an account that is public on purpose", () => {
  const OLD = "Make your TikTok account private (Setup step 3), then press Try again.";

  it("never tells him to make it private, also on posts that failed before", () => {
    expect(TIKTOK_PRIVATE_ONLY).not.toMatch(/Make your TikTok account private/);
    expect(TIKTOK_PRIVATE_ONLY).toContain("Post it yourself");
    expect(postError(OLD)).toBe(TIKTOK_PRIVATE_ONLY);
    expect(postError("Facebook said the video was too long for a Reel.")).toBe("Facebook said the video was too long for a Reel.");
  });

  it("offers Post it yourself instead of a Try again that would fail again", () => {
    expect(failedForPublicAccount(post({ status: "failed", error: OLD }))).toBe(true);
    expect(failedForPublicAccount(post({ status: "failed", error: TIKTOK_PRIVATE_ONLY }))).toBe(true);
    expect(failedForPublicAccount(post({ status: "failed", error: "TikTok did not answer." }))).toBe(false);
    expect(failedForPublicAccount(post({ platform: "youtube", status: "failed", error: OLD }))).toBe(false);
  });

  it("the clip page says the same", () => {
    const row = { platform: "tiktok", status: "failed", metrics: null, error: OLD } as const;
    expect(calmCopy(row)?.text).toBe("TikTok only takes Clip Factory's uploads on a private account until it approves the app. Go to Library and tap Post it yourself.");
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
