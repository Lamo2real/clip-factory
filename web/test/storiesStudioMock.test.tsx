// The Lamo Stories mock's ideas, characters and stories parts (docs/CONTRACTS.md §45.7–§45.9, §45.16.8): the seed
// covers every story status, every script passes the engine's validator, a production job walks its run in about 10 s,
// and the status table, the stale rules and the approve rule hold as they do in the API.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import { STEP_ORDER, type StoriesApi, type Workspace } from "../src/stories/api/types.ts";
import { validateScript } from "../src/stories/engine/engine.ts";

const WS: Workspace = {
  workspaceId: "stories",
  workspaceName: "Lamo Stories",
  workspaceType: "stories",
  builtin: false,
  configuration: {
    defaultDurationSec: 40,
    captionsOn: true,
    musicOn: true,
    storyModel: "claude-sonnet",
    providers: { images: "builtin-rig", animation: "builtin-2d", audio: "builtin-synth" },
    youtubeCategory: "27",
    youtubePrivacy: "public",
  },
  version: 1,
};

let store: MockStore;
let api: Pick<StoriesApi, (typeof ideas.KEYS)[number] | (typeof characters.KEYS)[number] | (typeof stories.KEYS)[number]>;
const S = stories.SEED_IDS.stories;
const C = stories.SEED_IDS.characters;
const I = stories.SEED_IDS.ideas;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
  store = createStore();
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  api = { ...ideas.api(store), ...characters.api(store), ...stories.api(store) };
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs a mock call to the end (its fake latency included). */
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

/** Lets a production job walk to its end (10 s by default). */
async function finish(seconds = 12) {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

describe("the seed", () => {
  it("has several characters, the safety ideas and a story in every status", async () => {
    const cast = await call(api.listCharacters("stories"));
    expect(cast.length).toBeGreaterThanOrEqual(4);
    expect(cast.map((c) => c.name)).toEqual([...cast.map((c) => c.name)].sort((a, b) => a.localeCompare(b)));
    const all = await call(api.listIdeas("stories"));
    expect(all.some((i) => i.category === "driving_safety" && i.safetyTopicId && !i.needsGuidance)).toBe(true);
    expect(all.some((i) => i.category === "driving_safety" && i.needsGuidance && !i.safetyTopicId)).toBe(true);
    const { stories: list } = await call(api.listStories("stories", { status: "all", limit: 50 }));
    const statuses = new Set(list.map((s) => s.status));
    for (const s of ["draft", "producing", "needs_check", "review", "approved", "rejected", "published", "failed"]) expect(statuses.has(s as never), s).toBe(true);
  });

  it("the studio e2e opens the very ids the seed has", () => {
    const spec = readFileSync(join(import.meta.dirname, "..", "e2e", "stories-studio.spec.ts"), "utf8");
    for (const id of [S.review, S.needsCheck, S.approved, S.failed, I.deer, C.pip]) expect(spec).toContain(id);
  });

  it("every seeded script passes the engine's validator", () => {
    const scripts = Object.entries(store.scripts);
    expect(scripts.length).toBeGreaterThanOrEqual(6);
    for (const [id, script] of scripts) {
      const r = validateScript(script);
      expect(r.ok, `${id}: ${r.ok ? "" : r.errors.join(" ")}`).toBe(true);
    }
  });

  it("the needs_check story has its problems, the review story's facts are checked on its storyboard", async () => {
    const nc = await call(api.getStory("stories", S.needsCheck));
    expect(nc.story.status).toBe("needs_check");
    expect(nc.story.safety?.status).toBe("problems");
    expect(nc.story.safety?.problems.length).toBeGreaterThan(0);
    expect(nc.story.safety?.citations.length).toBeGreaterThan(0);
    const rv = await call(api.getStory("stories", S.review));
    expect(rv.story.safety).toMatchObject({ status: "ok", checkedScriptVersion: rv.story.scriptVersion });
    expect(rv.story.stale).toEqual([]);
    expect(rv.script?.safety?.topicId).toBe(rv.story.safetyTopicId);
  });
});

describe("ideas", () => {
  it("match a driving idea to its checked topic, or mark it as needing checked advice", async () => {
    const ok = await call(api.createIdea("stories", { title: "Black ice on the bridge", logline: "Pip's car starts to skid on black ice.", category: "driving_safety" }));
    expect(ok.safetyTopicId).toBeTruthy();
    expect(ok.needsGuidance).toBe(false);
    const no = await call(api.createIdea("stories", { title: "Parallel parking", logline: "Dash squeezes into a tiny space.", category: "driving_safety" }));
    expect(no).toMatchObject({ safetyTopicId: null, needsGuidance: true });
    const fun = await call(api.createIdea("stories", { title: "Ice cream mountain", logline: "Bolt builds an ice cream tower.", category: "comedy" }));
    expect(fun).toMatchObject({ safetyTopicId: null, needsGuidance: false });
  });

  it("Ask for ideas makes drafts and saves nothing; Expand fills the concept; More like this points at its idea", async () => {
    const before = store.ideas.length;
    const drafts = await call(api.generateIdeas("stories", { topic: "snow", category: "comedy", count: 3 }));
    expect(drafts).toHaveLength(3);
    expect(drafts.every((d) => d.category === "comedy" && d.source === "ai")).toBe(true);
    expect(store.ideas.length).toBe(before);
    const grown = await call(api.expandIdea("stories", I.deer, { durationSec: 45 }));
    expect(grown.concept?.beats.length).toBeGreaterThanOrEqual(3);
    expect(grown.concept?.beats.length).toBeLessThanOrEqual(8);
    expect(grown.concept?.onScreenText.length).toBeLessThanOrEqual(6);
    expect(grown.title).toBe("A deer on the road");
    const more = await call(api.ideaVariations("stories", I.gps, { count: 2 }));
    expect(more).toHaveLength(2);
    expect(more.every((d) => d.source === "variation" && d.parentIdeaId === I.gps)).toBe(true);
    expect((await refused(api.expandIdea("stories", I.tractor))).code).toBe("conflict");
  });

  it("are refused on Lamo Clips' workspace and on an unknown one", async () => {
    expect((await refused(api.listIdeas("clips"))).status).toBe(409);
    expect((await refused(api.listIdeas("01JZZZZZZZZZZZZZZZZZZZZZZZ"))).status).toBe(404);
  });
});

describe("characters", () => {
  it("edit with a version (a stale one is 409), refuse a duplicate name, and can't be deleted while being made", async () => {
    const pip = await call(api.getCharacter("stories", C.pip));
    const { characterId: _id, workspaceId: _w, references: _r, portrait: _p, storyCount: _s, createdAt: _c, updatedAt: _u, ...input } = pip;
    const saved = await call(api.putCharacter("stories", C.pip, { ...input, personality: "Brave now", version: pip.version }));
    expect(saved.version).toBe(pip.version + 1);
    expect((await refused(api.putCharacter("stories", C.pip, { ...input, version: pip.version }))).code).toBe("conflict");
    expect((await refused(api.createCharacter("stories", { ...input, version: undefined } as never))).message).toMatch(/already have a character called Pip/);
    // Nana Rose is in the story being made right now.
    expect((await refused(api.deleteCharacter("stories", C.nana))).message).toMatch(/being made/);
  });

  it("take reference pictures through a presigned PUT, at most 10 MB, and portraits only with AI pictures on", async () => {
    expect((await refused(api.referenceUpload("stories", C.bolt, { filename: "big.png", contentType: "image/png", size: 11 * 1024 * 1024 }))).code).toBe("too_large");
    expect((await refused(api.referenceUpload("stories", C.bolt, { filename: "a.gif", contentType: "image/gif", size: 10 }))).code).toBe("bad_request");
    const up = await call(api.referenceUpload("stories", C.bolt, { filename: "bolt.png", contentType: "image/png", size: 2000 }));
    expect(up.uploadUrl.startsWith("mock:")).toBe(true);
    const bolt = await call(api.referenceComplete("stories", C.bolt, up.assetId));
    expect(bolt.references.map((r) => r.assetId)).toContain(up.assetId);
    expect(store.assets.some((a) => a.assetId === up.assetId && a.kind === "character_ref")).toBe(true);
    expect((await refused(api.makePortrait("stories", C.bolt))).message).toMatch(/AI pictures are off/);
    (store.workspaces[0]!.configuration as { providers: { images: string } }).providers.images = "nova-canvas";
    const job = await call(api.makePortrait("stories", C.bolt));
    expect(job.jobType).toBe("portrait");
    await finish(4);
    expect((await call(api.getCharacter("stories", C.bolt))).portrait).not.toBeNull();
  });
});

describe("a new story", () => {
  it("walks every step in about 10 seconds and lands in review, with its idea marked used", async () => {
    const { story, job } = await call(api.createStory("stories", { ideaId: I.deer, characterIds: [C.pip, C.dash] }));
    expect(story.status).toBe("producing");
    expect(story.durationSec).toBe(40);
    expect(job.configuration.run).toEqual(STEP_ORDER);
    await vi.advanceTimersByTimeAsync(4000);
    const mid = await call(api.getStory("stories", story.storyId));
    expect(mid.job?.status).toBe("running");
    expect(mid.job?.progress).toBeGreaterThan(0);
    expect(mid.job?.progress).toBeLessThan(1);
    expect(mid.script).not.toBeNull();
    await finish();
    const done = await call(api.getStory("stories", story.storyId));
    expect(done.story.status).toBe("review");
    expect(done.job?.status).toBe("ready");
    expect(done.job?.steps.every((s) => s.status === "done")).toBe(true);
    expect(done.story.stale).toEqual([]);
    expect(done.story.scenes.length).toBeGreaterThan(2);
    expect(done.story.actualDurationSec).toBeGreaterThan(30);
    expect(done.story.actualDurationSec).toBeLessThanOrEqual(89.5);
    expect(done.story.postCaptions.youtubeTitle.length).toBeLessThanOrEqual(100);
    expect(done.story.postCaptions.youtubeDescription).toMatch(/Check your local road rules/);
    expect(validateScript(done.script).ok).toBe(true);
    expect(store.ideas.find((i) => i.ideaId === I.deer)).toMatchObject({ status: "used" });
    expect(store.ideas.find((i) => i.ideaId === I.deer)!.storyIds).toContain(story.storyId);
    expect(store.assets.filter((a) => a.storyId === story.storyId).map((a) => a.kind)).toEqual(expect.arrayContaining(["storyboard", "scene_still", "final_video", "cover"]));
  });

  it("refuses a driving-safety concept that no checked advice covers", async () => {
    const e = await refused(api.createStory("stories", { brief: { title: "Overtaking safely", logline: "How to pass a slow tractor.", category: "driving_safety" }, characterIds: [C.dash] }));
    expect(e.code).toBe("conflict");
    expect(e.message).toMatch(/only makes driving-safety videos from checked advice/);
    expect((await refused(api.createStory("stories", { brief: { title: "X", logline: "Y", category: "comedy" }, characterIds: [] }))).code).toBe("bad_request");
  });

  it("a failed step makes it and every later step stale; Try again runs exactly those", async () => {
    store.knobs.failStep = "sound";
    const { story } = await call(api.createStory("stories", { brief: { title: "Juggling", logline: "Dash learns to juggle.", category: "comedy" }, characterIds: [C.dash] }));
    await finish();
    const failed = await call(api.getStory("stories", story.storyId));
    expect(failed.story.status).toBe("failed");
    expect(failed.story.stale).toEqual(["sound", "captions", "assemble", "preview"]);
    expect(failed.job?.error).toMatch(/Tap Try again/);
    const again = await call(api.produce("stories", story.storyId));
    expect(again.job.configuration.run).toEqual(["sound", "captions", "assemble", "preview"]);
    await finish();
    expect((await call(api.getStory("stories", story.storyId))).story.status).toBe("review");
  });

  it("Cancel puts back the status it had before the job", async () => {
    const { story } = await call(api.createStory("stories", { brief: { title: "Bubbles", logline: "Pip blows a giant bubble.", category: "comedy" }, characterIds: [C.pip] }));
    const r = await call(api.cancelStory("stories", story.storyId));
    expect(r.story.status).toBe("draft");
    expect(r.job?.status).toBe("canceled");
    expect((await refused(api.cancelStory("stories", story.storyId))).code).toBe("conflict");
  });
});

describe("review", () => {
  it("the approve rule: a needs_check story is refused; fixing a caption makes safety, captions, assemble and preview stale; Check again runs only those", async () => {
    const { story, script } = await call(api.getStory("stories", S.needsCheck));
    expect((await refused(api.approve("stories", S.needsCheck, story.version))).message).toMatch(/^Fix the facts first/);
    const captions = script!.captions.map((c) => (/full beam/i.test(c.text) ? { ...c, text: "Use dipped headlights in fog" } : c));
    const patched = await call(api.patchStory("stories", S.needsCheck, { version: story.version, captions }));
    expect(patched.story.status).toBe("needs_check");
    expect(patched.story.stale).toEqual(["safety", "captions", "assemble", "preview"]);
    expect(patched.story.scriptVersion).toBe(story.scriptVersion + 1);
    expect(patched.story.safety?.status).toBe("pending");
    expect((await refused(api.patchStory("stories", S.needsCheck, { version: story.version, title: "Old version" }))).code).toBe("conflict");
    const check = await call(api.produce("stories", S.needsCheck));
    expect(check.job.configuration.run).toEqual(["safety", "captions", "assemble", "preview"]);
    await finish();
    const after = await call(api.getStory("stories", S.needsCheck));
    expect(after.story.status).toBe("review");
    expect(after.story.safety).toMatchObject({ status: "ok", checkedScriptVersion: after.story.scriptVersion });
    const ok = await call(api.approve("stories", S.needsCheck, after.story.version));
    expect(ok.status).toBe("approved");
  });

  it("a stale story can't be approved; a sound edit makes sound, assemble and preview stale", async () => {
    const { story, script } = await call(api.getStory("stories", S.review));
    const scene = script!.scenes[0]!;
    const sfx = [...scene.sfx, { id: `${scene.sceneId}.own1`, at: 1, sfx: "boing" as const, volume: 0.7 }];
    const r = await call(api.patchStory("stories", S.review, { version: story.version, scenes: [{ sceneId: scene.sceneId, sfx }] }));
    expect(r.story.stale).toEqual(["sound", "assemble", "preview"]);
    expect(r.script!.scenes[0]!.sfx).toEqual(sfx);
    expect((await refused(api.approve("stories", S.review, r.story.version))).message).toBe("Your changes aren't in the video yet. Tap Remake first.");
    const mood = await call(api.patchStory("stories", S.review, { version: r.story.version, postCaptions: { x: "New words" } }));
    expect(mood.story.stale).toEqual(["safety", "sound", "assemble", "preview"]);
  });

  it("Remake this scene is a new take of only that scene; Remake the whole video writes a new storyboard", async () => {
    const before = await call(api.getStory("stories", S.review));
    const target = before.script!.scenes[1]!.sceneId;
    const r = await call(api.requestChanges("stories", S.review, { sceneIds: [target] }));
    expect(r.job).toMatchObject({ jobType: "changes", configuration: { sceneIds: [target], note: null, from: "storyboard" } });
    await finish();
    const after = await call(api.getStory("stories", S.review));
    expect(after.story.scriptVersion).toBe(before.story.scriptVersion + 1);
    const a = after.script!.scenes;
    const b = before.script!.scenes;
    expect(a.find((s) => s.sceneId === target)!.seed).not.toBe(b.find((s) => s.sceneId === target)!.seed);
    expect(a.filter((s) => s.sceneId !== target)).toEqual(b.filter((s) => s.sceneId !== target));
    expect(after.story.status).toBe("review");
    const whole = await call(api.produce("stories", S.review, { from: "storyboard" }));
    expect(whole.job.configuration.run).toEqual(STEP_ORDER);
    await finish();
    expect((await call(api.getStory("stories", S.review))).story.scriptVersion).toBe(after.story.scriptVersion + 1);
    expect((await refused(api.requestChanges("stories", S.review, {}))).code).toBe("bad_request");
  });

  it("reject keeps the reason; download is only for approved or posted videos", async () => {
    expect((await refused(api.download("stories", S.review))).code).toBe("conflict");
    const ok = await call(api.download("stories", S.approved));
    expect(ok.filename).toBe("bolt-ties-his-shoes.mp4");
    const r = await call(api.reject("stories", S.review, "Too dark"));
    expect(r).toMatchObject({ status: "rejected", reviewNote: "Too dark" });
    expect((await refused(api.reject("stories", S.approved))).code).toBe("conflict");
  });
});
