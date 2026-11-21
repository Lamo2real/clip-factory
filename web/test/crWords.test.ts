// lib/contentRewards.ts (docs/CONTRACTS.md §38.4–§38.8, §38.20): the words for every membership, stop, clip state,
// reason and result code; one vermilion button per next step; the grouped send-by-hand line and its copy; the
// places line; the 404 / 503 rule; money only formatted.
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import type { CampaignStop, CrConnection, CrSubmission, Membership, NextStep } from "../src/api/types.ts";
import {
  CHECK_TEXT,
  CONNECT_RESULTS,
  CONNECT_RESULT_TEXT,
  MEMBERSHIP_CHIP,
  REASON_CODES,
  STOP_CODES,
  SUB_STATES,
  afterUploadLine,
  amountText,
  budgetChip,
  crAvailability,
  crCardLine,
  crSetupCount,
  forDevice,
  nextStepFor,
  payLine,
  placesLines,
  reasonText,
  rejectHint,
  sendGroups,
  stopText,
  subLineFor,
  unlinkedPlaces,
  usd,
  usdShort,
  vermilionOf,
  type GateInput,
} from "../src/lib/contentRewards.ts";

const BANNED = /\b(mcp|oauth|tokens?|scopes?|cpm|submissions?|api)\b/i;
const ours = (t: string) => t.replace(/\*\*[^*]+\*\*/g, "");
const URL_ = "https://contentrewards.com/c/campaigns/200ea21b-be80-4db8-b552-8e32b148604e";

const conn = (over: Partial<CrConnection> = {}): CrConnection => ({
  status: "connected",
  canSubmit: true,
  crLinked: {},
  stepsDone: [],
  pilotEmail: { to: "x", subject: "y", body: "z", mailto: "mailto:x" },
  ...over,
});

const gate = (over: Partial<GateInput> = {}): GateInput => ({
  campaignId: "200ea21b-be80-4db8-b552-8e32b148604e",
  url: URL_,
  membership: "in",
  state: "active",
  access: "open",
  rulesState: "ready",
  hasRules: true,
  logoNeeded: false,
  logoReady: false,
  anyway: [],
  stops: [],
  ownVideosOnly: false,
  connection: conn(),
  ...over,
});

const stop = (code: CampaignStop["code"], hard = true): CampaignStop => ({ code, hard, text: stopText(code, { platformsPaid: ["youtube", "instagram"], leftCents: 388_000, bestPer1kCents: 50, clipUntil: "2026-11-23", audience: "40% of viewers from the US" }) });

/** How many vermilion controls a next step draws (its button, never more). */
const vermilions = (s: NextStep) => (s.button ? 1 : 0);

describe("the words", () => {
  it("every Connect result, check, membership, stop, clip state and reason has kid-proof words", () => {
    const all = [
      ...CONNECT_RESULTS.map((r) => CONNECT_RESULT_TEXT[r]),
      ...Object.values(CHECK_TEXT),
      ...Object.values(MEMBERSHIP_CHIP),
      ...STOP_CODES.map((c) => stopText(c, { platformsPaid: ["youtube"], leftCents: 100, bestPer1kCents: 50, clipUntil: "2026-11-23", audience: "viewers in the US" })),
      ...REASON_CODES.map((c) => reasonText(c, "youtube", "Logo missing.", 30)),
    ];
    expect(CONNECT_RESULTS).toHaveLength(9);
    // §39.3 added overlay_needed (a hard stop, like sound_needed).
    expect(STOP_CODES).toHaveLength(26);
    expect(REASON_CODES).toHaveLength(23);
    for (const t of all) {
      expect(t.trim(), t).not.toBe("");
      expect(BANNED.test(ours(t)), t).toBe(false);
      expect(/[–—]/.test(t), t).toBe(false);
    }
  });

  it("the contract's sentences, word for word", () => {
    expect(CONNECT_RESULT_TEXT.connected).toBe("Content Rewards is connected!");
    expect(CONNECT_RESULT_TEXT.not_allowed).toBe("Content Rewards says your account can't connect apps yet. Send the email below.");
    expect(CHECK_TEXT.ok).toBe("Content Rewards answers. You're signed in.");
    expect(stopText("deadline", { clipUntil: "2026-11-23" })).toBe("This campaign stopped taking clips on 23 Nov. Pick another one.");
    expect(stopText("budget_half", { leftCents: 388_000 })).toBe("Half the money is used. $3,880 is left. Post soon, before it runs out.");
    expect(stopText("low_rate", { bestPer1kCents: 50 })).toBe("It pays only $0.50 per 1,000 views. Most campaigns pay $1 or more. You can still make clips, or pick another one.");
    expect(stopText("no_place", { platformsPaid: ["youtube", "instagram"] })).toBe("Set up YouTube first. This campaign pays for YouTube and Instagram.");
    expect(reasonText("not_linked", "youtube")).toBe(
      "Content Rewards doesn't know this YouTube account. Open Content Rewards settings, tap **Accounts**, and add it. Then tap I added it.",
    );
    expect(MEMBERSHIP_CHIP.apply_first).toBe("Applied?");
  });

  it("a line for every clip state (§38.6)", () => {
    const base = { platform: "youtube" as const, flagged: false, views: 12_300, earned: null, minutesLeft: 12 };
    const line = (state: CrSubmission["state"], over: Partial<CrSubmission> = {}) => subLineFor({ ...base, state, ...over });
    expect(SUB_STATES).toHaveLength(9);
    for (const s of SUB_STATES) expect(line(s)).not.toBe("");
    expect(line("waiting_for_post")).toBe("Goes to Content Rewards after it posts.");
    expect(line("sending")).toBe("Sending to Content Rewards…");
    expect(line("sent")).toBe("Sent ✓ · Waiting for the brand to check it");
    expect(line("sent", { flagged: true })).toBe("On hold: Content Rewards is checking the views.");
    expect(line("approved")).toBe("Approved ✓ · 12.3K views on YouTube");
    expect(line("approved", { earned: { paidCents: 310, pendingCents: 0 } })).toBe("Approved ✓ · 12.3K views on YouTube Earned on Content Rewards: $3.10 so far.");
    expect(line("rejected", { reason: { code: "refused", text: "", brandSaid: "Logo missing in the first seconds." } })).toBe("Not approved: “Logo missing in the first seconds.”");
    expect(line("rejected")).toBe("Not approved: The brand gave no reason.");
    expect(line("rejected", { appeal: { href: "x", words: "y", askedAt: new Date().toISOString() } })).toBe("Asked again ✓ · The answer takes 2 to 7 days.");
    expect(line("send_by_hand")).toBe("Send this to Content Rewards now (12 min left)");
    expect(line("send_by_hand", { reason: { code: "not_sent_by_app", text: "" } })).toBe("Clip Factory couldn't send this one. Send it yourself now (12 min left).");
    expect(line("send_by_hand", { minutesLeft: 4, reason: { code: "not_visible_yet", text: "" } })).toBe("Content Rewards can't see this post yet. Send it yourself now (4 min left).");
    expect(line("sent_by_hand")).toBe("You sent it ✓ · Looking for it on Content Rewards…");
    expect(line("missed")).toContain("Too late to send this one.");
    expect(line("sent", { removed: true })).toBe("Content Rewards took this clip off the campaign. It earns nothing more.");
    expect(line("approved", { postGone: true })).toBe("The post is gone from YouTube, so it stops earning.");
    expect(rejectHint("Logo missing")).toMatch(/^Next time:/);
    expect(rejectHint("Too short")).toMatch(/^Next time:/);
    expect(rejectHint("nice")).toBeNull();
  });
});

describe("the next step: one vermilion button, or none while he only waits (§38.4)", () => {
  const refusedConn = conn({ status: "not_connected", canSubmit: false, lastResult: "not_allowed" });
  const rows: [string, Partial<GateInput>, NextStep["kind"], string | null][] = [
    ["unknown", { membership: "unknown", connection: conn({ status: "not_connected", canSubmit: false }) }, "connect", "Connect Content Rewards"],
    ["unknown + refused", { membership: "unknown", connection: refusedConn }, "check_yourself", "Open campaign"],
    ["not_joined", { membership: "not_joined" }, "join", "Open campaign"],
    ["apply_first", { membership: "apply_first", access: "application" }, "applied", "Yes, I applied"],
    ["waiting", { membership: "waiting", access: "application", said: "applied" }, "wait", null],
    ["in", { membership: "in" }, "make_clips", "Make clips for this campaign"],
    ["in + paused", { membership: "in", stops: [stop("paused")] }, "stop", null],
    ["left", { membership: "left" }, "join", "Open campaign"],
    ["not_accepted", { membership: "not_accepted", said: "not_eligible" }, "pick_another", "Find another campaign"],
    ["manual", { membership: "manual" }, "make_clips", "Make clips for this campaign"],
    ["manual, rules hidden", { membership: "manual", rulesState: "waiting_for_join" }, "rules_paste", "Open campaign"],
    ["rules reading", { rulesState: "reading" }, "stop", null],
    ["rules failed", { rulesState: "failed" }, "rules_paste", "Open campaign"],
    ["logo", { logoNeeded: true }, "logo", "Add the logo"],
    ["soft stops", { stops: [stop("budget_half", false), stop("face_needed", false)] }, "anyway", "Make clips anyway"],
    ["soft stops accepted", { stops: [stop("budget_half", false)], anyway: ["budget_half"] }, "make_clips", "Make clips for this campaign"],
    ["own videos only", { ownVideosOnly: true }, "pick_video", null],
    ["ended", { stops: [stop("ended")] }, "pick_another", null],
    ["tiktok only", { stops: [stop("tiktok_only")] }, "pick_another", null],
    ["no place", { stops: [{ ...stop("no_place"), fixHref: "/settings/posting/setup/youtube" }] }, "stop", "Set it up"],
  ];
  it.each(rows)("%s", (_name, over, kind, label) => {
    const step = nextStepFor(gate(over));
    expect(step.kind).toBe(kind);
    expect(vermilions(step)).toBeLessThanOrEqual(1);
    expect(vermilionOf(step)).toBe(label);
    expect(step.chip.trim()).not.toBe("");
    for (const t of [step.text, step.sub ?? "", ...(step.asks ?? []).map((a) => a.label)]) expect(BANNED.test(ours(t)), t).toBe(false);
  });

  it("the not_connected note never asks for Make clips anyway", () => {
    const step = nextStepFor(gate({ membership: "manual", connection: conn({ status: "not_connected", canSubmit: false }), stops: [stop("not_connected", false)] }));
    expect(step.kind).toBe("make_clips");
    expect(step.sub).toContain("Clip Factory isn't connected to Content Rewards");
  });

  it("the rules box: with text in it, the vermilion is the box's button instead", () => {
    const check = nextStepFor(gate({ membership: "unknown", connection: refusedConn }));
    expect(vermilionOf(check, "")).toBe("Open campaign");
    expect(vermilionOf(check, "Use #FaZe")).toBe("I'm in. Read these rules");
    const paste = nextStepFor(gate({ membership: "manual", rulesState: "waiting_for_join" }));
    expect(vermilionOf(paste, "  ")).toBe("Open campaign");
    expect(vermilionOf(paste, "Use #FaZe")).toBe("Read these rules");
    expect(check.asks?.map((a) => a.label)).toEqual(["It says Submit clip"]);
  });

  it("application campaigns offer the quiet asks; a phone's vermilion is Set up Content Rewards (§39.1)", () => {
    const apply = nextStepFor(gate({ membership: "apply_first", access: "application" }));
    expect(apply.asks?.map((a) => a.label)).toEqual(["It says Not eligible", "It says Submit clip"]);
    const step = nextStepFor(gate({ membership: "unknown", connection: conn({ status: "not_connected", canSubmit: false }) }));
    const phone = forDevice(step, true);
    // The same setup page, with the way back to this campaign's card (steps 1 and 2 work on a phone).
    expect(phone.button).toEqual({ label: "Set up Content Rewards", href: step.button!.href, external: false });
    expect(phone.button!.href).toMatch(/^\/settings\/posting\/setup\/contentrewards\?back=\/campaigns\/[0-9a-f-]{36}$/);
    expect(phone.text).toBe("Connect Content Rewards on your Mac, so I can see if you're in.");
  });

  it("every membership has a chip", () => {
    const all: Membership[] = ["unknown", "not_joined", "apply_first", "waiting", "in", "left", "not_accepted", "manual"];
    for (const m of all) expect(MEMBERSHIP_CHIP[m]).not.toBe("");
  });
});

describe("send by hand: one line for one clip's posts to one campaign", () => {
  const sub = (postId: string, platform: CrSubmission["platform"], minutesLeft: number, clipId = "c1"): CrSubmission => ({
    postId,
    clipId,
    clipTitle: "Big win",
    campaignId: "k1",
    campaignName: "FaZe Clips",
    platform,
    url: `https://example.com/${postId}`,
    state: "send_by_hand",
    line: "",
    minutesLeft,
    views: null,
    earned: null,
    openCampaignHref: URL_,
    updatedAt: "2026-11-21T10:00:00Z",
  });

  it("two posts → one line with the smallest minutes left, its copy the links one per line", () => {
    const groups = sendGroups([sub("p2", "instagram", 20), sub("p1", "youtube", 12), { ...sub("p3", "x", 9), state: "sent" }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.line).toBe("Send these 2 to Content Rewards now (12 min left)");
    expect(groups[0]!.copy).toBe("https://example.com/p1\nhttps://example.com/p2");
    expect(groups[0]!.postIds).toEqual(["p1", "p2"]);
    expect(groups[0]!.openHref).toBe(URL_);
  });

  it("one post keeps its own sentence; no time left or no link: no line", () => {
    expect(sendGroups([sub("p1", "youtube", 12)])[0]!.line).toBe("Send this to Content Rewards now (12 min left)");
    expect(sendGroups([sub("p1", "youtube", 0)])).toEqual([]);
    expect(sendGroups([{ ...sub("p1", "youtube", 5), url: undefined }])).toEqual([]);
    expect(sendGroups([sub("p1", "youtube", 5, "a"), sub("p2", "youtube", 5, "b")])).toHaveLength(2);
  });
});

describe("places, connection and money", () => {
  it("Upload to's lines: only paid places, and TikTok left out until its audit", () => {
    expect(placesLines({ platformsPaid: ["youtube", "instagram"], uploadPlaces: ["youtube"] })).toEqual(["Only places this campaign pays for."]);
    expect(placesLines({ platformsPaid: ["youtube", "tiktok"], uploadPlaces: ["youtube"] })[1]).toBe(
      "TikTok is left out for now. Until TikTok checks Clip Factory, TikTok posts are private, and private posts can't earn.",
    );
    expect(placesLines({ platformsPaid: ["youtube", "tiktok"], uploadPlaces: ["youtube", "tiktok"] })).toHaveLength(1);
    expect(unlinkedPlaces({ platformsPaid: ["youtube", "instagram"] }, conn({ crLinked: { youtube: false, instagram: true } }))).toEqual(["youtube"]);
    expect(unlinkedPlaces({ platformsPaid: ["instagram"] }, conn({ crLinked: { youtube: false } }))).toEqual([]);
  });

  it("the line above Upload says who sends it", () => {
    expect(afterUploadLine(conn(), "in")).toBe("After it posts, Clip Factory sends it to Content Rewards by itself.");
    for (const [c, m] of [
      [conn({ status: "read_only", canSubmit: false }), "in"],
      [conn(), "manual"],
      [conn({ status: "not_connected", canSubmit: false }), "manual"],
    ] as const)
      expect(afterUploadLine(c, m)).toBe("After it posts, send its link to Content Rewards within 30 minutes. I'll remind you.");
  });

  it("the setup card's line and ring", () => {
    expect(crCardLine(conn({ status: "not_connected", canSubmit: false }), true)).toBe("Not started");
    expect(crCardLine(conn({ status: "not_connected", canSubmit: false, stepsDone: ["ready-account"] }), true)).toBe("Step 2 of 3");
    expect(crCardLine(conn({ status: "not_connected", canSubmit: false, stepsDone: ["ready-account", "ready-socials"] }), false)).toBe("Do this on your Mac");
    expect(crCardLine(conn(), true)).toBe("Ready: sends your clips for you");
    expect(crCardLine(conn({ status: "read_only", canSubmit: false }), true)).toBe("Ready: you send clips yourself");
    expect(crCardLine(conn({ status: "read_only", canSubmit: false, pilotSentAt: "2026-11-21T00:00:00Z" }), true)).toBe("Waiting for Content Rewards to say yes");
    expect(crCardLine(conn({ status: "needs_reconnect", canSubmit: false }), true)).toBe("Needs you: sign in again");
    expect(crSetupCount(conn({ crLinked: { youtube: true } }))).toBe(3);
    expect(crSetupCount(conn({ status: "not_connected", canSubmit: false, stepsDone: ["ready-socials"], crLinked: { youtube: false } }))).toBe(0);
  });

  it("the 404 / 503 rule: only a 503 with code unavailable is Coming soon", () => {
    expect(crAvailability(new ApiError(404, "not_found", "x"))).toBe("missing");
    expect(crAvailability(new ApiError(503, "unavailable", "x"))).toBe("soon");
    expect(crAvailability(new ApiError(503, "platform_down", "Content Rewards didn't answer."))).toBe("error");
    expect(crAvailability(new ApiError(503, "internal", "x"))).toBe("error");
    expect(crAvailability(new Error("boom"))).toBe("error");
  });

  it("money is only formatted", () => {
    expect(usd(420)).toBe("$4.20");
    expect(usd(5)).toBe("$0.05");
    expect(usd(789_000)).toBe("$7,890.00");
    expect(usd(null)).toBe("");
    expect(usdShort(850_000)).toBe("$8,500");
    expect(usdShort(1825)).toBe("$18.25");
    expect(amountText(1_234_567)).toBe("12345.67");
    expect(budgetChip(7)).toBe("Plenty left");
    expect(budgetChip(56)).toBe("Half used");
    expect(budgetChip(95)).toBe("Almost gone");
    expect(budgetChip(null)).toBeNull();
    expect(payLine({ platform: "youtube", per1kCents: 100, perPostCents: null, minPayoutCents: 200, maxPayoutCents: 20_000, minViews: null }, "cpm")).toBe(
      "$1.00 per 1,000 views · up to $200.00 a clip · a clip starts paying once it has earned $2.00",
    );
    expect(payLine({ platform: "youtube", per1kCents: null, perPostCents: 500, minPayoutCents: null, maxPayoutCents: null, minViews: 1000 }, "per_post")).toBe(
      "$5.00 for each approved post · needs 1,000 views",
    );
    expect(payLine({ platform: "youtube", per1kCents: null, perPostCents: null, minPayoutCents: null, maxPayoutCents: null, minViews: null }, "pool")).toBe("Shares the prize money");
  });
});
