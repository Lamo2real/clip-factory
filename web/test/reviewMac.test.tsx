// A Review card's TikTok while the owner's Mac posts TikTok (docs/CONTRACTS.md §47), rendered on the mock API. With
// Your Mac posts TikTok on (and TikTok not approving the app yet) a card with TikTok ticked starts on My settings like
// every other place: Everyone, Comments, Duet and Stitch on, no tap before Upload, and TikTok's API answer (creator
// info) asked in the background but never waited for. The Mac posts My settings whatever the card says, so its row
// shows them read-only (§47.9), and a ticked Your brand or Branded content holds Upload for TikTok: the Mac can't add
// TikTok's label yet. With the Mac off, TikTok's API rule stays exactly as it was: nothing picked, the switches off,
// Upload held until the owner taps Use my settings, and every ask for creator info is the card's own.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import { mockApi } from "../src/api/mock/index.ts";
import type { Api, Platform, Settings, TikTokCreator, TikTokPostOptions } from "../src/api/types.ts";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { DEFAULT_PRESET } from "../src/lib/preset.ts";
import {
  MAC_COMMERCIAL_HELD,
  MAC_LABEL_HELD,
  MAC_PRIVACY_OPTIONS,
  macCreator,
  macPostsLine,
  macTikTokChoices,
  macTikTokHeld,
  NO_TIKTOK_CHOICES,
  PICK_WHOSE,
  tiktokOptions,
} from "../src/lib/tiktokChoices.ts";

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
  posting: { posts(clipId: string): { platform: string; status: string }[] };
  mac: { queue(): { clipId: string; privacy: string; comment: boolean; duet: boolean; stitch: boolean }[] };
};
const knobs = () => (window as unknown as { __cfMock: Knobs }).__cfMock;

const ASK = "Tap Use my settings first. TikTok needs your tap.";
const MAC_LINE = "Your Mac posts it with My settings: Everyone · Comments on · Duet on · Stitch on";
const EVERY = "Every place uses your settings. Tap a place below to change it for this clip.";
const OTHERS = "Your other places already use your settings. TikTok needs your tap each time.";

let root: Root;
let app: HTMLElement;
let creatorAsks = 0;
let meAnswered = false;
let sent: (TikTokPostOptions | undefined)[] = [];
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
const checkIn = (el: HTMLElement, label: string) =>
  Array.from(el.querySelectorAll<HTMLLabelElement>("label.check-chip")).find((l) => l.textContent?.includes(label))!.querySelector<HTMLInputElement>("input")!;
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
}: {
  mac: boolean;
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
    confirmClip: (clipId, captions, tiktok, platforms, options) => {
      sent.push(tiktok);
      return confirm(clipId, captions, tiktok, platforms, options);
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

  it("always My settings, as the Mac posts them: the saved privacy and switches, Commercial content as ticked on the clip", () => {
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
    const followers = { privacy: "FOLLOWER_OF_CREATOR", comments: false, duet: true, stitch: false };
    expect(macTikTokChoices(followers)).toMatchObject(followers);
    // A ticked paid partnership stays ticked (it holds Upload for TikTok), and the privacy stays the one the Mac uses.
    const paid = { ...NO_TIKTOK_CHOICES, commercial: true, branded: true };
    expect(macTikTokChoices(followers, paid)).toMatchObject({ ...followers, commercial: true, branded: true });
    // What the card had for TikTok's API path never leaks in: only Commercial content is the clip's own.
    expect(macTikTokChoices(DEFAULT_PRESET.tiktok, { ...NO_TIKTOK_CHOICES, privacy: "SELF_ONLY", comments: false })).toEqual(start);
    // Unset (an old preset) is Everyone, as the server's preset_options.
    expect(macTikTokChoices({ ...DEFAULT_PRESET.tiktok, privacy: "" }).privacy).toBe("PUBLIC_TO_EVERYONE");
  });

  it("the row's line is built from My settings' real values", () => {
    expect(macPostsLine(DEFAULT_PRESET.tiktok)).toBe(MAC_LINE);
    expect(macPostsLine({ privacy: "SELF_ONLY", comments: false, duet: true, stitch: false })).toBe(
      "Your Mac posts it with My settings: Only me · Comments off · Duet on · Stitch off",
    );
    expect(macPostsLine({ ...DEFAULT_PRESET.tiktok, privacy: "" })).toBe(MAC_LINE);
  });

  it("Your brand or Branded content holds the Mac, and so does Commercial content with nothing ticked; off holds nothing", () => {
    expect(macTikTokHeld(NO_TIKTOK_CHOICES)).toBeNull();
    expect(macTikTokHeld({ ...NO_TIKTOK_CHOICES, commercial: true, yourBrand: true })).toBe(MAC_LABEL_HELD);
    expect(macTikTokHeld({ ...NO_TIKTOK_CHOICES, commercial: true, branded: true })).toBe(MAC_LABEL_HELD);
    expect(macTikTokHeld({ ...NO_TIKTOK_CHOICES, commercial: true, yourBrand: true, branded: true })).toBe(MAC_LABEL_HELD);
    // TikTok's "Pick Your brand or Branded content" would go round in a circle: the way out is to turn it off.
    expect(macTikTokHeld({ ...NO_TIKTOK_CHOICES, commercial: true })).toBe(MAC_COMMERCIAL_HELD);
    // Ticked, then Commercial content turned off: nothing is labeled, nothing held.
    expect(macTikTokHeld({ ...NO_TIKTOK_CHOICES, commercial: false, yourBrand: true, branded: true })).toBeNull();
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
    expect(inCard(".tt-yourself-hint")!.textContent).toBe("TikTok: your Mac posts it for everyone.");
    // TikTok's API is asked in the background, for the account's name and the longest clip only: once for every card.
    await until(() => tiktokLine().startsWith("Posting as "), "TikTok's answer names the account");
    expect(document.querySelectorAll(".review-card").length).toBeGreaterThan(1);
    expect(creatorAsks).toBe(1);
    expect(tiktokLine()).toContain("Who can see it: Everyone · Comments on · Duet on · Stitch on");

    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    expect(sent[0]).toEqual({ privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: false, disableStitch: false, brandContent: false, brandOrganic: false });
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
    // Opening the row: the Mac's line, no name (Posting as is left out in this mode only), and TikTok is asked once more.
    const asked = creatorAsks;
    await click(inCard('[data-place="tiktok"] summary')!);
    await until(() => creatorAsks === asked + 1, "opening the row asks TikTok again");
    const row = tiktokRowOf();
    expect(row.querySelector(".tt-mac-uses")!.textContent).toContain(MAC_LINE);
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

describe("Review card while the Mac posts TikTok: the row is read-only", () => {
  it("shows what the Mac posts it with and Change My settings, with no per-clip privacy or switch; the Mac job gets the preset's privacy", async () => {
    const clipId = await mount({ mac: true, tiktok: { privacy: "FOLLOWER_OF_CREATOR", stitch: false } });
    await until(() => tiktokLine().startsWith("Posting as "), "TikTok's answer");
    await click(inCard('[data-place="tiktok"] summary')!);
    const row = tiktokRowOf();
    expect(row.querySelector(".tt-mac-uses")!.textContent).toContain("Your Mac posts it with My settings: Followers · Comments on · Duet on · Stitch off");
    const change = Array.from(row.querySelectorAll<HTMLAnchorElement>("a")).find((a) => a.textContent?.trim() === "Change My settings")!;
    expect(change.getAttribute("href")).toBe("/settings/posting/my-settings");
    // Nothing that changes who sees it or the switches for this clip: no Who can see it dropdown, no Comments, Duet or Stitch.
    expect(row.querySelector('[aria-haspopup="listbox"]')).toBeNull();
    expect(switchesIn(row)).toEqual(["Commercial content"]);
    expect(row.textContent).toContain("Posting as");
    // Upload: the preset's privacy, as the Mac posts it.
    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    expect(sent[0]).toEqual({ privacyLevel: "FOLLOWER_OF_CREATOR", disableComment: false, disableDuet: false, disableStitch: true, brandContent: false, brandOrganic: false });
    await until(() => !!knobs().mac.queue().find((j) => j.clipId === clipId), "the Mac's job");
    expect(knobs().mac.queue().find((j) => j.clipId === clipId)).toMatchObject({ privacy: "FOLLOWER_OF_CREATOR", comment: true, duet: true, stitch: false });
  });

  it("Branded content holds Upload for TikTok with the Mac's words; unticking it, then Commercial content, lets the clip go", async () => {
    await mount({ mac: true });
    await click(inCard('[data-place="tiktok"] summary')!);
    const row = tiktokRowOf();
    await click(switchIn(row, "Commercial content"));
    // On with nothing ticked: held, and the way out is never "pick one" (that holds the Mac too).
    expect(inCard(".upload-going")!.textContent).toBe(MAC_COMMERCIAL_HELD);
    expect(upload().getAttribute("title")).toBeNull();
    expect(card().textContent).not.toContain(PICK_WHOSE);
    expect(row.textContent).not.toContain("Pick Your brand");
    await click(checkIn(row, "Branded content"));
    expect(inCard(".upload-going")!.textContent).toBe(MAC_LABEL_HELD);
    expect(upload().getAttribute("aria-disabled")).toBe("true");
    expect(row.querySelector('[role="alert"]')!.textContent).toBe(MAC_LABEL_HELD);
    // Nothing would add the label, so the row never says the video will be labeled.
    expect(row.textContent).not.toContain("will be labeled");
    // Ticking it is about this clip only: his settings stay on.
    expect(buttonIn(card(), "Your settings are on")).toBeTruthy();
    await click(upload());
    expect(sent).toEqual([]);
    // Unticked: then Commercial content off, and TikTok goes again, with no label.
    await click(checkIn(row, "Branded content"));
    expect(inCard(".upload-going")!.textContent).toBe(MAC_COMMERCIAL_HELD);
    expect(upload().getAttribute("aria-disabled")).toBe("true");
    await click(switchIn(row, "Commercial content"));
    expect(upload().getAttribute("aria-disabled")).toBeNull();
    expect(row.querySelector('[role="alert"]')).toBeNull();
    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    expect(sent[0]).toMatchObject({ privacyLevel: "PUBLIC_TO_EVERYONE", brandContent: false, brandOrganic: false });
  });

  it("Your brand holds it too, and the other places still upload once TikTok is unticked", async () => {
    const clipId = await mount({ mac: true });
    await click(inCard('[data-place="tiktok"] summary')!);
    const row = tiktokRowOf();
    await click(switchIn(row, "Commercial content"));
    await click(checkIn(row, "Your brand"));
    expect(inCard(".upload-going")!.textContent).toBe(MAC_LABEL_HELD);
    expect(upload().getAttribute("aria-disabled")).toBe("true");
    await click(chip("TikTok"));
    expect(inCard(".upload-going")!.textContent).toBe("Going to: YouTube");
    expect(upload().getAttribute("aria-disabled")).toBeNull();
    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    expect(sent[0]).toBeUndefined();
    await until(() => knobs().posting.posts(clipId).length === 1, "its post");
    expect(knobs().posting.posts(clipId).map((p) => p.platform)).toEqual(["youtube"]);
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
    // Before TikTok approves the app, TikTok's API offers only Only me.
    expect(tiktokLine()).toContain("Who can see it: Only me");
    expect(inCard(".my-settings__note")!.textContent).toBe(EVERY);
    // The row: TikTok's own privacy and switches, no Mac line.
    await click(inCard('[data-place="tiktok"] summary')!);
    expect(tiktokRowOf().querySelector(".tt-mac-uses")).toBeNull();
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
});
