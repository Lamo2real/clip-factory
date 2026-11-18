import { describe, expect, it, vi } from "vitest";
import type { Api, Job, WeekClip } from "../src/api/types.ts";
import { chatReducer, historyOf, initialChat, newestAnswerId } from "../src/features/help/chatState.ts";
import { deviceOf } from "../src/features/help/context.ts";
import { blocks, DODGE_COVER, DODGE_HOLD_MS, DODGE_RETURN_MS, DODGE_SETTLE_MS, DODGE_TAP, hardToTap } from "../src/features/help/dodge.ts";
import { readLive } from "../src/features/help/live.ts";
import { nameOf, ringTarget } from "../src/features/help/spotlight.ts";
import { hasUnsaved, registerUnsaved } from "../src/features/help/unsaved.ts";
import type { HelpAnswer } from "../src/features/help/types.ts";

describe("the launcher's spot (§19.8)", () => {
  // The phone circle, 56 px, above the tab bar at the right.
  const base = { top: 700, bottom: 756, left: 300, right: 356 };

  it("makes a control hard to tap only when it covers much of it or leaves no 44 px part free", () => {
    expect(blocks(base, [])).toBe(false);
    // Not touching it: never.
    expect(hardToTap(base, { top: 720, bottom: 780, left: 0, right: 200 })).toBe(false);
    expect(hardToTap(base, { top: 756, bottom: 800, left: 0, right: 400 })).toBe(false);
    // A big row link or card it rests on the edge of: most of it is still free to tap.
    expect(hardToTap(base, { top: 680, bottom: 780, left: 16, right: 374 })).toBe(false);
    expect(hardToTap(base, { top: 730, bottom: 790, left: 0, right: 400 })).toBe(false);
    // A switch or a small button under it: covered by more than 30 %.
    expect(hardToTap(base, { top: 712, bottom: 744, left: 310, right: 362 })).toBe(true);
    expect(hardToTap(base, { top: 712, bottom: 744, left: 280, right: 340 })).toBe(true);
    // A button it only nicks, but what is left beside it is under 44 px each way.
    expect(hardToTap(base, { top: 748, bottom: 792, left: 320, right: 400 })).toBe(false);
    expect(hardToTap(base, { top: 700, bottom: 744, left: 330, right: 400 })).toBe(true);
    expect(DODGE_COVER).toBe(0.3);
    expect(DODGE_TAP).toBe(44);
  });

  it("fades out sooner than it comes back, and holds each state a while", () => {
    expect(DODGE_SETTLE_MS).toBeGreaterThanOrEqual(200);
    expect(DODGE_SETTLE_MS).toBeLessThanOrEqual(400);
    expect(DODGE_RETURN_MS).toBeGreaterThanOrEqual(600);
    expect(DODGE_RETURN_MS).toBeLessThanOrEqual(800);
    expect(DODGE_HOLD_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe("spotlight names and targets", () => {
  it("puts spaces between an element's parts and prefers its name", () => {
    const li = document.createElement("li");
    li.innerHTML = '<span class="account__mark" aria-hidden="true">T</span><span><span class="account__name">TikTok</span><span>Not connected</span></span><span>Coming soon</span>';
    expect(nameOf(li)).toBe("TikTok");
    li.querySelector(".account__name")!.remove();
    expect(nameOf(li)).toBe("Not connected Coming soon");
  });

  it("rings only the heading of a very tall element", () => {
    const section = document.createElement("section");
    section.innerHTML = '<div class="apple__text"><div class="apple__head"><h2 class="apple__name">Click sound</h2></div></div>';
    section.getBoundingClientRect = () => ({ height: 1300 }) as DOMRect;
    expect(ringTarget(section, 812)).toBe(section.querySelector(".apple__head"));
    section.getBoundingClientRect = () => ({ height: 200 }) as DOMRect;
    expect(ringTarget(section, 812)).toBe(section);
  });
});

describe("device context", () => {
  it("names phones, tablets and desktops", () => {
    expect(deviceOf("ios", 390)).toBe("phone");
    expect(deviceOf("ios", 1024)).toBe("tablet");
    expect(deviceOf("mac", 1440)).toBe("desktop");
    expect(deviceOf("windows", 500)).toBe("phone");
  });
});

describe("unsaved changes", () => {
  it("asks while any screen has a change that is not saved", () => {
    let dirty = true;
    const off = registerUnsaved(() => dirty);
    expect(hasUnsaved()).toBe(true);
    dirty = false;
    expect(hasUnsaved()).toBe(false);
    dirty = true;
    off();
    expect(hasUnsaved()).toBe(false);
    const broken = registerUnsaved(() => {
      throw new Error("x");
    });
    expect(hasUnsaved()).toBe(false);
    broken();
  });
});

describe("chat state", () => {
  const answer = (live = false): HelpAnswer => ({
    known: true,
    text: live ? "You have {value}." : "Tap Keep.",
    steps: [],
    actions: [],
    sources: ["x"],
    ...(live ? { live: { metric: "review_waiting" as const, text: "You have {value}." } } : {}),
  });

  it("keeps the last four turns as history, in memory only", () => {
    let s = initialChat;
    for (let i = 0; i < 3; i++) {
      s = chatReducer(s, { type: "ask", id: i * 2 + 1, text: `q${i}` });
      s = chatReducer(s, { type: "answer", id: i * 2 + 2, answer: answer(), requestId: "r", trouble: false });
    }
    const h = historyOf(s.entries);
    expect(h).toHaveLength(4);
    expect(h[0]).toEqual({ role: "user", text: "q1" });
    expect(h[3]).toEqual({ role: "assistant", text: "Tap Keep." });
    expect(newestAnswerId(s.entries)).toBe(6);
    expect(chatReducer(s, { type: "reset" })).toEqual(initialChat);
  });

  it("marks a live answer as loading, then fills it", () => {
    let s = chatReducer(initialChat, { type: "answer", id: 1, answer: answer(true), requestId: "r", trouble: false });
    expect(s.entries[0]).toMatchObject({ live: { kind: "loading" } });
    s = chatReducer(s, { type: "live", entryId: 1, live: { kind: "failed" } });
    expect(s.entries[0]).toMatchObject({ live: { kind: "failed" } });
  });

  it("blocks Ask until a 429's wait is over", () => {
    const s = chatReducer(initialChat, { type: "notice", id: 1, tone: "busy", text: "x", until: 5000 });
    expect(s.blockedUntil).toBe(5000);
    expect(s.thinking).toBe(false);
  });
});

describe("live numbers (§19.7)", () => {
  const clip = (hook: string, views: number, posted = true): WeekClip =>
    ({ clip: { hook }, posted, totals: { views, likes: 0, comments: 0, shares: 0 }, views: {}, best: false, anchorAt: "" }) as unknown as WeekClip;
  const fakeApi = (over: Partial<Api>): Api => over as Api;

  it("reads the best clip of this week, most views first", async () => {
    const getWeek = vi.fn(async () => ({ clips: [clip("Small", 90), clip("Big win", 12_400), clip("Mid", 900, false)] }));
    const a = fakeApi({ getWeek: getWeek as unknown as Api["getWeek"] });
    const r = await readLive({ metric: "best_clip_week_views", text: "", range: "this_week" }, a, { now: new Date(2026, 10, 16, 12) });
    expect(r).toEqual({ kind: "values", values: { value: "12.4K", hook: "Big win" } });
    expect(getWeek).toHaveBeenCalledWith("2026-W47", expect.any(String), expect.any(String));
    const total = await readLive({ metric: "week_total_views", text: "" }, a);
    expect(total).toEqual({ kind: "values", values: { value: "13.4K" } });
    const count = await readLive({ metric: "week_clips", text: "" }, a);
    expect(count).toEqual({ kind: "values", values: { value: "3", posted: "2" } });
    const last = await readLive({ metric: "best_clip_week_views", text: "", range: "last_week" }, a, { now: new Date(2026, 10, 16, 12) });
    expect(last.kind).toBe("values");
    expect(getWeek).toHaveBeenLastCalledWith("2026-W46", expect.any(String), expect.any(String));
  });

  it("says so when the week has no clips", async () => {
    const a = fakeApi({ getWeek: (async () => ({ clips: [] })) as unknown as Api["getWeek"] });
    expect(await readLive({ metric: "best_clip_week_views", text: "" }, a)).toEqual({ kind: "text", text: "No clips this week yet." });
  });

  it("reads counts, jobs, skills and accounts", async () => {
    const a = fakeApi({
      me: (async () => ({ counts: { review: 5, running: 1, posted: 42 } })) as unknown as Api["me"],
      listJobs: (async () => ({ jobs: [{ status: "running", progress: 0.42, clipCount: 0 } as Job], nextCursor: null })) as Api["listJobs"],
      // Every skill is always used (§18), so all three count.
      listSkills: (async () => [{ skillId: "a" }, { skillId: "b" }, { skillId: "c" }]) as unknown as Api["listSkills"],
      listAccounts: (async () => [{ status: "connected" }, { status: "not_connected" }]) as unknown as Api["listAccounts"],
    });
    expect(await readLive({ metric: "review_waiting", text: "" }, a)).toEqual({ kind: "values", values: { value: "5" } });
    expect(await readLive({ metric: "jobs_running", text: "" }, a)).toEqual({ kind: "values", values: { value: "1" } });
    expect(await readLive({ metric: "clips_posted", text: "" }, a)).toEqual({ kind: "values", values: { value: "42" } });
    expect(await readLive({ metric: "latest_job", text: "" }, a)).toEqual({ kind: "values", values: { value: "working", progress: "42", clips: "0" } });
    expect(await readLive({ metric: "skills_on", text: "" }, a)).toEqual({ kind: "values", values: { value: "3" } });
    expect(await readLive({ metric: "accounts_connected", text: "" }, a)).toEqual({ kind: "values", values: { value: "1" } });
  });

  it("reads a clip's views only on its page, and throws when a read fails", async () => {
    const a = fakeApi({
      clipPerformance: (async () => ({ totals: { views: 3400 }, bestPlatform: "tiktok" })) as unknown as Api["clipPerformance"],
      me: async () => {
        throw new Error("offline");
      },
    });
    expect(await readLive({ metric: "clip_views", text: "" }, a)).toEqual({ kind: "skip" });
    expect(await readLive({ metric: "clip_views", text: "" }, a, { clipId: "c1" })).toEqual({ kind: "values", values: { value: "3.4K", platform: "TikTok" } });
    await expect(readLive({ metric: "review_waiting", text: "" }, a)).rejects.toThrow("offline");
  });
});
