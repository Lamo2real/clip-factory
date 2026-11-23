import { describe, expect, it } from "vitest";
import type { PostMetrics } from "../src/api/types.ts";
import {
  STATS_ORDER,
  ago,
  calmCopy,
  compact,
  labelsFor,
  metricGroups,
  perfStatus,
  pickBest,
  reactionParts,
  until,
  watchTotal,
} from "../src/lib/metrics.ts";

const at = "2026-11-16T10:00:00Z";
const m = (over: Partial<PostMetrics> = {}): PostMetrics => ({
  views: 1000,
  likes: 50,
  comments: 4,
  shares: 3,
  checkedAt: at,
  metricsUpdatedAt: at,
  extra: {},
  ...over,
});

describe("compact numbers", () => {
  it("shortens big numbers and dashes missing ones", () => {
    expect(compact(950)).toBe("950");
    expect(compact(1234)).toBe("1.2K");
    expect(compact(48_210)).toBe("48.2K");
    expect(compact(3_400_000)).toBe("3.4M");
    expect(compact(0)).toBe("0");
    expect(compact(null)).toBe("–");
    expect(compact(undefined)).toBe("–");
  });

  it("reads watch time and waits", () => {
    expect(watchTotal(65)).toBe("1:05");
    expect(watchTotal(36 * 3600)).toBe("36 h");
    const now = Date.parse(at);
    expect(ago("2026-11-16T09:57:00Z", now)).toBe("3 min ago");
    expect(ago("2026-11-16T09:59:40Z", now)).toBe("just now");
    expect(ago("2026-11-16T07:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-11-15T09:00:00Z", now)).toBe("yesterday");
    expect(ago("2026-11-14T09:00:00Z", now)).toBe("2 days ago");
    expect(until("2026-11-16T10:04:00Z", now)).toBe("4 min");
    expect(until("2026-11-16T10:00:20Z", now)).toBe("1 min");
    expect(until("2026-11-16T11:05:00Z", now)).toBe("1 h 5 min");
    expect(until("2026-11-16T09:00:00Z", now)).toBe("");
  });
});

describe("metric rows per platform", () => {
  it("shows only what each platform gives", () => {
    expect(labelsFor("tiktok")).toEqual(["Views", "Likes", "Comments", "Shares"]);
    expect(labelsFor("tiktok")).not.toContain("Saves");
    for (const p of ["instagram", "facebook"] as const) expect(labelsFor(p)).not.toContain("Impressions");
    expect(labelsFor("youtube")).toContain("New subscribers");
    expect(labelsFor("facebook")[0]).toBe("Plays");
    expect(labelsFor("x")[0]).toBe("Video views");
    expect(labelsFor("x")).toContain("Watched to 100%");
  });

  it("leaves absent fields out instead of showing 0", () => {
    const g = metricGroups("youtube", m({ shares: null }));
    expect(g.top).toMatchObject({ label: "Views", value: "1K", raw: 1000 });
    expect(g.fast.map((r) => r.label)).toEqual(["Likes", "Comments"]);
    expect(g.slow).toEqual({ note: "Updates daily", rows: [] }); // no Analytics numbers yet: just the note

    const yt = metricGroups("youtube", m({ shares: 9, extra: { avgViewSeconds: 65, avgViewPercent: 48.6, watchMinutes: 1200 } }));
    expect(yt.slow?.note).toBe("Updates daily");
    expect(yt.slow?.rows.map((r) => [r.label, r.value])).toEqual([
      ["Watch time", "1.2K min"],
      ["Average view", "1:05"],
      ["Average % watched", "49%"],
      ["Shares", "9"],
    ]);
  });

  it("tells Instagram's slow views apart from its fast likes", () => {
    const g = metricGroups("instagram", m({ views: null, shares: null }));
    expect(g.top.value).toBe("–");
    expect(g.top.spoken).toBe("Views: not in yet");
    expect(g.fast.map((r) => r.label)).toEqual(["Likes", "Comments"]);
    const full = metricGroups("instagram", m({ extra: { reach: 700, saved: 12, skipRatePercent: 21.4 } }));
    expect(full.slow?.note).toBe("Can take 2 days");
    expect(full.slow?.rows.map((r) => r.label)).toEqual(["Reach", "Shares", "Saves", "Skip rate"]);
  });

  it("gives Facebook plays and a reactions breakdown", () => {
    const g = metricGroups("facebook", m({ comments: null, shares: null, likes: 60, extra: { replays: 10, reactions: { like: 40, love: 20, wow: 0 } } }));
    expect(g.top.label).toBe("Plays");
    expect(g.fast).toEqual([]);
    expect(g.slow?.rows.map((r) => r.label)).toEqual(["Replays", "Reactions"]);
    expect(reactionParts({ like: 40, love: 20, wow: 0 })).toEqual([
      { name: "Like", count: "40" },
      { name: "Love", count: "20" },
    ]);
  });

  it("gives X its own numbers, replies from comments", () => {
    const g = metricGroups("x", m({ extra: { impressions: 9000, playback25: 300 } }));
    expect(g.fast.map((r) => r.label)).toEqual(["Impressions", "Likes", "Reposts", "Replies", "Watched to 25%"]);
    expect(g.slow).toBeNull();
  });
});

describe("status and calm copy", () => {
  it("maps posts to stack statuses (first match wins)", () => {
    expect(perfStatus(undefined)).toBe("not_posted");
    expect(perfStatus({ status: "pending_integration" })).toBe("waiting_for_connection");
    expect(perfStatus({ status: "queued" })).toBe("posting");
    expect(perfStatus({ status: "failed" })).toBe("failed");
    expect(perfStatus({ status: "posted", privacy: "private" })).toBe("posted_private");
    expect(perfStatus({ status: "posted", privacy: "public" })).toBe("posted");
  });

  it("says one calm line per state, with the right link", () => {
    const base = { platform: "instagram" as const, metrics: null };
    expect(calmCopy({ ...base, status: "waiting_for_connection" })).toEqual({
      text: "Connect Instagram in Settings › Posting › Set up posting.",
      link: { href: "/settings/posting/setup/instagram", label: "Set up Instagram" },
    });
    expect(calmCopy({ ...base, status: "not_posted" })).toEqual({
      text: "Not posted here. Turn on Instagram in Settings › Posting › Where clips go.",
      link: { href: "/settings/posting/where", label: "Open Where clips go" },
    });
    expect(calmCopy({ ...base, status: "posting" })).toEqual({ text: "Posting now…", spinner: true });
    expect(calmCopy({ ...base, platform: "tiktok", status: "posted_private" })?.text).toBe(
      "Uploaded privately. TikTok shows numbers after the app is approved.",
    );
    expect(calmCopy({ ...base, status: "posted" })?.text).toBe("Numbers are on the way. Check back in a few minutes.");
    expect(calmCopy({ ...base, status: "posted", metrics: m() })).toBeNull();
    expect(calmCopy({ ...base, status: "failed", error: "The video was too long." })).toEqual({
      text: "The video was too long. Go to Library and tap Try again.",
      link: { href: "/library", label: "Go to Library" },
    });
  });

  it("TikTok while the Mac posts it (§47.4): what the Mac does, never Post it yourself, no Go to Library for a stop", () => {
    const tt = { platform: "tiktok" as const, metrics: null };
    const mac = (state: "waiting" | "working" | "stopped", extra = {}) => ({ state, since: at, source: "upload" as const, ...extra });
    expect(calmCopy({ ...tt, status: "mac", mac: mac("waiting") })).toEqual({ text: "Waiting for your Mac" });
    expect(calmCopy({ ...tt, status: "mac", mac: mac("working", { step: "uploading" }) })).toEqual({ text: "Posting…", spinner: true });
    // Try again is on the clip page itself: no link away.
    expect(calmCopy({ ...tt, status: "mac", mac: mac("stopped", { reason: "TikTok wants you to log in again. Then tap Try again." }) })).toEqual({
      text: "Didn't work: TikTok wants you to log in again",
    });
    // Not sure it posted (D7): the chip says that, so the line only says where to look, with or without its row.
    const pressed = mac("stopped", { pressedAt: at, reason: "Your Mac pressed Post but couldn't confirm it. Look on your TikTok: if it's there, tap It's on TikTok." });
    const notSure = { kind: "stopped" as const, words: "Not sure it posted · look on your TikTok", button: "on_tiktok" as const, again: true, noLink: true };
    expect(calmCopy({ ...tt, status: "mac", mac: pressed })).toEqual({ text: "Look on your TikTok" });
    expect(calmCopy({ ...tt, status: "mac", mac: pressed }, notSure)).toEqual({ text: "Look on your TikTok" });
    // A stuck post's row (on_tiktok) whose Mac went quiet keeps its own words (D5, review round 3, item 6); inside the
    // find window the line says from when Try again comes.
    const stuck = { ...notSure, words: "Your Mac hasn't checked in since 14:05" };
    expect(calmCopy({ ...tt, status: "mac", mac: mac("working") }, stuck)).toEqual({ text: "Your Mac hasn't checked in since 14:05" });
    const soon = { ...notSure, words: "Not sure it posted · look on your TikTok · Try again from 14:35", again: false };
    expect(calmCopy({ ...tt, status: "mac", mac: mac("working") }, soon)).toEqual({ text: "Look on your TikTok · Try again from 14:35" });
    // The page's row: its words, and its one button on the page.
    const row = { kind: "waiting" as const, words: "Waiting for your Mac · next at 14:31", button: null };
    expect(calmCopy({ ...tt, status: "mac", mac: mac("waiting") }, row)).toEqual({ text: "Waiting for your Mac · next at 14:31" });
    expect(calmCopy({ ...tt, status: "mac", mac: mac("working") }, { kind: "working", words: "Posting…", button: null, spinner: true })).toEqual({
      text: "Posting…",
      spinner: true,
    });
    const off = { kind: "not_ready" as const, words: "Your Mac posts TikTok is off", button: "turn_on" as const, href: "/settings/posting/tiktok-mac" };
    expect(calmCopy({ ...tt, status: "not_posted" }, off)).toEqual({ text: "Your Mac posts TikTok is off" });
    // A private upload keeps saying so, and why the Mac can't post it yet.
    expect(calmCopy({ ...tt, status: "posted_private" }, off)?.text).toBe(
      "Uploaded privately. TikTok shows numbers after the app is approved. Your Mac posts TikTok is off.",
    );
    // Posted by his Mac without its link: the Add link box is on the page.
    const link = { kind: "posted" as const, words: "Posted by your Mac · Everyone · add the link", button: "add_link" as const };
    expect(calmCopy({ ...tt, status: "posted", by: "you", via: "mac" }, link)).toEqual({ text: "Posted by your Mac. Add its TikTok link to count views." });
  });

  it("a TikTok post refused for the public account says the Mac posts it, never Post it yourself", () => {
    const tt = { platform: "tiktok" as const, metrics: null, status: "failed" as const };
    const STORED = "TikTok only takes Clip Factory's uploads on a private account until it approves the app. Tap Post it yourself to post it for everyone.";
    const OLD = "Make your TikTok account private (Setup step 3), then press Try again.";
    // The server's own sentence since 23 Nov (platforms/errors.TIKTOK_PRIVATE_ONLY) reads the same.
    const NOW_STORED = "TikTok only takes Clip Factory's own uploads on a private account for now, so your Mac posts it for everyone.";
    for (const error of [STORED, OLD, NOW_STORED]) {
      const calm = calmCopy({ ...tt, error });
      expect(calm).toEqual({ text: "TikTok only takes Clip Factory's own uploads on a private account for now, so your Mac posts it for everyone." });
      expect(calm?.text).not.toMatch(/yourself|Go to Library/);
    }
    // Any other TikTok failure, once TikTok approved the app (no row): Try again in Library, as before.
    expect(calmCopy({ ...tt, error: "TikTok did not answer." })).toEqual({
      text: "TikTok did not answer. Go to Library and tap Try again.",
      link: { href: "/library", label: "Go to Library" },
    });
  });

  it("crowns the most views, ties going to the earlier platform", () => {
    const posts = STATS_ORDER.map((platform) => ({ platform, metrics: null as PostMetrics | null }));
    expect(pickBest(posts)).toBeNull();
    posts[2]!.metrics = m({ views: 500 });
    posts[4]!.metrics = m({ views: 500 });
    expect(pickBest(posts)).toBe("instagram");
    posts[3]!.metrics = m({ views: 0 });
    expect(pickBest(posts)).toBe("instagram");
    posts[1]!.metrics = m({ views: 501 });
    expect(pickBest(posts)).toBe("tiktok");
  });
});
