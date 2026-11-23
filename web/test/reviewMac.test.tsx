// A Review card's TikTok while the owner's Mac posts TikTok (docs/CONTRACTS.md §47), rendered on the mock API. With
// Your Mac posts TikTok on (and TikTok not approving the app yet) a card with TikTok ticked starts on My settings like
// every other place: Everyone, Comments, Duet and Stitch on, no tap before Upload, and TikTok's API answer (creator
// info) asked in the background but never waited for. With the Mac off, TikTok's API rule stays exactly as it was:
// nothing picked, the switches off, and Upload held until the owner taps Use my settings.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import { mockApi } from "../src/api/mock/index.ts";
import type { Api, Platform, TikTokCreator, TikTokPostOptions } from "../src/api/types.ts";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { DEFAULT_PRESET } from "../src/lib/preset.ts";
import { MAC_PRIVACY_OPTIONS, macCreator, macTikTokChoices, NO_TIKTOK_CHOICES, tiktokOptions } from "../src/lib/tiktokChoices.ts";

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

const { SessionProvider } = await import("../src/app/session.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { Review } = await import("../src/screens/review/Review.tsx");

type Knobs = {
  setup: { finish(p: Platform): void; setAudit(passed: boolean): void };
  posting: { posts(clipId: string): { platform: string; status: string }[] };
  mac: { queue(): { clipId: string; privacy: string; comment: boolean; duet: boolean; stitch: boolean }[] };
};
const knobs = () => (window as unknown as { __cfMock: Knobs }).__cfMock;

const ASK = "Tap Use my settings first. TikTok needs your tap.";
const EVERY = "Every place uses your settings. Tap a place below to change it for this clip.";
const OTHERS = "Your other places already use your settings. TikTok needs your tap each time.";

let root: Root;
let app: HTMLElement;
let creatorAsks = 0;
let meAnswered = false;
let sent: (TikTokPostOptions | undefined)[] = [];
const flush = (ms = 0) => act(async () => new Promise((r) => setTimeout(r, ms)));
async function until(ok: () => boolean, what: string) {
  for (let i = 0; i < 200 && !ok(); i++) await flush(10);
  expect(ok(), what).toBe(true);
}
const card = () => document.querySelector<HTMLElement>(".review-card")!;
const inCard = (selector: string) => card()?.querySelector<HTMLElement>(selector) ?? null;
const buttonIn = (el: HTMLElement, name: RegExp | string) =>
  Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent?.trim() ?? "")));
const upload = () => buttonIn(card(), /^Upload( to .+)?$/)!;
const tiktokLine = () => inCard('[data-place="tiktok"] .place-row__now')?.textContent ?? "";
const click = (el: HTMLElement) => act(async () => el.click());

/**
 * The mock with YouTube and TikTok set up, TikTok not approving the app yet, Your Mac posts TikTok `mac`, and Upload
 * to YouTube and TikTok remembered on this device. `creator` replaces TikTok's creator-info answer.
 */
async function mount({ mac, audited = false, creator }: { mac: boolean; audited?: boolean; creator?: () => Promise<TikTokCreator> }) {
  const store = seed();
  store.settings = { ...store.settings, tiktokMac: { on: mac } };
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

  it("start on My settings: Everyone, all three on, Commercial content off; the saved choices and a ticked paid partnership are kept", () => {
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
    expect(macTikTokChoices({ privacy: "FOLLOWER_OF_CREATOR", comments: false, duet: true, stitch: false })).toMatchObject({
      privacy: "FOLLOWER_OF_CREATOR",
      comments: false,
      duet: true,
      stitch: false,
    });
    // Branded content can't be Followers (TikTok's rule): Everyone, and the paid partnership stays ticked.
    const paid = { ...NO_TIKTOK_CHOICES, commercial: true, branded: true };
    expect(macTikTokChoices({ privacy: "FOLLOWER_OF_CREATOR", comments: true, duet: true, stitch: true }, paid)).toMatchObject({
      privacy: "PUBLIC_TO_EVERYONE",
      commercial: true,
      branded: true,
    });
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

  it("TikTok's answer failing never holds Upload, says nothing about it, and the row still offers every choice", async () => {
    const clipId = await mount({ mac: true, creator: () => Promise.reject(new ApiError(502, "platform_down", "TikTok did not answer.")) });
    await until(() => creatorAsks === 1, "TikTok was asked");
    await flush(20);
    expect(card().textContent).not.toContain("TikTok did not answer");
    expect(card().textContent).not.toContain("Ask TikTok again");
    expect(buttonIn(card(), "Your settings are on")).toBeTruthy();
    expect(tiktokLine()).toBe("Who can see it: Everyone · Comments on · Duet on · Stitch on");
    expect(upload().getAttribute("aria-disabled")).toBeNull();
    // Opening the row: the Mac's own choices, no name, and TikTok is asked once more.
    const asked = creatorAsks;
    const summary = inCard('[data-place="tiktok"] summary')!;
    await click(summary);
    await until(() => creatorAsks === asked + 1, "opening the row asks TikTok again");
    const row = inCard('[data-place="tiktok"]')!;
    expect(row.textContent).toContain("Who can see it");
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

  it("he can still change TikTok for this clip, and Use my settings puts his settings back", async () => {
    await mount({ mac: true });
    await until(() => tiktokLine().startsWith("Posting as "), "TikTok's answer");
    await click(inCard('[data-place="tiktok"] summary')!);
    const stitch = Array.from(inCard('[data-place="tiktok"]')!.querySelectorAll<HTMLElement>('[role="switch"]')).find((s) =>
      s.closest(".toggle-row")?.querySelector(".toggle-row__label")?.textContent === "Stitch",
    )!;
    expect(stitch.getAttribute("aria-checked")).toBe("true");
    await click(stitch);
    expect(stitch.getAttribute("aria-checked")).toBe("false");
    expect(inCard(".my-settings__note")!.textContent).toBe("You changed some for this clip. Tap to put yours back.");
    await click(buttonIn(card(), "Use my settings")!);
    expect(buttonIn(card(), "Your settings are on")).toBeTruthy();
    expect(stitch.getAttribute("aria-checked")).toBe("true");
    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    expect(sent[0]?.disableStitch).toBe(false);
  });
});

describe("Review card while the Mac posts TikTok: his change for one clip", () => {
  it("picking Only me for this clip goes with Upload, and the card offers to put his settings back", async () => {
    await mount({ mac: true });
    await click(inCard('[data-place="tiktok"] summary')!);
    const row = inCard('[data-place="tiktok"]')!;
    // The Mac's choices: every one TikTok Studio has, Everyone picked.
    const who = row.querySelector<HTMLButtonElement>('.field button[aria-haspopup="listbox"]')!;
    expect(who.textContent).toContain("Everyone");
    await click(who);
    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(options.map((o) => o.textContent?.trim())).toEqual(["Everyone", "Followers", "Friends", "Only me"]);
    await click(options.find((o) => o.textContent?.trim() === "Only me")!);
    expect(tiktokLine()).toContain("Who can see it: Only me · Comments on · Duet on · Stitch on");
    expect(buttonIn(card(), "Use my settings")).toBeTruthy();
    await click(upload());
    await until(() => sent.length === 1, "Upload sent the clip");
    expect(sent[0]?.privacyLevel).toBe("SELF_ONLY");
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
});
