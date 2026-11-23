// Does this clip fit the campaign? (docs/CONTRACTS.md §39.3, §39.5): the web's live check (lib/crFit.ts) against the
// API's golden cases when they are there, the verdict and its words, the block's one vermilion, Upload's words, the
// fixes, "Read the rules" once per page, "I read them. They're OK", and the "could earn" line with "Not now".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignFit, FitItem } from "../src/api/types.ts";
import {
  adFirst,
  canUploadOf,
  casefold,
  checkLineText,
  checkPages,
  copyStateOf,
  fitLines,
  fitMain,
  fixedWords,
  hasItem,
  headlineOf,
  isChecked,
  isNotNow,
  liveFit,
  newClipsHref,
  safeFixHref,
  saveChecked,
  saveNotNow,
  softText,
  sortItems,
  uploadOffWords,
  verdictOf,
} from "../src/lib/crFit.ts";
import { CampaignFit as Block, KEEP_IT_HERE, READ_THEM } from "../src/screens/review/CampaignFit.tsx";
import { FitSuggestion, copyWords } from "../src/screens/review/FitSuggestion.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Review's list reads the API through api(): a small fake per test.
const fake = vi.hoisted(() => ({ api: null as unknown }));
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => fake.api }));
const { reviewClips } = await import("../src/screens/review/Review.tsx");

const CID = "200ea21b-be80-4db8-b552-8e32b148604e";
const it_ = (rule: FitItem["rule"], state: FitItem["state"], text: string, fix: FitItem["fix"] = null, platform?: FitItem["platform"]): FitItem =>
  platform ? { rule, state, text, fix, platform } : { rule, state, text, fix };
const READ = { kind: "open" as const, label: "Read the rules", href: `/campaigns/${CID}#rules` };
const OK_ITEMS = [it_("length", "ok", "42 seconds. FaZe Clips takes 15 to 60."), it_("source", "ok", "Any video is fine for FaZe Clips.")];
const SEND = it_("send", "note", "After it posts, Clip Factory sends it to Content Rewards by itself.");
const CAPS = {
  youtubeTitle: "He did WHAT",
  youtubeDescription: "#Ad The clutch #FaZe @FaZeClan",
  instagram: "#Ad The clutch #FaZe @FaZeClan",
  facebook: "#Ad The clutch #FaZe @FaZeClan",
  tiktok: "#Ad The clutch #FaZe @FaZeClan",
  x: "#Ad The clutch #FaZe @FaZeClan",
};

function fit(items: FitItem[], over: Partial<CampaignFit> = {}): CampaignFit {
  const sorted = sortItems(items);
  const verdict = verdictOf(sorted);
  return {
    campaignId: CID,
    campaignName: "FaZe Clips",
    verdict,
    headline: headlineOf(verdict, "FaZe Clips", sorted),
    canUpload: canUploadOf(sorted),
    canRemake: true,
    items: sorted,
    softCodes: [],
    required: { disclosure: "#Ad", tokens: ["#FaZe", "@FaZeClan"], phrase: null },
    uploadPlaces: ["youtube", "instagram"],
    checkedAt: "2026-11-21T12:00:00.000Z",
    ...over,
  };
}

// ---------- the API's golden cases, when they are in the repo (G writes them) ----------

const CASES = join(import.meta.dirname, "..", "..", "api", "tests", "fixtures", "cr_fit_live_cases.json");
const golden: { name: string; fit: CampaignFit; card: { captions: typeof CAPS; chosen: null | string[]; tiktok: null | { brandContent: boolean } }; expect: CampaignFit }[] =
  existsSync(CASES) ? JSON.parse(readFileSync(CASES, "utf8")) : [];

describe.skipIf(!golden.length)("the live check against the API's golden cases (cr_fit_live_cases.json)", () => {
  for (const c of golden)
    it(c.name, () => {
      expect(liveFit(c.fit, { captions: c.card.captions, chosen: c.card.chosen as never, tiktok: c.card.tiktok })).toEqual(c.expect);
    });
});

describe("the live check (a port of fit.py live)", () => {
  const base = fit([
    ...OK_ITEMS,
    it_("places", "ok", "Goes to YouTube and Instagram. FaZe Clips pays for both."),
    it_("tags", "ok", "Every caption has #FaZe and @FaZeClan."),
    it_("ad", "ok", "#Ad is at the start of every caption."),
    it_("paid_switch", "ok", "Paid promotion goes on for YouTube."),
    it_("paid_switch", "note", "Instagram doesn't let apps turn on Paid partnership. #Ad and the words on the video tell viewers."),
    SEND,
  ]);

  it("B's match: a whole token, any case, a phrase with spaces folded; #Ad in the first 30 characters", () => {
    expect(hasItem("Clip #FaZe!", "#faze")).toBe(true);
    expect(hasItem("Clip #FaZeClan", "#FaZe")).toBe(false);
    expect(hasItem("by @faze.clan", "@faze")).toBe(false);
    expect(hasItem("Use  code\nFAZE now", "use code faze")).toBe(true);
    expect(adFirst("#ad wow", "#Ad")).toBe(true);
    expect(adFirst("#Sponsored wow", "#Ad")).toBe(true);
    expect(adFirst("#ad wow", "#Sponsored")).toBe(false);
    expect(adFirst(`${"x".repeat(31)} #Ad`, "#Ad")).toBe(false);
  });

  it("like Python: #Ad's place counts characters (an emoji is one), and a phrase folds like casefold (ß is ss)", () => {
    // 15 emoji and a space: 16 characters before #Ad (31 UTF-16 units). B's rule says it is at the start.
    expect(adFirst(`${"🔥".repeat(15)} #Ad`, "#Ad")).toBe(true);
    expect(adFirst(`${"🔥".repeat(30)} #Ad`, "#Ad")).toBe(false);
    expect(casefold("Straße")).toBe("strasse");
    expect(hasItem("Das GROSSE Spiel heute", "große spiel")).toBe(true);
    expect(hasItem("Die große Show", "GROSSE show")).toBe(true);
  });

  it("nothing changed: still Can earn", () => {
    const out = liveFit(base, { captions: CAPS, chosen: null, tiktok: null });
    expect(out.verdict).toBe("fits");
    expect(out.headline).toBe("Can earn on FaZe Clips");
    expect(out.canUpload).toBe(true);
  });

  it("a deleted tag is a fix the upload puts back: still Can earn, Fix it for me offered", () => {
    const out = liveFit(base, { captions: { ...CAPS, instagram: "#Ad The clutch @FaZeClan" }, chosen: null, tiktok: null });
    expect(out.verdict).toBe("fits");
    expect(out.canUpload).toBe(true);
    const fix = out.items.find((i) => i.rule === "tags" && i.state === "fix")!;
    expect(fix.text).toBe("The Instagram words are missing #FaZe. I'll put it back when it uploads.");
    expect(fix.fix).toEqual({ kind: "captions", label: "Fix it for me" });
    expect(fixedWords(out, ["youtube", "instagram"], { ...CAPS, instagram: "#Ad The clutch @FaZeClan" })).toBe("Fixed: #FaZe is back.");
    expect(fixedWords(out, ["youtube", "instagram"], { ...CAPS, instagram: "The clutch" })).toBe("Fixed: #Ad, #FaZe and @FaZeClan are back.");
  });

  it("TikTok's Branded content off: Almost ready, Upload off with its words; on again: Can earn", () => {
    const tt = fit(base.items, { uploadPlaces: ["youtube", "tiktok"] });
    const off = liveFit(tt, { captions: CAPS, chosen: ["youtube", "tiktok"], tiktok: { brandContent: false } });
    expect(off.verdict).toBe("fixable");
    expect(off.headline).toBe("Almost ready for FaZe Clips");
    expect(off.canUpload).toBe(false);
    expect(uploadOffWords(off)).toBe("Turn on Branded content for TikTok first.");
    expect(off.items.find((i) => i.fix?.kind === "tiktok_branded")?.fix?.label).toBe("Turn on Branded content");
    expect(fitMain(off)).toBeNull();
    const on = liveFit(tt, { captions: CAPS, chosen: ["youtube", "tiktok"], tiktok: { brandContent: true } });
    expect(on.verdict).toBe("fits");
    expect(on.canUpload).toBe(true);
  });

  it("a place turned off becomes a note, and back on it goes away", () => {
    const off = liveFit(base, { captions: CAPS, chosen: ["youtube"], tiktok: null });
    expect(off.items.find((i) => i.rule === "places" && i.state === "note")?.text).toBe("Instagram pays too. Turn it on to earn there as well.");
    const back = liveFit(off, { captions: CAPS, chosen: ["youtube", "instagram"], tiktok: null });
    expect(back.items.some((i) => i.rule === "places" && i.state === "note")).toBe(false);
  });
});

describe("verdicts, Upload and the block's one vermilion", () => {
  const remake = { kind: "remake" as const, label: "Make a FaZe Clips copy" };
  const newClips = { kind: "new_clips" as const, label: "Make new clips for this campaign", href: `/?campaign=${CID}` };
  const cases: { name: string; f: CampaignFit; headline: string; canUpload: boolean; main: string | null; off: string | null }[] = [
    { name: "fits", f: fit([...OK_ITEMS, SEND]), headline: "Can earn on FaZe Clips", canUpload: true, main: null, off: null },
    {
      name: "fixable: a copy",
      f: fit([it_("on_screen", "remake", "“Paid partnership” isn't on the video.", remake), ...OK_ITEMS, SEND]),
      headline: "FaZe Clips needs a copy of this clip",
      canUpload: false,
      main: "Make a FaZe Clips copy",
      off: "Tap Make a FaZe Clips copy first.",
    },
    {
      name: "fixable: one thing first",
      f: fit([it_("places", "todo", "Set up YouTube first. FaZe Clips pays for YouTube.", { kind: "open", label: "Set up YouTube", href: "/settings/posting/setup/youtube" }), ...OK_ITEMS]),
      headline: "One thing first for FaZe Clips",
      canUpload: false,
      main: "Set up YouTube",
      off: "Set up YouTube first. FaZe Clips pays for YouTube.",
    },
    {
      name: "wait",
      f: fit([it_("campaign", "todo", "Content Rewards wants the brand to check your other clips first. I'll tell you when you can post again."), ...OK_ITEMS]),
      headline: "Wait a little for FaZe Clips",
      canUpload: false,
      main: null,
      off: "Content Rewards wants the brand to check your other clips first. I'll tell you when you can post again.",
    },
    {
      name: "doesn't fit",
      f: fit([it_("length", "no", "This clip is 72 seconds. FaZe Clips takes 15 to 60 seconds.", newClips), it_("source", "ok", "Any video is fine for FaZe Clips.")]),
      headline: "This clip can't earn on FaZe Clips",
      canUpload: false,
      main: "Make new clips for this campaign",
      off: "This clip can't earn on FaZe Clips.",
    },
    {
      name: "can't tell",
      f: fit([it_("uncertain", "check", "I couldn't check: Clips must feel organic. Look yourself.", READ), it_("banned", "check", "I couldn't check: no swearing. Look yourself.", READ), ...OK_ITEMS]),
      headline: "Check 2 things, then upload",
      canUpload: true,
      main: null,
      off: null,
    },
  ];
  for (const c of cases)
    it(c.name, () => {
      expect(c.f.headline).toBe(c.headline);
      expect(c.f.canUpload).toBe(c.canUpload);
      expect(fitMain(c.f)?.fix?.label ?? null).toBe(c.main);
      expect(uploadOffWords(c.f)).toBe(c.off);
    });

  it("one check: Check 1 thing, then upload", () => {
    expect(fit([it_("uncertain", "check", "I couldn't check: x. Look yourself.", READ)]).headline).toBe("Check 1 thing, then upload");
  });

  it("problems show first, then the ok ones", () => {
    const f = fit([...OK_ITEMS, SEND, it_("ad", "fix", "#Ad isn't at the start of the YouTube words. I'll put it there when it uploads.", null, "youtube")]);
    expect(f.items.map((i) => i.state)).toEqual(["fix", "note", "ok", "ok"]);
  });

  it("the could-earn line's soft words are those of softCodes' first code, never of a stop already accepted", () => {
    const face = it_("soft", "check", "This brand wants your face on camera. Clips of other videos may be turned down.", READ);
    const half = it_("soft", "note", "Half the money is used. $3,880 is left. Post soon, before it runs out.");
    const spoken = it_("spoken", "check", "The brand wants “paid partnership” said out loud. Clip Factory can't. This clip may be turned down.", READ);
    // He accepted face_needed already (still listed, sorted first); budget_half is the one the tap accepts.
    expect(softText(fit([face, half, ...OK_ITEMS], { softCodes: ["budget_half"] }))).toBe(half.text);
    expect(softText(fit([face, half, ...OK_ITEMS], { softCodes: ["face_needed", "budget_half"] }))).toBe(face.text);
    expect(softText(fit([spoken, half], { softCodes: ["spoken_needed"] }))).toBe(spoken.text);
    expect(softText(fit([face, half], { softCodes: [] }))).toBeNull();
    expect(softText(fit([face], { softCodes: ["budget_half"] }))).toBeNull();
  });

  it("each verdict shows only its own lines (§39.3 Then): the no items, the wait item, the first todo, one thing at a time", () => {
    const ig = it_("paid_switch", "note", "Instagram doesn't let apps turn on Paid partnership. #Ad and the words on the video tell viewers.");
    const tag = it_("tags", "fix", "The Instagram words are missing #FaZe. I'll put it back when it uploads.", { kind: "captions", label: "Fix it for me" }, "instagram");
    const no = it_("length", "no", "This clip is 72 seconds. FaZe Clips takes 15 to 60 seconds.", { kind: "new_clips", label: "Make new clips for this campaign", href: `/?campaign=${CID}` });
    const settings = { kind: "open" as const, label: "Open Content Rewards settings", href: "https://contentrewards.com/c/settings", external: true };
    const todo1 = it_("places", "todo", "Add YouTube in Content Rewards first. Then tap I added it.", settings, "youtube");
    const note2 = it_("place_link", "note", "Content Rewards doesn't know your Instagram account. Add it there, then tap I added it.", settings, "instagram");
    const wait = it_("campaign", "todo", "The brand paused this campaign. I'll tell you when it opens again.");
    const check = it_("uncertain", "check", "I couldn't check: Clips must feel organic. Look yourself.", READ);
    const last = it_("deadline", "note", "Today is the last day FaZe Clips takes clips.");

    expect(fitLines(fit([no, tag, ig, SEND, ...OK_ITEMS])).lines).toEqual([no]);
    expect(fitLines(fit([wait, tag, ig, SEND, check])).lines).toEqual([wait]);
    expect(fitLines(fit([todo1, note2, ig, SEND])).lines).toEqual([todo1]);
    const fits = fitLines(fit([ig, last, tag, SEND, ...OK_ITEMS]));
    expect(fits.lines).toEqual([tag, SEND]);
    expect(fits.folded).toEqual(expect.arrayContaining([ig, last]));
    const cant = fitLines(fit([check, ig, SEND]));
    expect(cant.lines).toEqual([SEND]);
    expect(cant.folded).toEqual([ig]);
    expect(checkLineText(check.text)).toBe("Clips must feel organic. Look yourself.");
    expect(checkLineText("I couldn't check the language. FaZe Clips wants English.")).toBe("I couldn't check the language. FaZe Clips wants English.");
  });

  it("Read the rules once per page, never one per line", () => {
    const f = fit([it_("uncertain", "check", "a", READ), it_("uncertain", "check", "b", READ), it_("banned", "check", "c", READ)]);
    expect(checkPages(f.items)).toHaveLength(1);
  });

  it("new clips keep the clip's own link only for length, banned, posted and one campaign", () => {
    const link = "https://www.youtube.com/watch?v=abc";
    for (const rule of ["length", "banned", "posted", "one_campaign"] as const) expect(newClipsHref(CID, rule, link)).toBe(`/?campaign=${CID}&link=${encodeURIComponent(link)}`);
    for (const rule of ["source", "language"] as const) expect(newClipsHref(CID, rule, link)).toBe(`/?campaign=${CID}`);
    expect(newClipsHref(CID, "length", null)).toBe(`/?campaign=${CID}`);
    expect(safeFixHref({ kind: "open", label: "x", href: "//evil.example" })).toBeNull();
    expect(safeFixHref({ kind: "open", label: "x", href: "javascript:alert(1)" })).toBeNull();
    expect(safeFixHref({ kind: "open", label: "x", href: "https://contentrewards.com/c/settings" })).toEqual({ href: "https://contentrewards.com/c/settings", external: true });
  });
});

describe("where the copy stands, from the copy's own job (§39.3 The copy)", () => {
  const read = (status: "queued" | "running" | "ready" | "failed" | "canceled", clip?: "review" | "declined" | "posted" | "confirmed") => ({
    jobId: "J2",
    job: { status },
    clips: clip ? [{ clipId: "C2", status: clip, remakeOf: { clipId: "C1", jobId: "J1" } }] : [],
  });
  it("making only while its job runs; a failed, canceled or gone job, or a thrown-away copy, brings the button back", () => {
    expect(copyStateOf("C1", null, null)).toBe("none");
    expect(copyStateOf("C1", "J2", null)).toBe("unknown");
    expect(copyStateOf("C1", "J2", read("queued"))).toBe("making");
    expect(copyStateOf("C1", "J2", read("running"))).toBe("making");
    expect(copyStateOf("C1", "J2", read("failed"))).toBe("none");
    expect(copyStateOf("C1", "J2", read("canceled"))).toBe("none");
    expect(copyStateOf("C1", "J2", { jobId: "J2", job: null, clips: [] })).toBe("none");
    expect(copyStateOf("C1", "J2", read("ready", "declined"))).toBe("none");
    expect(copyStateOf("C1", "J2", read("ready"))).toBe("none");
    // An older read of another job says nothing about this one.
    expect(copyStateOf("C1", "J3", read("running"))).toBe("unknown");
  });
  it("ready only when the copy is in this Review list (or, on the clip page, waits in Review); uploaded: done", () => {
    expect(copyStateOf("C1", "J2", read("ready", "review"), true)).toBe("ready");
    expect(copyStateOf("C1", "J2", read("ready", "review"), false)).toBe("unknown");
    expect(copyStateOf("C1", "J2", read("ready", "review"))).toBe("ready");
    expect(copyStateOf("C1", "J2", read("ready", "posted"))).toBe("done");
    expect(copyStateOf("C1", "J2", read("ready", "confirmed"))).toBe("done");
  });
});

describe("the copy on Review (/review?job=)", () => {
  const clip = (clipId: string, jobId: string, status: string, over: Record<string, unknown> = {}) => ({ clipId, jobId, status, ...over });
  it("a copy stays listed after its original was thrown away (the job's clips' remakes, not only its Review clips')", async () => {
    const store = [
      clip("C1", "J1", "declined", { remakes: { [CID]: { jobId: "J2", at: "2026-11-21T10:00:00.000Z" } } }),
      clip("C3", "J1", "review"),
      clip("C2", "J2", "review", { remakeOf: { clipId: "C1", jobId: "J1" }, campaignId: CID }),
    ];
    const asked: string[] = [];
    fake.api = {
      listClips: async (q: { status?: string; jobId?: string } = {}) => {
        asked.push(`${q.status}:${q.jobId}`);
        return store.filter((c) => (q.status === "all" || c.status === (q.status ?? "review")) && (!q.jobId || c.jobId === q.jobId));
      },
    };
    const list = await reviewClips("J1");
    expect(list.map((c) => c.clipId)).toEqual(["C3", "C2"]);
    expect(asked).toEqual(["all:J1", "review:J2"]);
    // A job with no copies: one read, its Review clips only.
    asked.length = 0;
    store[0] = clip("C1", "J1", "review");
    expect((await reviewClips("J1")).map((c) => c.clipId)).toEqual(["C1", "C3"]);
    expect(asked).toEqual(["all:J1"]);
  });
});

describe("this device's answers", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("I read them: held while the lines stay, opened again by a new line; at most 200 kept", () => {
    expect(isChecked("c1", CID, ["a"])).toBe(false);
    expect(saveChecked("c1", CID, ["a", "b"])).toBe(true);
    expect(isChecked("c1", CID, ["a", "b"])).toBe(true);
    expect(isChecked("c1", CID, ["a", "b", "c"])).toBe(false);
    for (let i = 0; i < 230; i++) saveChecked(`k${i}`, CID, ["x"]);
    expect(Object.keys(JSON.parse(localStorage.getItem("cf-cr-checked")!))).toHaveLength(200);
  });

  it("Not now: kept for that clip; at most 200 clips", () => {
    expect(isNotNow("c1")).toBe(false);
    saveNotNow("c1");
    expect(isNotNow("c1")).toBe(true);
    for (let i = 0; i < 230; i++) saveNotNow(`n${i}`);
    expect(JSON.parse(localStorage.getItem("cf-cr-not-now")!)).toHaveLength(200);
  });

  it("throwing storage never breaks anything", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("no storage");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("no storage");
    });
    expect(isChecked("c1", CID, ["a"])).toBe(false);
    expect(saveChecked("c1", CID, ["a"])).toBe(false);
    expect(isNotNow("c1")).toBe(false);
    expect(saveNotNow("c1")).toBe(false);
  });
});

// ---------- the block and the line, drawn ----------

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const draw = async (node: ReactNode) => {
  await act(async () => root.render(node));
};
const buttons = () => [...host.querySelectorAll<HTMLElement>("button, a.btn")].map((b) => b.textContent?.replace(/\(opens in a new tab\)/, "").trim());
const vermilion = () => [...host.querySelectorAll<HTMLElement>(".btn--primary")].map((b) => b.textContent?.trim());

describe("the fit block (CampaignFit.tsx)", () => {
  it("fits with a missing tag: Can earn, an optional glass Fix it for me, no vermilion of its own", async () => {
    const f = fit([...OK_ITEMS, SEND, it_("tags", "fix", "The Instagram words are missing #FaZe. I'll put it back when it uploads.", { kind: "captions", label: "Fix it for me" }, "instagram")]);
    const onFix = vi.fn();
    await draw(createElement(Block, { clipId: "c1", fit: f, primary: true, onFixCaptions: onFix }));
    expect(host.textContent).toContain("Campaign clip · FaZe Clips");
    expect(host.textContent).toContain("Can earn on FaZe Clips");
    expect(host.textContent).toContain("See what's right (2)");
    expect(vermilion()).toEqual([]);
    const fixBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Fix it for me"))!;
    expect(fixBtn.className).toContain("btn--glass");
    await act(async () => fixBtn.click());
    expect(onFix).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-help]")?.getAttribute("data-help")).toBe("cr-review-strip cr-fit");
  });

  it("a copy: its vermilion is Make a FaZe Clips copy (glass on a lower card)", async () => {
    const f = fit([it_("on_screen", "remake", "“Paid partnership” isn't on the video.", { kind: "remake", label: "Make a FaZe Clips copy" }), ...OK_ITEMS]);
    const onRemake = vi.fn();
    await draw(createElement(Block, { clipId: "c1", fit: f, primary: true, onRemake }));
    expect(vermilion()).toEqual(["Make a FaZe Clips copy"]);
    await act(async () => (host.querySelector(".btn--primary") as HTMLElement).click());
    expect(onRemake).toHaveBeenCalledOnce();
    await draw(createElement(Block, { clipId: "c1", fit: f, primary: false, onRemake }));
    expect(vermilion()).toEqual([]);
    await draw(createElement(Block, { clipId: "c1", fit: f, primary: true, onRemake, copy: "making" }));
    expect(host.textContent).toContain("Making a FaZe Clips copy… It shows here in about 3 minutes.");
    expect(vermilion()).toEqual([]);
  });

  it("wait: the wait line, Keep it here, and no vermilion of its own", async () => {
    const f = fit([it_("campaign", "todo", "The brand paused this campaign. I'll tell you when it opens again."), ...OK_ITEMS]);
    await draw(createElement(Block, { clipId: "c1", fit: f, primary: true }));
    expect(host.textContent).toContain("Wait a little for FaZe Clips");
    expect(host.textContent).toContain("The brand paused this campaign.");
    expect(host.textContent).toContain(KEEP_IT_HERE);
    expect(vermilion()).toEqual([]);
  });

  it("doesn't fit: the no lines and one vermilion Make new clips for this campaign", async () => {
    const f = fit([it_("length", "no", "This clip is 72 seconds. FaZe Clips takes 15 to 60 seconds.", { kind: "new_clips", label: "Make new clips for this campaign", href: `/?campaign=${CID}` })]);
    await draw(createElement(Block, { clipId: "c1", fit: f, primary: true }));
    expect(host.textContent).toContain("This clip can't earn on FaZe Clips");
    expect(vermilion()).toEqual(["Make new clips for this campaign"]);
  });

  it("Almost ready: its own green Turn on Branded content, never folded into another button", async () => {
    const f = fit([it_("paid_switch", "fix", "Branded content is off on TikTok.", { kind: "tiktok_branded", label: "Turn on Branded content" }, "tiktok"), ...OK_ITEMS]);
    const onBranded = vi.fn();
    await draw(createElement(Block, { clipId: "c1", fit: f, primary: true, onBranded }));
    expect(host.textContent).toContain("Almost ready for FaZe Clips");
    const green = [...host.querySelectorAll<HTMLElement>(".btn--leaf")].find((b) => b.textContent?.includes("Turn on Branded content"))!;
    await act(async () => green.click());
    expect(onBranded).toHaveBeenCalledOnce();
    expect(vermilion()).toEqual([]);
  });

  it("doesn't fit shows only its no line: never the send note or the Instagram note under a can't-earn headline", async () => {
    const f = fit([
      it_("length", "no", "This clip is 72 seconds. FaZe Clips takes 15 to 60 seconds.", { kind: "new_clips", label: "Make new clips for this campaign", href: `/?campaign=${CID}` }),
      it_("paid_switch", "note", "Instagram doesn't let apps turn on Paid partnership. #Ad and the words on the video tell viewers."),
      SEND,
      ...OK_ITEMS,
    ]);
    await draw(createElement(Block, { clipId: "c1", fit: f, primary: true }));
    expect(host.textContent).toContain("This clip is 72 seconds.");
    expect(host.textContent).not.toContain("After it posts");
    expect(host.textContent).not.toContain("Instagram doesn't let apps");
  });

  it("one thing first: only the first todo, one Open Content Rewards settings, and its own green I added it", async () => {
    const settings = { kind: "open" as const, label: "Open Content Rewards settings", href: "https://contentrewards.com/c/settings", external: true };
    const f = fit([
      it_("places", "todo", "Add YouTube in Content Rewards first. Then tap I added it.", settings, "youtube"),
      it_("place_link", "note", "Content Rewards doesn't know your Instagram account. Add it there, then tap I added it.", settings, "instagram"),
      SEND,
    ]);
    const onAdded = vi.fn(async () => true);
    await draw(createElement(Block, { clipId: "c1", fit: f, primary: true, onAdded }));
    expect(host.textContent).toContain("One thing first for FaZe Clips");
    expect(host.textContent).not.toContain("Instagram account");
    expect(buttons().filter((b) => b === "Open Content Rewards settings")).toHaveLength(1);
    expect(vermilion()).toEqual(["Open Content Rewards settings (opens in a new tab)"]);
    const added = [...host.querySelectorAll<HTMLElement>(".btn--leaf")].find((b) => b.textContent?.includes("I added it"))!;
    await act(async () => added.click());
    expect(onAdded).toHaveBeenCalledWith("youtube");
  });

  it("his own check is never Clip Factory's tick: after I read them, no check mark on the headline", async () => {
    localStorage.clear();
    const f = fit([it_("uncertain", "check", "I couldn't check: Clips must feel organic. Look yourself.", READ), SEND, ...OK_ITEMS]);
    await draw(createElement(Block, { clipId: "c9", fit: f, primary: true }));
    // The things to check come right under the headline, before the send note, without saying "I couldn't check:" twice.
    const text = host.textContent ?? "";
    expect(text.indexOf("Clips must feel organic.")).toBeLessThan(text.indexOf("After it posts"));
    expect(host.querySelector(".cr-fit__checks")?.textContent).not.toContain("I couldn't check: ");
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(READ_THEM))!.click());
    expect(host.querySelector(".cr-fit__headline")?.textContent).toBe("You checked these for FaZe Clips");
    // Icon.tsx draws the same path for the same name: the headline's icon is not the fits' check mark.
    const tick = async () => {
      await act(async () => root.unmount());
      root = createRoot(host);
      await draw(createElement(Block, { clipId: "c10", fit: fit([...OK_ITEMS, SEND]), primary: true }));
      return host.querySelector(".cr-fit__headline svg")?.innerHTML;
    };
    const checkedIcon = host.querySelector(".cr-fit__headline svg")?.innerHTML;
    expect(checkedIcon).not.toBe(await tick());
  });

  it("Check 1 thing: I couldn't check these: heads only its own line; the fix and send lines sit in a list apart", async () => {
    localStorage.clear();
    const tag = it_("tags", "fix", "The Instagram words are missing #FaZe. I'll put it back when it uploads.", { kind: "captions", label: "Fix it for me" }, "instagram");
    const f = fit([it_("uncertain", "check", "I couldn't check: Clips must feel organic. Look yourself.", READ), tag, SEND, ...OK_ITEMS]);
    await draw(createElement(Block, { clipId: "c11", fit: f, primary: true, onFixCaptions: () => undefined }));
    const group = host.querySelector(".cr-fit__checks")!;
    const lead = group.querySelector(".cr-fit__lead")!;
    expect(lead.textContent).toBe("I couldn't check these:");
    // The heading names its own list (and only that one), and that list holds only the things to check.
    const own = group.querySelector("ul")!;
    expect(own.getAttribute("aria-labelledby")).toBe(lead.id);
    expect([...own.querySelectorAll("li")].map((li) => li.getAttribute("data-state"))).toEqual(["check"]);
    expect(host.querySelectorAll(`[aria-labelledby="${lead.id}"]`)).toHaveLength(1);
    // The tags line and the send note follow in their own list, outside the group, right after it.
    const more = group.nextElementSibling!;
    expect(more.matches("ul.cr-fit__lines.cr-fit__more")).toBe(true);
    expect(more.hasAttribute("aria-labelledby")).toBe(false);
    expect([...more.querySelectorAll("li")].map((li) => li.getAttribute("data-rule"))).toEqual(["tags", "send"]);
    expect(group.textContent).not.toContain("#FaZe");
    expect(group.textContent).not.toContain("After it posts");
  });

  it("the copy: making, ready and uploaded each have their line, and no copy button meanwhile", async () => {
    const f = fit([it_("on_screen", "remake", "“Paid partnership” isn't on the video.", { kind: "remake", label: "Make a FaZe Clips copy" }), ...OK_ITEMS]);
    for (const [copy, words] of [
      ["making", "Making a FaZe Clips copy… It shows here in about 3 minutes."],
      ["ready", "The FaZe Clips copy is ready, right below."],
      ["done", "The FaZe Clips copy is uploaded. You can throw this one away."],
    ] as const) {
      await draw(createElement(Block, { clipId: "c1", fit: f, primary: true, onRemake: () => undefined, copy }));
      expect(host.textContent).toContain(words);
      expect(buttons()).not.toContain("Make a FaZe Clips copy");
    }
    await draw(createElement(Block, { clipId: "c1", fit: f, primary: true, onRemake: () => undefined, copy: "none" }));
    expect(vermilion()).toEqual(["Make a FaZe Clips copy"]);
  });

  it("can't tell: I couldn't check these, Read the rules once, and I read them folds the lines (this device only)", async () => {
    localStorage.clear();
    const f = fit([it_("uncertain", "check", "I couldn't check: Clips must feel organic. Look yourself.", READ), it_("banned", "check", "I couldn't check: no swearing. Look yourself.", READ), ...OK_ITEMS]);
    await draw(createElement(Block, { clipId: "c1", fit: f, primary: true }));
    expect(host.textContent).toContain("Check 2 things, then upload");
    expect(host.textContent).toContain("I couldn't check these:");
    expect(buttons().filter((b) => b === "Read the rules")).toHaveLength(1);
    const read = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(READ_THEM))!;
    await act(async () => read.click());
    expect(host.textContent).toContain("You checked these for FaZe Clips");
    expect(host.textContent).toContain("You checked this (2)");
    expect(f.canUpload).toBe(true);
    // A changed line opens the block again.
    const changed = fit([it_("uncertain", "check", "I couldn't check: something new. Look yourself.", READ), it_("banned", "check", "I couldn't check: no swearing. Look yourself.", READ)]);
    await act(async () => root.unmount());
    root = createRoot(host);
    await draw(createElement(Block, { clipId: "c1", fit: changed, primary: true }));
    expect(host.textContent).toContain("Check 2 things, then upload");
  });
});

describe("the could-earn line (FitSuggestion.tsx)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  const suggested = fit(
    [
      it_("soft", "note", "Half the money is used. $3,880 is left. Post soon, before it runs out."),
      it_("logo", "remake", "The FaZe logo isn't on this clip.", { kind: "remake", label: "Make a FaZe Clips copy" }),
      it_("source", "ok", "From FaZe's YouTube."),
    ],
    { softCodes: ["budget_half"] },
  );

  it("two optional glass controls, the soft text, and the copy sends campaignAnyway", async () => {
    const onCopy = vi.fn();
    await draw(createElement(FitSuggestion, { clipId: "c1", fit: suggested, onCopy }));
    expect(host.textContent).toContain("This clip could earn money on FaZe Clips.");
    expect(host.textContent).toContain("I'd make a copy with its logo, “Paid partnership” and #Ad. This one stays as it is.");
    expect(host.textContent).toContain("Half the money is used.");
    expect(buttons()).toEqual(["Make a FaZe Clips copy", "Not now"]);
    expect(vermilion()).toEqual([]);
    await act(async () => (host.querySelector("button") as HTMLElement).click());
    expect(onCopy).toHaveBeenCalledWith(["budget_half"]);
    expect(copyWords({ items: [], required: suggested.required })).toBe("I'd make a copy with “Paid partnership” and #Ad. This one stays as it is.");
  });

  it("Not now hides it for that clip on this device, also when storage throws", async () => {
    await draw(createElement(FitSuggestion, { clipId: "c1", fit: suggested, onCopy: () => undefined }));
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Not now")!.click());
    expect(host.textContent).toBe("");
    expect(isNotNow("c1")).toBe(true);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("no storage");
    });
    await act(async () => root.unmount());
    root = createRoot(host);
    await draw(createElement(FitSuggestion, { clipId: "c2", fit: suggested, onCopy: () => undefined }));
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Not now")!.click());
    expect(host.textContent).toBe("");
  });

  it("not read yet: nothing at all (a copy already asked for never flashes its button)", async () => {
    await draw(createElement(FitSuggestion, { clipId: "c1", fit: suggested, onCopy: () => undefined, copy: "unknown" }));
    expect(host.textContent).toBe("");
  });

  it("the copy in Review: ready, right below", async () => {
    await draw(createElement(FitSuggestion, { clipId: "c1", fit: suggested, onCopy: () => undefined, copy: "ready" }));
    expect(host.textContent).toContain("The FaZe Clips copy is ready, right below. Upload the copy to earn money.");
    expect(buttons()).toEqual([]);
  });
});
