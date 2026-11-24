// The Lamo Stories mock, round 3 (docs/CONTRACTS.md §45.34): it answers every new call the way the API does, so
// `npm run dev:mock` and Playwright behave like the real app. Write them again (a captions task whose draft is never
// saved, 409 with no storyboard), Story.effective and Story.format (the workspace's default, or the body's own shape,
// checked), Download of an extra copy by name, the account a publishing 409 names (a TikTok Lamo Stories cannot tell
// from Lamo Clips', an account that changed) until confirmAccount, a redesign of a saved character (its name kept),
// an edited full idea checked like the API, a reference video's own setting and its job in GET, and the chat paged
// with `before`. In memory, with fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as chat from "../src/stories/api/mock/chat.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import * as library from "../src/stories/api/mock/library.ts";
import * as publishing from "../src/stories/api/mock/publishing.ts";
import * as references from "../src/stories/api/mock/references.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import type { AiTask, SocialAccount, StoriesApi, StoriesConfig, Workspace } from "../src/stories/api/types.ts";
import { accountOf } from "../src/stories/studio/words.ts";

const WS: Workspace = {
  workspaceId: "stories",
  workspaceName: "Lamo Stories",
  workspaceType: "stories",
  builtin: false,
  configuration: {
    defaultDurationSec: 40,
    captionsOn: true,
    musicOn: true,
    providers: { images: "builtin-rig", video: "builtin-2d", audio: "builtin-synth" },
    video: { resolution: "1080x1080", aspect: "1:1", quality: "high", fps: 30 } as unknown as StoriesConfig["video"],
    production: { burnCaptions: true, scenesAtOnce: 2, keepVersions: "all" },
    youtubeCategory: "27",
    youtubePrivacy: "public",
    xMonthlyLimitUsd: null,
  } satisfies StoriesConfig,
  version: 1,
};

const S = stories.SEED_IDS.stories;
const C = stories.SEED_IDS.characters;
const I = stories.SEED_IDS.ideas;

const social = (platform: SocialAccount["platform"], extra: Partial<SocialAccount> = {}): SocialAccount => ({
  socialAccountId: `stories.${platform}`,
  workspaceId: "stories",
  platform,
  app: { choice: "clips", saved: true },
  lastCheckedAt: null,
  connectionStatus: "connected",
  externalAccountId: `ext-${platform}`,
  accountName: `Lamo ${platform}`,
  handle: `@lamo.${platform}`,
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
  ...extra,
});

let store: MockStore;
let api: StoriesApi;

function setup(knobs: Record<string, unknown> = {}) {
  store = createStore();
  store.knobs = { ...knobs };
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  chat.seed(store);
  references.seed(store);
  store.social.push(social("youtube"), social("tiktok"));
  publishing.afterSeed(store);
  api = { ...ideas.api(store), ...characters.api(store), ...stories.api(store), ...publishing.api(store), ...library.api(store), ...chat.api(store), ...references.api(store) } as StoriesApi;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
  setup();
});

afterEach(() => {
  vi.useRealTimers();
});

async function call<T>(p: Promise<T>): Promise<T> {
  const out = p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  await vi.advanceTimersByTimeAsync(1200);
  const r = await out;
  if (!r.ok) throw r.e;
  return r.v;
}

async function refused(p: Promise<unknown>): Promise<ApiError> {
  try {
    await call(p);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the call to be refused");
}

async function settled(p: Promise<AiTask>): Promise<AiTask> {
  const t = await call(p);
  await vi.advanceTimersByTimeAsync(4000);
  return call(api.getTask("stories", t.taskId));
}

describe("Write them again", () => {
  it("is a captions task of the storyboard agent whose draft is never saved by itself", async () => {
    const before = structuredClone(store.stories.find((s) => s.storyId === S.review)!.postCaptions);
    const task = await settled(api.writeCaptions("stories", S.review, { override: { model: "haiku-5-5", effort: "low" } }));
    expect(task).toMatchObject({ kind: "captions", status: "done", model: "haiku-5-5", effort: "low" });
    const r = task.result as { storyId: string; scriptVersion: number; postCaptions: Record<string, string> };
    expect(r.storyId).toBe(S.review);
    expect(r.scriptVersion).toBe(store.stories.find((s) => s.storyId === S.review)!.scriptVersion);
    expect(Object.keys(r.postCaptions).sort()).toEqual(["facebook", "instagram", "tiktok", "x", "youtubeDescription", "youtubeTitle"]);
    expect(r.postCaptions.youtubeTitle).not.toBe(before.youtubeTitle);
    expect(store.stories.find((s) => s.storyId === S.review)!.postCaptions).toEqual(before);
  });

  it("answers 409 while the story has no storyboard, and refuses an unknown key or model", async () => {
    expect((await refused(api.writeCaptions("stories", S.draft))).status).toBe(409);
    expect((await refused(api.writeCaptions("stories", S.review, { nope: 1 } as never))).code).toBe("bad_request");
    expect((await refused(api.writeCaptions("stories", S.review, { override: { model: "gpt-0" } }))).code).toBe("bad_request");
  });
});

describe("Story.effective and Story.format", () => {
  it("every story carries what its next run uses", async () => {
    const { stories: list } = await call(api.listStories("stories", { status: "all", limit: 50 }));
    expect(list.every((s) => s.effective && s.effective.model)).toBe(true);
    expect(list.find((s) => s.storyId === S.approved)!.effective).toEqual({ model: "fable-5-2", effort: "high", effortApplied: true, from: "project" });
    expect(list.find((s) => s.storyId === S.review)!.effective).toMatchObject({ model: "opus-5-5", from: "default" });
  });

  it("a new story gets the workspace's shape, or the body's own, checked like the API", async () => {
    const made = await call(api.createStory("stories", { ideaId: I.sandwich, characterIds: [C.pip] }));
    expect(made.story.format).toEqual({ aspect: "1:1", width: 1080, height: 1080 });
    const wide = await call(api.createStory("stories", { ideaId: I.gps, characterIds: [C.nana], format: { aspect: "16:9", width: 1920, height: 1080 } }));
    expect(wide.story.format).toEqual({ aspect: "16:9", width: 1920, height: 1080 });
    expect((await refused(api.createStory("stories", { ideaId: I.gps, characterIds: [C.nana], format: { aspect: "16:9", width: 1080, height: 1920 } }))).message).toBe("That size does not fit that shape. Pick one of its sizes.");
    expect((await refused(api.createStory("stories", { ideaId: I.gps, characterIds: [C.nana], format: { aspect: "4:3" as never, width: 800, height: 600 } }))).code).toBe("bad_request");
  });
});

describe("Download of an extra copy", () => {
  it("answers a copy the video has by name, and 409 for one it has not", async () => {
    expect((await call(api.download("stories", S.approved))).filename).toMatch(/\.mp4$/);
    expect(await refused(api.download("stories", S.approved, { format: "webm" }))).toMatchObject({ status: 404, message: "That format was not made for this video." });
    setup({ extraFormats: ["webm", "mov"] });
    expect((await call(api.download("stories", S.approved, { format: "webm" }))).filename).toMatch(/\.webm$/);
    expect((await call(api.download("stories", S.approved, { format: "mov" }))).filename).toMatch(/\.mov$/);
    // Each copy is an ASSET# of kind video with meta.format (§45.34), beside the final_video MP4.
    const { items } = await call(api.library("stories", { storyId: S.approved, limit: 100 }));
    expect(items.filter((i) => i.kind === "final_video" || i.kind === "video").map((i) => `${i.kind}:${i.meta.format ?? "mp4"}`).sort()).toEqual(["final_video:mp4", "video:mov", "video:webm"]);
    expect((await refused(api.download("stories", S.review, { format: "webm" }))).status).toBe(409);
  });
});

describe("the account a publishing 409 names (§45.34)", () => {
  it("a TikTok Lamo Stories cannot tell from Lamo Clips' asks once per identity, then confirmAccount sends it", async () => {
    store.social.find((a) => a.platform === "tiktok")!.reason = "clips_unknown";
    const count = store.publishing.length;
    const e = await refused(api.publish("stories", S.approved, [{ platform: "tiktok", socialAccountId: "stories.tiktok" }]));
    expect(e.status).toBe(409);
    expect(accountOf(e)).toEqual({ externalAccountId: "ext-tiktok", accountName: "Lamo tiktok", handle: "@lamo.tiktok" });
    // Nothing is written while the owner is asked.
    expect(store.publishing).toHaveLength(count);
    const made = await call(api.publish("stories", S.approved, [{ platform: "tiktok", socialAccountId: "stories.tiktok", confirmAccount: "ext-tiktok" }]));
    expect(made[0]).toMatchObject({ platform: "tiktok", accountName: "Lamo tiktok", handle: "@lamo.tiktok", externalAccountId: "ext-tiktok" });
    // Asked once: the next post there goes straight on.
    await call(api.publish("stories", S.published, [{ platform: "tiktok", socialAccountId: "stories.tiktok" }]));
  });

  it("a confirmAccount that is not the account it would go to now names the account", async () => {
    const e = await refused(api.publish("stories", S.approved, [{ platform: "youtube", socialAccountId: "stories.youtube", confirmAccount: "ext-old" }]));
    expect(e.message).toContain("Clips Funded's YouTube is a different account now: this YouTube account (Lamo youtube). Tap Yes if that is right.");
    expect(accountOf(e)?.externalAccountId).toBe("ext-youtube");
  });

  it("Try again on a post whose account changed asks first, then records the new account", async () => {
    const job = store.publishing.find((j) => j.platform === "tiktok")!;
    Object.assign(store.social.find((a) => a.platform === "tiktok")!, { externalAccountId: "ext-new", accountName: "New", handle: "@new" });
    const e = await refused(api.retryPublishing("stories", job.publishingJobId));
    expect(accountOf(e)).toEqual({ externalAccountId: "ext-new", accountName: "New", handle: "@new" });
    const next = await call(api.retryPublishing("stories", job.publishingJobId, { confirmAccount: "ext-new" }));
    expect(next).toMatchObject({ publishingStatus: "queued", externalAccountId: "ext-new", accountName: "New", handle: "@new" });
  });
});

describe("a redesign of a saved character", () => {
  it("keeps its name and changes only what the words are about; an unknown character is 404", async () => {
    const pip = store.characters.find((c) => c.characterId === C.pip)!;
    const task = await settled(api.designCharacter("stories", { description: "Give Pip a big blue jumper", characterId: C.pip }));
    const draft = (task.result as { character: typeof pip }).character;
    expect(draft.name).toBe("Pip");
    expect(draft.look.outfit.top).toBe("#62c6ff");
    expect(draft.look.hair).toEqual(pip.look.hair);
    expect(draft.movementStyle).toBe(pip.movementStyle);
    expect(draft.voice).toEqual(pip.voice);
    expect((await refused(api.designCharacter("stories", { description: "anything", characterId: "01JSTCHNOPE00000000000000" }))).status).toBe(404);
  });
});

describe("an edited full idea", () => {
  it("is checked like the API: 3 to 8 steps, an ending, a known feel, up to 6 words on screen", async () => {
    const skid = store.ideas.find((i) => i.ideaId === I.skid)!;
    const c = structuredClone(skid.concept!);
    expect((await refused(api.patchIdea("stories", I.skid, { concept: { ...c, beats: ["one", "two"] } }))).message).toBe("concept.beats needs 3 to 8 lines.");
    expect((await refused(api.patchIdea("stories", I.skid, { concept: { ...c, ending: "" } }))).code).toBe("bad_request");
    expect((await refused(api.patchIdea("stories", I.skid, { concept: { ...c, onScreenText: ["1", "2", "3", "4", "5", "6", "7"] } }))).code).toBe("bad_request");
    const saved = await call(api.patchIdea("stories", I.skid, { title: "Calm hands on ice", concept: { ...c, beats: ["a", "b", "c"], tone: "calm" } }));
    expect(saved).toMatchObject({ title: "Calm hands on ice", concept: { beats: ["a", "b", "c"], tone: "calm" } });
  });
});

describe("a reference video's own setting and its job", () => {
  it("PATCH { ai } keeps the model and effort with the video; an unknown model is refused", async () => {
    const r = await call(api.patchReference("stories", references.SEED_IDS.ready, { ai: { model: "sonnet-5-5", effort: "low" } }));
    expect(r.ai).toEqual({ model: "sonnet-5-5", effort: "low" });
    expect((await refused(api.patchReference("stories", references.SEED_IDS.ready, { ai: { model: "gpt-0", effort: null } }))).code).toBe("bad_request");
    expect((await refused(api.patchReference("stories", references.SEED_IDS.ready, {}))).code).toBe("bad_request");
    const started = await call(api.analyzeReference("stories", references.SEED_IDS.ready));
    expect(started.job.meta.models[0]).toMatchObject({ model: "sonnet-5-5", effort: "low" });
    // As the API: the setting can change while a run works (that run keeps what it started with).
    expect((await call(api.patchReference("stories", references.SEED_IDS.ready, { ai: { model: null, effort: null } }))).ai).toEqual({ model: null, effort: null });
    const got = await call(api.getReference("stories", references.SEED_IDS.ready));
    expect(got.job?.jobId).toBe(started.job.jobId);
    expect(got.job?.steps.map((s) => s.key)).toEqual(["look", "listen", "write"]);
    expect((await call(api.getReference("stories", references.SEED_IDS.analyzed))).job).toBeNull();
  });
});

describe("the chat paged with before", () => {
  it("answers the newest 500, then the 500 before a message, then fewer", async () => {
    setup({ longChat: 1120 });
    const id = chat.SEED_IDS.conversations.long;
    const newest = (await call(api.getConversation("stories", id))).messages;
    expect(newest).toHaveLength(chat.SHOWN);
    expect(newest.at(-1)!.text).toBe("Answer number 1120");
    const older = (await call(api.getConversation("stories", id, { before: newest[0]!.msgId }))).messages;
    expect(older).toHaveLength(chat.SHOWN);
    expect(newest[0]!.text).toBe("Question number 621");
    expect(older.at(-1)!.text).toBe("Answer number 620");
    const oldest = (await call(api.getConversation("stories", id, { before: older[0]!.msgId }))).messages;
    expect(oldest).toHaveLength(120);
    expect(oldest[0]!.text).toBe("Question number 1");
    expect((await refused(api.getConversation("stories", id, { before: "01JSTMSNOPE000000000000000" }))).status).toBe(404);
  });
});
