// Your Mac posts it on TikTok (docs/CONTRACTS.md §47): the TikTok row (§47.4: only what the Mac is doing, with at most
// one button, ADR-86), the stuck rule and the find window shared with the API (D2), the Mac's queue place (D4), the
// owner's requests (D5), the helpers and the mock's rules.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { mockApi } from "../src/api/mock/index.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import type { TikTokMacControls } from "../src/api/mock/tiktokMac.ts";
import type { Clip, MacHelper, MacJob, PlatformPerformance, Post, PostMac } from "../src/api/types.ts";
import { calmCopy, perfStatus, postStatusLabel } from "../src/lib/metrics.ts";
import { perfFromPost } from "../src/lib/liveCache.ts";
import {
  backlogTimeWords,
  canSendToMac,
  clockWords,
  heldWords,
  helperLine,
  holdLine,
  loginBackLine,
  inLineWords,
  loginLine,
  loginRequestLine,
  MAC_AGAIN_CONFIRM,
  MAC_BEAT_STALE_MS,
  MAC_BEATS_FROM,
  MAC_CLAIM_MAX_MS,
  MAC_CLIP_PAGE_LOOK,
  MAC_FIND_BUTTON,
  MAC_FIND_NONE,
  MAC_FIND_WINDOW_MS,
  MAC_LET_GO_BUTTON,
  MAC_LET_GO_PENDING,
  MAC_LET_GO_TOAST,
  MAC_LINK_EMPTY,
  MAC_LOGIN_BACK_LINE,
  MAC_MAY_HAVE_POSTED,
  MAC_NO_LINK_BUTTON,
  MAC_NO_LINK_CONFIRM,
  MAC_NO_LINK_SAVED,
  MAC_NO_LINK_YES,
  MAC_NOT_HOLDING,
  MAC_NOT_PAUSED,
  MAC_NOT_POSTING,
  MAC_NOT_PRESSED,
  MAC_OFF_LINE,
  MAC_OFFLINE_MS,
  MAC_ON_TIKTOK_BUTTON,
  MAC_OPEN_BUTTON,
  MAC_OPEN_STOPPED_BUTTON,
  MAC_PAUSED_STARTING,
  MAC_PRESSED_REASON,
  MAC_REQUEST_PICK,
  MAC_RESUME_BUTTON,
  MAC_RESUME_PENDING,
  MAC_RESUMED_TOAST,
  MAC_ROW_CAMPAIGN,
  MAC_ROW_IN_LINE,
  MAC_ROW_NEXT,
  MAC_ROW_PRESSED,
  MAC_ROW_STOPPED_EARLY,
  MAC_STALE_MS,
  MAC_STILL_LOOKING,
  MAC_UNDO_REFUSED,
  MAC_UNKNOWN_SETTING,
  MAC_WORKING,
  macChip,
  macHelperBeats,
  macInsteadOk,
  macOn,
  macPlace,
  macStuck,
  macWaitWords,
  macWindowOver,
  pausedWords,
  postsFromStacks,
  rowNeedsMac,
  sendableLine,
  sendLots,
  shortReason,
  tiktokFacts,
  tiktokFactsFromStacks,
  tiktokRow,
  waitingLine,
  whenLine,
  type MacQueueJob,
  type TikTokRowContext,
} from "../src/lib/tiktokMac.ts";
import { MAC_HINT, MAC_SENT_WAITS, MAC_WHERE_LINE, macUploadLine, savedForSetup, sentLine } from "../src/lib/tiktokMac.ts";
import * as tiktokMacLib from "../src/lib/tiktokMac.ts";
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
/** A post the Mac works on right now: claimed 2 minutes ago, its last beat a minute ago. */
const working = (extra: Partial<PostMac> = {}) => macPost({ state: "working", step: "uploading", claimedAt: iso(NOW - 2 * MIN), beatAt: iso(NOW - MIN), ...extra });
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
const SETTINGS = "/settings/posting/tiktok-mac";
const turnOn = (words: string) => ({ kind: "not_ready", words, button: "turn_on", href: SETTINGS });
const openMac = (words: string) => ({ kind: "not_ready", words, button: "open_mac", href: SETTINGS });
/** A job in the Mac's queue, in the server's order. */
const job = (clipId: string, source: MacJob["source"], state: MacJob["state"] = "waiting", extra: Partial<MacQueueJob> = {}): MacQueueJob => ({
  clipId,
  source,
  state,
  since: "2026-11-22T12:00:00.000Z",
  ...extra,
});

describe("the constants shared with the API (D2)", () => {
  it("the stuck rule's and the find window's minutes equal tiktok_self.py's", () => {
    const py = readFileSync(join(import.meta.dirname, "../../api/src/clipfactory_api/tiktok_self.py"), "utf8");
    const minutes = (name: string) => {
      const m = new RegExp(`^${name} = timedelta\\(minutes=(\\d+)\\)$`, "m").exec(py);
      expect(m, name).not.toBeNull();
      return Number(m![1]);
    };
    expect(MAC_BEAT_STALE_MS).toBe(minutes("MAC_BEAT_STALE") * MIN);
    expect(MAC_CLAIM_MAX_MS).toBe(minutes("MAC_CLAIM_MAX") * MIN);
    expect(MAC_FIND_WINDOW_MS).toBe(minutes("MAC_FIND_WINDOW") * MIN);
    // The refusal on no link before Post, word for word.
    expect(/^MAC_NOT_PRESSED = "(.+)"$/m.exec(py)?.[1]).toBe(MAC_NOT_PRESSED);
    // The helper version beats count from: the same on both sides.
    expect(/^MAC_BEATS_FROM = "([\d.]+)"$/m.exec(py)?.[1]).toBe(MAC_BEATS_FROM);
    // The old 15-minute rule is gone on both sides (no alias).
    expect(py).not.toMatch(/^MAC_STUCK = /m);
    expect("MAC_STUCK_MS" in tiktokMacLib).toBe(false);
    expect(MAC_OFFLINE_MS).toBe(10 * MIN);
  });
});

describe("the stuck rule and the find window (D2, tiktok_self.mac_stuck / window_over)", () => {
  const claimedAt = iso(NOW - 10 * MIN);
  it("stuck once its own beat is 5 minutes old (from the claim without a beat)", () => {
    expect(macStuck({ state: "working", claimedAt, beatAt: iso(NOW - 5 * MIN + 1000) }, NOW)).toBe(false);
    expect(macStuck({ state: "working", claimedAt, beatAt: iso(NOW - 5 * MIN) }, NOW)).toBe(true);
    expect(macStuck({ state: "working", claimedAt: iso(NOW - 4 * MIN - 59_000) }, NOW)).toBe(false);
    expect(macStuck({ state: "working", claimedAt: iso(NOW - 5 * MIN) }, NOW)).toBe(true);
  });
  it("or once its claim is 50 minutes old, even with fresh beats", () => {
    expect(macStuck({ state: "working", claimedAt: iso(NOW - 49 * MIN - 59_000), beatAt: iso(NOW - MIN) }, NOW)).toBe(false);
    expect(macStuck({ state: "working", claimedAt: iso(NOW - 50 * MIN), beatAt: iso(NOW - MIN) }, NOW)).toBe(true);
  });
  it("only a working post, and never without its times", () => {
    expect(macStuck({ state: "waiting", claimedAt: iso(NOW - 60 * MIN) }, NOW)).toBe(false);
    expect(macStuck({ state: "stopped", claimedAt: iso(NOW - 60 * MIN) }, NOW)).toBe(false);
    expect(macStuck({ state: "working" }, NOW)).toBe(false);
  });
  it("the find window: over without a press, or 30 minutes after it", () => {
    expect(macWindowOver({}, NOW)).toBe(true);
    expect(macWindowOver({ pressedAt: iso(NOW - 29 * MIN - 59_000) }, NOW)).toBe(false);
    expect(macWindowOver({ pressedAt: iso(NOW - 30 * MIN) }, NOW)).toBe(true);
    // A time it can't read is never taken as over (no second post on a guess).
    expect(macWindowOver({ pressedAt: "soon" }, NOW)).toBe(false);
  });
});

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

  it("Posting… while the Mac works on it, with no button: never Not sure it posted or Try again, however long it takes", () => {
    const posting = { kind: "working", words: "Posting…", button: null, spinner: true };
    expect(rowOf([working()], ready())).toEqual(posting);
    // 49 minutes after the claim, through Post and the find window, with its beats fresh: still the Mac's.
    const long = working({ step: "finding", claimedAt: iso(NOW - 49 * MIN), pressedAt: iso(NOW - 20 * MIN), beatAt: iso(NOW - 4 * MIN) });
    expect(rowOf([long], ready())).toEqual(posting);
    // Not known yet (the session or the check-in still loading): Posting… too.
    expect(rowOf([working()], ready({ macOn: undefined, helper: undefined }))).toEqual(posting);
    // The Mac needs him or is paused while its beats are fresh: it is still on this one.
    expect(rowOf([working()], ready({ helper: helper(iso(NOW - MIN), { state: "needs_you" }) }))).toEqual(posting);
    expect(rowOf([working()], ready({ helper: helper(iso(NOW - MIN), { state: "paused" }) }))).toEqual(posting);
  });

  it("a working post whose switch went off before it is stuck says so, with Turn on", () => {
    expect(rowOf([working()], ready({ macOn: false }))).toEqual(turnOn("Your Mac posts TikTok is off"));
    expect(rowOf([working()], ready({ macOn: false }))?.spinner).toBeUndefined();
  });

  it("stuck (its beat 5 minutes old, or its claim 50) after Post: not sure it posted, It's on TikTok, Try again once the find window is over", () => {
    const claimedAt = iso(NOW - 8 * MIN);
    const since = iso(NOW - 9 * MIN);
    // Pressed 10 minutes ago: It's on TikTok works now; Try again waits for the window, and the words say from when.
    const pressedAt = NOW - 10 * MIN;
    const pressed = working({ step: "finding", claimedAt, pressedAt: iso(pressedAt), beatAt: iso(NOW - 6 * MIN) });
    expect(rowOf([pressed], ready())).toEqual({
      kind: "stopped",
      words: `${MAC_ROW_PRESSED} · Try again from ${hm(pressedAt + 30 * MIN)}`,
      button: "on_tiktok",
      since,
      again: false,
      noLink: true,
    });
    expect(rowOf([{ ...pressed, mac: { ...pressed.mac!, pressedAt: iso(NOW - 30 * MIN) } }], ready())).toMatchObject({ words: MAC_ROW_PRESSED, again: true });
  });

  it("stuck before Post (the Mac slept mid-upload): it can't be on TikTok, so Try again only, never It's on TikTok (review round 3, item 2)", () => {
    const tryAgain = { kind: "stopped", words: "Your Mac stopped before it pressed Post", button: "try_again" };
    expect(MAC_ROW_STOPPED_EARLY).toBe(tryAgain.words);
    expect(rowOf([working({ claimedAt: iso(NOW - 8 * MIN), beatAt: iso(NOW - 6 * MIN) })], ready())).toEqual(tryAgain);
    // The 50-minute cap with fresh beats: the same (nothing was posted).
    expect(rowOf([working({ claimedAt: iso(NOW - 50 * MIN), beatAt: iso(NOW - MIN) })], ready())).toEqual(tryAgain);
    // Its chip says it didn't work, never "Posting…" or "Not sure it posted".
    const stuck = working({ beatAt: iso(NOW - 6 * MIN) }).mac!;
    expect(macChip(stuck, tiktokRow(tiktokFacts(clip("posted"), [youtube, macPost(stuck)]), ready()))).toBe("Didn't work");
  });

  it("an older helper (before 1.1.0, no beats in its long waits): only its 50-minute claim makes a job stuck (review round 3, item 1)", () => {
    const old = (extra: Partial<MacHelper> = {}) => ready({ helper: helper(iso(NOW - MIN), { version: "1.0.0", ...extra }) });
    expect(macHelperBeats({ version: "1.0.0" })).toBe(false);
    expect(macHelperBeats({ version: "0.9" })).toBe(false);
    for (const h of [{ version: "1.1.0" }, { version: "1.10" }, { version: "2.0.0" }, { version: "dev" }, {}, null, undefined]) expect(macHelperBeats(h)).toBe(true);
    // 12 minutes into its upload wait, its last step 11 minutes old: still Posting….
    const uploading = working({ claimedAt: iso(NOW - 12 * MIN), beatAt: iso(NOW - 11 * MIN) });
    expect(rowOf([uploading], old())).toMatchObject({ kind: "working", words: "Posting…" });
    expect(macStuck(uploading.mac!, NOW, false)).toBe(false);
    expect(macStuck(uploading.mac!, NOW)).toBe(true);
    // Pressed 10 minutes ago, still checking for its link: Posting… too, until the claim is 50 minutes old.
    const pressed = working({ step: "pressing", claimedAt: iso(NOW - 20 * MIN), pressedAt: iso(NOW - 10 * MIN), beatAt: iso(NOW - 10 * MIN) });
    expect(rowOf([pressed], old())?.kind).toBe("working");
    expect(rowOf([working({ claimedAt: iso(NOW - 50 * MIN), beatAt: iso(NOW - 40 * MIN) })], old())?.button).toBe("try_again");
    // Its queue place counts its working job as the Mac's.
    expect(macPlace([job("w", "upload", "working", { claimedAt: iso(NOW - 12 * MIN), beatAt: iso(NOW - 11 * MIN) }), job("c1", "upload")], "c1", old().helper, NOW)).toBe(1);
    // It never reads Start my Mac again: its paused rows open its page, as before.
    expect(rowOf([macPost()], old({ state: "paused", reason: "Paused on your Mac." }))).toEqual(openMac("Paused on your Mac · your clips wait until it's started again"));
  });

  it("stuck while the Mac itself stopped checking in (10 minutes, D5): since when, with It's on TikTok and Try again", () => {
    const stuck = working({ step: "finding", claimedAt: iso(NOW - 45 * MIN), pressedAt: iso(NOW - 40 * MIN), beatAt: iso(NOW - 15 * MIN) });
    for (const seen of [NOW - 10 * MIN, NOW - 40 * MIN])
      expect(rowOf([stuck], ready({ helper: helper(iso(seen)) }))).toMatchObject({
        kind: "stopped",
        words: `Your Mac hasn't checked in since ${hm(seen)}`,
        button: "on_tiktok",
        again: true,
      });
    // 9 minutes: it checks in, so not sure it posted.
    expect(rowOf([stuck], ready({ helper: helper(iso(NOW - 9 * MIN)) }))?.words).toBe(MAC_ROW_PRESSED);
    // Never checked in: said so; not known yet: not sure it posted.
    expect(rowOf([stuck], ready({ helper: null }))).toMatchObject({ words: "Your Mac isn't set up yet", button: "on_tiktok" });
    expect(rowOf([stuck], ready({ helper: undefined }))).toMatchObject({ words: MAC_ROW_PRESSED, button: "on_tiktok" });
    // Never a spinner for good, and never only Turn on.
    for (const ctx of [ready({ helper: helper(iso(NOW - 40 * MIN)) }), ready({ macOn: false })]) {
      expect(rowOf([stuck], ctx)?.spinner).toBeUndefined();
      expect(rowOf([stuck], ctx)?.button).toBe("on_tiktok");
    }
    // Before Post, offline: since when, with Try again (nothing was posted).
    const early = working({ claimedAt: iso(NOW - 20 * MIN), beatAt: iso(NOW - 15 * MIN) });
    expect(rowOf([early], ready({ helper: helper(iso(NOW - 12 * MIN)) }))).toEqual({ kind: "stopped", words: `Your Mac hasn't checked in since ${hm(NOW - 12 * MIN)}`, button: "try_again" });
  });

  it("not sure it posted, after the Mac pressed Post and stopped: It's on TikTok first; Try again only after the find window", () => {
    const claimedAt = "2026-11-22T14:02:00.000Z";
    const pressedAt = "2026-11-22T14:05:00.000Z";
    const words = "Not sure it posted · look on your TikTok";
    const pressed = { kind: "stopped", words: `${words} · Try again from ${hm(Date.parse(pressedAt) + 30 * MIN)}`, button: "on_tiktok", since: "2026-11-22T14:01:00.000Z", again: false, noLink: true };
    // The stored reason (the server's tiktok_mac.PRESSED) never names a button he doesn't have; the row never shows it.
    expect(MAC_PRESSED_REASON).toBe("Your Mac pressed Post but couldn't confirm it. Look on your TikTok: if it's there, tap It's on TikTok.");
    expect(MAC_PRESSED_REASON).not.toMatch(/I posted it|yourself/i);
    // His own words, chosen by pressedAt, never the stored reason's; the finder looks from a minute before the claim.
    expect(rowOf([macPost({ state: "stopped", claimedAt, pressedAt, reason: MAC_PRESSED_REASON })], ready())).toEqual(pressed);
    // 30 minutes after Post the Mac stopped looking: Try again comes too.
    const later = ready({ now: Date.parse(pressedAt) + 30 * MIN, helper: helper(iso(Date.parse(pressedAt) + 29 * MIN)) });
    expect(rowOf([macPost({ state: "stopped", claimedAt, pressedAt })], later)).toEqual({ ...pressed, words, again: true });
    // No claim time: from a minute before Post was pressed.
    expect(rowOf([macPost({ state: "stopped", pressedAt })], ready())?.since).toBe("2026-11-22T14:04:00.000Z");
    // Saying it's on TikTok needs no Mac: the same row while the Mac can't post.
    for (const ctx of [ready({ macOn: false }), ready({ helper: null }), ready({ helper: helper(iso(NOW - MAC_STALE_MS)) })])
      expect(rowOf([macPost({ state: "stopped", claimedAt, pressedAt })], ctx)).toEqual(pressed);
    expect(rowOf([macPost({ state: "stopped", claimedAt, pressedAt })], ready())?.words).not.toMatch(/Didn't work/);
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
    const needs = ready({ helper: helper(iso(NOW - MIN), { state: "needs_you", reason: "TikTok wants a code.", needsYouClipId: "c1" }) });
    expect(rowOf([macPost({ state: "stopped", reason: "TikTok wants a code. Type it on your Mac." })], needs)).toEqual({
      kind: "stopped",
      words: "Didn't work: TikTok wants a code · look at your Mac first",
      button: "try_again",
    });
  });

  it("the Mac can't post: switch off (Turn on), never set up or not seen for 30 minutes (Open Your Mac posts TikTok)", () => {
    for (const posts of [[], [macPost()], [macPost({ state: "stopped", reason: "Timed out." })]]) {
      expect(rowOf(posts, ready({ macOn: false }))).toEqual(turnOn("Your Mac posts TikTok is off"));
      // The switch is on, the Mac never checked in: Turn on would open a switch that is already on (bug hunt, 23 Nov).
      expect(rowOf(posts, ready({ helper: null }))).toEqual(openMac("Your Mac isn't set up yet"));
      expect(rowOf(posts, ready({ macOn: undefined, helper: null }))).toEqual(openMac("Your Mac isn't set up yet"));
      // The switch is already on: open its page, where the status line says the rest.
      const old = NOW - MAC_STALE_MS;
      expect(rowOf(posts, ready({ helper: helper(iso(old)) }))).toEqual(openMac(`Your Mac hasn't checked in since ${hm(old)}`));
    }
    expect(MAC_STALE_MS).toBe(30 * MIN);
    // 29 minutes is not stale yet.
    expect(rowOf([macPost()], ready({ helper: helper(iso(NOW - 29 * MIN)) }))?.kind).toBe("waiting");
    // Not known yet (the session or the check-in still loading): no Turn on.
    expect(rowOf([], ready({ macOn: undefined, helper: undefined }))?.kind).toBe("offer");
  });

  it("the Mac needs him (D5): Open the stopped clip, where its Try again and It's on TikTok are", () => {
    const needs = (extra: Partial<MacHelper> = {}) => ready({ helper: helper(iso(NOW - MIN), { state: "needs_you", reason: "TikTok wants a code. Type it.", ...extra }) });
    const words = "Your Mac needs you: TikTok wants a code · look at your Mac";
    for (const posts of [[], [macPost()], [macPost({ source: "sent" })]])
      expect(rowOf(posts, needs({ needsYouClipId: "c9" }))).toEqual({ kind: "not_ready", words, button: "open_stopped", href: "/clips/c9" });
    // No stopped clip known (an older server), or this is it: Open Your Mac posts TikTok.
    expect(rowOf([], needs())).toEqual(openMac(words));
    expect(rowOf([macPost()], needs({ needsYouClipId: "c1" }))).toEqual(openMac(words));
    expect(rowOf([], ready({ helper: helper(iso(NOW - MIN), { state: "needs_you" }) }))).toEqual(openMac("Your Mac needs you · look at your Mac"));
  });

  it("paused on the Mac (D5): Start my Mac again, then 'starting again within a minute' until it checks in", () => {
    const paused = (extra: Partial<MacHelper> = {}) => ready({ helper: helper(iso(NOW - MIN), { state: "paused", reason: "Paused on your Mac.", ...extra }) });
    for (const posts of [[], [macPost()]])
      expect(rowOf(posts, paused())).toEqual({ kind: "not_ready", words: "Paused on your Mac · your clips wait until it's started again", button: "resume" });
    const trial = paused({ reason: "Paused after the 3 trial posts. Clip Factory checks their views first." });
    expect(rowOf([macPost({ source: "sent" })], trial)).toEqual({ kind: "not_ready", words: "Paused after the 3 trial posts · your Mac goes on once their views are checked", button: "resume" });
    expect(pausedWords({})).toBe("Paused on your Mac · your clips wait until it's started again");
    // Asked: no second button, it says what happens next.
    const asked = { resumeRequest: { at: iso(NOW - 10_000) } };
    expect(rowOf([], paused(asked))).toEqual({ kind: "not_ready", words: "Paused on your Mac · starting again within a minute", button: null });
    expect(rowOf([macPost()], { ...trial, helper: { ...trial.helper!, ...asked } })?.words).toBe("Paused after the 3 trial posts · starting again within a minute");
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

  it("held on the Mac (its holdAutoBefore, D5): an auto-posting clip made before it says so, with Post with my Mac", () => {
    const holdBefore = "2026-11-22T13:55:00.000Z";
    const ctx = ready({ helper: helper(iso(NOW - MIN), { holdBefore }) });
    expect(rowOf([macPost({ source: "auto", since: "2026-11-22T13:00:00.000Z" })], ctx)).toEqual({
      kind: "waiting",
      words: `Held on your Mac: made before ${hm(Date.parse(holdBefore))}`,
      button: "post_with_mac",
    });
    // Made after it, or not an auto-posting clip: not held.
    expect(rowOf([macPost({ source: "auto", since: "2026-11-22T14:00:00.000Z" })], ctx)?.button).toBeNull();
    expect(rowOf([macPost({ source: "sent", since: "2026-11-22T13:00:00.000Z" })], ctx)?.button).toBeNull();
    expect(heldWords("03:55")).toBe("Held on your Mac: made before 03:55");
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

  it("a campaign clip skips TikTok for now (D1): plain words, no button, whatever the Mac does; a Private test stays off TikTok", () => {
    const campaign = clip("posted", { campaignId: "camp-1" });
    const skips = { kind: "campaign", words: "Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet.", button: null };
    expect(MAC_ROW_CAMPAIGN).toBe(skips.words);
    for (const ctx of [ready(), ready({ macOn: false }), ready({ helper: null }), ready({ helper: helper(iso(NOW - MIN), { state: "paused" }) })])
      expect(rowOf([], ctx, campaign)).toEqual(skips);
    expect(rowOf([tiktok({ status: "failed", error: "TikTok did not answer." })], ready(), campaign)).toEqual(skips);
    // Once TikTok approved the app, its TikTok goes through TikTok's API (the old rows).
    expect(rowOf([], ready({ audited: true }), campaign)).toBeNull();
    expect(rowOf([], ready(), clip("posted", { auto: { runId: "r", at: "t", test: "private" } }))).toEqual({
      kind: "private_test",
      words: "Private test · stays off TikTok",
      button: null,
    });
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
    expect(tiktokRow(tiktokFactsFromStacks(clip("posted", { campaignId: "c" }), stacks), ready())?.kind).toBe("campaign");
  });

  it("which rows read the Mac's check-in (no row reads auto-posting's runs any more)", () => {
    expect(rowNeedsMac(tiktokFacts(clip("posted"), [youtube]))).toBe(true);
    expect(rowNeedsMac(tiktokFacts(clip("posted"), [youtube, macPost()]))).toBe(true);
    expect(rowNeedsMac(tiktokFacts(clip("posted", { campaignId: "c" }), [youtube]))).toBe(false);
    expect(rowNeedsMac(tiktokFacts(clip("posted", { auto: { runId: "r", at: "t", test: "private" } }), [youtube]))).toBe(false);
    expect(rowNeedsMac(tiktokFacts(clip("posted"), [youtube, tiktok({ privacy: "public" })]))).toBe(false);
    for (const gone of ["rowNeedsRuns", "lastLiveRunAt", "afterRunWords", "MAC_ROW_CHECK_IN"]) expect(gone in tiktokMacLib, gone).toBe(false);
  });

  it("small words: the reason's first sentence, today's times without the day", () => {
    expect(shortReason("TikTok wants you to log in again.")).toBe("TikTok wants you to log in again");
    expect(shortReason("Your Mac's helper ran into a problem three times. Post it yourself for now.")).toBe("Your Mac's helper ran into a problem three times");
    // Never "post it yourself" (ADR-86), wherever an older helper put it in the first sentence.
    expect(shortReason("TikTok's upload page looks different; post it yourself for now.")).toBe("TikTok's upload page looks different");
    expect(shortReason("Post it yourself for now.")).toBe("");
    expect(shortReason("Check it, then post it yourself.")).toBe("Check it");
    expect(shortReason("TikTok said \"Something went wrong\". Try again later, or post it yourself.")).toBe('TikTok said "Something went wrong"');
    expect(shortReason(undefined)).toBe("");
    expect(clockWords(NOW + 5 * MIN, NOW)).toBe(hm(NOW + 5 * MIN));
    const tomorrow = NOW + 24 * 3_600_000;
    expect(clockWords(tomorrow, NOW)).toBe(timeWords(tomorrow, NOW));
  });

  it("the clip page's stack and chip: 'Not sure it posted' once, on the chip; the line says where to look (D7)", () => {
    expect(perfStatus({ status: "mac" })).toBe("mac");
    expect(postStatusLabel({ status: "mac" })).toBe("Waiting for your Mac");
    const stack = { platform: "tiktok", status: "mac", metrics: null } as Pick<PlatformPerformance, "platform" | "status" | "metrics">;
    expect(calmCopy({ ...stack, mac: mac({ state: "working", step: "settings" }) })).toEqual({ text: "Posting…", spinner: true });
    expect(calmCopy({ ...stack, mac: mac({ state: "stopped", reason: "A puzzle showed." }) })).toEqual({ text: "Didn't work: A puzzle showed" });
    const pressed = mac({ state: "stopped", pressedAt: "2026-11-22T14:05:00.000Z", reason: MAC_PRESSED_REASON });
    expect(calmCopy({ ...stack, mac: pressed })).toEqual({ text: "Look on your TikTok" });
    expect(MAC_CLIP_PAGE_LOOK).toBe("Look on your TikTok");
    // With its row too (stuck after Post), never the row's words beside the chip's: where to look, and from when Try
    // again comes while the find window lasts.
    const stuck = working({ step: "finding", claimedAt: iso(NOW - 40 * MIN), pressedAt: iso(NOW - 35 * MIN), beatAt: iso(NOW - 6 * MIN) }).mac!;
    const row = tiktokRow(tiktokFacts(clip("posted"), [youtube, macPost(stuck)]), ready())!;
    expect(macChip(stuck, row)).toBe("Not sure it posted");
    expect(calmCopy({ ...stack, mac: stuck }, row)).toEqual({ text: "Look on your TikTok" });
    const early = { ...stuck, pressedAt: iso(NOW - 10 * MIN) };
    const earlyRow = tiktokRow(tiktokFacts(clip("posted"), [youtube, macPost(early)]), ready())!;
    expect(calmCopy({ ...stack, mac: early }, earlyRow)).toEqual({ text: `Look on your TikTok · Try again from ${hm(NOW + 20 * MIN)}` });
    // Its Mac stopped checking in (D5): the row's own words, on the clip page too (review round 3, item 6).
    const offline = tiktokRow(tiktokFacts(clip("posted"), [youtube, macPost(stuck)]), ready({ helper: helper(iso(NOW - 12 * MIN)) }))!;
    expect(macChip(stuck, offline)).toBe("Not sure it posted");
    expect(calmCopy({ ...stack, mac: stuck }, offline)).toEqual({ text: `Your Mac hasn't checked in since ${hm(NOW - 12 * MIN)}` });
    expect(calmCopy({ ...stack, mac: pressed }, tiktokRow(tiktokFacts(clip("posted"), [youtube, macPost(pressed)]), ready()))?.text).not.toMatch(/Not sure/);
    expect(macChip({ state: "waiting" })).toBe("Waiting for your Mac");
    expect(macChip({ state: "working" })).toBe("Posting…");
    expect(macChip({ state: "stopped" })).toBe("Didn't work");
    // Pressed, or a stuck post (its row says so): not sure it posted.
    expect(macChip({ state: "stopped", pressedAt: "2026-11-22T14:05:00.000Z" })).toBe("Not sure it posted");
    expect(macChip({ state: "working" }, { button: "on_tiktok" })).toBe("Not sure it posted");
    expect(macChip({ state: "working" }, { button: null })).toBe("Posting…");
  });

  it("a live post brings its Mac state to the clip page, and drops it once posted", () => {
    const prev = { platform: "tiktok", status: "mac", account: "connected", metrics: null, refreshing: false, final: false, mac: mac() } as PlatformPerformance;
    expect(perfFromPost(macPost({ state: "working", step: "pressing" }), prev)).toMatchObject({ status: "mac", mac: { state: "working", step: "pressing" } });
    const done = perfFromPost({ postId: "p1", clipId: "c1", platform: "tiktok", status: "posted", by: "you", via: "mac", privacy: "public" }, prev);
    expect(done).toMatchObject({ status: "posted", by: "you", via: "mac" });
    expect(done.mac).toBeUndefined();
  });
});

describe("Review's line above Upload while the Mac posts this clip's TikTok (bug hunt, 23 Nov)", () => {
  it("says what the Mac is doing now, with its one fix; the plain line only once it can post (or while not known)", () => {
    expect(macUploadLine(ready(), true)).toEqual({ words: MAC_HINT, row: null });
    expect(macUploadLine(ready(), false)).toEqual({ words: MAC_WHERE_LINE, row: null });
    // Not known yet: never a wrong warning.
    expect(macUploadLine(ready({ helper: undefined }), true)).toEqual({ words: MAC_HINT, row: null });
    // Never checked in: not set up, with Open Your Mac posts TikTok (never Turn on: the switch is on).
    expect(macUploadLine(ready({ helper: null }), true)).toEqual({ words: "TikTok: Your Mac isn't set up yet", row: openMac("Your Mac isn't set up yet") });
    // Needs him, paused, not seen for 3 hours.
    const needs = macUploadLine(ready({ helper: helper(iso(NOW - MIN), { state: "needs_you", reason: "TikTok wants a code." }) }), true);
    expect(needs).toEqual({ words: "TikTok: Your Mac needs you: TikTok wants a code · look at your Mac", row: openMac("Your Mac needs you: TikTok wants a code · look at your Mac") });
    const paused = macUploadLine(ready({ helper: helper(iso(NOW - MIN), { state: "paused" }) }), true);
    expect(paused.words).toBe("TikTok: Paused on your Mac · your clips wait until it's started again");
    expect(paused.row?.button).toBe("resume");
    const old = NOW - 3 * 60 * MIN;
    expect(macUploadLine(ready({ helper: helper(iso(old)) }), true)).toEqual({
      words: `TikTok: Your Mac hasn't checked in since ${hm(old)}`,
      row: openMac(`Your Mac hasn't checked in since ${hm(old)}`),
    });
  });

  it("a clip Upload only saved (every place waits for set up) is not uploading", () => {
    const waits = (platform: Post["platform"]): Post => ({ postId: platform, clipId: "c1", platform, status: "pending_integration" });
    expect(savedForSetup([waits("youtube"), waits("tiktok")])).toBe(true);
    expect(savedForSetup([waits("youtube"), { ...waits("tiktok"), status: "queued" }])).toBe(false);
    expect(savedForSetup([])).toBe(false);
  });
});

describe("a waiting clip's place in the Mac's queue (D4, counted the way plan.js picks)", () => {
  it("null when the queue is not known or the clip is not waiting in it", () => {
    expect(macPlace(null, "c1", null, NOW)).toBeNull();
    expect(macPlace(undefined, "c1", null, NOW)).toBeNull();
    expect(macPlace([job("c9", "sent")], "c1", null, NOW)).toBeNull();
    expect(macPlace([job("c1", "upload", "working")], "c1", null, NOW)).toBeNull();
  });

  it("one per tick: Upload taps first, then auto-posting's, then the backlog, each in the server's order", () => {
    const q = [job("u1", "upload"), job("u2", "upload"), job("a1", "auto"), job("s1", "sent"), job("s2", "sent")];
    expect(["u1", "u2", "a1", "s1", "s2"].map((id) => macPlace(q, id, null, NOW))).toEqual([0, 1, 2, 3, 4]);
    // An auto-posting clip later in the server's order still goes before the backlog.
    const mixed = [job("s1", "sent"), job("a1", "auto"), job("u1", "upload")];
    expect(["s1", "a1", "u1"].map((id) => macPlace(mixed, id, null, NOW))).toEqual([2, 1, 0]);
  });

  it("a job the Mac works on counts unless it is stuck; one it holds never counts", () => {
    const fresh = { claimedAt: iso(NOW - 2 * MIN), beatAt: iso(NOW - MIN) };
    expect(macPlace([job("w", "sent", "working", fresh), job("c1", "upload")], "c1", null, NOW)).toBe(1);
    expect(macPlace([job("w", "sent", "working", { claimedAt: iso(NOW - 9 * MIN), beatAt: iso(NOW - 6 * MIN) }), job("c1", "upload")], "c1", null, NOW)).toBe(0);
    const holding = helper(iso(NOW - MIN), { holdBefore: "2026-11-22T13:00:00.000Z" });
    const q = [job("a-old", "auto", "waiting", { since: "2026-11-22T12:00:00.000Z" }), job("a-new", "auto", "waiting", { since: "2026-11-22T13:30:00.000Z" }), job("s1", "sent")];
    expect(macPlace(q, "s1", holding, NOW)).toBe(1);
    expect(macPlace(q, "s1", null, NOW)).toBe(2);
  });

  it("the words: next, in line (N before it), the backlog's own time, or in line during a backfill", () => {
    const say = (source: MacJob["source"], queue: MacQueueJob[] | null, h: Partial<MacHelper> = {}, clipId = "c1") =>
      macWaitWords({ source }, ready({ queue, helper: helper(iso(NOW - MIN), h) }), clipId);
    const first = (source: MacJob["source"]) => [job("c1", source), job("c2", "sent")];
    const third = (source: MacJob["source"]) => [job("u0", "upload"), job("u1", "upload"), job("c1", source)];
    expect(say("upload", first("upload"))).toBe("Waiting for your Mac · next");
    expect(say("upload", third("upload"))).toBe("Waiting for your Mac · in line (2 before it)");
    expect(say("auto", first("auto"))).toBe("Waiting for your Mac · next");
    expect(say("auto", third("auto"))).toBe("Waiting for your Mac · in line (2 before it)");
    expect(say("sent", third("sent"))).toBe("Waiting for your Mac · in line (2 before it)");
    expect(say("sent", third("sent"), { backfill: true })).toBe("Waiting for your Mac · in line (2 before it)");
    // The first backlog clip: the Mac's own pace during a backfill, else its backlogAt.
    expect(say("sent", first("sent"), { backfill: true })).toBe("Waiting for your Mac · in line");
    expect(say("sent", first("sent"))).toBe("Waiting for your Mac");
    expect(say("sent", first("sent"), { backlogAt: iso(NOW - MIN) })).toBe("Waiting for your Mac · next");
    expect(say("sent", first("sent"), { backlogAt: iso(NOW) })).toBe("Waiting for your Mac · next");
    const later = NOW + 40 * MIN;
    expect(say("sent", first("sent"), { backlogAt: iso(later) })).toBe(`Waiting for your Mac · goes at about ${hm(later)}`);
    const tomorrow = NOW + 26 * 3_600_000;
    expect(say("sent", first("sent"), { backlogAt: iso(tomorrow) })).toBe(`Waiting for your Mac · goes at about ${timeWords(tomorrow, NOW)}`);
    // Never a place or a time it doesn't know: no queue, or not in it.
    for (const source of ["upload", "auto", "sent"] as const) {
      expect(say(source, null, { backlogAt: iso(later) })).toBe("Waiting for your Mac");
      expect(say(source, [job("c9", "sent")], { backlogAt: iso(later) })).toBe("Waiting for your Mac");
    }
    expect(macWaitWords({ source: "upload" }, ready({ queue: first("upload") }))).toBe("Waiting for your Mac");
    expect([MAC_ROW_NEXT, MAC_ROW_IN_LINE, inLineWords(3), backlogTimeWords("20:30")]).toEqual(["next", "in line", "in line (3 before it)", "goes at about 20:30"]);
  });

  it("a waiting row reads it from the context's queue", () => {
    const queue = [job("u1", "upload"), job("c1", "upload")];
    expect(rowOf([macPost()], ready({ queue }))).toEqual({ kind: "waiting", words: "Waiting for your Mac · in line (1 before it)", button: null });
    expect(rowOf([macPost()], ready({ queue: [job("c1", "upload")] }))?.words).toBe("Waiting for your Mac · next");
    expect(rowOf([macPost()], ready())?.words).toBe("Waiting for your Mac");
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

  it("Send these to my Mac and Post with my Mac take clips not on TikTok yet, never a campaign clip (D1) or a Private test", () => {
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
    expect(helperLine(helper(at, { state: "paused" }), NOW)).toBe("Paused on your Mac. Your clips wait until it's started again.");
    expect(helperLine(helper(at, { state: "paused", reason: "Paused on your Mac." }), NOW)).toBe("Paused on your Mac. Your clips wait until it's started again.");
    expect(helperLine(helper(at, { state: "paused", reason: "Paused after the 3 trial posts. Clip Factory checks their views first." }), NOW)).toBe(
      "Paused after the 3 trial posts. Your Mac goes on once their views are checked.",
    );
    expect(waitingLine(3)).toBe("3 waiting for your Mac");
    expect(sendableLine(1)).toBe("1 clip isn't on TikTok yet.");
    expect(sendableLine(4)).toBe("4 clips aren't on TikTok yet.");
    // Just sent: never "0 clips aren't on TikTok yet." and nothing else (bug hunt, 23 Nov).
    expect(sendableLine(0, 2)).toBe("2 clips already wait for your Mac.");
    expect(sendableLine(0, 1)).toBe("1 clip already waits for your Mac.");
    expect(sendableLine(3, 1)).toBe("3 clips aren't on TikTok yet. 1 clip already waits for your Mac.");
    expect(sendableLine(0)).toBe("0 clips aren't on TikTok yet.");
    // Sent while the Mac never checked in: they wait for it.
    expect(sentLine(2)).toBe("Sent 2 clips to your Mac.");
    expect(sentLine(1, true)).toBe(`Sent 1 clip to your Mac. ${MAC_SENT_WAITS}`);
    expect(MAC_SENT_WAITS).toBe("They wait until your Mac checks in.");
    expect(MAC_OFF_LINE).toBe("Off. Your Mac doesn't post your TikTok clips.");
    for (const line of [MAC_OFF_LINE, sendableLine(2)]) expect(line).not.toMatch(/yourself/i);
  });

  it("every word of the round (6.8), word for word", () => {
    expect(holdLine("Mon 03:55")).toBe("Your Mac holds auto-posting clips made before Mon 03:55.");
    expect({
      MAC_RESUME_BUTTON,
      MAC_PAUSED_STARTING,
      MAC_RESUMED_TOAST,
      MAC_RESUME_PENDING,
      MAC_OPEN_STOPPED_BUTTON,
      MAC_LET_GO_BUTTON,
      MAC_LET_GO_TOAST,
      MAC_LET_GO_PENDING,
      MAC_NO_LINK_BUTTON,
      MAC_NO_LINK_CONFIRM,
      MAC_NO_LINK_YES,
      MAC_NO_LINK_SAVED,
      MAC_LINK_EMPTY,
      MAC_ROW_PRESSED,
      MAC_AGAIN_CONFIRM,
      MAC_OPEN_BUTTON,
      MAC_ON_TIKTOK_BUTTON,
      MAC_FIND_BUTTON,
      MAC_FIND_NONE,
      MAC_STILL_LOOKING,
    }).toEqual({
      MAC_RESUME_BUTTON: "Start my Mac again",
      MAC_PAUSED_STARTING: "starting again within a minute",
      MAC_RESUMED_TOAST: "Your Mac starts again within a minute.",
      MAC_RESUME_PENDING: "Your Mac starts again the next time it checks in, within a minute.",
      MAC_OPEN_STOPPED_BUTTON: "Open the stopped clip",
      MAC_LET_GO_BUTTON: "Let them go",
      MAC_LET_GO_TOAST: "Your Mac lets them go within a minute.",
      MAC_LET_GO_PENDING: "Your Mac lets them go the next time it checks in, within a minute.",
      MAC_NO_LINK_BUTTON: "It's on TikTok, no link",
      MAC_NO_LINK_CONFIRM: "Save it as on TikTok without its link? Its views show once you add the link.",
      MAC_NO_LINK_YES: "Yes, it's on TikTok",
      MAC_NO_LINK_SAVED: "Saved. Add its link later to see its views.",
      MAC_LINK_EMPTY: "Paste the link first, or tap Find it for me.",
      MAC_ROW_PRESSED: "Not sure it posted · look on your TikTok",
      MAC_AGAIN_CONFIRM: "Post it again? Only if it's not on your TikTok.",
      MAC_OPEN_BUTTON: "Open Your Mac posts TikTok",
      MAC_ON_TIKTOK_BUTTON: "It's on TikTok",
      MAC_FIND_BUTTON: "Find it for me",
      MAC_FIND_NONE: "Not found yet. Try again in a minute, or paste the link.",
      MAC_STILL_LOOKING: "Your Mac pressed Post less than 30 minutes ago. Look on your TikTok first, then try again later.",
    });
    // No word of the Mac's tells him to post it himself or names a button he doesn't have.
    for (const [name, value] of Object.entries(tiktokMacLib))
      if (typeof value === "string" && name !== "MAC_UNKNOWN_SETTING") expect(value, name).not.toMatch(/post it yourself|I posted it/i);
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
  const sendable = (store: ReturnType<typeof seed>) => store.clips.filter((x) => canSendToMac(x, store.posts.filter((p) => p.clipId === x.clipId)));
  const status409 = (message: string) => ({ status: 409, message });

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

  it("claim, steps (each one a beat) and done: posted by your Mac, through the one TikTok post", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = sendable(store)[0]!;
    expect(await api.sendToMac([c.clipId, c.clipId])).toEqual([{ clipId: c.clipId, sent: true }]);
    expect((await api.sendToMac([c.clipId]))[0]).toMatchObject({ sent: false, reason: "Your Mac already has this clip." });
    const m = knobs().mac;
    const claimed = m.claim(c.clipId, "mock-mac", 3 * MIN);
    expect(claimed).toMatchObject({ state: "working", claimedAt: claimed.beatAt });
    expect(() => m.claim(c.clipId, "another-mac")).toThrow("Another try already has this clip.");
    expect(() => m.step(c.clipId, "uploading", "another-mac")).toThrow("Another try already has this clip.");
    const stepped = m.step(c.clipId, "uploading");
    expect(Date.parse(stepped.beatAt!)).toBeGreaterThan(Date.parse(claimed.beatAt!));
    // The same step again is its beat: the step stays.
    expect(m.step(c.clipId, "uploading").step).toBe("uploading");
    expect(m.post(c.clipId)?.mac?.beatAt).toBeTruthy();
    // While the Mac works on it: no It's on TikTok, no Take it back, no Try again.
    await expect(api.markTikTokPosted(c.clipId, "https://www.tiktok.com/@lamo.clips/video/7710644811602169121")).rejects.toThrow(MAC_WORKING);
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

  it("the stuck rule (D2): beat 4:59 is the Mac's, 5:00 is stuck; a claim 50 minutes old is stuck even with fresh beats", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const [a, b] = sendable(store);
    await api.sendToMac([a!.clipId, b!.clipId]);
    const m = knobs().mac;
    m.claim(a!.clipId, "mock-mac", 20 * MIN);
    m.beat(a!.clipId, 5 * MIN - 2000);
    await expect(api.retryMac(a!.clipId, true, true)).rejects.toThrow(MAC_WORKING);
    await expect(api.markTikTokPosted(a!.clipId, undefined, undefined, true)).rejects.toThrow(MAC_WORKING);
    m.beat(a!.clipId, 5 * MIN);
    const back = await api.retryMac(a!.clipId, false, true);
    // Its claim, device and beat go; againAt says when he tapped it.
    expect(tiktokOf(back)?.mac).toEqual({ state: "waiting", since: expect.any(String), source: "upload" });
    expect((await api.tiktokMacStatus()).queue.find((j) => j.clipId === a!.clipId)).toMatchObject({ againAt: expect.any(String) });
    expect(m.claim(a!.clipId, "mac-mini-2").attempt).toBe(2);
    // 49 minutes with fresh beats: still the Mac's; 50: stuck.
    m.claim(b!.clipId, "mock-mac", 49 * MIN);
    m.beat(b!.clipId, MIN);
    await expect(api.retryMac(b!.clipId, false, true)).rejects.toThrow(MAC_WORKING);
    const p = store.posts.find((x) => x.clipId === b!.clipId && x.platform === "tiktok")!;
    p.mac = { ...p.mac!, claimedAt: iso(Date.now() - 50 * MIN) };
    expect(tiktokOf(await api.retryMac(b!.clipId, false, true))?.mac?.state).toBe("waiting");
  });

  it("after Post was pressed: Try again needs It's not on TikTok and waits out the 30-minute find window (D2)", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = sendable(store)[0]!;
    await api.sendToMac([c.clipId]);
    const m = knobs().mac;
    m.claim(c.clipId);
    m.step(c.clipId, "pressing", undefined, 10 * MIN);
    m.stopped(c.clipId, "Timed out.", true);
    expect(m.post(c.clipId)?.mac).toMatchObject({ state: "stopped", reason: MAC_PRESSED_REASON });
    expect((await api.tiktokMacStatus()).helper).toMatchObject({ state: "needs_you", reason: "Timed out.", needsYouClipId: c.clipId });
    // A post that was pressed is never claimed again by itself.
    expect(() => m.claim(c.clipId)).toThrow("Another try already has this clip.");
    await expect(api.retryMac(c.clipId)).rejects.toThrow(MAC_MAY_HAVE_POSTED);
    // Pressed 10 minutes ago: the Mac may still find it.
    await expect(api.retryMac(c.clipId, true, true)).rejects.toMatchObject(status409(MAC_STILL_LOOKING));
    expect(m.post(c.clipId)?.mac).toMatchObject({ state: "stopped", pressedAt: expect.any(String) });
    // 30 minutes after Post: it waits again; its press moves to pressedBefore (the Mac's never-twice guard reads it).
    const p = store.posts.find((x) => x.clipId === c.clipId && x.platform === "tiktok")!;
    const pressedAt = iso(Date.now() - 30 * MIN);
    p.mac = { ...p.mac!, pressedAt };
    const back = await api.retryMac(c.clipId, true, true);
    expect(tiktokOf(back)?.mac).toMatchObject({ state: "waiting", source: "upload" });
    expect(tiktokOf(back)?.mac?.pressedAt).toBeUndefined();
    const job = (await api.tiktokMacStatus()).queue.find((j) => j.clipId === c.clipId)!;
    expect(job.pressedBefore).toBe(pressedAt);
    expect(Date.parse(job.againAt!)).toBeGreaterThanOrEqual(Date.parse(pressedAt) + MAC_FIND_WINDOW_MS);
    // It answered the stopped post: the Mac that needed him goes on, and the stopped clip is no longer named.
    const h = (await api.tiktokMacStatus()).helper!;
    expect(h.state).toBe("ok");
    expect(h.needsYouClipId).toBeUndefined();
    // A claim keeps them; done drops them.
    expect(m.claim(c.clipId)).toMatchObject({ pressedBefore: pressedAt, againAt: job.againAt });
    m.done(c.clipId);
    expect((await api.tiktokMacStatus()).queue.find((j) => j.clipId === c.clipId)).toBeUndefined();
  });

  it("a waiting post that still has pressedAt is never claimed (the claim's pressed guard)", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = sendable(store)[0]!;
    await api.sendToMac([c.clipId]);
    const p = store.posts.find((x) => x.clipId === c.clipId && x.platform === "tiktok")!;
    p.mac = { ...p.mac!, pressedAt: iso(Date.now() - 40 * MIN) };
    expect(() => knobs().mac.claim(c.clipId)).toThrow("Another try already has this clip.");
  });

  it("Find it for me (D3): nothing found is a 409 and saves nothing; the next look finds it; noLink saves it without its link", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const [a, b] = sendable(store);
    await api.sendToMac([a!.clipId, b!.clipId]);
    const m = knobs().mac;
    m.claim(a!.clipId);
    m.step(a!.clipId, "pressing");
    m.stopped(a!.clipId, "Timed out.");
    const was = structuredClone(m.post(a!.clipId));
    await expect(api.markTikTokPosted(a!.clipId, undefined, "2026-11-22T14:00:00.000Z")).rejects.toMatchObject(status409(MAC_FIND_NONE));
    expect(m.post(a!.clipId)).toEqual(was);
    const found = await api.markTikTokPosted(a!.clipId);
    expect(tiktokOf(found)).toMatchObject({ status: "posted", by: "you", url: expect.stringContaining("tiktok.com") });
    expect(found.note).toBeUndefined();
    // Already his with its link: answered as it is.
    expect(tiktokOf(await api.markTikTokPosted(a!.clipId))).toEqual(tiktokOf(found));
    // It's on TikTok, no link: saved as his with no link and no finder.
    await expect(api.markTikTokPosted(b!.clipId, "https://www.tiktok.com/@lamo.clips/video/7710644811602169121", undefined, true)).rejects.toMatchObject({
      status: 400,
      message: "Send a link or noLink, not both.",
    });
    const saved = await api.markTikTokPosted(b!.clipId, undefined, undefined, true);
    expect(tiktokOf(saved)).toMatchObject({ status: "posted", by: "you" });
    expect(tiktokOf(saved)?.url).toBeUndefined();
    expect(tiktokOf(saved)?.mac).toBeUndefined();
    expect(saved.note).toBeUndefined();
  });

  it("no link while the Mac works on it before Post with fresh beats is refused, even past the 50-minute cap (D3)", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = sendable(store)[0]!;
    await api.sendToMac([c.clipId]);
    knobs().mac.claim(c.clipId, "mock-mac", 55 * MIN);
    knobs().mac.beat(c.clipId, MIN);
    await expect(api.markTikTokPosted(c.clipId, undefined, undefined, true)).rejects.toThrow(MAC_WORKING);
    // Find it for me on a working post: the Mac's answer, before the finder ever looks.
    knobs().mac.beat(c.clipId, 0);
    const p = store.posts.find((x) => x.clipId === c.clipId && x.platform === "tiktok")!;
    p.mac = { ...p.mac!, claimedAt: iso(Date.now() - MIN) };
    await expect(api.markTikTokPosted(c.clipId)).rejects.toThrow(MAC_WORKING);
    // Its beat 5 minutes old: the Mac stopped before Post, so the clip isn't on TikTok: no link is still refused
    // (it would be lost for good), and Try again puts it back for the Mac.
    knobs().mac.beat(c.clipId, 5 * MIN);
    await expect(api.markTikTokPosted(c.clipId, undefined, undefined, true)).rejects.toThrow(MAC_NOT_PRESSED);
    expect(tiktokOf(await api.retryMac(c.clipId, false, true))).toMatchObject({ status: "mac", mac: { state: "waiting" } });
  });

  it("It's on TikTok on the stopped post lets a Mac that needed him go on, as Try again does", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = sendable(store)[0]!;
    await api.sendToMac([c.clipId]);
    const m = knobs().mac;
    m.claim(c.clipId);
    m.step(c.clipId, "pressing");
    m.stopped(c.clipId, "TikTok logged your Mac out.", true);
    expect((await api.tiktokMacStatus()).helper).toMatchObject({ state: "needs_you", needsYouClipId: c.clipId });
    expect(tiktokOf(await api.markTikTokPosted(c.clipId, "https://www.tiktok.com/@lamo.clips/video/7710644811602169121"))).toMatchObject({ status: "posted", by: "you" });
    const h = (await api.tiktokMacStatus()).helper!;
    expect(h).toMatchObject({ state: "ok" });
    expect(h.reason).toBeUndefined();
    expect(h.needsYouClipId).toBeUndefined();
  });

  it("Take it back after the Mac pressed Post is refused; It's on TikTok still works", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = sendable(store)[0]!;
    await api.sendToMac([c.clipId]);
    const m = knobs().mac;
    m.claim(c.clipId);
    m.step(c.clipId, "pressing");
    m.stopped(c.clipId, "Timed out.");
    await expect(api.takeBackFromMac(c.clipId)).rejects.toThrow(MAC_MAY_HAVE_POSTED);
    expect(m.post(c.clipId)?.status).toBe("mac");
    expect(tiktokOf(await api.markTikTokPosted(c.clipId, undefined, undefined, true))).toMatchObject({ status: "posted", by: "you" });
  });

  it("Take it back: a converted post gets its old fields back, a made one goes", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const privateOne = store.clips.find((x) => !x.campaignId && store.posts.some((p) => p.clipId === x.clipId && p.platform === "tiktok" && p.privacy === "private"))!;
    const was = structuredClone(store.posts.find((p) => p.clipId === privateOne.clipId && p.platform === "tiktok"));
    await api.sendToMac([privateOne.clipId]);
    expect(knobs().mac.post(privateOne.clipId)).toMatchObject({ status: "mac", postId: was!.postId });
    const back = await api.takeBackFromMac(privateOne.clipId);
    expect(tiktokOf(back)).toEqual(was);
    await expect(api.takeBackFromMac(privateOne.clipId)).rejects.toThrow(MAC_NOT_POSTING);
    await expect(api.retryMac(privateOne.clipId)).rejects.toThrow(MAC_NOT_POSTING);
  });

  it("It's on TikTok with no link on a waiting Mac post makes it his own; its Undo gives it back to the Mac", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = sendable(store)[0]!;
    await api.sendToMac([c.clipId]);
    const mine = await api.markTikTokPosted(c.clipId, undefined, undefined, true);
    expect(tiktokOf(mine)).toMatchObject({ status: "posted", by: "you" });
    expect(tiktokOf(mine)?.mac).toBeUndefined();
    const undone = await api.undoTikTokPosted(c.clipId);
    expect(tiktokOf(undone)).toMatchObject({ status: "mac", mac: { state: "waiting" } });
  });

  it("the queue is empty while off, and an auto-posting run's Mac post waits while auto-posting is off", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = sendable(store)[0]!;
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
    const c = sendable(store)[0]!;
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

  it("a campaign clip never goes to the Mac (D1): send refuses it with and without now; Upload with TikTok is refused until TikTok approved the app", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true }, postPreset: { tiktok: { privacy: "SELF_ONLY" } } as never });
    const c = store.clips.find((x) => x.status === "posted" && canSendToMac(x, store.posts.filter((p) => p.clipId === x.clipId)))!;
    c.campaignId = "camp-1";
    for (const now of [false, true]) expect((await api.sendToMac([c.clipId], now))[0]).toEqual({ clipId: c.clipId, sent: false, reason: MAC_ROW_CAMPAIGN });
    expect(knobs().mac.post(c.clipId)?.status).not.toBe("mac");
    expect((await api.tiktokMacStatus()).queue.find((j) => j.clipId === c.clipId)).toBeUndefined();
    delete c.campaignId;
    c.auto = { runId: "r", at: "2026-11-22T10:00:00.000Z", test: "private" };
    expect((await api.sendToMac([c.clipId]))[0]).toMatchObject({ sent: false, reason: "This was a Private test, so it stays off TikTok." });
  });

  it("Upload of a campaign clip with TikTok ticked: refused with the D1 words while TikTok has not approved the app", async () => {
    const { store, api } = start();
    for (const p of ["youtube", "tiktok"]) knobs().setup.finish(p);
    knobs().setup.setAudit(false);
    await api.putSettings({ tiktokMac: { on: true } });
    const c = store.clips.find((x) => x.status === "review")!;
    c.campaignId = "camp-1";
    const tiktok = { privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: false, disableStitch: false, brandContent: true, brandOrganic: false };
    await expect(api.confirmClip(c.clipId, undefined, tiktok, ["youtube", "tiktok"])).rejects.toMatchObject({
      status: 400,
      message: "Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet. Turn TikTok off, then tap Upload.",
    });
    expect(store.posts.some((p) => p.clipId === c.clipId)).toBe(false);
  });

  it("the owner's requests (D5): Start my Mac again only while paused, Let them go only while it holds clips; the Mac's ping clears each", async () => {
    const { api } = start();
    const m = knobs().mac;
    await expect(api.tiktokMacRequest("resume")).rejects.toMatchObject(status409("Your Mac hasn't checked in yet. Set it up on your Mac."));
    await expect(api.tiktokMacRequest("stop" as never)).rejects.toMatchObject({ status: 400, message: MAC_REQUEST_PICK });
    m.ping("ok");
    await expect(api.tiktokMacRequest("resume")).rejects.toMatchObject(status409(MAC_NOT_PAUSED));
    await expect(api.tiktokMacRequest("let_go")).rejects.toMatchObject(status409(MAC_NOT_HOLDING));
    m.ping("paused", "Paused on your Mac.", undefined, { holdBefore: "2026-11-22T03:55:00.000Z", backlogAt: "2026-11-22T15:00:00.000Z", backfill: true });
    expect((await api.tiktokMacStatus()).helper).toMatchObject({ holdBefore: "2026-11-22T03:55:00.000Z", backlogAt: "2026-11-22T15:00:00.000Z", backfill: true });
    const resumed = (await api.tiktokMacRequest("resume"))!;
    expect(resumed.resumeRequest?.at).toEqual(expect.any(String));
    const held = (await api.tiktokMacRequest("let_go"))!;
    expect(held.letGoRequest?.at).toEqual(expect.any(String));
    // A ping that did something else keeps the request; the Mac's done for it clears only its own.
    m.ping("paused", "Paused on your Mac.", undefined, { holdBefore: "2026-11-22T03:55:00.000Z", resumeDone: "2026-11-22T01:00:00.000Z" });
    expect((await api.tiktokMacStatus()).helper?.resumeRequest).toEqual(resumed.resumeRequest);
    m.ping("ok", undefined, undefined, { holdBefore: "2026-11-22T03:55:00.000Z", resumeDone: resumed.resumeRequest!.at });
    let h = (await api.tiktokMacStatus()).helper!;
    expect(h.resumeRequest).toBeUndefined();
    expect(h.letGoRequest).toEqual(held.letGoRequest);
    // A ping without its extras removes them.
    expect(h.backlogAt).toBeUndefined();
    expect(h.backfill).toBeUndefined();
    m.ping("ok", undefined, undefined, { letGoDone: held.letGoRequest!.at });
    h = (await api.tiktokMacStatus()).helper!;
    expect(h.letGoRequest).toBeUndefined();
    expect(h.holdBefore).toBeUndefined();
  });

  it("a needs-you stop names its clip until an ok ping", async () => {
    const { store, api } = start();
    await api.putSettings({ tiktokMac: { on: true } });
    const c = sendable(store)[0]!;
    await api.sendToMac([c.clipId]);
    const m = knobs().mac;
    m.claim(c.clipId);
    m.stopped(c.clipId, "TikTok wants a code.", true);
    expect((await api.tiktokMacStatus()).helper?.needsYouClipId).toBe(c.clipId);
    m.ping("needs_you", "TikTok wants a code.");
    expect((await api.tiktokMacStatus()).helper?.needsYouClipId).toBe(c.clipId);
    m.ping("ok");
    expect((await api.tiktokMacStatus()).helper?.needsYouClipId).toBeUndefined();
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

describe("§47.11: a hold that is only a TikTok login", () => {
  const at = "2026-11-24T08:28:43.000Z";
  const held = helper(at, { state: "needs_you", reason: "TikTok logged your Mac out. Log in to TikTok again on your Mac.", needsYouClipId: "c1", needsYouCode: "login" });

  it("the carry-on line comes only with needsYouCode login, under the needs-you status line", () => {
    expect(MAC_LOGIN_BACK_LINE).toBe("Your Mac carries on by itself once it's logged in to your TikTok.");
    expect(loginBackLine(held)).toBe(MAC_LOGIN_BACK_LINE);
    expect(helperLine(held, NOW)).toBe("Your Mac needs you: TikTok logged your Mac out. Log in to TikTok again on your Mac.");
    for (const other of [
      { ...held, needsYouCode: undefined },
      { ...held, needsYouCode: undefined, reason: "TikTok wants a check (a puzzle or a code). Do it on your Mac, then tap Try again." },
      { ...held, state: "ok" as const },
      { ...held, state: "paused" as const },
    ]) {
      expect(loginBackLine(other)).toBeNull();
    }
    expect(loginBackLine(null)).toBeNull();
    expect(MAC_LOGIN_BACK_LINE).not.toMatch(/\b(API|cookie|session|handle|uid|Keychain|code)\b/i);
  });

  it("Settings' panel shows the line for a login hold and nothing for any other hold", async () => {
    const { MacLoginBack } = await import("../src/screens/settings/TikTokMacBranch.tsx");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    expect(renderToStaticMarkup(createElement(MacLoginBack, { helper: held }))).toBe(
      `<p class="autopost__line" data-mac="login-back">${MAC_LOGIN_BACK_LINE.replace("'", "&#x27;")}</p>`,
    );
    for (const other of [{ ...held, needsYouCode: undefined }, { ...held, state: "ok" as const }, null]) {
      expect(renderToStaticMarkup(createElement(MacLoginBack, { helper: other }))).toBe("");
    }
  });
});
