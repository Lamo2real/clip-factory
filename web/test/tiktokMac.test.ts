// Your Mac posts it on TikTok (docs/CONTRACTS.md §47): the row words, the helpers and the mock's rules.
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { mockApi } from "../src/api/mock/index.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import type { TikTokMacControls } from "../src/api/mock/tiktokMac.ts";
import type { Clip, MacHelper, PlatformPerformance, Post, PostMac } from "../src/api/types.ts";
import { calmCopy, perfStatus, postStatusLabel } from "../src/lib/metrics.ts";
import { perfFromPost } from "../src/lib/liveCache.ts";
import {
  canPostYourselfInstead,
  canSendToMac,
  macInsteadOk,
  macMayBeOnTikTok,
  helperLine,
  loginLine,
  loginRequestLine,
  MAC_MAY_HAVE_POSTED,
  MAC_NOT_POSTING,
  MAC_PRESSED_REASON,
  MAC_STEP_WORDS,
  MAC_UNDO_REFUSED,
  MAC_UNKNOWN_SETTING,
  MAC_WORKING,
  macChip,
  macOn,
  macRowWords,
  macTryAgainLabel,
  sendableLine,
  sendLots,
  waitingLine,
  whenLine,
} from "../src/lib/tiktokMac.ts";
import { canPostYourself, canPostYourselfHere, offerAfterUpload, tiktokState } from "../src/lib/tiktokYourself.ts";
import { timeWords } from "../src/lib/autopost.ts";

beforeAll(() => {
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
});

const NOW = Date.parse("2026-11-22T14:30:00.000Z");
const mac = (extra: Partial<PostMac> = {}): PostMac => ({ state: "waiting", since: "2026-11-22T14:00:00.000Z", source: "upload", ...extra });
const macPost = (extra: Partial<PostMac> = {}): Post => ({ postId: "p1", clipId: "c1", platform: "tiktok", status: "mac", mac: mac(extra) });
const helper = (seenAt: string, extra: Partial<MacHelper> = {}): MacHelper => ({ seenAt, state: "ok", ...extra });
const clip = (status: Clip["status"], extra: Partial<Clip> = {}) => ({ clipId: "c1", status, hook: "He lost it", ...extra }) as Clip;
const youtube: Post = { postId: "p0", clipId: "c1", platform: "youtube", status: "posted" };

describe("the TikTok row's words", () => {
  it("waiting, with one reason it may wait longer", () => {
    expect(macRowWords(mac(), { helper: helper(new Date(NOW - 60_000).toISOString()), now: NOW })).toBe("Waiting for your Mac");
    expect(macRowWords(mac(), { helper: undefined, now: NOW })).toBe("Waiting for your Mac");
    expect(macRowWords(mac(), { helper: null, now: NOW })).toBe("Waiting for your Mac · set up your Mac first");
    const old = new Date(NOW - 11 * 60_000).toISOString();
    expect(macRowWords(mac(), { helper: helper(old), now: NOW })).toBe(`Waiting for your Mac · your Mac was last seen ${timeWords(old, NOW)}`);
    expect(macRowWords(mac({ source: "auto" }), { helper: null, autoPostOn: false, now: NOW })).toBe("Waiting for your Mac · auto-posting is off");
    // Auto-posting on: an auto-posting run's Mac post waits like any other.
    expect(macRowWords(mac({ source: "auto" }), { helper: null, autoPostOn: true, now: NOW })).toBe("Waiting for your Mac · set up your Mac first");
    // Only an auto-posting run's post waits for auto-posting.
    expect(macRowWords(mac({ source: "sent" }), { helper: null, autoPostOn: false, now: NOW })).toBe("Waiting for your Mac · set up your Mac first");
    // The switch is off: nothing goes to the Mac, whatever else is true.
    expect(macRowWords(mac({ source: "auto" }), { helper: null, autoPostOn: false, macOn: false, now: NOW })).toBe("Waiting for your Mac · it's switched off");
    expect(macRowWords(mac(), { helper: helper(new Date(NOW).toISOString()), macOn: true, now: NOW })).toBe("Waiting for your Mac");
  });

  it("working, with each step's words", () => {
    expect(MAC_STEP_WORDS).toEqual({
      video: "Getting the video",
      opening: "Opening TikTok",
      uploading: "Uploading",
      settings: "Setting Everyone and the switches",
      pressing: "Posting",
      finding: "Finding the link",
    });
    expect(macRowWords(mac({ state: "working", step: "uploading" }))).toBe("Your Mac is posting it · Uploading");
    expect(macRowWords(mac({ state: "working" }))).toBe("Your Mac is posting it · Getting the video");
  });

  it("stopped, with the reason", () => {
    expect(macRowWords(mac({ state: "stopped", reason: "TikTok wants you to log in again." }))).toBe("Your Mac stopped: TikTok wants you to log in again.");
    expect(macTryAgainLabel(mac({ state: "stopped" }))).toBe("Try again");
    expect(macTryAgainLabel(mac({ state: "stopped", pressedAt: "2026-11-22T14:05:00.000Z" }))).toBe("It's not on TikTok, try again");
  });

  it("the clip page says the same, and its chip the state", () => {
    expect(perfStatus({ status: "mac" })).toBe("mac");
    expect(postStatusLabel({ status: "mac" })).toBe("Waiting for your Mac");
    const stack = { platform: "tiktok", status: "mac", metrics: null } as Pick<PlatformPerformance, "platform" | "status" | "metrics">;
    expect(calmCopy({ ...stack, mac: mac({ state: "working", step: "settings" }) })).toEqual({ text: "Your Mac is posting it · Setting Everyone and the switches", spinner: true });
    expect(calmCopy({ ...stack, mac: mac({ state: "stopped", reason: "A puzzle showed." }) })).toEqual({
      text: "Your Mac stopped: A puzzle showed.",
      link: { href: "/library", label: "Go to Library" },
    });
    expect(calmCopy({ platform: "tiktok", status: "posted", metrics: null, by: "you", via: "mac" })?.text).toBe(
      "Posted by your Mac. Add its TikTok link in Library to count views.",
    );
    expect(macChip({ state: "waiting" })).toBe("Waiting for your Mac");
    expect(macChip({ state: "working" })).toBe("Your Mac is posting it");
    expect(macChip({ state: "stopped" })).toBe("Your Mac stopped");
  });

  it("a live post brings its Mac state to the clip page, and drops it once posted", () => {
    const prev = { platform: "tiktok", status: "mac", account: "connected", metrics: null, refreshing: false, final: false, mac: mac() } as PlatformPerformance;
    expect(perfFromPost(macPost({ state: "working", step: "pressing" }), prev)).toMatchObject({ status: "mac", mac: { state: "working", step: "pressing" } });
    const done = perfFromPost({ postId: "p1", clipId: "c1", platform: "tiktok", status: "posted", by: "you", via: "mac", privacy: "public" }, prev);
    expect(done).toMatchObject({ status: "posted", by: "you", via: "mac" });
    expect(done.mac).toBeUndefined();
  });
});

describe("which buttons show", () => {
  it("Post it yourself stays as it is without a Mac post, and reads instead on a waiting or stopped one", () => {
    expect(tiktokState([macPost()])).toBe("mac");
    expect(canPostYourself(clip("posted"), [youtube, macPost()])).toBe(false);
    expect(canPostYourselfInstead([youtube, macPost()])).toBe(true);
    expect(canPostYourselfInstead([macPost({ state: "stopped" })])).toBe(true);
    expect(canPostYourselfInstead([macPost({ state: "working" })])).toBe(false);
    // Once the Mac pressed Post it may be on TikTok: never taken back; I posted it and Not on TikTok instead.
    const pressed = { state: "stopped" as const, pressedAt: "2026-11-22T14:10:00.000Z" };
    expect(canPostYourselfInstead([macPost(pressed)])).toBe(false);
    expect(macInsteadOk(pressed)).toBe(false);
    expect(macMayBeOnTikTok(pressed)).toBe(true);
    expect(macMayBeOnTikTok({ state: "stopped" })).toBe(false);
    expect(macMayBeOnTikTok({ state: "working", pressedAt: pressed.pressedAt })).toBe(false);
    expect(macTryAgainLabel(pressed)).toBe("It's not on TikTok, try again");
    expect(canPostYourselfInstead([youtube])).toBe(false);
    expect(canPostYourselfHere(clip("posted"), { status: "mac" })).toBe(false);
    // Posted by his Mac: his own post (by: "you").
    expect(tiktokState([{ ...youtube, platform: "tiktok", by: "you", via: "mac", privacy: "public" }])).toBe("yours");
  });

  it("Send these to my Mac takes clips that show Post it yourself, never a campaign clip or a Private test", () => {
    expect(canSendToMac(clip("posted"), [youtube])).toBe(true);
    expect(canSendToMac(clip("posted", { campaignId: "camp" }), [youtube])).toBe(false);
    expect(canSendToMac(clip("posted", { auto: { runId: "r", at: "t", test: "private" } }), [youtube])).toBe(false);
    expect(canSendToMac(clip("posted"), [youtube, macPost()])).toBe(false);
    expect(canSendToMac(clip("review"), [])).toBe(false);
  });

  it("the sheet never opens by itself after Upload while the Mac posts TikTok", () => {
    const setups = [{ platform: "tiktok", ready: true, gates: [] }] as never;
    expect(offerAfterUpload([youtube], setups)).toEqual({ offer: true, open: true });
    expect(offerAfterUpload([youtube], setups, true)).toEqual({ offer: true, open: false });
    expect(offerAfterUpload([youtube, macPost()], setups, true)).toEqual({ offer: false, open: false });
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
    expect(sendableLine(1)).toBe("1 clip shows Post it yourself.");
    expect(sendableLine(4)).toBe("4 clips show Post it yourself.");
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
    expect((await api.sendToMac([c.clipId]))[0]).toMatchObject({ sent: false, reason: "Campaign clips go on TikTok by hand. Tap Post it yourself." });
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
