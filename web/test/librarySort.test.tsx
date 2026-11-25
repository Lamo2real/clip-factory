// Library › Sort by: the order lives in the address next to the filter, "Most relevant" keeps the list as it came, the
// other three order by reactions or views (ties keep the list's order), and the dropdown unfolds, folds away and returns focus.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, Post } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { cardReactions, filterFrom, filterHref, sortClips, sortFrom, SORTS } = await import("../src/screens/library/Library.tsx");
const { Dropdown } = await import("../src/components/Dropdown.tsx");

const clip = (id: string, totalViews?: number) => ({ clipId: id, totalViews }) as unknown as Clip;
const post = (clipId: string, views: number | null, likes: number | null = null, comments: number | null = null, shares: number | null = null) =>
  ({ clipId, metrics: { views, likes, comments, shares, checkedAt: "x" } }) as unknown as Post;

describe("the sort in the address", () => {
  it("reads ?sort= next to ?show= and falls back to Most relevant", () => {
    expect(sortFrom("")).toBe("relevant");
    expect(sortFrom("?sort=nonsense")).toBe("relevant");
    for (const s of ["popular", "most", "least"] as const) expect(sortFrom(`?sort=${s}`)).toBe(s);
    expect(filterFrom("?show=posted&sort=most")).toBe("posted");
  });
  it("writes the plain address for the defaults and both words otherwise", () => {
    expect(filterHref("all")).toBe("/library");
    expect(filterHref("all", "relevant")).toBe("/library");
    expect(filterHref("posted")).toBe("/library?show=posted");
    expect(filterHref("all", "most")).toBe("/library?sort=most");
    expect(filterHref("waiting", "least")).toBe("/library?show=waiting&sort=least");
    expect(SORTS.map((s) => s.value)).toEqual(["relevant", "popular", "most", "least"]);
  });
});

describe("sortClips", () => {
  const clips = [clip("a"), clip("b"), clip("c"), clip("d", 50)];
  const posts = [post("a", 100, 1), post("a", 10, 0, 5), post("b", 500, 0), post("c", 20, 30, 0, 10), post("c", null)];
  const ids = (list: Clip[]) => list.map((c) => c.clipId);
  it("keeps the list as it came for Most relevant", () => {
    expect(sortClips(clips, posts, "relevant")).toBe(clips);
  });
  it("orders by views, high to low and low to high (a clip with no numbers uses its total, else 0)", () => {
    expect(ids(sortClips(clips, posts, "most"))).toEqual(["b", "a", "d", "c"]);
    expect(ids(sortClips(clips, posts, "least"))).toEqual(["c", "d", "a", "b"]);
  });
  it("orders by likes, comments and shares for Most popular, views break ties, and nothing is changed in place", () => {
    expect(cardReactions(posts.filter((p) => p.clipId === "a"))).toBe(6);
    expect(cardReactions(posts.filter((p) => p.clipId === "c"))).toBe(40);
    expect(ids(sortClips(clips, posts, "popular"))).toEqual(["c", "a", "b", "d"]);
    expect(ids(clips)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("the sort dropdown", () => {
  let host: HTMLElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const picked: string[] = [];
  const show = (value = "relevant") =>
    act(() =>
      root.render(<Dropdown variant="sort" caption="Sort by" label="Sort clips" value={value} options={SORTS} placeholder="Most relevant" onChange={(v) => picked.push(v)} />),
    );
  const button = () => host.querySelector<HTMLButtonElement>("button.dropdown__button")!;
  const list = () => host.querySelector<HTMLElement>(".dropdown__list");
  const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it("shows a caption, the pick and a chevron, and unfolds on a tap", () => {
    show();
    expect(host.querySelector(".dropdown--sort")).not.toBeNull();
    expect(host.querySelector(".dropdown__cap")?.textContent).toBe("Sort by");
    expect(button().textContent).toContain("Most relevant");
    expect(list()).toBeNull();
    act(() => button().click());
    expect(list()?.getAttribute("data-state")).toBe("closed");
    tick(50);
    expect(list()?.getAttribute("data-state")).toBe("open");
    expect(host.querySelectorAll(".dropdown__opt")).toHaveLength(4);
  });

  it("picks one, folds away (still drawn while it does), then leaves, and focus returns to the line", () => {
    show();
    act(() => button().click());
    tick(50);
    act(() => host.querySelectorAll<HTMLElement>(".dropdown__opt")[2]!.click());
    expect(picked).toEqual(["most"]);
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(list()?.getAttribute("data-state")).toBe("closed");
    tick(400);
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("closes on Escape and marks the picked choice", () => {
    show("popular");
    act(() => button().click());
    tick(50);
    expect(host.querySelector(".dropdown__opt.is-on .dropdown__name")?.textContent).toBe("Most popular");
    act(() => void list()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    tick(400);
    expect(list()).toBeNull();
  });
});
