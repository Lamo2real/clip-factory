// Kid-proof fixes in Clips Funded's studio ("its idiot proof, even an 8 year old should be able to use the app"):
// Post it's Upload says which place to tap; Make the video's missing pick shows by the button and its part comes into
// view; facts to fix have Fix the words; editors ask "Leave without saving?"; saving the sounds keeps the captions
// typed and the other way round; a redesign's Use this keeps the editor's own changes; Try and Next show what they
// changed on a phone; Ask for changes says what is missing in its own form; a stopped draft reads "Not made yet";
// Reject asks first; a removed picture has Undo. Rendered with the mock's ideas, characters and stories parts, as
// storiesStudioScreens.test.tsx does; nothing leaves the machine.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { navigate } from "../src/lib/router.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import { isCar, type CharacterInput, type PersonInput, type PublishingJob, type SocialAccount, type StoriesApi, type StoriesConfig, type TikTokCreator, type Workspace } from "../src/stories/api/types.ts";
import type { StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { CharactersScreen, mergeRedesign } = await import("../src/stories/screens/Characters.tsx");
const { ProductionScreen } = await import("../src/stories/screens/Production.tsx");
const { ReviewScreen, approveBlock, fieldToFix } = await import("../src/stories/screens/Review.tsx");
const { pickPlaceFirst } = await import("../src/stories/studio/PublishSheet.tsx");
const { nowLine } = await import("../src/stories/studio/StepTrack.tsx");
const { notMadeYet, statusLabel } = await import("../src/stories/studio/words.ts");
const { statusWords } = await import("../src/stories/ui.tsx");
const { leaveHolders, LEAVE_TITLE } = await import("../src/stories/studio/leaveGuard.tsx");
const { sameCharacter } = await import("../src/stories/studio/CharacterEditor.tsx");
const { inputOf, newCar } = await import("../src/stories/studio/looks.ts");

/** A seeded person (a car has no person look). */
function person(c: CharacterInput): PersonInput {
  if (isCar(c)) throw new Error("expected a person, got a car");
  return c;
}

const S = stories.SEED_IDS.stories;
const C = stories.SEED_IDS.characters;
const I = stories.SEED_IDS.ideas;

const WS: Workspace = {
  workspaceId: "stories",
  workspaceName: "Clips Funded",
  workspaceType: "stories",
  builtin: false,
  configuration: {
    defaultDurationSec: 50,
    captionsOn: false,
    musicOn: true,
    providers: { images: "builtin-rig", video: "builtin-2d", audio: "builtin-synth" },
    video: { resolution: "1080x1920", aspect: "9:16", quality: "high", fps: 30 },
    production: { burnCaptions: true, scenesAtOnce: 2, keepVersions: "all" },
    youtubeCategory: "1",
    youtubePrivacy: "unlisted",
    xMonthlyLimitUsd: null,
  } satisfies StoriesConfig,
  version: 1,
};

const account = (platform: SocialAccount["platform"], connectionStatus: SocialAccount["connectionStatus"], accountName: string | null): SocialAccount => ({
  socialAccountId: `stories.${platform}`,
  workspaceId: "stories",
  platform,
  app: { choice: "clips", saved: true },
  lastCheckedAt: accountName ? "2026-11-21T09:00:00.000Z" : null,
  connectionStatus,
  externalAccountId: accountName ? `ext-${platform}` : null,
  accountName,
  handle: null,
  avatarUrl: null,
  sharedWithClips: false,
  connectedAt: null,
  missing: [],
  reason: null,
  reconnectBy: null,
  choices: null,
  limits: [],
  warning: null,
  skipped: false,
});

const CREATOR: TikTokCreator = {
  nickname: "Clips Funded",
  username: "funded.clips",
  avatarUrl: null,
  privacyOptions: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxDurationSec: 600,
};

let store: MockStore;
let api: StoriesApi;
let root: Root;
let host: HTMLElement;

function makeApi(): StoriesApi {
  store = createStore();
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  store.social.push(account("youtube", "connected", "Clips Funded Channel"), account("tiktok", "connected", "Clips Funded TikTok"), account("instagram", "not_connected", null), account("facebook", "not_connected", null), account("x", "not_connected", null));
  const now = "2026-11-21T12:00:00.000Z";
  const impl: Partial<StoriesApi> = {
    ...ideas.api(store),
    ...characters.api(store),
    ...stories.api(store),
    listWorkspaces: async () => store.workspaces,
    getWorkspace: async () => store.workspaces[0]!,
    dashboard: async () => Promise.reject(new Error("not used")),
    library: async () => ({ items: [], nextCursor: null }),
    guidance: async () => ({ topics: [], checkedAt: now }),
    social: async () => ({ accounts: structuredClone(store.social), clips: [] }),
    tiktokCreatorInfo: async () => CREATOR,
    publish: async (ws, storyId, targets) =>
      targets.map((t, i): PublishingJob => ({ publishingJobId: `pj${i}`, workspaceId: ws, contentId: storyId, socialAccountId: t.socialAccountId, platform: t.platform, publishingStatus: "queued", accountName: null, createdAt: now, updatedAt: now })),
    listPublishing: async () => [],
    listReferences: async () => [],
    checkSocial: async (_ws, platform) => structuredClone(store.social.find((x) => x.platform === platform)!),
  };
  return new Proxy(impl, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.reject(new Error(`not used: ${k}`))) }) as StoriesApi;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
  forgetLoaded();
  api = makeApi();
  setStoriesApi(api);
  history.replaceState(null, "", "/stories");
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  setStoriesApi(null);
  vi.useRealTimers();
});

async function wait(ms = 1500) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function show(node: ReactNode) {
  host = document.createElement("div");
  host.className = "stories-app";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<ToastProvider>{node}</ToastProvider>));
  await wait();
}

const page = (p: StoriesPage) => ({ ws: "stories", page: p });

function control(name: string | RegExp, within: ParentNode = document): HTMLElement {
  const all = Array.from(within.querySelectorAll<HTMLElement>("button, a, label"));
  const words = (el: HTMLElement) => [el.textContent?.trim() ?? "", el.getAttribute("aria-label") ?? ""];
  const hit = all.find((el) => words(el).some((w) => (typeof name === "string" ? w === name : name.test(w))));
  if (!hit) throw new Error(`no control "${String(name)}" in: ${all.map((e) => e.textContent?.trim()).join(" | ")}`);
  return hit;
}
const has = (name: string | RegExp, within: ParentNode = document) => {
  try {
    control(name, within);
    return true;
  } catch {
    return false;
  }
};

async function click(el: HTMLElement, ms = 1500) {
  await act(async () => el.click());
  await wait(ms);
}

function type(el: Element | null, value: string) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error("not a text box");
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function field(label: string | RegExp): HTMLInputElement | HTMLTextAreaElement {
  const l = Array.from(document.querySelectorAll<HTMLLabelElement>("label[for]")).find((x) => (typeof label === "string" ? x.textContent?.trim() === label : label.test(x.textContent ?? "")));
  const el = l?.htmlFor ? document.getElementById(l.htmlFor) : null;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error(`no field ${String(label)}`);
  return el;
}

async function pick(group: string, option: string) {
  const g = Array.from(document.querySelectorAll('[role="radiogroup"]')).find((r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() === group);
  if (!g) throw new Error(`no pick bar ${group}`);
  const opt = Array.from(g.querySelectorAll("label")).find((l) => l.querySelector(".st-s-pick__label")?.textContent?.trim() === option);
  if (!opt) throw new Error(`no option ${option}`);
  await click(opt.querySelector("input") as HTMLElement, 50);
}

const dialog = (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((d) => d.querySelector(".st-s-sheet__title")?.textContent === title) ?? null;

// ---------- Post it ----------

describe("Post it: Upload is the one main button and says which place to tap", () => {
  it("Upload with nothing picked says to tap a place, by the buttons, and points at the places", async () => {
    const publish = vi.spyOn(api, "publish");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    const sheet = dialog("Post it")!;
    // "Use my settings" is plain: the sheet's one orange button is Upload.
    expect(Array.from(sheet.querySelectorAll(".st-btn--main")).map((b) => b.textContent)).toEqual(["Upload"]);
    await click(control("Use my settings", sheet), 50);
    await click(control("Upload", sheet), 50);
    expect(publish).not.toHaveBeenCalled();
    const why = sheet.querySelector(".st-s-sheet__actions .st-s-sheet__why");
    expect(why?.textContent).toBe("Tap YouTube (or another place) first.");
    expect(sheet.querySelector(".st-s-places")?.classList.contains("is-nudged")).toBe(true);
    expect(document.activeElement).toBe(sheet.querySelector("button.st-s-place"));
    // Tapping a place takes the nudge away.
    await click(control(/Clips Funded Channel/, sheet), 50);
    expect(sheet.querySelector(".st-s-sheet__why")).toBeNull();
    expect(sheet.querySelector(".st-s-places")?.classList.contains("is-nudged")).toBe(false);
  });

  it("with only one place connected, Use my settings picks it, and Upload goes", async () => {
    store.social.find((a) => a.platform === "tiktok")!.connectionStatus = "not_connected";
    const publish = vi.spyOn(api, "publish");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    const sheet = dialog("Post it")!;
    await click(control("Use my settings", sheet), 50);
    expect(control(/Clips Funded Channel/, sheet).getAttribute("aria-pressed")).toBe("true");
    await click(control("Upload", sheet));
    expect(publish).toHaveBeenCalledWith("stories", S.approved, [{ platform: "youtube", socialAccountId: "stories.youtube", options: { privacy: "public", category: "1", notifySubscribers: true } }]);
  });

  it("names the place to tap", () => {
    expect(pickPlaceFirst([{ platform: "tiktok" }])).toBe("Tap TikTok first.");
    expect(pickPlaceFirst([{ platform: "youtube" }, { platform: "x" }])).toBe("Tap YouTube (or another place) first.");
    expect(pickPlaceFirst([])).toBe("Connect an account in Social accounts first.");
  });
});

// ---------- Make the video ----------

describe("Make the video: a missing pick shows by the button, and its part comes into view", () => {
  it("no idea picked: the line is in the pinned bar and the idea part gets the focus", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    await click(control("Make the video"), 50);
    expect(create).not.toHaveBeenCalled();
    const bar = document.querySelector(".st-s-actionbar--pin")!;
    expect(bar.querySelector(".st-s-notice")?.textContent).toContain("Pick an idea, or tap Type an idea.");
    expect(document.activeElement?.id).toBe("st-nv-1");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("no character: the cast part gets the focus", async () => {
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich, castIds: ["01JSTCH0000000000000000099"] })} />);
    await click(control("Make the video"), 50);
    expect(document.querySelector(".st-s-actionbar--pin .st-s-notice")?.textContent).toContain("Pick at least one character.");
    expect(document.activeElement?.id).toBe("st-nv-2");
  });

  it("Type an idea with no title: the title box gets the focus", async () => {
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    await pick("Where the idea comes from", "Type an idea");
    await click(control("Make the video"), 50);
    expect(document.activeElement).toBe(field("Title"));
  });
});

// ---------- Leave without saving? ----------

describe("Leave without saving?", () => {
  it("a new character with a name typed asks before the page changes; Keep editing stays, Leave goes", async () => {
    await show(<CharactersScreen {...page({ name: "character_new" })} />);
    expect(leaveHolders()).toBe(0);
    for (let i = 0; i < 4; i += 1) await click(control(/^Next:/), 50);
    type(field("Name"), "Lulu");
    await wait(50);
    expect(leaveHolders()).toBe(1);
    act(() => navigate("/stories/production"));
    await wait(50);
    expect(location.pathname).toBe("/stories");
    const sheet = dialog(LEAVE_TITLE)!;
    expect(sheet).not.toBeNull();
    await click(control("Keep editing", sheet), 50);
    expect(dialog(LEAVE_TITLE)).toBeNull();
    expect(field("Name").value).toBe("Lulu");
    act(() => navigate("/stories/production"));
    await wait(50);
    await click(control("Leave", dialog(LEAVE_TITLE)!), 50);
    expect(location.pathname).toBe("/stories/production");
  });

  it("an edited caption asks; a saved one does not", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    expect(leaveHolders()).toBe(0);
    const cue = document.querySelector<HTMLInputElement>(".st-s-cue input")!;
    type(cue, "Steer where you want to go");
    await wait(50);
    expect(leaveHolders()).toBe(1);
    act(() => navigate("/stories/review"));
    await wait(50);
    expect(location.pathname).toBe("/stories");
    expect(dialog(LEAVE_TITLE)).not.toBeNull();
    await click(control("Keep editing", dialog(LEAVE_TITLE)!), 50);
    await click(control("Save captions"));
    expect(leaveHolders()).toBe(0);
    act(() => navigate("/stories/review"));
    await wait(50);
    expect(location.pathname).toBe("/stories/review");
  });

  it("a typed video title asks before Study it or Back; nothing picked does not", async () => {
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    expect(leaveHolders()).toBe(0);
    await pick("Where the idea comes from", "Type an idea");
    type(field("Title"), "Pip flies a kite");
    await wait(50);
    expect(leaveHolders()).toBe(1);
    act(() => navigate("/stories/references"));
    await wait(50);
    expect(location.pathname).toBe("/stories");
    expect(dialog(LEAVE_TITLE)).not.toBeNull();
  });

  it("deleting a character with changes not saved never asks to leave", async () => {
    await show(<CharactersScreen {...page({ name: "character", characterId: C.bolt })} />);
    for (let i = 0; i < 4; i += 1) await click(control(/^Next:/), 50);
    type(field("Name"), "Bolt the Brave");
    await wait(50);
    expect(leaveHolders()).toBe(1);
    await click(control("Delete"), 50);
    await click(control("Delete", document.querySelector('[role="dialog"]')!));
    expect(dialog(LEAVE_TITLE)).toBeNull();
    expect(location.pathname).toBe("/stories/characters");
  });

  it("a character as saved compares the same, whatever the order of its parts", () => {
    const c = store.characters.find((x) => x.characterId === C.pip)!;
    const p = person(inputOf(c));
    const shuffled = { ...p, look: Object.fromEntries(Object.entries(p.look).reverse()) } as unknown as CharacterInput;
    expect(sameCharacter(inputOf(c), shuffled)).toBe(true);
    expect(sameCharacter(inputOf(c), { ...inputOf(c), name: `${c.name} ` })).toBe(true);
    expect(sameCharacter(inputOf(c), { ...inputOf(c), name: "Lulu" })).toBe(false);
  });
});

// ---------- Two boxes on Review ----------

describe("Review: saving one box keeps the other box's changes", () => {
  it("Save sounds keeps the caption typed, and Save captions keeps the music picked", async () => {
    const patch = vi.spyOn(api, "patchStory");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    const cue = () => document.querySelector<HTMLInputElement>(".st-s-cue input")!;
    type(cue(), "Steer where you want to go");
    await pick("Music", "Triumphant");
    await click(control("Save sounds"));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]![2]).toMatchObject({ musicMood: "triumphant" });
    expect(patch.mock.calls[0]![2].captions).toBeUndefined();
    expect(cue().value).toBe("Steer where you want to go");
    // The other way round: music picked, captions saved.
    await pick("Music", "Calm");
    await click(control("Save captions"));
    expect(patch.mock.calls[1]![2].captions?.some((c) => c.text === "Steer where you want to go")).toBe(true);
    const music = Array.from(document.querySelectorAll('[role="radiogroup"]')).find((r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() === "Music")!;
    expect(music.querySelector<HTMLInputElement>("input:checked")?.value).toBe("calm");
    expect(control("Save sounds").textContent).toBe("Save sounds");
  });
});

// ---------- Facts to fix ----------

describe("Facts to fix: Fix the words opens the caption to change", () => {
  it("never names a button that is not there, and Fix the words focuses the caption the problem quotes", async () => {
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.needsCheck })} />);
    const notice = Array.from(document.querySelectorAll<HTMLElement>(".st-s-notice")).find((n) => n.textContent?.includes("Fix the facts first."))!;
    expect(notice.textContent).not.toContain("Check again");
    expect(has("Check again")).toBe(false);
    expect(document.getElementById("st-approve-why")?.textContent).toBe("Fix the facts first: tap Fix the words.");
    await pick("Which words", "With the post");
    await click(control("Fix the words", notice), 50);
    const focused = document.activeElement as HTMLInputElement;
    expect(focused.closest(".st-s-cue")).not.toBeNull();
    expect(focused.value).toMatch(/full beam/i);
    vi.unstubAllGlobals();
  });

  it("picks the field whose words the problem quotes", () => {
    const box = document.createElement("div");
    box.innerHTML = '<input class="st-s-input" value="Slow down"><input class="st-s-input" value="Turn on your full beam lights">';
    const problems = ["“Turn on your full beam lights” does not match the checked advice."];
    expect(fieldToFix(box, problems)?.value).toBe("Turn on your full beam lights");
    expect(fieldToFix(box, ["Something else"])?.value).toBe("Slow down");
    const story = store.stories.find((s) => s.storyId === S.needsCheck)!;
    expect(approveBlock(story)).toBe("Fix the facts first: tap Fix the words.");
  });
});

// ---------- Ask for changes ----------

describe("Ask for changes with nothing said", () => {
  it("says so inside its own form and puts the focus in the box", async () => {
    const changes = vi.spyOn(api, "requestChanges");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(control("Ask for changes"), 50);
    await click(control("Send the changes"), 50);
    expect(changes).not.toHaveBeenCalled();
    const form = document.querySelector('form[aria-label="Ask for changes"]')!;
    expect(form.textContent).toContain("Say what to change, or pick a scene.");
    expect(document.activeElement).toBe(field("What should change?"));
    // The page's own notice above stays quiet.
    expect(Array.from(document.querySelectorAll(".st-s-review__side > .st-s-notice")).some((n) => n.textContent?.includes("Say what to change"))).toBe(false);
  });
});

// ---------- Reject ----------

describe("Reject asks first", () => {
  it("Keep it rejects nothing; the production page of a rejected video never says it is ready to watch", async () => {
    const reject = vi.spyOn(api, "reject");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(control("Reject"), 50);
    await click(control("Reject the video"), 50);
    const sure = dialog("Reject this video?")!;
    expect(sure.textContent).toContain("You can't undo this.");
    await click(control("Keep it", sure), 50);
    expect(reject).not.toHaveBeenCalled();
    expect(dialog("Reject this video?")).toBeNull();
    expect(nowLine({ status: "ready" } as never, [], "rejected")).toBe("Not used. It won't be posted.");
    expect(nowLine({ status: "ready" } as never, [], "review")).toBe("All done! It's ready to watch.");
  });
});

// ---------- A stopped draft ----------

describe("A draft nothing is making reads Not made yet", () => {
  it("is under Not made yet with Make it, never under Being made", async () => {
    await show(<ProductionScreen {...page({ name: "production" })} />);
    const sections = Array.from(document.querySelectorAll(".st-s-section")).map((h) => h.textContent);
    expect(sections).toContain("Not made yet");
    const row = Array.from(document.querySelectorAll<HTMLElement>(".st-s-run")).find((r) => r.textContent?.includes("Dash at the car wash"))!;
    expect(row.textContent).toContain("Not made yet");
    expect(row.textContent).not.toContain("Getting ready");
    expect(control("Make it", row).getAttribute("href")).toBe(`/stories/production/${S.draft}`);
    const being = document.querySelector(".st-s-section")!;
    const list = being.textContent === "Being made" ? being.nextElementSibling : null;
    expect(list?.textContent ?? "").not.toContain("Dash at the car wash");
  });

  it("the words: a draft with no run is Not made yet; one with a run waiting is Getting ready", () => {
    expect(notMadeYet({ status: "draft", currentJobId: null })).toBe(true);
    expect(statusLabel({ status: "draft", currentJobId: null })).toBe("Not made yet");
    expect(statusLabel({ status: "draft", currentJobId: "job" })).toBe("Getting ready");
    expect(statusLabel({ status: "failed", currentJobId: null })).toBe("Stopped");
    expect(statusWords({ status: "draft", currentJobId: null }).label).toBe("Not made yet");
    expect(statusWords({ status: "draft", currentJobId: "job" }).label).toBe("Starting");
  });
});

// ---------- Characters ----------

describe("Characters: Use this, Try, Next, and a picture's ×", () => {
  it("Use this keeps the editor's own changes and takes only the parts the redesign changed", () => {
    const c = store.characters.find((x) => x.characterId === C.pip)!;
    const saved = person(inputOf(c));
    const now = { ...saved, look: { ...saved.look, skin: "#b8f2d0" } };
    const next = { ...saved, look: { ...saved.look, outfit: { ...saved.look.outfit, top: "#e8453c" } } };
    const merged = person(mergeRedesign(now, saved, next));
    expect(merged.look.skin).toBe("#b8f2d0");
    expect(merged.look.outfit.top).toBe("#e8453c");
    expect(merged.name).toBe(c.name);
  });

  it("Use this on a car keeps the editor's own changes and takes only the car parts the redesign changed", () => {
    const saved = { ...newCar(), name: "Rosso" };
    const now = { ...saved, car: { ...saved.car, paint: "#2f6fe0" } };
    const next = { ...saved, car: { ...saved.car, wheels: { ...saved.car.wheels, style: "sport" as const } } };
    const merged = mergeRedesign(now, saved, next);
    if (!isCar(merged)) throw new Error("expected a car");
    expect(merged.car.paint).toBe("#2f6fe0");
    expect(merged.car.wheels.style).toBe("sport");
    expect(merged.name).toBe("Rosso");
  });

  it("Try on a face brings the preview into view when it is off screen", async () => {
    await show(<CharactersScreen {...page({ name: "character", characterId: C.pip })} />);
    await click(control("Next: Face"), 50);
    const preview = document.querySelector<HTMLElement>(".st-s-editor__preview")!;
    preview.getBoundingClientRect = () => ({ top: -2000, bottom: -1700, left: 0, right: 300, width: 300, height: 300, x: 0, y: -2000, toJSON: () => ({}) });
    const seen = vi.fn();
    preview.scrollIntoView = seen;
    await click(control(/^Try\s*Sad$/), 50);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ block: "nearest" }));
  });

  it("Next opens the next part from its top, with the focus on it", async () => {
    await show(<CharactersScreen {...page({ name: "character_new" })} />);
    const parts = document.querySelector<HTMLElement>(".st-s-editor__parts")!;
    const seen = vi.fn();
    parts.scrollIntoView = seen;
    await click(control("Next: Face"), 50);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Face");
    await click(control("Back"), 50);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Looks");
  });

  it("the × takes a picture out with Undo; it is deleted only when Undo's time is up", async () => {
    const pip = store.characters.find((x) => x.characterId === C.pip)!;
    pip.references = [{ assetId: "01JSTAS0000000000000000001", url: "data:image/png;base64,AA==", contentType: "image/png", createdAt: "2026-11-21T10:00:00.000Z" }];
    const del = vi.spyOn(api, "deleteReference");
    await show(<CharactersScreen {...page({ name: "character", characterId: C.pip })} />);
    expect(document.querySelectorAll(".st-s-refs__item")).toHaveLength(1);
    await click(control(/Remove picture 1/), 50);
    expect(document.querySelectorAll(".st-s-refs__item")).toHaveLength(0);
    expect(del).not.toHaveBeenCalled();
    await click(control("Undo"), 50);
    expect(document.querySelectorAll(".st-s-refs__item")).toHaveLength(1);
    await click(control(/Remove picture 1/), 9000);
    expect(del).toHaveBeenCalledWith("stories", C.pip, "01JSTAS0000000000000000001");
  });
});
