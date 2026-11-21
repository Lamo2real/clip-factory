// The Lamo Stories studio screens (docs/CONTRACTS.md §45.16.5, §45.16.6; spec §5.B–E): Ideas, Characters, Production
// and Review, rendered with a fake StoriesApi (setStoriesApi) built from the mock's ideas, characters and stories parts
// plus small stand-ins for the rest. Only storiesApi() is used; nothing leaves the machine.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import type { GuidanceTopic, PublishingJob, SocialAccount, StoriesApi, TikTokCreator, Workspace } from "../src/stories/api/types.ts";
import type { StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no canvas: the engine previews draw nothing, quietly.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { IdeasScreen, adviceLine } = await import("../src/stories/screens/Ideas.tsx");
const { CharactersScreen } = await import("../src/stories/screens/Characters.tsx");
const { ProductionScreen } = await import("../src/stories/screens/Production.tsx");
const { ReviewScreen, approveBlock } = await import("../src/stories/screens/Review.tsx");
const { optionsFor, PublishSheet } = await import("../src/stories/studio/PublishSheet.tsx");
const { NO_TIKTOK_CHOICES } = await import("../src/lib/tiktokChoices.ts");

const S = stories.SEED_IDS.stories;
const C = stories.SEED_IDS.characters;
const I = stories.SEED_IDS.ideas;

const WS: Workspace = {
  workspaceId: "stories",
  workspaceName: "Lamo Stories",
  workspaceType: "stories",
  builtin: false,
  configuration: {
    defaultDurationSec: 50,
    captionsOn: false,
    musicOn: true,
    storyModel: "claude-sonnet",
    providers: { images: "builtin-rig", animation: "builtin-2d", audio: "builtin-synth" },
    youtubeCategory: "1",
    youtubePrivacy: "unlisted",
  },
  version: 1,
};

const account = (platform: SocialAccount["platform"], connectionStatus: SocialAccount["connectionStatus"], accountName: string | null): SocialAccount => ({
  socialAccountId: `stories.${platform}`,
  workspaceId: "stories",
  platform,
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
});

const CREATOR: TikTokCreator = {
  nickname: "Lamo Stories",
  username: "lamo.stories",
  avatarUrl: null,
  privacyOptions: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxDurationSec: 600,
};

const TOPICS: GuidanceTopic[] = ideas.guidanceTopicIds().map((id) => ({ id, title: ideas.topicTitle(id)!, steps: [], donts: [], caveats: [], citations: ideas.citationsFor(id) }));

let store: MockStore;
let api: StoriesApi;
let pubs: PublishingJob[];
let root: Root;
let host: HTMLElement;

function makeApi(): StoriesApi {
  store = createStore();
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  store.social.push(account("youtube", "connected", "Lamo Stories Channel"), account("tiktok", "connected", "Lamo Stories TikTok"), account("instagram", "needs_reconnect", "lamo.stories"), account("facebook", "not_connected", null), account("x", "not_connected", null));
  pubs = [];
  const now = "2026-11-21T12:00:00.000Z";
  return {
    ...ideas.api(store),
    ...characters.api(store),
    ...stories.api(store),
    listWorkspaces: async () => store.workspaces,
    getWorkspace: async () => store.workspaces[0]!,
    patchWorkspace: async () => store.workspaces[0]!,
    dashboard: async () => Promise.reject(new Error("not used")),
    library: async () => ({ items: [], nextCursor: null }),
    providers: async () => [],
    guidance: async () => ({ topics: TOPICS, checkedAt: now }),
    social: async () => ({ accounts: structuredClone(store.social), clips: [] }),
    connectSocial: async () => ({ authorizeUrl: "/", expiresAt: now }),
    chooseSocial: async () => store.social[0]!,
    shareWithClips: async () => store.social[0]!,
    checkSocial: async () => store.social[0]!,
    tiktokCreatorInfo: async () => CREATOR,
    disconnectSocial: async () => undefined,
    publish: async (ws, storyId, targets) => {
      const made = targets.map((t, i): PublishingJob => ({ publishingJobId: `pj${i}`, workspaceId: ws, contentId: storyId, socialAccountId: t.socialAccountId, platform: t.platform, publishingStatus: "queued", accountName: store.social.find((a) => a.platform === t.platform)?.accountName ?? null, createdAt: now, updatedAt: now }));
      pubs.push(...made);
      return structuredClone(made);
    },
    listPublishing: async () => structuredClone(pubs),
    retryPublishing: async (_ws, id) => {
      const j = pubs.find((x) => x.publishingJobId === id)!;
      j.publishingStatus = "queued";
      delete j.error;
      return structuredClone(j);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
  forgetLoaded();
  api = makeApi();
  setStoriesApi(api);
  history.replaceState(null, "", "/stories");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  setStoriesApi(null);
  vi.useRealTimers();
});

/** Lets fake latency, polls and effects run. */
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

/** The button or link whose words match. */
function control(name: string | RegExp, within: ParentNode = document): HTMLElement {
  const all = Array.from(within.querySelectorAll<HTMLElement>("button, a, label"));
  const words = (el: HTMLElement) => [el.textContent?.trim() ?? "", el.getAttribute("aria-label") ?? ""];
  const hit = all.find((el) => words(el).some((w) => (typeof name === "string" ? w === name : name.test(w))));
  if (!hit) throw new Error(`no control "${String(name)}" in: ${all.map((e) => e.textContent?.trim()).join(" | ")}`);
  return hit;
}

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

const text = () => document.body.textContent ?? "";

// ---------- Ideas ----------

describe("Ideas", () => {
  it("shows the board with each safety idea's checked advice, and a safety idea without it cannot become a video", async () => {
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    const cards = Array.from(document.querySelectorAll(".st-s-idea"));
    expect(cards.length).toBe(store.ideas.length);
    const deer = cards.find((c) => c.textContent?.includes("A deer on the road"))!;
    expect(deer.textContent).toMatch(/Checked advice: .*From /);
    const tractor = cards.find((c) => c.textContent?.includes("Overtaking a tractor"))!;
    expect(tractor.textContent).toContain("Needs checked advice");
    const make = control("Make the video", tractor);
    expect(make.getAttribute("aria-disabled")).toBe("true");
    await click(make);
    expect(location.pathname).toBe("/stories");
    await click(control("Make the video", deer));
    expect(location.pathname + location.search).toBe(`/stories/production/new?idea=${I.deer}`);
    expect(adviceLine({ category: "comedy", safetyTopicId: null, needsGuidance: false }, TOPICS)).toBeNull();
  });

  it("New idea: a title, one line and one of four big kinds, then Save", async () => {
    const create = vi.spyOn(api, "createIdea");
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    await click(control("New idea"), 50);
    await click(control("Save idea"), 50);
    expect(text()).toContain("Give the idea a title.");
    type(field("Title"), "Dash learns to juggle");
    type(field("What happens, in one line"), "Dash drops every ball, then finds the trick.");
    await pick("What kind of video?", "Funny");
    await click(control("Save idea"));
    expect(create).toHaveBeenCalledWith("stories", { title: "Dash learns to juggle", logline: "Dash drops every ball, then finds the trick.", category: "comedy", source: "manual" });
    expect(Array.from(document.querySelectorAll(".st-s-idea__title")).map((e) => e.textContent)).toContain("Dash learns to juggle");
  });

  it("Ask for ideas: a topic and a kind make drafts; each is saved only when Save is tapped", async () => {
    const gen = vi.spyOn(api, "generateIdeas");
    const create = vi.spyOn(api, "createIdea");
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    await click(control("Ask for ideas"), 50);
    type(field(/What about/), "a snowy day");
    await pick("What kind?", "Everyday skills");
    await click(control("Get ideas"));
    expect(gen).toHaveBeenCalledWith("stories", { topic: "a snowy day", category: "everyday_skills", count: 4 });
    const drafts = Array.from(document.querySelectorAll(".st-s-draft"));
    expect(drafts).toHaveLength(4);
    expect(create).not.toHaveBeenCalled();
    await click(control("Save", drafts[1]!));
    expect(create).toHaveBeenCalledTimes(1);
    expect(drafts[1]!.textContent).toContain("Saved");
  });

  it("Make it a full idea shows the concept; More like this adds drafts that point at it", async () => {
    const vary = vi.spyOn(api, "ideaVariations");
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    const gps = () => Array.from(document.querySelectorAll(".st-s-idea")).find((c) => c.textContent?.includes("sleepy GPS"))!;
    await click(control("Make it a full idea", gps()));
    expect(gps().querySelector(".st-s-concept")).not.toBeNull();
    expect(gps().querySelectorAll(".st-s-concept__beats li").length).toBeGreaterThanOrEqual(3);
    await click(control("More like this", gps()));
    expect(vary).toHaveBeenCalledWith("stories", I.gps, { count: 3 });
    expect(document.querySelector(".st-s-drafts__title")?.textContent).toContain("More like");
    expect(document.querySelectorAll(".st-s-draft")).toHaveLength(3);
  });

  it("Delete hides the card at once and Undo brings it back; without Undo it is deleted", async () => {
    const del = vi.spyOn(api, "deleteIdea");
    await show(<IdeasScreen {...page({ name: "ideas" })} />);
    const rainbow = () => Array.from(document.querySelectorAll(".st-s-idea")).find((c) => c.textContent?.includes("How a rainbow is made"));
    await click(control("Delete", rainbow()!), 50);
    expect(rainbow()).toBeUndefined();
    await click(control("Undo"), 50);
    expect(rainbow()).toBeDefined();
    await click(control("Delete", rainbow()!), 50);
    await wait(9000);
    expect(del).toHaveBeenCalledWith("stories", I.rainbow);
    expect(store.ideas.some((i) => i.ideaId === I.rainbow)).toBe(false);
  });
});

// ---------- Characters ----------

describe("Characters", () => {
  it("the gallery shows every character with its rig", async () => {
    await show(<CharactersScreen {...page({ name: "characters" })} />);
    const cards = Array.from(document.querySelectorAll(".st-s-cast__card"));
    expect(cards.map((c) => c.querySelector(".st-s-cast__name")?.textContent)).toEqual(["Bolt", "Dash", "Nana Rose", "Pip"]);
    expect(cards.every((c) => c.querySelector("canvas[role=img]"))).toBe(true);
  });

  it("New character: the five parts, a live preview with each face and move to try, then Save", async () => {
    const create = vi.spyOn(api, "createCharacter");
    await show(<CharactersScreen {...page({ name: "character_new" })} />);
    await pick("Shape", "Tall");
    await pick("Hair style", "Curly");
    await click(control("Next: Face"), 50);
    expect(document.querySelectorAll(".st-s-face")).toHaveLength(14);
    await click(control(/^Try\s*Shocked$/), 50);
    expect(document.querySelector(".st-s-editor__now")?.textContent).toContain("Shocked");
    const neutral = Array.from(document.querySelectorAll(".st-s-face")).find((f) => f.textContent?.includes("Neutral"))!;
    expect(control(/Uses it/, neutral).getAttribute("aria-disabled")).toBe("true");
    await click(control("Next: Moves"), 50);
    await pick("Try a move", "Jump");
    expect(document.querySelector(".st-s-editor__now")?.textContent).toContain("Jump");
    await click(control("Next: Sounds"), 50);
    await click(control(/Whoa/), 50);
    await click(control("Next: Name and personality"), 50);
    await click(control("Save character"), 50);
    expect(text()).toContain("Give your character a name.");
    type(field("Name"), "Zed");
    type(field("Personality"), "Brave and kind");
    type(field(/^Traits/), "brave");
    await click(control("Add"), 50);
    await click(control("Save character"));
    expect(create).toHaveBeenCalledTimes(1);
    const sent = create.mock.calls[0]![1];
    expect(sent).toMatchObject({ name: "Zed", personality: "Brave and kind", traits: ["brave"], movementStyle: "bouncy" });
    expect(sent.look).toMatchObject({ body: "tall", hair: { style: "curly" } });
    expect(sent.voice.noises).toContain("whoa");
    expect(sent.expressions).toContain("neutral");
    expect(location.pathname).toMatch(/^\/stories\/characters\/[0-9A-Z]{26}$/);
  });

  it("an edit that lost a race (409) offers Reload; delete asks first and is refused while a story with it is being made", async () => {
    const put = vi.spyOn(api, "putCharacter");
    await show(<CharactersScreen {...page({ name: "character", characterId: C.nana })} />);
    store.characters.find((c) => c.characterId === C.nana)!.version += 1;
    await click(control("Save changes"));
    expect(put).toHaveBeenCalledTimes(1);
    expect(text()).toContain("was changed somewhere else");
    await click(control("Reload"));
    await click(control("Save changes"));
    expect(put).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Nana Rose is saved.");
    await click(control("Delete"), 50);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Delete Nana Rose?");
    await click(control("Delete", document.querySelector('[role="dialog"]')!));
    expect(text()).toContain("is in a story that is being made");
    expect(store.characters.some((c) => c.characterId === C.nana)).toBe(true);
  });

  it("reference pictures go up with a progress bar and can be removed; the AI picture says how to turn it on", async () => {
    const up = vi.spyOn(api, "referenceUpload");
    const done = vi.spyOn(api, "referenceComplete");
    await show(<CharactersScreen {...page({ name: "character", characterId: C.bolt })} />);
    expect(text()).toContain("AI pictures are off");
    const input = document.querySelector<HTMLInputElement>('.st-s-refs input[type="file"]')!;
    const file = new File([new Uint8Array(4000)], "bolt.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await wait(300);
    expect(document.querySelector(".st-s-refs .st-s-progress")).not.toBeNull();
    await wait(3000);
    expect(up).toHaveBeenCalledWith("stories", C.bolt, { filename: "bolt.png", contentType: "image/png", size: 4000 });
    expect(done).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(".st-s-refs__item")).toHaveLength(1);
    await click(control(/Remove picture 1/));
    expect(document.querySelectorAll(".st-s-refs__item")).toHaveLength(0);
  });
});

// ---------- Production ----------

describe("Production", () => {
  it("New: the idea from the link, its cast, the workspace's default length and captions, then Make the video", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.sandwich })} />);
    const chosen = () => Array.from(document.querySelectorAll('.st-s-casttile[aria-pressed="true"]')).map((t) => t.textContent);
    expect(chosen().map((t) => t?.replace(/[✓+]/g, "").trim())).toEqual(["Dash", "Pip"]);
    const length = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(length.value).toBe("50");
    expect(document.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    const tile = (name: string) => Array.from(document.querySelectorAll<HTMLElement>(".st-s-casttile")).find((t) => t.textContent?.includes(name))!;
    await click(tile("Bolt"), 50);
    await click(tile("Nana Rose"), 50);
    expect(tile("Nana Rose").getAttribute("aria-disabled")).toBe("true");
    expect(tile("Nana Rose").getAttribute("aria-pressed")).toBe("false");
    await click(control("Make the video"));
    expect(create).toHaveBeenCalledWith("stories", { characterIds: [C.pip, C.dash, C.bolt], durationSec: 50, captionsOn: false, musicMood: "comedic", ideaId: I.sandwich });
    expect(location.pathname).toMatch(/^\/stories\/production\/[0-9A-Z]{26}$/);
  });

  it("New: a safety idea without checked advice can't start, and a typed safety concept outside the list is refused with the list", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: I.tractor })} />);
    expect(text()).toContain("only makes driving-safety videos from checked advice");
    await click(control("Make the video"), 50);
    expect(create).not.toHaveBeenCalled();
    await pick("Where the idea comes from", "Type my own");
    type(field("Title"), "Parking in a tiny space");
    type(field("What happens, in one line"), "Dash squeezes the car into a tiny gap.");
    await pick("What kind of video?", "Driving safety");
    // The idea's own character came along.
    expect(document.querySelector('.st-s-casttile[aria-pressed="true"]')?.textContent).toContain("Dash");
    await click(control("Make the video"));
    expect(create).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Checked advice covers:");
  });

  it("the story's page shows the eight steps, checks every 2 seconds while it runs, and lands on Watch it in Review", async () => {
    const get = vi.spyOn(api, "getStory");
    await show(<ProductionScreen {...page({ name: "production_story", storyId: S.producing })} />);
    expect(document.querySelectorAll(".st-s-track__step")).toHaveLength(8);
    const calls = get.mock.calls.length;
    await wait(4100);
    expect(get.mock.calls.length - calls).toBeGreaterThanOrEqual(2);
    expect(document.querySelectorAll(".st-s-film__card").length).toBeGreaterThan(2);
    await wait(10_000);
    expect(document.querySelectorAll(".st-s-track__step.is-done")).toHaveLength(8);
    expect(control("Watch it in Review").getAttribute("href")).toBe(`/stories/review/${S.producing}`);
  });

  it("Cancel stops a run; Try again on a stopped one runs only what is left", async () => {
    const cancel = vi.spyOn(api, "cancelStory");
    const produce = vi.spyOn(api, "produce");
    await show(<ProductionScreen {...page({ name: "production_story", storyId: S.producing })} />);
    await click(control("Cancel"));
    expect(cancel).toHaveBeenCalledWith("stories", S.producing);
    await act(async () => root.render(<ToastProvider><ProductionScreen {...page({ name: "production_story", storyId: S.failed })} /></ToastProvider>));
    await wait();
    await click(control("Try again from “Animate”"));
    expect(produce).toHaveBeenCalledWith("stories", S.failed);
    expect(document.querySelector(".st-s-track.is-live")).not.toBeNull();
    await wait(6000);
    expect(document.querySelector(".st-s-track__step.is-running, .st-s-track__step.is-done:nth-child(8)")).not.toBeNull();
  });

  it("the list shows every story with its step track", async () => {
    await show(<ProductionScreen {...page({ name: "production" })} />);
    expect(document.querySelectorAll(".st-s-run")).toHaveLength(store.stories.length);
    expect(document.querySelectorAll(".st-s-run .st-s-track__steps").length).toBe(store.stories.length);
  });
});

// ---------- Review ----------

describe("Review", () => {
  it("the queue holds only videos to watch or check (and approved and posted ones below)", async () => {
    await show(<ReviewScreen {...page({ name: "review" })} />);
    const titles = Array.from(document.querySelectorAll(".st-s-qcard__title")).map((e) => e.textContent);
    expect(titles).toEqual(["Foggy morning drive", "When the car starts to slide", "Bolt ties his shoes", "The sandwich tower"]);
  });

  it("needs_check: the problems and sources show, Approve waits, and a fixed caption is saved then checked again", async () => {
    const patch = vi.spyOn(api, "patchStory");
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.needsCheck })} />);
    expect(text()).toContain("Fix the facts first.");
    expect(document.querySelectorAll(".st-s-sources li").length).toBeGreaterThan(0);
    expect(control("Approve").getAttribute("aria-disabled")).toBe("true");
    const bad = Array.from(document.querySelectorAll<HTMLInputElement>(".st-s-cue input")).find((i) => /full beam/.test(i.value))!;
    type(bad, "Use dipped headlights in fog");
    await click(control("Save captions"));
    expect(patch.mock.calls[0]![2]).toMatchObject({ captions: expect.arrayContaining([expect.objectContaining({ text: "Use dipped headlights in fog" })]) });
    await click(control("Check again"));
    expect(produce).toHaveBeenCalledWith("stories", S.needsCheck);
    await wait(12_000);
    expect(control("Approve").getAttribute("aria-disabled")).toBeNull();
  });

  it("Approve celebrates and turns into Post it; the approve rule blocks a stale video", async () => {
    const approve = vi.spyOn(api, "approve");
    const story = structuredClone(store.stories.find((s) => s.storyId === S.review)!);
    expect(approveBlock({ ...story, stale: ["sound"] })).toBe("Your changes aren't in the video yet. Tap Remake first.");
    expect(approveBlock({ ...story, safety: { ...story.safety!, checkedScriptVersion: story.scriptVersion - 1 } })).toBe("Your changes aren't in the video yet. Tap Remake first.");
    expect(approveBlock(story)).toBeNull();
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(control("Approve"));
    expect(approve).toHaveBeenCalledWith("stories", S.review, story.version);
    expect(text()).toContain("Approved! Now you can post it.");
    expect(control("Post it")).toBeDefined();
    expect(control("Download")).toBeDefined();
  });

  it("Remake this scene sends only the scene; Remake the whole video starts from the storyboard; Ask for changes sends the note and scenes", async () => {
    const changes = vi.spyOn(api, "requestChanges");
    const produce = vi.spyOn(api, "produce");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    const second = store.stories.find((s) => s.storyId === S.review)!.scenes[1]!.sceneId;
    await click(control("Remake this scene", document.querySelectorAll(".st-s-film__card")[1]!));
    expect(changes).toHaveBeenLastCalledWith("stories", S.review, { sceneIds: [second] });
    await wait(12_000);
    await click(control("Remake the whole video"), 50);
    await click(control("Remake it"));
    expect(produce).toHaveBeenLastCalledWith("stories", S.review, { from: "storyboard" });
    await wait(12_000);
    await click(control("Ask for changes"), 50);
    type(field("What should change?"), "More snow, please");
    await click(control(/^\+?\s*1\. /), 50);
    await click(control("Send the changes"));
    expect(changes).toHaveBeenLastCalledWith("stories", S.review, { note: "More snow, please", sceneIds: [store.stories.find((s) => s.storyId === S.review)!.scenes[0]!.sceneId] });
  });

  it("Reject keeps the reason", async () => {
    const reject = vi.spyOn(api, "reject");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await click(control("Reject"), 50);
    type(field(/^Why\?/), "Too dark");
    await click(control("Reject the video"));
    expect(reject).toHaveBeenCalledWith("stories", S.review, "Too dark");
    expect(text()).toContain("Not used.");
  });

  it("the post words show each platform's limit; the sound effects editor adds, moves and removes effects", async () => {
    const patch = vi.spyOn(api, "patchStory");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.review })} />);
    await pick("Which words", "With the post");
    type(field("X"), "x".repeat(281));
    expect(text()).toContain("281 / 280");
    await click(control("Save post words"), 50);
    expect(patch).not.toHaveBeenCalled();
    type(field("X"), "Pip on ice!");
    await click(control("Save post words"));
    expect(patch.mock.calls[0]![2]).toMatchObject({ postCaptions: { x: "Pip on ice!" } });
    expect(Object.keys(patch.mock.calls[0]![2].postCaptions!)).toEqual(["x"]);

    const scene = document.querySelectorAll(".st-s-sfx__scene")[2]!;
    const before = scene.querySelectorAll(".st-s-sfx__row").length;
    await click(control(/Add a sound/, scene), 50);
    expect(scene.querySelectorAll(".st-s-sfx__row")).toHaveLength(before + 1);
    const marks = scene.querySelectorAll<HTMLButtonElement>(".st-s-timeline__mark");
    const mark = marks[marks.length - 1]!;
    await act(async () => mark.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await click(control("Save sounds"));
    const sent = patch.mock.calls[1]![2].scenes![0]!;
    const script = store.scripts[S.review]!;
    expect(sent.sceneId).toBe(script.scenes[2]!.sceneId);
    const added = sent.sfx!.find((c) => c.id.includes(".own"))!;
    expect(added).toMatchObject({ sfx: "pop", volume: 0.8 });
    // Added in the middle of the scene, then moved on by one tenth of a second with the arrow key.
    expect(added.at).toBeCloseTo(Math.round((Math.round((script.scenes[2]!.durationSec / 2) * 10) / 10 + 0.1) * 10) / 10, 5);
    expect(text()).toContain("Saved. Tap Remake to put it in the video.");
    expect(text()).toContain("Your changes aren't in the video yet.");
    const rows = () => document.querySelectorAll(".st-s-sfx__scene")[2]!.querySelectorAll(".st-s-sfx__row");
    const n = rows().length;
    await click(control(/^Remove/, rows()[n - 1]!), 50);
    expect(rows()).toHaveLength(n - 1);
  });

  it("Download fetches the file link for an approved video", async () => {
    const dl = vi.spyOn(api, "download");
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Download"));
    expect(dl).toHaveBeenCalledWith("stories", S.approved);
    expect(clicked).toHaveBeenCalled();
    clicked.mockRestore();
  });
});

// ---------- Post it ----------

describe("Post it", () => {
  it("lists only this workspace's connected accounts by name, with nothing chosen; others only offer Connect in Connections", async () => {
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    const dialog = document.querySelector('[role="dialog"]')!;
    const places = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button.st-s-place"));
    expect(places.map((p) => p.querySelector(".st-s-place__name")?.textContent)).toEqual(["Lamo Stories Channel", "Lamo Stories TikTok"]);
    expect(places.every((p) => p.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(control(/Post it|Post to/, dialog).getAttribute("aria-disabled")).toBe("true");
    const off = Array.from(dialog.querySelectorAll(".st-s-place--off"));
    expect(off.map((o) => o.querySelector(".st-s-place__platform")?.textContent)).toEqual(["Instagram", "Facebook", "X"]);
    expect(off.every((o) => o.querySelector('a[href="/stories/connections"]'))).toBe(true);
  });

  it("TikTok: who can see it starts empty with TikTok's own choices; Comments, Duet and Stitch show and start off; Use my settings fills the preset", async () => {
    const publish = vi.spyOn(api, "publish");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    await click(control("Post it"));
    const dialog = () => document.querySelector('[role="dialog"]')!;
    await click(control(/Lamo Stories TikTok/, dialog()));
    expect(dialog().querySelector(".dropdown__value")?.textContent).toBe("Pick who can see it");
    const switches = () => Array.from(dialog().querySelectorAll<HTMLElement>(".st-tiktok [role=switch]"));
    expect(switches().slice(0, 3).map((s) => s.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    expect(control(/Post it|Post to/, dialog()).getAttribute("aria-disabled")).toBe("true");
    await click(control(/Lamo Stories Channel/, dialog()), 50);
    await click(control("Use my settings", dialog()), 50);
    expect(dialog().querySelector(".dropdown__value")?.textContent).toBe("Everyone");
    expect(switches().slice(0, 3).map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
    await click(control("More details", dialog()), 50);
    expect(dialog().textContent).toContain("Made for kids: No");
    await click(control("Post to 2 places", dialog()));
    expect(publish).toHaveBeenCalledWith("stories", S.approved, [
      { platform: "tiktok", socialAccountId: "stories.tiktok", options: { privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: false, disableStitch: false, brandContent: false, brandOrganic: false } },
      { platform: "youtube", socialAccountId: "stories.youtube", options: { privacy: "public", category: "1", notifySubscribers: true } },
    ]);
    expect(dialog().textContent).toContain("Sending your video");
  });

  it("flat options per platform (§45.6)", () => {
    const yt = { privacy: "private" as const, category: "27", notifySubscribers: false };
    expect(optionsFor("youtube", yt, true, NO_TIKTOK_CHOICES, null)).toEqual({ privacy: "private", category: "27", notifySubscribers: false });
    expect(optionsFor("instagram", yt, false, NO_TIKTOK_CHOICES, null)).toEqual({ shareToFeed: false });
    expect(optionsFor("facebook", yt, true, NO_TIKTOK_CHOICES, null)).toBeUndefined();
    expect(optionsFor("tiktok", yt, true, { ...NO_TIKTOK_CHOICES, privacy: "SELF_ONLY", comments: true }, { ...CREATOR, commentDisabled: true })).toEqual({
      privacyLevel: "SELF_ONLY",
      disableComment: true,
      disableDuet: true,
      disableStitch: true,
      brandContent: false,
      brandOrganic: false,
    });
  });

  it("the Posts panel: each job's sentence and Try again; a changed account asks first, then sends confirmAccount", async () => {
    const retry = vi.spyOn(api, "retryPublishing");
    pubs.push({
      publishingJobId: "pj-old",
      workspaceId: "stories",
      contentId: S.approved,
      socialAccountId: "stories.youtube",
      platform: "youtube",
      publishingStatus: "needs_attention",
      accountName: "Old Channel",
      error: "Lamo Stories' YouTube (Old Channel) needs connecting again. Open Lamo Stories › Connections, then tap Try again.",
      createdAt: "2026-11-21T11:00:00.000Z",
      updatedAt: "2026-11-21T11:00:00.000Z",
    });
    retry.mockRejectedValueOnce(new ApiError(409, "conflict", "Lamo Stories' YouTube is now Lamo Stories Channel. Check it, then tap Try again."));
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    expect(document.querySelector(".st-s-post__why")?.textContent).toContain("needs connecting again");
    await click(control("Try again", document.querySelector(".st-postspanel")!));
    expect(retry).toHaveBeenCalledWith("stories", "pj-old", undefined);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Lamo Stories Channel");
    expect(dialog.textContent).toContain("ext-youtube");
    await click(control(/Yes, post to/, dialog));
    expect(retry).toHaveBeenLastCalledWith("stories", "pj-old", { confirmAccount: "ext-youtube" });
    expect(document.querySelector(".st-s-post")?.textContent).toContain("Waiting");
  });

  it("a post that goes up while watching is celebrated", async () => {
    pubs.push({ publishingJobId: "pj1", workspaceId: "stories", contentId: S.approved, socialAccountId: "stories.youtube", platform: "youtube", publishingStatus: "publishing", accountName: "Lamo Stories Channel", createdAt: "2026-11-21T11:00:00.000Z", updatedAt: "2026-11-21T11:00:00.000Z" });
    await show(<ReviewScreen {...page({ name: "review_story", storyId: S.approved })} />);
    pubs[0]!.publishingStatus = "posted";
    pubs[0]!.url = "https://youtube.com/shorts/x";
    await wait(10_500);
    expect(text()).toContain("Posted to YouTube!");
    expect(document.querySelector(".st-s-post a")?.getAttribute("href")).toBe("https://youtube.com/shorts/x");
  });

  it("the sheet alone: no account connected means no post, only the way to Connections", async () => {
    for (const a of store.social) a.connectionStatus = "not_connected";
    const story = store.stories.find((s) => s.storyId === S.approved)!;
    await show(<PublishSheet ws="stories" story={story} config={{}} jobs={[]} onSent={() => undefined} onRetry={() => undefined} onClose={() => undefined} />);
    expect(document.querySelectorAll("button.st-s-place")).toHaveLength(0);
    expect(text()).toContain("No Lamo Stories account is connected yet.");
    expect(control("Post it").getAttribute("aria-disabled")).toBe("true");
  });
});
