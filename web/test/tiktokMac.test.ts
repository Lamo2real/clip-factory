// Your Mac posts it on TikTok (docs/CONTRACTS.md §47): the TikTok row (§47.4: only what the Mac is doing, with at most
// one button, ADR-85), the helpers and the mock's rules.
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { mockApi } from "../src/api/mock/index.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import type { TikTokMacControls } from "../src/api/mock/tiktokMac.ts";
import type { Clip, MacHelper, PlatformPerformance, Post, PostMac } from "../src/api/types.ts";
import { calmCopy, perfStatus, postStatusLabel } from "../src/lib/metrics.ts";
import { perfFromPost } from "../src/lib/liveCache.ts";
import {
  canSendToMac,
  clockWords,
  helperLine,
  lastLiveRunAt,
  loginLine,
  loginRequestLine,
  MAC_MAY_HAVE_POSTED,
  MAC_NOT_POSTING,
  MAC_OFF_LINE,
  MAC_ON_TIKTOK_BUTTON,
  MAC_OPEN_BUTTON,
  MAC_PRESSED_REASON,
  MAC_STALE_MS,
  MAC_UNDO_REFUSED,
  MAC_UNKNOWN_SETTING,
  MAC_WORKING,
  macChip,
  macInsteadOk,
  macOn,
  macWaitWords,
  postsFromStacks,
  rowNeedsMac,
  rowNeedsRuns,
  sendableLine,
  sendLots,
  shortReason,
  tiktokFacts,
  tiktokFactsFromStacks,
  tiktokRow,
  waitingLine,
  whenLine,
  type TikTokRowContext,
} from "../src/lib/tiktokMac.ts";
import { canPostYourself, tiktokState, TIKTOK_PRIVATE_ONLY } from "../src/lib/tiktokYourself.ts";
import { timeWords } from "../src/lib/autopost.ts";

beforeAll(() => {
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
});

const NOW = Date.parse("2026-11-22T14:30:00.000Z");
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();
/** The owner's own clock time, as the rows say it. */
const hm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const mac = (extra: Partial<PostMac> = {}): PostMac => ({ state: "waiting", since: "2026-11-22T14:00:00.000Z", source: "upload", ...extra });
const macPost = (extra: Partial<PostMac> = {}): Post => ({ postId: "p1", clipId: "c1", platform: "tiktok", status: "mac", mac: mac(extra) });
const helper = (seenAt: string, extra: Partial<MacHelper> = {}): MacHelper => ({ seenAt, state: "ok", ...extra });
const clip = (status: Clip["status"], extra: Partial<Clip> = {}) => ({ clipId: "c1", status, hook: "He lost it", ...extra }) as Clip;
const youtube: Post = { postId: "p0", clipId: "c1", platform: "youtube", status: "posted" };
const tiktok = (extra: Partial<Post>): Post => ({ postId: "p1", clipId: "c1", platform: "tiktok", status: "posted", ...extra });
/** The Mac is on and checked in a minute ago; auto-posting is on. */
const ready = (extra: Partial<TikTokRowContext> = {}): TikTokRowContext => ({
  audited: false,
  macOn: true,
  helper: helper(iso(NOW - MIN)),
  autoPostOn: true,
  now: NOW,
  ...extra,
});
const rowOf = (posts: Post[], ctx: TikTokRowContext, c: Clip = clip("posted")) => tiktokRow(tiktokFacts(c, [youtube, ...posts]), ctx);

describe("the TikTok row (§47.4)", () => {
  it("posted by the Mac: Everyone with Open, or Add link without its link", () => {
    const url = "https://www.tiktok.com/@lamo.clips/video/1";
    expect(rowOf([tiktok({ by: "you", via: "mac", privacy: "public", url })], ready())).toEqual({ kind: "posted", words: "Posted by your Mac · Everyone", button: null, url });
    expect(rowOf([tiktok({ by: "you", via: "mac", privacy: "private", url })], ready())?.words).toBe("Posted by your Mac · Only you");
    const at = "2026-11-22T14:10:00.000Z";
    expect(rowOf([tiktok({ by: "you", via: "mac", privacy: "public", postedAt: at })], ready())).toEqual({
      kind: "posted",
      words: "Posted by your Mac · Everyone · add the link",
      button: "add_link",
      since: at,
    });
  });

  it("posted by him (from before the Mac): only Add link, even once TikTok approved the app", () => {
    expect(rowOf([tiktok({ by: "you", privacy: "public" })], ready({ audited: true }))).toEqual({
      kind: "posted_you",
      words: "Posted by you · Everyone · add the link",
      button: "add_link",
    });
    expect(rowOf([tiktok({ by: "you", privacy: "public", url: "https://vm.tiktok.com/x/" })], ready())?.button).toBeNull();
  });

  it("Posting… while the Mac works and can post, with no button", () => {
    const working = { kind: "working", words: "Posting…", button: null, spinner: true };
    expect(rowOf([macPost({ state: "working", step: "uploading" })], ready())).toEqual(working);
    // Not known yet (the session or the check-in still loading): Posting… too.
    expect(rowOf([macPost({ state: "working" })], ready({ macOn: undefined, helper: undefined }))).toEqual(working);
  });

  it("a post left working never spins for good: the switch off, a Mac asleep or crashed, or one that needs him says so", () => {
    const working = [macPost({ state: "working", step: "uploading", claimedAt: iso(NOW - 40 * MIN) })];
    const settings = "/settings/posting/tiktok-mac";
    // The switch turned off mid-post: the server leaves it working until a Mac takes it again.
    expect(rowOf(working, ready({ macOn: false }))).toEqual({ kind: "not_ready", words: "Your Mac posts TikTok is off", button: "turn_on", href: settings });
    // The Mac asleep or crashed: not seen for 30 minutes.
    const old = NOW - MAC_STALE_MS;
    expect(rowOf(working, ready({ helper: helper(iso(old)) }))).toEqual({
      kind: "not_ready",
      words: `Your Mac hasn't checked in since ${hm(old)}`,
      button: "turn_on",
      href: settings,
    });
    expect(rowOf(working, ready({ helper: null }))?.button).toBe("turn_on");
    // It needs him, or it is paused on the Mac: what to do, and Open Your Mac posts TikTok.
    const needs = ready({ helper: helper(iso(NOW - MIN), { state: "needs_you", reason: "TikTok wants a code. Type it." }) });
    expect(rowOf(working, needs)).toEqual({ kind: "not_ready", words: "Your Mac needs you: TikTok wants a code · look at your Mac", button: "open_mac", href: settings });
    expect(rowOf(working, ready({ helper: helper(iso(NOW - MIN), { state: "paused" }) }))?.button).toBe("open_mac");
    for (const ctx of [ready({ macOn: false }), ready({ helper: helper(iso(old)) }), needs]) expect(rowOf(working, ctx)?.spinner).toBeUndefined();
  });

  it("waiting for an Upload tap: only the Mac's next check-in, never a time it doesn't know", () => {
    const upload = { kind: "waiting", words: "Waiting for your Mac · next check-in in about a minute", button: null };
    expect(rowOf([macPost()], ready())).toEqual(upload);
    expect(rowOf([macPost()], ready({ helper: helper(iso(NOW - 5 * MIN)) }))).toEqual(upload);
    // Every waiting Upload clip says the same: the Mac takes them one at a time, so none says a minute of its own.
    expect(rowOf([macPost()], ready())?.words).not.toMatch(/\d\d:\d\d/);
    // The Mac's check-in not read yet: no check-in words.
    expect(rowOf([macPost()], ready({ helper: undefined }))?.words).toBe("Waiting for your Mac");
    expect(macWaitWords({ source: "upload" }, ready({ helper: undefined }))).toBe("Waiting for your Mac");
  });

  it("waiting from the backlog: after the next auto-posting run, with its time; never a guessed minute", () => {
    const sent = macPost({ source: "sent" });
    const next = NOW + 5 * 3_600_000;
    const words = `Waiting for your Mac · goes after the next auto-posting run (${hm(next)})`;
    expect(rowOf([sent], ready({ nextRunAt: iso(next) }))).toEqual({ kind: "waiting", words, button: null });
    // The last run doesn't move it: the helper paces the backlog itself (one per run, or the backfill's pace).
    expect(rowOf([sent], ready({ nextRunAt: iso(next), lastRunAt: iso(NOW - 10 * MIN) }))?.words).toBe(words);
    // Another day: its weekday.
    const later = NOW + 30 * 3_600_000;
    expect(macWaitWords({ source: "sent" }, ready({ nextRunAt: iso(later) }))).toBe(`Waiting for your Mac · goes after the next auto-posting run (${timeWords(later, NOW)})`);
    // Runs not read, or auto-posting not known yet: no time.
    expect(rowOf([sent], ready())?.words).toBe("Waiting for your Mac");
    expect(rowOf([sent], ready({ nextRunAt: iso(next), autoPostOn: undefined }))?.words).toBe("Waiting for your Mac");
  });

  it("waiting from an auto-posting run: no time (the Mac may hold it, which the web can't see)", () => {
    expect(rowOf([macPost({ source: "auto" })], ready({ nextRunAt: iso(NOW + 3_600_000) }))).toEqual({ kind: "waiting", words: "Waiting for your Mac", button: null });
  });

  it("waiting while auto-posting is off: a backlog or auto-posting clip says so, with Post with my Mac for this one", () => {
    const off = { kind: "waiting", words: "Waiting for your Mac · auto-posting is off", button: "post_with_mac" };
    expect(rowOf([macPost({ source: "sent" })], ready({ autoPostOn: false }))).toEqual(off);
    expect(rowOf([macPost({ source: "auto" })], ready({ autoPostOn: false }))).toEqual(off);
    // An Upload tap's clip goes anyway.
    expect(rowOf([macPost()], ready({ autoPostOn: false }))?.button).toBeNull();
    // The Mac can't post: that comes first.
    expect(rowOf([macPost({ source: "sent" })], ready({ autoPostOn: false, macOn: false }))?.button).toBe("turn_on");
  });

  it("Didn't work: the reason's first sentence, and one Try again", () => {
    expect(rowOf([macPost({ state: "stopped", reason: "TikTok wants you to log in again. Then tap Try again." })], ready())).toEqual({
      kind: "stopped",
      words: "Didn't work: TikTok wants you to log in again",
      button: "try_again",
    });
    expect(rowOf([macPost({ state: "stopped" })], ready())?.words).toBe("Didn't work");
    // The helper's older reasons never tell him to post it himself.
    expect(rowOf([macPost({ state: "stopped", reason: "TikTok couldn't take the video, or post it yourself." })], ready())?.words).toBe(
      "Didn't work: TikTok couldn't take the video",
    );
    // A stop that needs him keeps its Try again (it is what turns "needs you" back to ok), after he looks at his Mac.
    const needs = ready({ helper: helper(iso(NOW - MIN), { state: "needs_you", reason: "TikTok wants a code." }) });
    expect(rowOf([macPost({ state: "stopped", reason: "TikTok wants a code. Type it on your Mac." })], needs)).toEqual({
      kind: "stopped",
      words: "Didn't work: TikTok wants a code · look at your Mac first",
      button: "try_again",
    });
  });

  it("Didn't work after the Mac pressed Post: It's on TikTok first, Try again second, so it never posts twice", () => {
    const claimedAt = "2026-11-22T14:02:00.000Z";
    const pressedAt = "2026-11-22T14:05:00.000Z";
    const pressed = { kind: "stopped", words: "Didn't work: your Mac couldn't tell if it posted · look on your TikTok first", button: "on_tiktok", since: "2026-11-22T14:01:00.000Z" };
    // The stored reason stays word for word (posts already have it saved, and the API writes it); the row never shows it.
    expect(MAC_PRESSED_REASON).toBe("Your Mac pressed Post but couldn't confirm it. Check your TikTok: if it's there, tap I posted it.");
    // His own words, chosen by pressedAt, never the stored reason's; the finder looks from a minute before the claim.
    expect(rowOf([macPost({ state: "stopped", claimedAt, pressedAt, reason: MAC_PRESSED_REASON })], ready())).toEqual(pressed);
    expect(rowOf([macPost({ state: "stopped", claimedAt, pressedAt, reason: MAC_PRESSED_REASON })], ready())?.words).not.toMatch(/I posted it|yourself/);
    // No claim time: from a minute before Post was pressed.
    expect(rowOf([macPost({ state: "stopped", pressedAt })], ready())?.since).toBe("2026-11-22T14:04:00.000Z");
    // Saying it's on TikTok needs no Mac: the same row while the Mac can't post.
    for (const ctx of [ready({ macOn: false }), ready({ helper: null }), ready({ helper: helper(iso(NOW - MAC_STALE_MS)) })])
      expect(rowOf([macPost({ state: "stopped", claimedAt, pressedAt })], ctx)).toEqual(pressed);
  });

  it("not on TikTok yet: one Post with my Mac, for every clip the Mac can take", () => {
    const offer = { kind: "offer", words: "Not on TikTok yet", button: "post_with_mac" };
    expect(rowOf([], ready())).toEqual(offer);
    expect(rowOf([tiktok({ status: "pending_integration" })], ready())).toEqual(offer);
    expect(rowOf([tiktok({ status: "failed", error: "TikTok did not answer." })], ready())).toEqual(offer);
    expect(rowOf([tiktok({ status: "failed", error: TIKTOK_PRIVATE_ONLY })], ready())).toEqual(offer);
    // Uploaded Only me (from before the account was public): it says so.
    expect(rowOf([tiktok({ privacy: "private" })], ready())).toEqual({ ...offer, words: "Only you can see it on TikTok" });
    // Not a clip in Review, nor one Clip Factory is uploading or posted for everyone.
    expect(tiktokRow(tiktokFacts(clip("review"), []), ready())).toBeNull();
    expect(rowOf([tiktok({ status: "queued" })], ready())).toBeNull();
    expect(rowOf([tiktok({ privacy: "public" })], ready())).toBeNull();
  });

  it("a campaign clip is posted in the TikTok app (Add link), a Private test stays off TikTok", () => {
    expect(rowOf([], ready(), clip("posted", { campaignId: "camp-1" }))).toEqual({
      kind: "campaign",
      words: "Campaign clip: post it in the TikTok app",
      button: "add_link",
    });
    expect(rowOf([], ready(), clip("posted", { auto: { runId: "r", at: "t", test: "private" } }))).toEqual({
      kind: "private_test",
      words: "Private test · stays off TikTok",
      button: null,
    });
  });

  it("the Mac can't post: switch off, never set up, or not seen for 30 minutes, each with Turn on", () => {
    const turnOn = (words: string) => ({ kind: "not_ready", words, button: "turn_on", href: "/settings/posting/tiktok-mac" });
    for (const posts of [[], [macPost()], [macPost({ state: "working" })], [macPost({ state: "stopped", reason: "Timed out." })]]) {
      expect(rowOf(posts, ready({ macOn: false }))).toEqual(turnOn("Your Mac posts TikTok is off"));
      expect(rowOf(posts, ready({ helper: null }))).toEqual(turnOn("Your Mac isn't set up yet"));
      const old = NOW - MAC_STALE_MS;
      expect(rowOf(posts, ready({ helper: helper(iso(old)) }))).toEqual(turnOn(`Your Mac hasn't checked in since ${hm(old)}`));
    }
    expect(MAC_STALE_MS).toBe(30 * MIN);
    // 29 minutes is not stale yet.
    expect(rowOf([macPost()], ready({ helper: helper(iso(NOW - 29 * MIN)) }))?.kind).toBe("waiting");
    // Not known yet (the session or the check-in still loading): no Turn on.
    expect(rowOf([], ready({ macOn: undefined, helper: undefined }))?.kind).toBe("offer");
    // Needs him, or paused on the Mac: what to do, with Open Your Mac posts TikTok (its status line says the rest).
    const open = (words: string) => ({ kind: "not_ready", words, button: "open_mac", href: "/settings/posting/tiktok-mac" });
    const needs = ready({ helper: helper(iso(NOW - MIN), { state: "needs_you", reason: "TikTok wants a code. Type it." }) });
    for (const posts of [[], [macPost()], [macPost({ source: "sent" })]])
      expect(rowOf(posts, needs)).toEqual(open("Your Mac needs you: TikTok wants a code · look at your Mac"));
    expect(rowOf([], ready({ helper: helper(iso(NOW - MIN), { state: "needs_you" }) }))).toEqual(open("Your Mac needs you · look at your Mac"));
    const paused = ready({ helper: helper(iso(NOW - MIN), { state: "paused", reason: "Paused on your Mac." }) });
    for (const posts of [[], [macPost()]]) expect(rowOf(posts, paused)).toEqual(open("Your Mac is paused · start it again on your Mac"));
    expect(MAC_OPEN_BUTTON).toBe("Open Your Mac posts TikTok");
    expect(MAC_ON_TIKTOK_BUTTON).toBe("It's on TikTok");
  });

  it("once TikTok approved the app, a clip not on TikTok keeps its old rows; a Mac post still says what the Mac does", () => {
    expect(rowOf([], ready({ audited: true }))).toBeNull();
    expect(rowOf([tiktok({ status: "failed", error: "TikTok did not answer." })], ready({ audited: true }))).toBeNull();
    expect(rowOf([macPost({ state: "stopped", reason: "Timed out." })], ready({ audited: true }))?.button).toBe("try_again");
  });

  it("the clip page reads the same row from its stacks", () => {
    const stack = (platform: PlatformPerformance["platform"], status: PlatformPerformance["status"], extra: Partial<PlatformPerformance> = {}) =>
      ({ platform, status, account: "connected", metrics: null, refreshing: false, final: false, ...extra }) as PlatformPerformance;
    const stacks = [stack("youtube", "posted"), stack("tiktok", "not_posted"), stack("instagram", "waiting_for_connection")];
    expect(postsFromStacks(clip("posted"), stacks).map((p) => [p.platform, p.status])).toEqual([
      ["youtube", "posted"],
      ["instagram", "pending_integration"],
    ]);
    expect(tiktokRow(tiktokFactsFromStacks(clip("posted"), stacks), ready())?.kind).toBe("offer");
    const priv = [stack("youtube", "posted"), stack("tiktok", "posted_private")];
    expect(tiktokRow(tiktokFactsFromStacks(clip("posted"), priv), ready())?.words).toBe("Only you can see it on TikTok");
    const stopped = [stack("tiktok", "mac", { mac: mac({ state: "stopped", reason: "Timed out." }) })];
    expect(tiktokRow(tiktokFactsFromStacks(clip("confirmed"), stopped), ready())?.words).toBe("Didn't work: Timed out");
    const mine = [stack("tiktok", "posted", { by: "you", via: "mac", url: "https://vm.tiktok.com/x/" })];
    expect(tiktokRow(tiktokFactsFromStacks(clip("posted"), mine), ready())?.kind).toBe("posted");
  });

  it("which rows read the Mac's check-in and auto-posting's runs", () => {
    expect(rowNeedsMac(tiktokFacts(clip("posted"), [youtube]))).toBe(true);
    expect(rowNeedsMac(tiktokFacts(clip("posted"), [youtube, macPost()]))).toBe(true);
    expect(rowNeedsMac(tiktokFacts(clip("posted", { campaignId: "c" }), [youtube]))).toBe(false);
    expect(rowNeedsMac(tiktokFacts(clip("posted"), [youtube, tiktok({ privacy: "public" })]))).toBe(false);
    expect(rowNeedsRuns(tiktokFacts(clip("posted"), [macPost({ source: "sent" })]), true)).toBe(true);
    expect(rowNeedsRuns(tiktokFacts(clip("posted"), [macPost({ source: "sent" })]), false)).toBe(false);
    expect(rowNeedsRuns(tiktokFacts(clip("posted"), [macPost()]), true)).toBe(false);
    const run = (at: string, kind: string, mode: string) => ({ at, kind, mode });
    expect(lastLiveRunAt([run("b", "private_now", "private"), run("a", "scheduled", "live")])).toBe("a");
    expect(lastLiveRunAt([])).toBeNull();
  });

  it("small words: the reason's first sentence, today's times without the day", () => {
    expect(shortReason("TikTok wants you to log in again.")).toBe("TikTok wants you to log in again");
    expect(shortReason("Your Mac's helper ran into a problem three times. Post it yourself for now.")).toBe("Your Mac's helper ran into a problem three times");
    // Never "post it yourself" (ADR-85), wherever the helper put it in the first sentence.
    expect(shortReason("TikTok's upload page looks different; post it yourself for now.")).toBe("TikTok's upload page looks different");
    expect(shortReason("Post it yourself for now.")).toBe("");
    expect(shortReason("Check it, then post it yourself.")).toBe("Check it");
    expect(shortReason("TikTok said \"Something went wrong\". Try again later, or post it yourself.")).toBe('TikTok said "Something went wrong"');
    expect(shortReason(undefined)).toBe("");
    expect(clockWords(NOW + 5 * MIN, NOW)).toBe(hm(NOW + 5 * MIN));
    const tomorrow = NOW + 24 * 3_600_000;
    expect(clockWords(tomorrow, NOW)).toBe(timeWords(tomorrow, NOW));
  });

  it("the clip page's stack says the same, and its chip the state", () => {
    expect(perfStatus({ status: "mac" })).toBe("mac");
    expect(postStatusLabel({ status: "mac" })).toBe("Waiting for your Mac");
    const stack = { platform: "tiktok", status: "mac", metrics: null } as Pick<PlatformPerformance, "platform" | "status" | "metrics">;
    expect(calmCopy({ ...stack, mac: mac({ state: "working", step: "settings" }) })).toEqual({ text: "Posting…", spinner: true });
    expect(calmCopy({ ...stack, mac: mac({ state: "stopped", reason: "A puzzle showed." }) })).toEqual({ text: "Didn't work: A puzzle showed" });
    expect(macChip({ state: "waiting" })).toBe("Waiting for your Mac");
    expect(macChip({ state: "working" })).toBe("Posting…");
    expect(macChip({ state: "stopped" })).toBe("Didn't work");
  });

  it("a live post brings its Mac state to the clip page, and drops it once posted", () => {
    const prev = { platform: "tiktok", status: "mac", account: "connected", metrics: null, refreshing: false, final: false, mac: mac() } as PlatformPerformance;
    expect(perfFromPost(macPost({ state: "working", step: "pressing" }), prev)).toMatchObject({ status: "mac", mac: { state: "working", step: "pressing" } });
    const done = perfFromPost({ postId: "p1", clipId: "c1", platform: "tiktok", status: "posted", by: "you", via: "mac", privacy: "public" }, prev);
    expect(done).toMatchObject({ status: "posted", by: "you", via: "mac" });
    expect(done.mac).toBeUndefined();
  });
});

describe("who may go to the Mac", () => {
  it("a Mac post is the Mac's: not offered again; it is taken back only while waiting or stopped before Post", () => {
    expect(tiktokState([macPost()])).toBe("mac");
    expect(canPostYourself(clip("posted"), [youtube, macPost()])).toBe(false);
    expect(macInsteadOk({ state: "waiting" })).toBe(true);
    expect(macInsteadOk({ state: "stopped" })).toBe(true);
    expect(macInsteadOk({ state: "working" })).toBe(false);
    expect(macInsteadOk({ state: "stopped", pressedAt: "2026-11-22T14:10:00.000Z" })).toBe(false);
    // Posted by his Mac: his own post (by: "you").
    expect(tiktokState([{ ...youtube, platform: "tiktok", by: "you", via: "mac", privacy: "public" }])).toBe("yours");
  });

  it("Send these to my Mac and Post with my Mac take clips not on TikTok yet, never a campaign clip or a Private test", () => {
    expect(canSendToMac(clip("posted"), [youtube])).toBe(true);
    expect(canSendToMac(clip("posted", { campaignId: "camp" }), [youtube])).toBe(false);
    expect(canSendToMac(clip("posted", { auto: { runId: "r", at: "t", test: "private" } }), [youtube])).toBe(false);
    expect(canSendToMac(clip("posted"), [youtube, macPost()])).toBe(false);
    expect(canSendToMac(clip("review"), [])).toBe(false);
  });
});

describe("Settings' lines", () => {
  it("the switch, the Mac's check-in, what waits and what can go", () => {
    expect(macOn(undefined)).toBe(false);
    expect(macOn({ tiktokMac: { on: true } })).toBe(true);
    expect(helperLine(null)).toBe("Your Mac hasn't checked in yet. Set it up on your Mac.");
    const at = "2026-11-22T14:03:00.000Z";
    expect(helperLine(helper(at), NOW)).toBe(`Your Mac checked in ${timeWords(at, NOW)}.`);
    expect(helperLine(helper(at, { state: "needs_you", reason: "TikTok wants you to log in again." }), NOW)).toBe(
      "Your Mac needs you: TikTok wants you to log in again.",
    );
    expect(helperLine(helper(at, { state: "paused" }), NOW)).toBe("Paused on your Mac.");
    expect(waitingLine(3)).toBe("3 waiting for your Mac");
    expect(sendableLine(1)).toBe("1 clip isn't on TikTok yet.");
    expect(sendableLine(4)).toBe("4 clips aren't on TikTok yet.");
    expect(MAC_OFF_LINE).toBe("Off. Your Mac doesn't post your TikTok clips.");
    for (const line of [MAC_OFF_LINE, sendableLine(2)]) expect(line).not.toMatch(/yourself/i);
  });

  it("sends at most 25 at a time, each clip once", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `c${i}`);
    const lots = sendLots([...ids, "c1"]);
    expect(lots.map((l) => l.length)).toEqual([25, 25, 10]);
    expect(lots.flat()).toEqual(ids);
  });
});

describe("the mock follows the API", () => {
  const knobs = () => (window as unknown as { __cfMock: { mac: TikTokMacControls; setup: { finish(p: string): void; setAudit(on: boolean): void } } }).__cfMock;
  function start() {
    const store = seed();
    const api = mockApi(store);
    return { store, api };
  }
  const tiktokOf = (out: { posts: Post[] }) => out.posts.find((p) => p.platform === "tiktok");

  it("refuses unknown tiktokMac keys and merges { on }", async () => {
    const { api } = start();
    await expect(api.putSettings({ tiktokMac: { on: true, x: 1 } as never })).rejects.toThrow(MAC_UNKNOWN_SETTING);
    expect((await api.putSettings({ tiktokMac: { on: true } })).tiktokMac).toEqual({ on: true });
    expect((await api.getSettings()).tiktokMac).toEqual({ on: true });
  });

  it("Upload with TikTok, while the Mac posts it and TikTok is not approved, hands TikTok to the Mac", async () => {
    const { store, api } = start();
    for (const p of ["youtube", "tiktok"]) knobs().setup.finish(p);
    knobs().setup.setAudit(false);
    const tiktok = { privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: false, disableStitch: false, brandContent: false, brandOrganic: false };
    // Off: exactly as before (Clip Factory's own upload).
    const [first, second] = store.clips.filter((c) => c.status === "review" && !c.campaignId);
    const before = await api.confirmClip(first!.clipId, undefined, tiktok, ["youtube", "tiktok"]);
    expect(tiktokOf(before)?.status).toBe("queued");
    await api.putSettings({ tiktokMac: { on: true } });
    // The TikTok choices stay required.
    await expect(api.confirmClip(second!.clipId, undefined, undefined, ["youtube", "tiktok"])).rejects.toThrow("Pick who can see it on TikTok.");
    const out = await api.confirmClip(second!.clipId, undefined, tiktok, ["youtube", "tiktok"]);
    expect(tiktokOf(out)).toMatchObject({ status: "mac", mac: { state: "waiting", source: "upload" } });
    expect(out.posts.find((p) => p.platform === "youtube")?.status).toBe("queued");
    const status = await api.tiktokMacStatus();
    expect(status.helper).toBeNull();
    expect(status.queue.find((j) => j.clipId === second!.clipId)).toMatchObject({ source: "upload", state: "waiting", privacy: "PUBLIC_TO_EVERYONE", comment: true, duet: true, stitch: true });
  });

  it("an Upload whose sheet said Only me still asks the Mac for Everyone, and done says public", async () => {
    const { store, api } = start();
    for (const p of ["tiktok"]) knobs().setup.finish(p);
    knobs().setup.setAudit(false);
    await api.putSettings({ tiktokMac: { on: true } });
    const c = store.clips.find((x) => x.status === "review" && !x.campaignId)!;
    const onlyMe = { privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: true, disableStitch: true, brandContent: false, brandOrganic: false };
    await api.confirmClip(c.clipId, undefined, onlyMe, ["tiktok"]);
    const job = (await api.tiktokMacStatus()).queue.find((j) => j.clipId === c.clipId)!;
    expect(job).toMatchObject({ privacy: "PUBLIC_TO_EVERYONE", comment: true, duet: true, stitch: true, attempt: 0 });
    expect(knobs().mac.claim(c.clipId).attempt).toBe(1);
    expect(tiktokOf(knobs().mac.done(c.clipId))).toMatchObject({ via: "mac", privacy: "public" });
  });

  it("Take it back after the Mac pressed Post is refused; I posted it still works", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = store.clips.find((x) => canSendToMac(x, store.posts.filter((p) => p.clipId === x.clipId)))!;
    await api.sendToMac([c.clipId]);
    const m = knobs().mac;
    m.claim(c.clipId);
    m.step(c.clipId, "pressing");
    m.stopped(c.clipId, "Timed out.");
    await expect(api.takeBackFromMac(c.clipId)).rejects.toThrow(MAC_MAY_HAVE_POSTED);
    expect(m.post(c.clipId)?.status).toBe("mac");
    expect(tiktokOf(await api.markTikTokPosted(c.clipId))).toMatchObject({ status: "posted", by: "you" });
  });

  it("claim, steps and done: posted by your Mac, through the one TikTok post", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = store.clips.find((x) => canSendToMac(x, store.posts.filter((p) => p.clipId === x.clipId)))!;
    expect((await api.sendToMac([c.clipId, c.clipId]))).toEqual([{ clipId: c.clipId, sent: true }]);
    expect((await api.sendToMac([c.clipId]))[0]).toMatchObject({ sent: false, reason: "Your Mac already has this clip." });
    const m = knobs().mac;
    expect(m.claim(c.clipId).state).toBe("working");
    expect(() => m.claim(c.clipId, "another-mac")).toThrow("Another try already has this clip.");
    expect(() => m.step(c.clipId, "uploading", "another-mac")).toThrow("Another try already has this clip.");
    m.step(c.clipId, "uploading");
    // While the Mac works on it: no I posted it, no Take it back, no Try again.
    await expect(api.markTikTokPosted(c.clipId)).rejects.toThrow(MAC_WORKING);
    await expect(api.takeBackFromMac(c.clipId)).rejects.toThrow(MAC_WORKING);
    await expect(api.retryMac(c.clipId)).rejects.toThrow(MAC_WORKING);
    m.step(c.clipId, "pressing");
    expect(m.post(c.clipId)?.mac?.pressedAt).toBeTruthy();
    const done = m.done(c.clipId, "https://www.tiktok.com/@lamo.clips/video/7710644811602169121");
    expect(tiktokOf(done)).toMatchObject({ status: "posted", by: "you", via: "mac", privacy: "public" });
    expect(tiktokOf(done)?.mac).toBeUndefined();
    expect(done.posts.filter((p) => p.platform === "tiktok")).toHaveLength(1);
    // Again: answered as the first.
    expect(tiktokOf(m.done(c.clipId))?.via).toBe("mac");
    await expect(api.undoTikTokPosted(c.clipId)).rejects.toThrow(MAC_UNDO_REFUSED);
  });

  it("stopped after pressing Post: the reason is fixed and Try again needs It's not on TikTok", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = store.clips.find((x) => canSendToMac(x, store.posts.filter((p) => p.clipId === x.clipId)))!;
    await api.sendToMac([c.clipId]);
    const m = knobs().mac;
    m.claim(c.clipId);
    m.step(c.clipId, "pressing");
    m.stopped(c.clipId, "Timed out.", true);
    expect(m.post(c.clipId)?.mac).toMatchObject({ state: "stopped", reason: MAC_PRESSED_REASON });
    expect((await api.tiktokMacStatus()).helper).toMatchObject({ state: "needs_you", reason: "Timed out." });
    // A post that was pressed is never claimed again by itself.
    expect(() => m.claim(c.clipId)).toThrow("Another try already has this clip.");
    await expect(api.retryMac(c.clipId)).rejects.toThrow(MAC_MAY_HAVE_POSTED);
    const back = await api.retryMac(c.clipId, true);
    expect(tiktokOf(back)?.mac).toEqual({ state: "waiting", since: expect.any(String), source: "sent" });
    expect((await api.tiktokMacStatus()).helper?.state).toBe("ok");
  });

  it("Take it back: a converted post gets its old fields back, a made one goes", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const privateOne = store.clips.find((x) => store.posts.some((p) => p.clipId === x.clipId && p.platform === "tiktok" && p.privacy === "private"))!;
    const was = structuredClone(store.posts.find((p) => p.clipId === privateOne.clipId && p.platform === "tiktok"));
    await api.sendToMac([privateOne.clipId]);
    expect(knobs().mac.post(privateOne.clipId)).toMatchObject({ status: "mac", postId: was!.postId });
    const back = await api.takeBackFromMac(privateOne.clipId);
    expect(tiktokOf(back)).toEqual(was);
    await expect(api.takeBackFromMac(privateOne.clipId)).rejects.toThrow(MAC_NOT_POSTING);
    await expect(api.retryMac(privateOne.clipId)).rejects.toThrow(MAC_NOT_POSTING);
  });

  it("I posted it on a waiting Mac post makes it his own; its Undo gives it back to the Mac", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = store.clips.find((x) => canSendToMac(x, store.posts.filter((p) => p.clipId === x.clipId)))!;
    await api.sendToMac([c.clipId]);
    const mine = await api.markTikTokPosted(c.clipId);
    expect(tiktokOf(mine)).toMatchObject({ status: "posted", by: "you" });
    expect(tiktokOf(mine)?.mac).toBeUndefined();
    const undone = await api.undoTikTokPosted(c.clipId);
    expect(tiktokOf(undone)).toMatchObject({ status: "mac", mac: { state: "waiting" } });
  });

  it("the queue is empty while off, and an auto-posting run's Mac post waits while auto-posting is off", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = store.clips.find((x) => canSendToMac(x, store.posts.filter((p) => p.clipId === x.clipId)))!;
    await api.sendToMac([c.clipId]);
    expect((await api.tiktokMacStatus()).queue.map((j) => j.clipId)).toContain(c.clipId);
    const p = store.posts.find((x) => x.clipId === c.clipId && x.platform === "tiktok")!;
    p.mac = { ...p.mac!, source: "auto" };
    expect((await api.tiktokMacStatus()).queue.map((j) => j.clipId)).not.toContain(c.clipId);
    await api.putSettings({ tiktokMac: { on: false } });
    expect((await api.tiktokMacStatus()).queue).toEqual([]);
    expect(() => knobs().mac.claim(c.clipId)).toThrow(ApiError);
  });

  it("while the switch is off, auto-posting lists his Mac's waiting and stopped posts for Post it yourself instead", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = store.clips.find((x) => canSendToMac(x, store.posts.filter((p) => p.clipId === x.clipId)))!;
    c.auto = { runId: "r#scheduled", at: "2026-11-22T13:00:00.000Z" };
    await api.sendToMac([c.clipId]);
    expect((await api.autoPostStatus()).tiktokYourself.map((t) => t.clipId)).not.toContain(c.clipId);
    await api.putSettings({ tiktokMac: { on: false } });
    expect((await api.autoPostStatus()).tiktokYourself.find((t) => t.clipId === c.clipId)).toMatchObject({ mac: true });
    // Pressed Post: it may be on TikTok, so it is not offered.
    const p = store.posts.find((x) => x.clipId === c.clipId && x.platform === "tiktok")!;
    p.mac = { ...p.mac!, state: "stopped", pressedAt: "2026-11-22T13:05:00.000Z" };
    expect((await api.autoPostStatus()).tiktokYourself.map((t) => t.clipId)).not.toContain(c.clipId);
  });

  it("a campaign clip or a Private test never goes to the Mac", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = store.clips.find((x) => x.status === "posted")!;
    c.campaignId = "camp-1";
    expect((await api.sendToMac([c.clipId]))[0]).toMatchObject({ sent: false, reason: "Campaign clips go on TikTok by hand. Post it in the TikTok app, then add the link." });
    delete c.campaignId;
    c.auto = { runId: "r", at: "2026-11-22T10:00:00.000Z", test: "private" };
    expect((await api.sendToMac([c.clipId]))[0]).toMatchObject({ sent: false, reason: "This was a Private test, so it stays off TikTok." });
  });
});

describe("the TikTok login on the Mac (§47.8)", () => {
  const seen: MacHelper = { seenAt: "2026-11-22T18:00:00.000Z", state: "ok" };
  it("says whether the Mac keeps a login, and nothing for a helper from before it said", () => {
    expect(loginLine(null)).toBeNull();
    expect(loginLine(seen)).toBeNull();
    expect(loginLine({ ...seen, login: "saved" })).toBe(
      "Your TikTok login is kept in your Mac's Keychain, so your Mac logs back in to TikTok by itself.",
    );
    expect(loginLine({ ...seen, login: "none" })).toBe(
      "No TikTok login is kept on your Mac. If TikTok logs your Mac out, you log in again on the Mac.",
    );
  });
  it("says what happens next after Change or Forget", () => {
    expect(loginRequestLine(seen)).toBeNull();
    expect(loginRequestLine({ ...seen, loginRequest: { action: "change", at: seen.seenAt } })).toBe(
      "Your Mac asks for the new login the next time it checks in, within a minute.",
    );
    expect(loginRequestLine({ ...seen, loginRequest: { action: "forget", at: seen.seenAt } })).toBe(
      "Your Mac forgets the login the next time it checks in, within a minute.",
    );
  });
  it("the mock asks the Mac only once one checked in, and never takes a login", async () => {
    const api = mockApi();
    await expect(api.tiktokMacLogin("forget")).rejects.toThrow("Set up your Mac first. Then it can keep your TikTok login.");
    await expect(api.tiktokMacLogin("show" as never)).rejects.toThrow("Pick change or forget.");
  });
});

describe("when the Mac posts (the owner, 22 Nov: TikTok follows auto-posting)", () => {
  it("names auto-posting's next run and how many wait, or says it posts on Upload", () => {
    const now = Date.parse("2026-11-22T20:15:00Z");
    expect(whenLine(true, "2026-11-22T21:00:00Z", 14, now)).toMatch(/^Posts with auto-posting · next \S+ \d\d:\d\d · 14 waiting$/);
    expect(whenLine(true, null, 2, now)).toBe("Posts with auto-posting · 2 waiting");
    expect(whenLine(false, "2026-11-22T21:00:00Z", 0, now)).toBe("Posts when you tap Upload · 0 waiting");
  });
});
