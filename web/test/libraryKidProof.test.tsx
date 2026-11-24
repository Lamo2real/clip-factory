// Library and This week, kid-proof: a failed numbers call leaves the clips on screen, the filter lives in the address,
// a card's pill and views tell the truth, the "Like clips that did well" tiles open their clip, and stars tapped just
// before the page closes are still saved.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import type { Api, Clip, Post, SimilarClip } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));
vi.mock("../src/lib/live.ts", () => ({
  useLiveEvents: () => undefined,
  useLivePoll: () => undefined,
  useLiveStatus: () => "live",
  onLiveSignal: () => () => undefined,
}));

const { cardPill, cardViews, filterFrom, filterHref, loadLibrary } = await import("../src/screens/library/Library.tsx");
const { SimilarClips } = await import("../src/components/SimilarClips.tsx");
const { WeekView } = await import("../src/screens/library/WeekView.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { seed } = await import("../src/api/mock/fixtures.ts");

const down = () => new ApiError(503, "internal", "Something went wrong on our side. Try again in a moment.");
const flush = (ms = 0) => act(async () => await new Promise((r) => setTimeout(r, ms)));

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  current = {};
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("loadLibrary: only the clips are needed", () => {
  const s = seed();
  const kept = s.clips.filter((c) => c.status !== "review" && c.status !== "declined");
  const withNumbers = s.posts.filter((p) => p.metrics);
  beforeEach(() => {
    current.listClips = vi.fn(async () => s.clips);
    current.listPosts = vi.fn(async () => s.posts);
    current.insights = vi.fn(async () => ({ learnings: s.learnings, posts: withNumbers }) as Awaited<ReturnType<Api["insights"]>>);
  });

  it("a failed insights call keeps every clip and its posts, and says so in the numbers part", async () => {
    current.insights = vi.fn(async () => Promise.reject(down()));
    const d = await loadLibrary();
    expect(d.clips.map((c) => c.clipId)).toEqual(kept.map((c) => c.clipId));
    expect(d.posts).toHaveLength(s.posts.length);
    expect(d.learnings).toEqual([]);
    expect(d.postsKnown).toBe(true);
    expect(d.numbersError).toBe("Something went wrong on our side. Try again in a moment.");
  });

  it("a failed post list keeps every clip, without guessing their posting never started", async () => {
    current.listPosts = vi.fn(async () => Promise.reject(down()));
    const d = await loadLibrary();
    expect(d.clips).toHaveLength(kept.length);
    expect(d.posts).toEqual([]);
    expect(d.postsKnown).toBe(false);
    expect(d.numbersError).toContain("Try again");
  });

  it("everything loaded: no numbers error; only a failed clip list is the whole page's error", async () => {
    expect((await loadLibrary()).numbersError).toBeNull();
    current.listClips = vi.fn(async () => Promise.reject(down()));
    await expect(loadLibrary()).rejects.toThrow("Something went wrong on our side.");
  });
});

describe("Library card truths", () => {
  const post = (over: Partial<Post>): Post => ({ postId: "P", clipId: "C", platform: "youtube", status: "posted", ...over });
  const m = (views: number) => ({ views, likes: 0, comments: 0, shares: 0, checkedAt: "", metricsUpdatedAt: "", extra: {} });

  it("the filter lives in the address, so Back and a reload keep it", () => {
    expect(filterFrom("?show=waiting")).toBe("waiting");
    expect(filterFrom("?show=posted")).toBe("posted");
    expect(filterFrom("")).toBe("all");
    expect(filterFrom("?show=nonsense")).toBe("all");
    for (const f of ["all", "waiting", "posted"] as const) expect(filterFrom(new URL(filterHref(f), "http://x").search)).toBe(f);
    expect(filterHref("all")).toBe("/library");
  });

  it("views follow the posts' live numbers, not the clip's older total", () => {
    const clip = { totalViews: 210_900 };
    expect(cardViews(clip, [post({ metrics: m(200_000) }), post({ metrics: m(19_300) }), post({})])).toBe(219_300);
    // Nothing measured on the posts yet: the clip's own total, else none.
    expect(cardViews(clip, [post({})])).toBe(210_900);
    expect(cardViews({}, [])).toBe(0);
  });

  it("the pill says Not started, Waiting for setup, and Uploading only while a post is on its way", () => {
    const confirmed = { status: "confirmed" as Clip["status"] };
    expect(cardPill(confirmed, [], true)).toEqual({ label: "Not started", tone: "warn" });
    expect(cardPill(confirmed, [post({ status: "pending_integration" }), post({ status: "pending_integration", platform: "x" })], false)).toEqual({
      label: "Waiting for setup",
      tone: "neutral",
    });
    // One post queued: the clip's own "Uploading".
    expect(cardPill(confirmed, [post({ status: "queued" }), post({ status: "pending_integration", platform: "x" })], false)).toBeNull();
    expect(cardPill({ status: "posted" }, [post({ status: "pending_integration" })], false)).toBeNull();
  });
});

describe("Like clips that did well", () => {
  it("each tile opens its clip, and the strip itself is not a stop for the keyboard", async () => {
    current.similarClips = vi.fn(async (): Promise<SimilarClip[]> => [
      { clipId: "01SIMILAR0000000000000000A", hook: "A rocket clears the lobby", title: "", momentType: "chaos", similarity: 0.86, performance: { views: 1200, likes: 1, comments: 0, shares: 0, posts: 1, checkedAt: "" } },
      { clipId: "01SIMILAR0000000000000000B", hook: "Backwards chase", title: "", momentType: "no_way", similarity: 0.7 },
    ]);
    act(() => root.render(<SimilarClips clipId="01THISCLIP0000000000000000" />));
    await flush();
    const links = Array.from(host.querySelectorAll<HTMLAnchorElement>(".similar__list a.similar__item"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/clips/01SIMILAR0000000000000000A", "/clips/01SIMILAR0000000000000000B"]);
    expect(links[0]!.textContent).toContain("A rocket clears the lobby");
    expect(host.querySelector(".similar__list")!.hasAttribute("tabindex")).toBe(false);
  });
});

describe("This week's stars", () => {
  it("are saved at once when the page hides or closes, not lost with the 800 ms wait", async () => {
    const { mockApi } = await import("../src/api/mock/index.ts");
    const mock = mockApi();
    (window as unknown as { __cfMockFaults: { latencyMs?: number } }).__cfMockFaults.latencyMs = 0;
    const save = vi.fn(mock.saveWeekBest.bind(mock));
    current = { ...mock, getWeek: mock.getWeek.bind(mock), saveWeekBest: save };
    act(() =>
      root.render(
        <ToastProvider>
          <WeekView week={null} />
        </ToastProvider>,
      ),
    );
    await flush(20);
    const star = host.querySelector<HTMLButtonElement>(".star-btn--card");
    expect(star).not.toBeNull();
    act(() => star!.click());
    expect(save).not.toHaveBeenCalled();
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(save).toHaveBeenCalledTimes(1);
    await flush(20);

    // Switching away (the tab goes hidden) saves the next tap at once too.
    act(() => star!.click());
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(save).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await flush(20);
  });
});
