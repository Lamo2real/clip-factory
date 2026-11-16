// Earnings (docs/CONTRACTS.md §21): the rates file, the rate in use, the per-app and per-clip estimates, and the words.
import { describe, expect, it } from "vitest";
import config from "../../config/earnings.json";
import type { ClipPerformance, Platform } from "../src/api/types.ts";
import {
  EARNINGS,
  MAX_RATE,
  MONEY_HREF,
  APP_NAME,
  clipEarnings,
  earnedLine,
  earningFor,
  formatRate,
  formatUsd,
  moneyPhrase,
  moneyWords,
  paidProgramNote,
  paidViews,
  parseRate,
  postViews,
  rateFor,
  rateRange,
  sourceDate,
  sumUsd,
  zeroReason,
} from "../src/lib/earnings.ts";
import { STATS_ORDER } from "../src/lib/metrics.ts";
import { match } from "../src/lib/router.ts";
import { perfEarnings } from "../src/screens/clip/ClipPerformance.tsx";
import { weekMoney } from "../src/screens/library/WeekView.tsx";

const ALL: Platform[] = ["youtube", "tiktok", "instagram", "facebook", "x"];

describe("config/earnings.json", () => {
  it("is the one source the web reads, for all five apps in the usual order", () => {
    expect(EARNINGS).toBe(config);
    expect(EARNINGS.order).toEqual([...STATS_ORDER]);
    expect(Object.keys(EARNINGS.platforms).sort()).toEqual([...ALL].sort());
    expect(EARNINGS.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MAX_RATE).toBe(100);
  });

  it("every app has a sane low ≤ typical ≤ high, a kid note, a unit and dated sources", () => {
    for (const p of ALL) {
      const r = EARNINGS.platforms[p];
      expect(r.lowUsdPer1000).toBeGreaterThanOrEqual(0);
      expect(r.lowUsdPer1000).toBeLessThanOrEqual(r.typicalUsdPer1000);
      expect(r.typicalUsdPer1000).toBeLessThanOrEqual(r.highUsdPer1000);
      expect(r.highUsdPer1000).toBeLessThanOrEqual(MAX_RATE);
      expect(r.kidNote.length).toBeGreaterThan(10);
      expect(r.kidRules.length).toBeGreaterThan(10);
      expect(r.kidCounts.length).toBeGreaterThan(5);
      // Kid-proof: no dashes and none of the grown-up words from the full rules.
      for (const t of [r.kidRules, r.kidCounts, r.kidNote, r.tooShortNote]) expect(t).not.toMatch(/[–—]|RPM|Module|Premium|impressions|Creator Pool/);
      expect(r.unit.length).toBeGreaterThan(3);
      expect(r.sources.length).toBeGreaterThan(0);
      for (const s of r.sources) {
        expect(s.url).toMatch(/^https:\/\//);
        expect(s.date).not.toBe("");
      }
      if (r.minClipSeconds > 0) expect(r.tooShortNote).toMatch(/only pays for videos/);
    }
  });

  it("matches the checked table: YouTube, Facebook and X start on, TikTok and Instagram off; TikTok needs 60 s", () => {
    // Order: youtube, tiktok, instagram, facebook, x. TikTok: Sweden is not eligible and clips are under 60 s;
    // Instagram: the bonus is invite-only.
    expect(ALL.map((p) => EARNINGS.platforms[p].paysPerView)).toEqual([true, false, false, true, true]);
    expect(config.$comment).toMatch(/true for YouTube, Facebook and X/);
    expect(config.$comment).toMatch(/false for TikTok/);
    expect(EARNINGS.platforms.youtube.typicalUsdPer1000).toBe(0.05);
    expect(EARNINGS.platforms.tiktok.minClipSeconds).toBe(60);
    expect(EARNINGS.platforms.tiktok.tooShortNote).toBe("TikTok only pays for videos 1 minute or longer.");
    expect(EARNINGS.platforms.tiktok.kidNote).toContain("1 minute or longer");
    expect(EARNINGS.platforms.facebook.minClipSeconds).toBe(10);
  });

  it("Settings › Money is a real page", () => {
    expect(match(MONEY_HREF)).toEqual({ name: "settings", tree: "posting", branch: "money" });
  });
});

describe("rateFor", () => {
  it("uses the usual amount and switch when nothing is set (old servers too)", () => {
    expect(rateFor("youtube")).toEqual({ rate: 0.05, yours: false, paid: true });
    expect(rateFor("tiktok", {})).toEqual({ rate: 0.7, yours: false, paid: false });
    expect(rateFor("instagram", {})).toEqual({ rate: 0.02, yours: false, paid: false });
    expect(rateFor("facebook", {})).toEqual({ rate: 0.05, yours: false, paid: true });
    expect(rateFor("x", { earningsRates: {}, earningsPaid: {} })).toEqual({ rate: 0.12, yours: false, paid: true });
  });

  it("uses the owner's own amount and switch", () => {
    expect(rateFor("youtube", { earningsRates: { youtube: 0.07 } })).toEqual({ rate: 0.07, yours: true, paid: true });
    expect(rateFor("youtube", { earningsPaid: { youtube: true } })).toEqual({ rate: 0.05, yours: false, paid: true });
    expect(rateFor("tiktok", { earningsPaid: { tiktok: true } })).toEqual({ rate: 0.7, yours: false, paid: true });
    expect(rateFor("youtube", { earningsPaid: { youtube: false } }).paid).toBe(false);
    expect(rateFor("facebook", { earningsRates: { facebook: 0 } })).toEqual({ rate: 0, yours: true, paid: true });
    expect(rateFor("x", { earningsPaid: { x: false } }).paid).toBe(false);
  });

  it("ignores a broken stored amount", () => {
    for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY, "0.5" as unknown as number])
      expect(rateFor("youtube", { earningsRates: { youtube: bad } })).toEqual({ rate: 0.05, yours: false, paid: true });
  });
});

const ON = { earningsPaid: { youtube: true, tiktok: true, instagram: true, facebook: true, x: true } };
const OFF = { earningsPaid: { youtube: false, tiktok: false, instagram: false, facebook: false, x: false } };

describe("earningFor", () => {
  it("is views / 1,000 × the rate", () => {
    const e = earningFor("youtube", 100_000, 30, ON);
    expect(e).toMatchObject({ platform: "youtube", why: "paid", reason: "", views: 100_000, rate: 0.05, yours: false, usdIfOn: null });
    expect(e.usd).toBeCloseTo(5, 10);
    expect(earningFor("facebook", 1_100_000, 30, ON).usd).toBeCloseTo(55, 10);
    expect(earningFor("x", 1234, 30, ON).usd).toBeCloseTo(0.14808, 10);
  });

  it("uses a custom rate", () => {
    expect(earningFor("youtube", 20_000, 30, { ...ON, earningsRates: { youtube: 0.5 } }).usd).toBeCloseTo(10, 10);
  });

  it("starts YouTube, Facebook and X on (a best guess) and TikTok and Instagram off: $0, a plain way to turn it on, and what it would be", () => {
    expect(earningFor("youtube", 50_000, 30).usd).toBeCloseTo(2.5, 10);
    expect(earningFor("facebook", 50_000, 30).usd).toBeCloseTo(2.5, 10);
    expect(earningFor("x", 50_000, 30).usd).toBeCloseTo(6, 10);
    for (const p of ["youtube", "facebook", "x"] as const) expect(earningFor(p, 50_000, 90)).toMatchObject({ why: "paid", reason: "" });
    const e = earningFor("instagram", 50_000, 30);
    expect(e).toMatchObject({ usd: 0, why: "off", reason: "Turn this on in Settings › Money if Instagram pays you." });
    expect(e.usdIfOn).toBeCloseTo(1, 10);
    expect(earningFor("tiktok", 50_000, 90)).toMatchObject({ usd: 0, why: "off", reason: "Turn this on in Settings › Money if TikTok pays you." });
    expect(earningFor("tiktok", 50_000, 90).usdIfOn).toBeCloseTo(35, 10);
  });

  it("an app that is on says plainly that it only counts inside its paid program, with who gets paid", () => {
    for (const p of ["youtube", "facebook", "x"] as const) {
      expect(paidProgramNote(p)).toBe(`This only counts if you are in ${APP_NAME[p]}'s paid program. ${EARNINGS.platforms[p].kidRules}`);
    }
    expect(paidProgramNote("youtube")).toContain("YouTube Partner Program");
  });

  it("gives $0 with a plain reason when the owner switched the app off", () => {
    const e = earningFor("youtube", 50_000, 30, { earningsPaid: { youtube: false } });
    expect(e).toMatchObject({ usd: 0, why: "off", reason: "YouTube does not pay you for views right now." });
    // Too short or no views: nothing to show for "if it paid you".
    expect(earningFor("tiktok", 50_000, 30).usdIfOn).toBeNull();
    expect(earningFor("youtube", null, 30).usdIfOn).toBeNull();
  });

  it("gives $0 when the clip is shorter than the app pays for (TikTok 60 s, Facebook 10 s)", () => {
    expect(earningFor("tiktok", 50_000, 59.9, ON)).toMatchObject({ usd: 0, why: "too_short", reason: "TikTok only pays for videos 1 minute or longer." });
    // Exactly 1 minute is paid, as the words say.
    expect(earningFor("tiktok", 50_000, 60, ON)).toMatchObject({ why: "paid" });
    expect(earningFor("tiktok", 50_000, 60, ON).usd).toBeCloseTo(35, 10);
    expect(earningFor("facebook", 50_000, 9, ON)).toMatchObject({ usd: 0, why: "too_short", reason: "Facebook only pays for videos 10 seconds or longer." });
    expect(earningFor("facebook", 50_000, 10, ON).why).toBe("paid");
    // No minimum: any length is paid.
    expect(earningFor("youtube", 1000, 1, ON).why).toBe("paid");
    // Length unknown: counted (the platform would have refused a too-short upload long before).
    expect(earningFor("tiktok", 1000, undefined, ON).why).toBe("paid");
  });

  it("missing views give no amount (not $0), even when the app is off or the clip too short", () => {
    for (const v of [null, undefined, Number.NaN, -5])
      expect(earningFor("youtube", v as number | null, 30, ON)).toMatchObject({ usd: null, views: null, why: "no_views" });
    expect(earningFor("youtube", 0, 30, ON)).toMatchObject({ usd: 0, why: "paid" });
    expect(earningFor("tiktok", null, 20)).toMatchObject({ usd: null, why: "off" });
    expect(earningFor("facebook", null, 5, ON)).toMatchObject({ usd: null, why: "too_short" });
  });

  it("switched off wins over too short, and both win over missing views", () => {
    expect(earningFor("tiktok", null, 20).why).toBe("off");
    expect(earningFor("tiktok", 10, 20).why).toBe("off");
    expect(earningFor("facebook", null, 5, ON).why).toBe("too_short");
  });
});

describe("paidViews: the count each app pays for", () => {
  const m = (views: number | null, extra: object) => ({ views, extra });
  it("YouTube uses engaged views, Facebook first plays, X impressions", () => {
    expect(paidViews("youtube", m(1000, { engagedViews: 600 }))).toBe(600);
    expect(paidViews("facebook", m(1000, { initialPlays: 700 }))).toBe(700);
    expect(paidViews("x", m(100, { impressions: 2700 }))).toBe(2700);
    // The YouTube guess uses engaged views when they are there.
    expect(earningFor("youtube", paidViews("youtube", m(100_000, { engagedViews: 40_000 })), 30, ON).usd).toBeCloseTo(2, 10);
  });
  it("falls back to views when the better number is missing or broken; other apps use views", () => {
    expect(paidViews("youtube", m(1000, {}))).toBe(1000);
    expect(paidViews("youtube", { views: 1000 })).toBe(1000);
    expect(paidViews("youtube", m(1000, { engagedViews: -1 }))).toBe(1000);
    expect(paidViews("facebook", m(5, { initialPlays: "7" }))).toBe(5);
    expect(paidViews("tiktok", m(800, { engagedViews: 1 }))).toBe(800);
    expect(paidViews("instagram", m(null, {}))).toBeNull();
    expect(paidViews("x", null)).toBeNull();
  });
});

describe("clipEarnings and sumUsd", () => {
  it("adds the apps the clip is on, in the usual order", () => {
    const yt = { earningsPaid: { youtube: true, x: true } };
    const c = clipEarnings({ x: 10_000, youtube: 100_000, tiktok: 80_000, instagram: null }, 30, yt);
    expect(c.platforms.map((p) => p.platform)).toEqual(["youtube", "tiktok", "instagram", "x"]);
    expect(c.usd).toBeCloseTo(5 + 0 + 1.2, 10);
    expect(c.reason).toBe("");
  });

  it("a fresh clip with no numbers anywhere is null (No money yet), not $0, whether apps are on or off", () => {
    expect(clipEarnings({}, 30).usd).toBeNull();
    expect(clipEarnings({ youtube: null }, 30).usd).toBeNull();
    const fresh = postViews(ALL.map((platform) => ({ platform, status: "posted", metrics: null })));
    expect(fresh).toEqual({ youtube: null, tiktok: null, instagram: null, facebook: null, x: null });
    const c = clipEarnings(fresh, 30);
    expect(c.usd).toBeNull();
    expect(earnedLine(c.usd)).toBe("No money yet");
    expect(c.platforms.map((p) => p.why)).toEqual(["no_views", "off", "off", "no_views", "no_views"]);
    expect(clipEarnings(fresh, 30, OFF).usd).toBeNull();
  });

  it("is $0 with one plain reason when every counted app pays nothing", () => {
    const off = clipEarnings({ tiktok: 5000, instagram: 300, youtube: null }, 90);
    expect(off.platforms.map((p) => p.why)).toEqual(["no_views", "off", "off"]);
    expect(off).toMatchObject({ usd: 0, reason: "These apps are switched off in Settings › Money." });
    const short = clipEarnings({ tiktok: 5000, facebook: 300 }, 5, ON);
    expect(short).toMatchObject({ usd: 0, reason: "This clip is too short for these apps to pay." });
    const mix = clipEarnings({ tiktok: 5000, facebook: 300 }, 30, { earningsPaid: { tiktok: true, facebook: false } });
    expect(mix).toMatchObject({ usd: 0, reason: "These apps don't pay for this clip." });
    // An app that pays but had 0 views: a real $0, no reason needed.
    expect(clipEarnings({ youtube: 0 }, 30, ON)).toMatchObject({ usd: 0, reason: "" });
    expect(zeroReason([])).toBe("");
  });

  it("sumUsd skips nulls", () => {
    expect(sumUsd([])).toBeNull();
    expect(sumUsd([null, undefined])).toBeNull();
    expect(sumUsd([null, 1.5, 0.25])).toBe(1.75);
  });

  it("postViews keeps posted public posts only", () => {
    expect(
      postViews([
        { platform: "youtube", status: "posted", metrics: { views: 10, extra: { engagedViews: 7 } } },
        { platform: "tiktok", status: "posted", privacy: "private", metrics: { views: 99 } },
        { platform: "instagram", status: "posted" },
        { platform: "facebook", status: "queued" },
        { platform: "x", status: "failed", metrics: { views: 4 } },
      ]),
    ).toEqual({ youtube: 7, instagram: null });
  });
});

describe("words", () => {
  it("formatUsd: cents to 2 decimals, thousands separators, less than 1¢, dash for nothing", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("less than 1¢");
    expect(formatUsd(0.0099)).toBe("less than 1¢");
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.014)).toBe("$0.01");
    expect(formatUsd(0.015)).toBe("$0.02");
    expect(formatUsd(0.995)).toBe("$1.00");
    expect(formatUsd(5)).toBe("$5.00");
    expect(formatUsd(1234.567)).toBe("$1,234.57");
    expect(formatUsd(1_234_567.8)).toBe("$1,234,567.80");
    expect(formatUsd(null)).toBe("–");
    expect(formatUsd(undefined)).toBe("–");
    expect(formatUsd(Number.NaN)).toBe("–");
    expect(formatUsd(-3)).toBe("$0.00");
  });

  it("rates and ranges", () => {
    expect(formatRate(0.05)).toBe("$0.05");
    expect(formatRate(1.2)).toBe("$1.20");
    expect(rateRange("youtube")).toBe("$0.02 to $0.10");
    expect(rateRange("x")).toBe("$0.02 to $0.29");
  });

  it("earnedLine and moneyPhrase: 'about' only before a real guess", () => {
    expect(earnedLine(null)).toBe("No money yet");
    expect(earnedLine(0)).toBe("Earned $0.00");
    expect(earnedLine(0.003)).toBe("Earned less than 1¢");
    expect(earnedLine(0.01)).toBe("Earned about $0.01");
    expect(earnedLine(12.5)).toBe("Earned about $12.50");
    expect(moneyPhrase("This week earned", 0.004)).toBe("This week earned less than 1¢");
    expect(moneyPhrase("This clip earned", 3.31)).toBe("This clip earned about $3.31");
    // The stack line uses the same parts.
    expect(moneyWords(0.004)).toEqual({ about: "", amount: "less than 1¢" });
    expect(moneyWords(0)).toEqual({ about: "", amount: "$0.00" });
    expect(moneyWords(0.42)).toEqual({ about: "about ", amount: "$0.42" });
  });

  it("sourceDate reads like the rest of the page", () => {
    expect(sourceDate("accessed 2026-11-16")).toBe("Checked 16 Nov 2026");
    expect(sourceDate("2026-11-09")).toBe("9 Nov 2026");
    expect(sourceDate("2026-08")).toBe("Aug 2026");
    expect(sourceDate("2026")).toBe("2026");
    for (const p of ALL) for (const src of EARNINGS.platforms[p].sources) expect(sourceDate(src.date)).not.toMatch(/^\d{4}-/);
  });

  it("every money screen uses the same short app names", () => {
    expect(APP_NAME).toEqual({ youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", x: "X" });
  });

  it("parseRate takes what people type", () => {
    expect(parseRate("0.05")).toEqual({ ok: true, value: 0.05 });
    expect(parseRate(" $0.07 ")).toEqual({ ok: true, value: 0.07 });
    expect(parseRate("0,05")).toEqual({ ok: true, value: 0.05 });
    expect(parseRate(".5")).toEqual({ ok: true, value: 0.5 });
    expect(parseRate("3.")).toEqual({ ok: true, value: 3 });
    expect(parseRate("0")).toEqual({ ok: true, value: 0 });
    expect(parseRate("100")).toEqual({ ok: true, value: 100 });
  });

  it("parseRate refuses with a plain sentence", () => {
    expect(parseRate("")).toEqual({ ok: false, message: "Type an amount, like 0.05." });
    expect(parseRate("abc")).toEqual({ ok: false, message: "Type only a number, like 0.05." });
    expect(parseRate("-1")).toEqual({ ok: false, message: "Type only a number, like 0.05." });
    expect(parseRate("1e3")).toEqual({ ok: false, message: "Type only a number, like 0.05." });
    expect(parseRate("0.055")).toEqual({ ok: false, message: "Use at most 2 numbers after the dot, like 0.05." });
    expect(parseRate("100.01")).toEqual({ ok: false, message: "That is too much. The most is 100 dollars." });
  });
});

describe("screens", () => {
  it("the clip page counts only stacks that show numbers, with the stack's own views", () => {
    const post = (platform: Platform, status: string, views: number | null) => ({
      platform,
      status,
      account: "connected",
      refreshing: false,
      final: false,
      metrics: views === undefined ? null : { views, likes: null, comments: null, shares: null, checkedAt: "", metricsUpdatedAt: "", extra: {} },
    });
    const perf = {
      clip: { clipId: "C", durationSec: 30 },
      posts: [post("youtube", "posted", 200_000), post("tiktok", "posted", 50_000), post("instagram", "posted_private", 9), post("facebook", "not_posted", 7), post("x", "posted", null)],
    } as unknown as ClipPerformance;
    const m = perfEarnings(perf, { earningsPaid: { youtube: true, x: true } });
    expect(Object.keys(m.platforms)).toEqual(["youtube", "tiktok", "x"]);
    expect(m.platforms.tiktok).toMatchObject({ usd: 0, why: "off" });
    expect(m.platforms.x).toMatchObject({ usd: null, why: "no_views" });
    expect(m.usd).toBeCloseTo(10, 10);
    expect(perfEarnings({ ...perf, posts: [] }, undefined).usd).toBeNull();
    // The usual switches: YouTube is on (200,000 × $0.05), TikTok off, X has no numbers yet.
    expect(perfEarnings(perf, undefined).usd).toBeCloseTo(10, 10);
    // Everything switched off: every counted app is $0.
    expect(perfEarnings(perf, OFF).usd).toBe(0);
  });

  it("This week: each clip's guess and the week total; the order is untouched", () => {
    const wc = (id: string, views: Partial<Record<Platform, number | null>>) => ({ clip: { clipId: id, durationSec: 30 }, views });
    const week = { clips: [wc("A", { youtube: 10_000 }), wc("B", {}), wc("C", { x: 1000, youtube: null })] } as never;
    const m = weekMoney(week, ON);
    expect([...m.byClip.keys()]).toEqual(["A", "B", "C"]);
    expect(m.byClip.get("A")!.usd).toBeCloseTo(0.5, 10);
    expect(m.byClip.get("B")).toBeNull();
    expect(m.byClip.get("C")!.usd).toBeCloseTo(0.12, 10);
    expect(m.total).toBeCloseTo(0.62, 10);
    expect(m.reason).toBe("");
    expect(weekMoney(null, undefined).total).toBeNull();
  });

  it("This week uses paidViews when the server sends them", () => {
    const week = { clips: [{ clip: { clipId: "A", durationSec: 30 }, views: { youtube: 10_000 }, paidViews: { youtube: 4000 } }] } as never;
    expect(weekMoney(week, ON).total).toBeCloseTo(0.2, 10);
  });

  it("This week: fresh clips with no numbers read No money yet, never $0.00, even with every app off", () => {
    const fresh = { clip: { clipId: "F", durationSec: 30 }, views: { youtube: null, tiktok: null, instagram: null, facebook: null, x: null } };
    for (const settings of [undefined, OFF]) {
      const m = weekMoney({ clips: [fresh] } as never, settings);
      expect(m.byClip.get("F")!.usd).toBeNull();
      expect(m.total).toBeNull();
    }
  });

  it("This week: all apps off gives $0 with the reason, per clip and for the week; the usual switches count YouTube", () => {
    const wc = (id: string, views: Partial<Record<Platform, number | null>>) => ({ clip: { clipId: id, durationSec: 30 }, views });
    const m = weekMoney({ clips: [wc("A", { youtube: 10_000 }), wc("B", { tiktok: 50, x: null })] } as never, OFF);
    expect(m.byClip.get("A")).toMatchObject({ usd: 0, reason: "These apps are switched off in Settings › Money." });
    expect(m.total).toBe(0);
    expect(m.reason).toBe("These apps are switched off in Settings › Money.");
    const usual = weekMoney({ clips: [wc("A", { youtube: 10_000 }), wc("B", { tiktok: 50, x: null })] } as never, undefined);
    expect(usual.total).toBeCloseTo(0.5, 10);
    expect(usual.byClip.get("B")).toMatchObject({ usd: 0, reason: "These apps are switched off in Settings › Money." });
  });
});
