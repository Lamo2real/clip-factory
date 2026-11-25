// A Review card's TikTok while the owner's Mac posts TikTok (docs/CONTRACTS.md §47), rendered on the mock API. With
// Your Mac posts TikTok on (and TikTok not approving the app yet) a card with TikTok ticked starts on My settings like
// every other place: Everyone, Comments, Duet and Stitch on, no tap before Upload, and TikTok's API answer (creator
// info) asked in the background but never waited for. TikTok's row is the clip's own (§47.9, 24 Nov): Who can see it
// (TikTok Studio's Everyone, Friends, Only me), the switches and Commercial content, and Upload sends exactly that with
// `tiktokMac`, so the Mac posts it with TikTok's label; nothing holds Upload for a label any more. With the Mac off,
// TikTok's API rule stays exactly as it was: nothing picked, the switches off, Upload held until the owner taps Use my
// settings, and every ask for creator info is the card's own.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import { mockApi } from "../src/api/mock/index.ts";
import type { Api, Platform, Settings, TikTokCreator, TikTokPostOptions } from "../src/api/types.ts";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { DEFAULT_PRESET } from "../src/lib/preset.ts";
import { MAC_HINT, MAC_WHERE_LINE } from "../src/lib/tiktokMac.ts";
import * as tiktokMacLib from "../src/lib/tiktokMac.ts";
import * as tiktokChoicesLib from "../src/lib/tiktokChoices.ts";
import { BRANDED_PRIVATE_LINE, MAC_PRIVACY_OPTIONS, macCreator, macTikTokChoices, NO_TIKTOK_CHOICES, PICK_WHOSE, tiktokOptions } from "../src/lib/tiktokChoices.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Api;
vi.mock("../src/api/index.ts", () => ({ api: () => current }));
vi.mock("../src/lib/config.ts", () => ({ config: () => ({ wsUrl: "ws://test" }), isMock: true }));
vi.mock("../src/lib/live.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/live.ts")>()),
  startLive: () => undefined,
  stopLive: () => undefined,
  useLiveEvents: () => undefined,
  useLivePoll: () => undefined,
}));

const { SessionProvider, useSession } = await import("../src/app/session.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { Review } = await import("../src/screens/review/Review.tsx");

type Knobs = {
  setup: { finish(p: Platform): void; setAudit(passed: boolean): void };
  posting: { posts(clipId: string): { platform: string; status: string }[]; clip(clipId: string): { tiktokLabel?: { brandContent: boolean; brandOrganic: boolean } } };
  mac: {
    queue(): { clipId: string; privacy: string; comment: boolean; duet: boolean; stitch: boolean; brandContent: boolean; brandOrganic: boolean }[];
    ping(): { on: boolean };
  };
};
const knobs = () => (window as unknown as { __cfMock: Knobs }).__cfMock;

const ASK = "Tap Use my settings first. TikTok needs your tap.";
const EVERY = "Tap a place below to change it for this clip.";
const OTHERS = "Tap this first. TikTok needs your tap.";

let root: Root;
let app: HTMLElement;
let creatorAsks = 0;
let meAnswered = false;
let sent: (TikTokPostOptions | undefined)[] = [];
/** Each Upload's `tiktokMac` and places, as the body says them. */
let sentMac: (boolean | undefined)[] = [];
let sentPlaces: (Platform[] | undefined)[] = [];
let session: ReturnType<typeof useSession> | null = null;
/** Keeps the session in reach, to change a setting while the cards are open (another device, or Settings). */
function Grab() {
  session = useSession();
  return null;
}
const flush = (ms = 0) => act(async () => new Promise((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 200 && !ok(); i++) await flush(10);
  expect(ok(), what).toBe(true);
}
const card = () => document.querySelector<HTMLElement>(".review-card")!;
const cards = () => Array.from(document.querySelectorAll<HTMLElement>(".review-card"));
const inCard = (selector: string) => card()?.querySelector<HTMLElement>(selector) ?? null;
const buttonIn = (el: HTMLElement, name: RegExp | string) =>
  Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent?.trim() ?? "")));
const upload = () => buttonIn(card(), /^Upload( to .+)?$/)!;
const tiktokLine = () => inCard('[data-place="tiktok"] .place-row__now')?.textContent ?? "";
const click = (el: HTMLElement) => act(async () => el.click());
const tiktokRowOf = (c: HTMLElement = card()) => c.querySelector<HTMLElement>('[data-place="tiktok"]')!;
const switchesIn = (el: HTMLElement) =>
  Array.from(el.querySelectorAll<HTMLElement>('[role="switch"]')).map((s) => s.closest(".toggle-row")?.querySelector(".toggle-row__label")?.textContent ?? "");
const switchIn = (el: HTMLElement, label: string) =>
  Array.from(el.querySelectorAll<HTMLElement>('[role="switch"]')).find((s) => s.closest(".toggle-row")?.querySelector(".toggle-row__label")?.textContent === label)!;
const hasCheck = (el: HTMLElement, label: string) => Array.from(el.querySelectorAll<HTMLLabelElement>("label.check-chip")).some((l) => l.textContent?.includes(label));
const checkIn = (el: HTMLElement, label: string) =>
  Array.from(el.querySelectorAll<HTMLLabelElement>("label.check-chip")).find((l) => l.textContent?.includes(label))!.querySelector<HTMLInputElement>("input")!;
/** Who can see it, in TikTok's row: its choices as listed, and a pick. */
const privacyButton = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('.dropdown__button[aria-haspopup="listbox"]')!;
async function privacyNames(row: HTMLElement): Promise<{ name: string; off: boolean; line: string }[]> {
  await click(privacyButton(row));
  const out = Array.from(row.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => ({
    name: o.querySelector(".dropdown__name")!.textContent ?? "",
    off: o.getAttribute("aria-disabled") === "true",
    line: o.querySelector(".dropdown__line")?.textContent ?? "",
  }));
  await click(privacyButton(row));
  return out;
}
async function pickPrivacy(row: HTMLElement, name: string) {
  await click(privacyButton(row));
  const option = Array.from(row.querySelectorAll<HTMLElement>('[role="option"]')).find((o) => o.querySelector(".dropdown__name")!.textContent === name)!;
  await click(option);
}
/** Opens TikTok's row and waits for its switches. */
async function openTikTok(): Promise<HTMLElement> {
  await click(inCard('[data-place="tiktok"] summary')!);
  const row = tiktokRowOf();
  await until(() => !!switchIn(row, "Commercial content") && !!privacyButton(row), "TikTok's row, open");
  return row;
}
/** The "Upload to" chip of a place. */
const chip = (name: string) => Array.from(card().querySelectorAll<HTMLButtonElement>(".upload-to button")).find((b) => b.textContent?.trim() === name)!;

/**
 * The mock with YouTube and TikTok set up, TikTok not approving the app yet, Your Mac posts TikTok `mac`, and Upload
 * to YouTube and TikTok remembered on this device. `creator` replaces TikTok's creator-info answer.
 */
async function mount({
  mac,
  audited = false,
  creator,
  tiktok,
  seen = true,
}: {
  mac: boolean;
  /** The Mac checked in (a set-up Mac); false: it never did. */
  seen?: boolean;
  audited?: boolean;
  creator?: () => Promise<TikTokCreator>;
  /** My settings' TikTok choices (the defaults when absent). */
  tiktok?: Partial<typeof DEFAULT_PRESET.tiktok>;
}) {
  const store = seed();
  store.settings = {
    ...store.settings,
    tiktokMac: { on: mac },
    ...(tiktok ? { postPreset: { ...DEFAULT_PRESET, tiktok: { ...DEFAULT_PRESET.tiktok, ...tiktok } } as Settings["postPreset"] } : {}),
  };
  const api = mockApi(store);
  for (const p of ["youtube", "tiktok"] as const) knobs().setup.finish(p);
  knobs().setup.setAudit(audited);
  if (mac && seen) knobs().mac.ping();
  localStorage.setItem("cf-upload-to", JSON.stringify(["youtube", "tiktok"]));
  const askCreator = creator ?? api.tiktokCreatorInfo.bind(api);
  const confirm = api.confirmClip.bind(api);
  current = {
    ...api,
    me: async () => {
      const me = await api.me();
      meAnswered = true;
      return me;
    },
    tiktokCreatorInfo: () => {
      creatorAsks++;
      return askCreator();
    },
    confirmClip: (clipId, captions, tiktok, platforms, options, tiktokMac) => {
      sent.push(tiktok);
      sentMac.push(tiktokMac);
      sentPlaces.push(platforms);
      return confirm(clipId, captions, tiktok, platforms, options, tiktokMac);
    },
  };
  app = document.createElement("div");
  app.className = "app";
  document.body.append(app);
  root = createRoot(app);
  await act(async () =>
    root.render(
      <ToastProvider>
        <SessionProvider onSignOut={() => undefined}>
          <Grab />
          <main id="main">
            <Review jobId={null} />
          </main>
        </SessionProvider>
      </ToastProvider>,
    ),
  );
  await until(() => meAnswered && !!inCard(".my-settings") && !!inCard('[data-place="tiktok"]'), "the first card, with TikTok ticked");
  await flush(10);
  return card().closest("li")!.id.replace("clip-", "");
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  forgetLoaded();
  creatorAsks = 0;
  meAnswered = false;
  sent = [];
  sentMac = [];
  sentPlaces = [];
  session = null;
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, addEventListener: () => undefined, removeEventListener: () => undefined }));
  (window as unknown as { __cfMockFaults?: { latencyMs?: number } }).__cfMockFaults = { latencyMs: 0 };
  Element.prototype.scrollIntoView ??= () => undefined;
});

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  delete (window as unknown as { __cfMockFaults?: unknown }).__cfMockFaults;
  vi.unstubAllGlobals();
});

describe("the Mac's choices (pure)", () => {
  it("TikTok Studio's privacy choices and switches, whatever TikTok's API offers the app; its answer only names the account and the longest clip", () => {
    const api: TikTokCreator = {
      nickname: "Lamo",
      username: "lamo.clips",
      privacyOptions: ["SELF_ONLY"],
      commentDisabled: true,
      duetDisabled: true,
      stitchDisabled: true,
      maxDurationSec: 180,
    };
    expect(macCreator(api)).toEqual({ ...api, privacyOptions: [...MAC_PRIVACY_OPTIONS], commentDisabled: false, duetDisabled: false, stitchDisabled: false });
    // Not asked yet, slow or failed: still enough to upload, with no name and no length limit.
    expect(macCreator(null)).toMatchObject({ nickname: "", privacyOptions: [...MAC_PRIVACY_OPTIONS], maxDurationSec: 0 });
  });

  it("starts on My settings: the saved privacy (one of TikTok Studio's) and switches, Commercial content as ticked on the clip", () => {
    expect(MAC_PRIVACY_OPTIONS).toEqual(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]);
    const start = macTikTokChoices(DEFAULT_PRESET.tiktok);
    expect(start).toEqual({ privacy: "PUBLIC_TO_EVERYONE", comments: true, duet: true, stitch: true, commercial: false, yourBrand: false, branded: false });
    expect(tiktokOptions(start, macCreator(null))).toEqual({
      privacyLevel: "PUBLIC_TO_EVERYONE",
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
      brandContent: false,
      brandOrganic: false,
    });
    const friends = { privacy: "MUTUAL_FOLLOW_FRIENDS", comments: false, duet: true, stitch: false };
    expect(macTikTokChoices(friends)).toMatchObject(friends);
    // A ticked paid partnership stays ticked, and goes to the Mac as TikTok's label.
    const paid = { ...NO_TIKTOK_CHOICES, commercial: true, branded: true };
    expect(macTikTokChoices(friends, paid)).toMatchObject({ ...friends, commercial: true, branded: true });
    expect(tiktokOptions(macTikTokChoices(friends, paid), macCreator(null))).toMatchObject({ privacyLevel: "MUTUAL_FOLLOW_FRIENDS", brandContent: true, brandOrganic: false });
    // What the card had for TikTok's API path never leaks in: only Commercial content is the clip's own at the start.
    expect(macTikTokChoices(DEFAULT_PRESET.tiktok, { ...NO_TIKTOK_CHOICES, privacy: "SELF_ONLY", comments: false })).toEqual(start);
    // Unset (an old preset), or Followers (TikTok Studio has no such choice), starts on Everyone.
    expect(macTikTokChoices({ ...DEFAULT_PRESET.tiktok, privacy: "" }).privacy).toBe("PUBLIC_TO_EVERYONE");
    expect(macTikTokChoices({ ...DEFAULT_PRESET.tiktok, privacy: "FOLLOWER_OF_CREATOR" }).privacy).toBe("PUBLIC_TO_EVERYONE");
  });

  it("the holds and the read-only row are gone", () => {
    for (const gone of ["macPostsLine", "macTikTokHeld", "MAC_LABEL_HELD", "MAC_COMMERCIAL_HELD"]) expect(gone in tiktokChoicesLib, gone).toBe(false);
    for (const gone of ["commercialRow", "MAC_ROW_COMMERCIAL", "MAC_ROW_CAMPAIGN"]) expect(gone in tiktokMacLib, gone).toBe(false);
  });
});

describe("Review card while the Mac posts TikTok", () => {
  it("starts on My settings: Everyone with the switches on, no tap, and Upload goes at once", async () => {
    const clipId = await mount({ mac: true });
    expect(buttonIn(card(), "Your settings are on")).toBeTruthy();
    expect(buttonIn(card(), "Use my settings")).toBeUndefined();
    expect(inCard(".my-settings__note")!.textContent).toBe(EVERY);
    expect(tiktokLine()).toContain("Who can see it: Everyone · Comments on · Duet on · Stitch on");
    expect(tiktokLine()).not.toContain("not picked yet");
    expect(upload().getAttribute("aria-disabled")).toBeNull();
    expect(inCard(".upload-going")!.textContent).toBe("Going to: YouTube · TikTok");
    expect(inCard(".tt-yourself-hint")!.textContent).toBe(MAC_HINT);
    expect(MAC_HINT).toBe("TikTok: your Mac posts it for everyone.");
    // TikTok's API is asked in the background, for the account's name and the longest clip only: once for every card.
    await until(() => tiktokLine().startsWith("Posting as "), "TikTok's answer names the account");
    expect(document.querySelectorAll(".review-card").length).toBeGreaterThan(1);
    expect(creatorAsks).toBe(1);
    expect(tiktokLine()).toContain("Who can see it: Everyone · Comments on · Duet on · Stitch on");

    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    expect(sent[0]).toEqual({ privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: false, disableStitch: false, brandContent: false, brandOrganic: false });
    // The card's own row, so the Mac posts exactly that.
    expect(sentMac[0]).toBe(true);
    await until(() => knobs().posting.posts(clipId).length === 2, "its posts");
    const posts = knobs().posting.posts(clipId);
    expect(posts.find((p) => p.platform === "tiktok")?.status).toBe("mac");
    expect(posts.find((p) => p.platform === "youtube")?.status).toBe("queued");
    // The Mac's job: Everyone, with Comment, Duet and Stitch on.
    expect(knobs().mac.queue().find((j) => j.clipId === clipId)).toMatchObject({ privacy: "PUBLIC_TO_EVERYONE", comment: true, duet: true, stitch: true });
  });

  it("TikTok's answer failing never holds Upload, says nothing about it, and the row still says what the Mac posts", async () => {
    const clipId = await mount({ mac: true, creator: () => Promise.reject(new ApiError(502, "platform_down", "TikTok did not answer.")) });
    await until(() => creatorAsks === 1, "TikTok was asked");
    await flush(20);
    expect(card().textContent).not.toContain("TikTok did not answer");
    expect(card().textContent).not.toContain("Ask TikTok again");
    expect(buttonIn(card(), "Your settings are on")).toBeTruthy();
    expect(tiktokLine()).toBe("Who can see it: Everyone · Comments on · Duet on · Stitch on");
    expect(upload().getAttribute("aria-disabled")).toBeNull();
    // Opening the row: its own choices (TikTok Studio's), no name (Posting as is left out in this mode only), and
    // TikTok is asked once more.
    const asked = creatorAsks;
    const row = await openTikTok();
    await until(() => creatorAsks === asked + 1, "opening the row asks TikTok again");
    expect(privacyButton(row).textContent).toContain("Everyone");
    expect(switchesIn(row)).toEqual(["Comments", "Duet", "Stitch", "Commercial content"]);
    expect(row.textContent).not.toContain("Posting as");
    expect(row.querySelector('[role="alert"]')).toBeNull();

    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    expect(sent[0]?.privacyLevel).toBe("PUBLIC_TO_EVERYONE");
    await until(() => knobs().posting.posts(clipId).find((p) => p.platform === "tiktok")?.status === "mac", "the Mac's post");
  });

  it("TikTok's answer being slow never holds Upload either", async () => {
    await mount({ mac: true, creator: () => new Promise<TikTokCreator>(() => undefined) });
    await until(() => creatorAsks === 1, "TikTok was asked");
    expect(inCard(".upload-going")!.textContent).toBe("Going to: YouTube · TikTok");
    expect(card().textContent).not.toContain("Asking TikTok");
    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    expect(sent[0]?.privacyLevel).toBe("PUBLIC_TO_EVERYONE");
  });

  it("a clip longer than TikTok takes still says so, once TikTok's answer gives the limit", async () => {
    await mount({ mac: true, creator: async () => ({ ...macCreator(null), nickname: "Lamo", username: "lamo", maxDurationSec: 5 }) });
    await until(() => inCard(".upload-going")!.textContent === "This clip is too long for TikTok. Untick TikTok to upload it to the rest.", "the too-long line");
    expect(upload().getAttribute("aria-disabled")).toBe("true");
    await click(upload());
    expect(sent).toEqual([]);
  });
});

describe("Review card's TikTok line when the Mac can't post yet (bug hunt, 23 Nov)", () => {
  it("never promises 'your Mac posts it for everyone' while the Mac never checked in, and never offers Turn on: the switch is on", async () => {
    await mount({ mac: true, seen: false });
    await until(() => inCard(".tt-yourself-hint")?.textContent === "TikTok: Your Mac isn't set up yet", "the Mac's own line");
    expect(card().textContent).not.toContain(MAC_HINT);
    const row = inCard('[data-mac="card"]')!;
    const links = Array.from(row.querySelectorAll<HTMLAnchorElement>("a"));
    expect(links.map((a) => a.textContent?.trim())).toEqual(["Open Your Mac posts TikTok"]);
    expect(links[0]!.getAttribute("href")).toBe("/settings/posting/tiktok-mac");
    // Upload still goes (its TikTok waits for the Mac).
    expect(upload().getAttribute("aria-disabled")).toBeNull();
  });
});

describe("Review card while the Mac posts TikTok: the row is the clip's own", () => {
  it("Who can see it and the switches change this clip only; the Mac job gets them, and Use my settings puts My settings back", async () => {
    const clipId = await mount({ mac: true });
    await until(() => tiktokLine().startsWith("Posting as "), "TikTok's answer");
    const row = await openTikTok();
    // TikTok Studio's choices, Everyone first; the closed line said My settings, and so does the open row.
    expect((await privacyNames(row)).map((o) => o.name)).toEqual(["Everyone", "Friends", "Only me"]);
    expect(privacyButton(row).textContent).toContain("Everyone");
    expect(switchesIn(row)).toEqual(["Comments", "Duet", "Stitch", "Commercial content"]);
    expect(row.textContent).toContain("Posting as");
    await pickPrivacy(row, "Friends");
    await click(switchIn(row, "Stitch"));
    // A change on the card: Use my settings offers to put his settings back, and Upload still goes at once.
    expect(buttonIn(card(), "Use my settings")).toBeTruthy();
    expect(inCard(".my-settings__note")!.textContent).toBe("You changed some. Tap to put yours back.");
    // The line above Upload follows the card: never "for everyone" while it is Friends.
    expect(inCard(".tt-yourself-hint")!.textContent).toBe(MAC_WHERE_LINE);
    expect(upload().getAttribute("aria-disabled")).toBeNull();
    // Use my settings puts My settings back on TikTok's row too.
    await click(buttonIn(card(), "Use my settings")!);
    expect(privacyButton(row).textContent).toContain("Everyone");
    expect(inCard(".tt-yourself-hint")!.textContent).toBe(MAC_HINT);
    await pickPrivacy(row, "Friends");
    await click(switchIn(row, "Comments"));
    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    expect(sent[0]).toEqual({ privacyLevel: "MUTUAL_FOLLOW_FRIENDS", disableComment: true, disableDuet: false, disableStitch: false, brandContent: false, brandOrganic: false });
    expect(sentMac[0]).toBe(true);
    await until(() => !!knobs().mac.queue().find((j) => j.clipId === clipId), "the Mac's job");
    expect(knobs().mac.queue().find((j) => j.clipId === clipId)).toMatchObject({ privacy: "MUTUAL_FOLLOW_FRIENDS", comment: false, duet: true, stitch: true, brandContent: false });
  });

  it("My settings saved as Friends: the card starts there, and the line above Upload never says for everyone", async () => {
    await mount({ mac: true, tiktok: { privacy: "MUTUAL_FOLLOW_FRIENDS", stitch: false } });
    // The saved settings reach the card a moment after it mounts (a slow machine shows "not picked yet" first).
    await until(() => tiktokLine().includes("Who can see it: Friends"), "the card starts on the saved Friends setting");
    expect(tiktokLine()).toContain("Who can see it: Friends · Comments on · Duet on · Stitch off");
    expect(inCard(".tt-yourself-hint")!.textContent).toBe(MAC_WHERE_LINE);
    expect(card().textContent).not.toContain(MAC_HINT);
    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    expect(sent[0]).toMatchObject({ privacyLevel: "MUTUAL_FOLLOW_FRIENDS", disableStitch: true });
  });

  it("Branded content goes with the Mac: no hold, TikTok's label line, and the Mac job carries it", async () => {
    const clipId = await mount({ mac: true });
    const row = await openTikTok();
    await click(switchIn(row, "Commercial content"));
    // On with nothing ticked: TikTok's own rule, as on its API path (pick whose).
    expect(inCard(".upload-going")!.textContent).toBe(`${PICK_WHOSE} Pick Your brand or Branded content on TikTok first.`);
    expect(upload().getAttribute("aria-disabled")).toBe("true");
    expect(upload().getAttribute("title")).toBe(PICK_WHOSE);
    expect(row.textContent).toContain("Pick Your brand, Branded content, or both.");
    await until(() => hasCheck(row, "Branded content"), "the Branded content chip");
    await click(checkIn(row, "Branded content"));
    // Nothing holds it: the row says the label TikTok shows, and the line above Upload says the Mac adds it.
    expect(upload().getAttribute("aria-disabled")).toBeNull();
    expect(inCard(".upload-going")!.textContent).toBe("Going to: YouTube · TikTok");
    expect(row.querySelector('[role="alert"]')).toBeNull();
    expect(row.textContent).toContain("Your video will be labeled as 'Paid partnership'.");
    expect(inCard(".tt-yourself-hint")!.textContent).toBe("TikTok: your Mac posts it for everyone and adds TikTok's Paid partnership label.");
    expect(tiktokLine()).toContain("· Paid partnership");
    expect(inCard(".tt-legal")!.textContent).toContain("Branded Content Policy");
    // TikTok's rule: Branded content can't be Only me (greyed, with TikTok's own words).
    expect((await privacyNames(row)).find((o) => o.name === "Only me")).toEqual({ name: "Only me", off: true, line: BRANDED_PRIVATE_LINE });
    // Ticking it is about this clip only: his settings stay on.
    expect(buttonIn(card(), "Your settings are on")).toBeTruthy();
    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    expect(sent[0]).toMatchObject({ privacyLevel: "PUBLIC_TO_EVERYONE", brandContent: true, brandOrganic: false });
    expect(sentMac[0]).toBe(true);
    await until(() => !!knobs().mac.queue().find((j) => j.clipId === clipId), "the Mac's job");
    expect(knobs().mac.queue().find((j) => j.clipId === clipId)).toMatchObject({ privacy: "PUBLIC_TO_EVERYONE", brandContent: true, brandOrganic: false });
    expect(knobs().posting.clip(clipId).tiktokLabel).toEqual({ brandContent: true, brandOrganic: false });
    // Uploaded just now: the Mac's row says the label.
    await until(() => !!document.querySelector(".kept-now__item .kept-now__mac"), "Uploaded just now");
    expect(document.querySelector(".kept-now__item .kept-now__mac")!.textContent).toMatch(/^TikTok: Waiting for your Mac.* · Paid partnership label$/);
  });

  it("TikTok unticked with Your brand still ticked: the other places go, and the clip keeps its label for Post with my Mac", async () => {
    const clipId = await mount({ mac: true });
    knobs().mac.ping();
    const row = await openTikTok();
    await click(switchIn(row, "Commercial content"));
    await until(() => hasCheck(row, "Your brand"), "the Your brand chip");
    await click(checkIn(row, "Your brand"));
    expect(upload().getAttribute("aria-disabled")).toBeNull();
    await click(chip("TikTok"));
    expect(inCard(".upload-going")!.textContent).toBe("Going to: YouTube");
    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    // The row's choices go too (tiktokMac), with TikTok left out of the places.
    expect(sent[0]).toMatchObject({ brandContent: false, brandOrganic: true });
    expect(sentMac[0]).toBe(true);
    expect(sentPlaces[0]).toEqual(["youtube"]);
    await until(() => knobs().posting.posts(clipId).length === 1, "its post");
    expect(knobs().posting.posts(clipId).map((p) => p.platform)).toEqual(["youtube"]);
    expect(knobs().posting.clip(clipId).tiktokLabel).toEqual({ brandContent: false, brandOrganic: true });
    // Uploaded just now: Post with my Mac, which posts it with TikTok's label.
    await until(() => !!document.querySelector(".kept-now__item"), "Uploaded just now");
    const kept = document.querySelector<HTMLElement>(".kept-now__item")!;
    await until(() => !!buttonIn(kept, "Post with my Mac"), "Post with my Mac");
    expect(kept.querySelector(".kept-now__mac")!.textContent).toBe("TikTok: Not on TikTok yet · Promotional content label");
    expect(knobs().mac.queue().find((j) => j.clipId === clipId)).toBeUndefined();
  });

  it("a clip uploaded without TikTok and no label ticked is offered Post with my Mac, with no label and no TikTok in the body", async () => {
    const clipId = await mount({ mac: true });
    knobs().mac.ping();
    await click(chip("TikTok"));
    await click(upload());
    await until(() => knobs().posting.posts(clipId).length === 1, "its post");
    expect(sent[0]).toBeUndefined();
    expect(sentMac[0]).toBeUndefined();
    await until(() => !!document.querySelector(".kept-now__item"), "Uploaded just now");
    const kept = document.querySelector<HTMLElement>(".kept-now__item")!;
    await until(() => !!buttonIn(kept, "Post with my Mac"), "Post with my Mac");
    expect(kept.querySelector(".kept-now__mac")!.textContent).toBe("TikTok: Not on TikTok yet");
    expect(knobs().posting.clip(clipId).tiktokLabel).toBeUndefined();
  });
});

describe("Review card while TikTok's API posts it (unchanged, TikTok's rule)", () => {
  it("the Mac off: nothing picked, Upload held until his tap, and TikTok is asked only then", async () => {
    await mount({ mac: false });
    await flush(20);
    expect(creatorAsks).toBe(0);
    expect(buttonIn(card(), "Use my settings")).toBeTruthy();
    expect(inCard(".my-settings__note")!.textContent).toBe(OTHERS);
    expect(tiktokLine()).toBe("Who can see it: not picked yet");
    expect(upload().getAttribute("aria-disabled")).toBe("true");
    expect(inCard(".upload-going")!.textContent).toBe(ASK);
    expect(inCard(".tt-yourself-hint")!.textContent).toBe("TikTok: turn on Your Mac posts TikTok so it posts for everyone.");
    await click(upload());
    expect(sent).toEqual([]);

    await click(buttonIn(card(), "Use my settings")!);
    await until(() => !!buttonIn(card(), "Your settings are on"), "his tap puts his settings on");
    expect(creatorAsks).toBe(1);
    // TikTok's API path: never `tiktokMac` (the server asks TikTok's API, with its own rules).
    expect(sentMac).toEqual([]);
    // Before TikTok approves the app, TikTok's API offers only Only me.
    expect(tiktokLine()).toContain("Who can see it: Only me");
    expect(inCard(".my-settings__note")!.textContent).toBe(EVERY);
    // The row: TikTok's own privacy and switches.
    await click(inCard('[data-place="tiktok"] summary')!);
    expect(tiktokRowOf().querySelector('[aria-haspopup="listbox"]')).toBeTruthy();
    expect(switchesIn(tiktokRowOf())).toEqual(["Comments", "Duet", "Stitch", "Commercial content"]);
  });

  it("the Mac on but TikTok approved the app: TikTok's API posts it, so its rule holds", async () => {
    await mount({ mac: true, audited: true });
    await flush(20);
    expect(creatorAsks).toBe(0);
    expect(tiktokLine()).toBe("Who can see it: not picked yet");
    expect(inCard(".upload-going")!.textContent).toBe(ASK);
    expect(inCard(".my-settings__note")!.textContent).toBe(OTHERS);
    await click(buttonIn(card(), "Use my settings")!);
    await until(() => tiktokLine().includes("Who can see it: Everyone · Comments on · Duet on · Stitch off"), "his tap, within TikTok's own choices");
  });

  it("a failed answer after his tap still holds Upload and offers Ask TikTok again", async () => {
    await mount({ mac: false, creator: () => Promise.reject(new ApiError(502, "platform_down", "TikTok did not answer.")) });
    await click(buttonIn(card(), "Use my settings")!);
    await until(() => inCard(".upload-going")!.textContent === "TikTok did not answer. Tap Ask TikTok again, or untick TikTok.", "the line says so");
    expect(upload().getAttribute("aria-disabled")).toBe("true");
    expect(buttonIn(card(), "Ask TikTok again")).toBeTruthy();
  });

  it("every card asks TikTok itself: the Mac mode's shared answer is never used", async () => {
    await mount({ mac: false });
    const [first, second] = cards();
    // Opening the TikTok row asks (TikTok's rule: this creator's current options), once per card, never shared.
    await click(first!.querySelector<HTMLElement>('[data-place="tiktok"] summary')!);
    await until(() => !!tiktokRowOf(first).querySelector(".tt-sheet__who"), "the first card's answer");
    expect(creatorAsks).toBe(1);
    await click(second!.querySelector<HTMLElement>('[data-place="tiktok"] summary')!);
    await until(() => !!tiktokRowOf(second).querySelector(".tt-sheet__who"), "the second card's answer");
    expect(creatorAsks).toBe(2);
    // Use my settings on a card without an answer yet: its own fresh ask too.
    const third = cards()[2]!;
    await click(buttonIn(third, "Use my settings")!);
    await until(() => !!buttonIn(third, "Your settings are on"), "the third card's tap");
    expect(creatorAsks).toBe(3);
  });

  it("Posting as shows even when TikTok gives no name", async () => {
    await mount({ mac: false, creator: async () => ({ nickname: "", username: "", privacyOptions: ["SELF_ONLY"], commentDisabled: false, duetDisabled: false, stitchDisabled: false, maxDurationSec: 600 }) });
    await click(buttonIn(card(), "Use my settings")!);
    await until(() => !!buttonIn(card(), "Your settings are on"), "his tap puts his settings on");
    await click(inCard('[data-place="tiktok"] summary')!);
    expect(tiktokRowOf().querySelector(".tt-sheet__who")?.textContent).toContain("Posting as");
  });

  it("a card that switches from the Mac to TikTok's API while open asks TikTok again on Use my settings", async () => {
    await mount({ mac: true });
    await until(() => tiktokLine().startsWith("Posting as "), "the Mac mode's answer");
    expect(creatorAsks).toBe(1);
    // Your Mac posts TikTok turned off (in Settings, or on another device) while the card is open.
    await act(async () => void (await session!.saveSettings({ tiktokMac: { on: false } })));
    await until(() => !!buttonIn(card(), "Use my settings"), "TikTok's API path again");
    expect(tiktokLine()).toBe("Who can see it: not picked yet");
    expect(inCard(".upload-going")!.textContent).toBe(ASK);
    expect(creatorAsks).toBe(1);
    await click(buttonIn(card(), "Use my settings")!);
    await until(() => !!buttonIn(card(), "Your settings are on"), "his tap puts his settings on");
    // Asked again, fresh: the shared answer (still under a minute old) was not used.
    expect(creatorAsks).toBe(2);
    expect(tiktokLine()).toContain("Who can see it: Only me");
  });

  it("a card changed in Mac mode that moves to TikTok's API path starts unpicked again, keeping Commercial content", async () => {
    await mount({ mac: true });
    const row = await openTikTok();
    await pickPrivacy(row, "Friends");
    await click(switchIn(row, "Commercial content"));
    expect(tiktokLine()).not.toContain("Who can see it: not picked yet");
    await act(async () => void (await session!.saveSettings({ tiktokMac: { on: false } })));
    await until(() => tiktokRowOf().textContent?.includes("Asking TikTok") || !!tiktokRowOf().querySelector(".tt-sheet__who"), "TikTok's API path, asked again");
    await until(() => !!privacyButton(tiktokRowOf()), "TikTok's own privacy");
    expect(privacyButton(tiktokRowOf()).textContent).toContain("Pick who can see it");
    expect(switchIn(tiktokRowOf(), "Commercial content").getAttribute("aria-checked")).toBe("true");
    await click(upload());
    expect(sent).toEqual([]);
  });
});
