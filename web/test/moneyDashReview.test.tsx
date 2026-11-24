// The money dashboard's review fixes (docs/CONTRACTS.md §27): a failed load for a new filter never leaves the last
// filter's numbers or clips on screen, Show more never sends another list's cursor, the sort bar never contradicts a
// list that can only be sorted by views, short histories say so, the banner names only the apps at fault, and the
// mock's clip list agrees with the server (old windows and a missing money permission count no money).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { moneyClips, type MoneyPost } from "../src/api/mock/moneySummary.ts";
import type { Api, MoneyClips, MoneySummary, Platform } from "../src/api/types.ts";
import { DEFAULT_CHOICE, type DashChoice } from "../src/lib/moneyDash.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fake: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => fake as Api }));

const { useSummary, forgetDashCache, bannerText, kpiSub } = await import("../src/screens/money/MoneyDashboard.tsx");
const { MoneyClipList, forgetClipCache } = await import("../src/screens/money/MoneyClipList.tsx");

const down = () => new ApiError(503, "internal", "Something went wrong on our side. Try again in a moment.");
const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

function summary(monthly: number): MoneySummary {
  return { platforms: ["youtube"], included: ["youtube"], excluded: [], through: "2026-11-16", throughBy: {}, historyFrom: {}, currencies: [{ monthly: { amountMicros: monthly } } as MoneySummary["currencies"][number]], revised: { days: 0, platforms: [] }, errors: [], behind: [], stale: false, asOf: "" };
}

function clipsPage(title: string, next?: string): MoneyClips {
  const clip = { clipId: title, title, firstPostedAt: "2026-10-01", views: 10, totals: [{ currency: "USD", amountMicros: 4_810_000 }], platforms: [] };
  return { period: 30, from: "2026-10-18", to: "2026-11-16", sort: "money", sortedBy: "money", clips: [clip], ...(next ? { nextCursor: next } : {}) };
}

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  for (const k of Object.keys(fake)) delete (fake as Record<string, unknown>)[k];
  forgetDashCache();
  forgetClipCache();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Probe({ apps }: { apps: Platform[] }) {
  const { data, error, fresh } = useSummary(apps, 30);
  return <p data-fresh={String(fresh)}>{error ? `error: ${error}` : data ? `monthly ${data.currencies[0]!.monthly.amountMicros}` : "loading"}</p>;
}

describe("a failed load after a filter change (review finding 2)", () => {
  it("never shows the last filter's numbers under the new chips", async () => {
    let fail = false;
    fake.getMoneySummary = vi.fn(async () => {
      if (fail) throw down();
      return summary(57_820_000);
    });
    act(() => root.render(<Probe apps={["youtube", "tiktok", "instagram", "facebook", "x"]} />));
    await flush();
    expect(host.textContent).toBe("monthly 57820000");
    fail = true;
    act(() => root.render(<Probe apps={["tiktok"]} />));
    // While TikTok loads, the old number is only shown as not fresh (the page dims it).
    expect(host.querySelector("p")!.dataset.fresh).toBe("false");
    await flush();
    expect(host.textContent).toBe("error: Something went wrong on our side. Try again in a moment.");
  });
});

describe("the clip list after a filter change (review finding 3)", () => {
  const choice = (apps: Platform[]): DashChoice => ({ ...DEFAULT_CHOICE, apps });

  it("a failed load shows the error, not the last filter's clips, and offers no Show more", async () => {
    let fail = false;
    fake.getMoneyClips = vi.fn(async () => {
      if (fail) throw down();
      return clipsPage("Old clip", "cursor-of-the-old-list");
    });
    act(() => root.render(<MoneyClipList choice={choice(["youtube"])} onSort={() => undefined} />));
    await flush();
    expect(host.textContent).toContain("Old clip");
    expect(host.textContent).toContain("Show more");
    fail = true;
    act(() => root.render(<MoneyClipList choice={choice(["tiktok"])} onSort={() => undefined} />));
    // Loading the new filter: the old list is dimmed and Show more is gone (its cursor belongs to the old list).
    expect(host.querySelector(".mclip-list.is-loading")).not.toBeNull();
    expect(host.textContent).not.toContain("Show more");
    await flush();
    expect(host.textContent).not.toContain("Old clip");
    expect(host.textContent).not.toContain("$4.81");
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Try again in a moment.");
    expect(vi.mocked(fake.getMoneyClips!).mock.calls.every(([q]) => !q.cursor)).toBe(true);
  });

  it("hides the sort bar when the list can only be sorted by views (review finding: TikTok only)", async () => {
    fake.getMoneyClips = vi.fn(async () => ({ ...clipsPage("A"), sortedBy: "views" as const, note: "TikTok doesn't share money per video. Sorted by views." }));
    act(() => root.render(<MoneyClipList choice={choice(["tiktok"])} onSort={() => undefined} />));
    await flush();
    expect(host.textContent).toContain("Sorted by views.");
    expect(host.querySelector("[aria-label='Sort clips']")).toBeNull();
  });
});

describe("short history and the banner (review findings 1 and 5)", () => {
  it("says how many days the average and the pace come from", () => {
    expect(kpiSub("daily", 10)).toBe("An average day (last 10 days)");
    expect(kpiSub("monthly", 10)).toBe("Last 30 days · only 10 days so far");
    expect(kpiSub("yearly", 1)).toBe("At this pace for a year · from 1 day so far");
    expect(kpiSub("daily", 30)).toBe("An average day (last 30 days)");
  });

  it("names only the apps whose check failed or that are behind", () => {
    expect(bannerText({ errors: [], behind: ["facebook"], stale: false, through: "2026-11-16" })).toBeNull();
    expect(bannerText({ errors: [{ platform: "facebook", text: "" }], behind: ["facebook"], stale: false, through: "2026-11-16" })).toBe("Couldn't check Facebook today.");
    expect(bannerText({ errors: [{ platform: "youtube", text: "" }], behind: ["youtube"], stale: true, through: "2026-11-10" })).toBe("Couldn't check YouTube today. Showing money up to Tue 10 Nov.");
    expect(bannerText({ errors: [], behind: ["youtube", "facebook"], stale: true, through: "2026-11-09" })).toBe("YouTube and Facebook haven't sent new money lately. Showing money up to Mon 9 Nov.");
  });
});

describe("the mock's clip list agrees with the server (review findings 4, 6, 7)", () => {
  const cards = new Map([["a", { clipId: "a", title: "A" }], ["b", { clipId: "b", title: "B" }]]);
  const base = { platforms: ["youtube"] as Platform[], period: 7 as const, sort: "money" as const };
  const yt = (clipId: string, amountMicros: number, from: string, to: string): MoneyPost => ({
    postId: `${clipId}-yt`,
    clipId,
    platform: "youtube",
    postedAt: "2026-09-01T10:00:00.000Z",
    views: 5_000,
    revenueWindows: { "7": { amountMicros, views: 2_000, from, to, currency: "USD" } },
  });

  it("an older run's window is not ranked with fresh ones", () => {
    const out = moneyClips([yt("a", 9_000_000, "2026-09-25", "2026-10-01"), yt("b", 1_000_000, "2026-11-10", "2026-11-16")], cards, base, false);
    expect([out.from, out.to]).toEqual(["2026-11-10", "2026-11-16"]);
    expect(out.clips.map((c) => c.clipId)).toEqual(["b", "a"]);
    expect(out.clips[1]!.platforms[0]!.moneyState).toBe("not_reported_yet");
    expect(out.clips[1]!.totals).toEqual([]);
  });

  it("verified Facebook alone sorts by views with a note", () => {
    const fb: MoneyPost = { postId: "f", clipId: "a", platform: "facebook", postedAt: "2026-09-01T10:00:00.000Z", views: 9 };
    const out = moneyClips([fb], cards, { ...base, platforms: ["facebook"] }, true);
    expect(out.sortedBy).toBe("views");
    expect(out.note).toBe("Facebook doesn't share money per video. Sorted by views.");
  });

  it("YouTube without the money permission counts no money", () => {
    const out = moneyClips([yt("b", 1_000_000, "2026-11-10", "2026-11-16")], cards, base, false, "needs_permission");
    expect(out.note).toBe("YouTube needs your OK first. Sorted by views.");
    expect(out.clips[0]!.platforms[0]!.moneyState).toBe("needs_permission");
    expect(out.clips[0]!.totals).toEqual([]);
  });
});
