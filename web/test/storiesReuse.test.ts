// Clips Funded › Use it again (docs/CONTRACTS.md §45.52): a made video's whole setup becomes a new draft. Against the
// in-memory mock API: the published seed video and its written script give a draft with the same scenes (what
// happens, the words, who is in it, the place, in order), cast, roles, series, length, shape, look, captions, music,
// references and AI; the draft is saved like any other and opens back in the form; the video it came from is unchanged.
import { describe, expect, it } from "vitest";

import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import type { Character, Story, StoryScript } from "../src/stories/api/types.ts";
import { scriptOfDraft } from "../src/stories/studio/Drafts.tsx";
import { cut, MADE, nextTitle, reuseForm, scenesOfScript, TITLE_MAX } from "../src/stories/studio/reuseForm.ts";

const WS = "stories";

describe("nextTitle", () => {
  it("counts the episode up, or adds 2", () => {
    expect(nextTitle("Night run 2")).toBe("Night run 3");
    expect(nextTitle("Episode 9")).toBe("Episode 10");
    expect(nextTitle("The sandwich tower")).toBe("The sandwich tower 2");
    expect(nextTitle("  spaced   out  ")).toBe("spaced out 2");
    expect(nextTitle("")).toBe("Untitled video 2");
  });
  it("stays within the title limit", () => {
    const long = "a".repeat(TITLE_MAX);
    expect([...nextTitle(long)].length).toBeLessThanOrEqual(TITLE_MAX);
    expect(nextTitle(long).endsWith(" 2")).toBe(true);
  });
});

describe("cut", () => {
  it("keeps short words and cuts long ones on a word break", () => {
    expect(cut("Pip  waves", 160)).toBe("Pip waves");
    const out = cut("one two three four five six", 16);
    expect(out).toBe("one two three");
  });
});

async function published() {
  const api = mockStoriesApi();
  const { stories } = await api.listStories(WS, { status: "all", limit: 50 });
  const story = stories.find((s) => s.status === "published");
  if (!story) throw new Error("the mock has no published video");
  const full = await api.getStory(WS, story.storyId);
  const characters: Character[] = await api.listCharacters(WS);
  return { api, story: full.story, script: full.script, characters };
}

describe("reuseForm on a real (seeded) published video", () => {
  it("copies every part of the setup", async () => {
    const { story, script, characters } = await published();
    expect(MADE.has(story.status)).toBe(true);
    expect(script?.scenes.length).toBeGreaterThan(0);
    const form = reuseForm(story, script, characters);
    expect(form.source).toBe("script");
    expect(form.title).toBe(nextTitle(story.title));
    expect(form.category).toBe(story.category);
    expect(form.characterIds).toEqual(story.characterIds);
    expect(form.durationSec).toBe(story.durationSec);
    expect(form.captionsOn).toBe(story.captionsOn);
    expect(form.musicMood).toBe(story.musicMood);
    expect(form.seriesId ?? null).toBe(story.seriesId ?? null);
    if (story.art) expect(form.art).toBe(story.art);
    if (story.format) expect(form.format).toEqual(story.format);
    // the scenes, in the video's order
    const scenes = form.script!.scenes;
    expect(scenes.length).toBe(script!.scenes.length);
    scenes.forEach((s, i) => {
      const src = script!.scenes[i]!;
      expect(s.what.length).toBeGreaterThan(0);
      expect(s.place).toBe(src.set);
      for (const id of s.who ?? []) expect(story.characterIds).toContain(id);
    });
  });

  it("saves as a draft that opens back in the form, and the video it came from is unchanged", async () => {
    const { api, story, script, characters } = await published();
    const before = structuredClone(await api.getStory(WS, story.storyId));
    const draft = await api.createVideoDraft(WS, { form: reuseForm(story, script, characters) });
    expect(draft.name).toBe(nextTitle(story.title));
    const again = await api.getVideoDraft(WS, draft.draftId);
    const known = (id: string) => characters.some((c) => c.characterId === id);
    const back = scriptOfDraft(again.form.script, known);
    expect(back.dropped).toBe(false);
    expect(back.script.scenes.map((s) => s.what)).toEqual(again.form.script!.scenes.map((s) => s.what));
    const after = await api.getStory(WS, story.storyId);
    expect(after.story).toEqual(before.story);
    expect(after.script).toEqual(before.script);
  });
});

describe("reuseForm details", () => {
  const base = (over: Partial<Story> = {}): Story =>
    ({
      storyId: "01JSTST0000000000000000099",
      workspaceId: WS,
      contentType: "animation",
      title: "Chase 1",
      status: "published",
      category: "comedy",
      ideaId: null,
      characterIds: ["A", "CAR", "GONE"],
      durationSec: 40,
      actualDurationSec: 41,
      captionsOn: false,
      musicMood: "tense",
      postCaptions: { youtubeTitle: "", youtubeDescription: "", instagram: "", facebook: "", tiktok: "", x: "" },
      scenes: [],
      scriptVersion: 2,
      storageLocation: "",
      stale: [],
      safetyTopicId: null,
      safety: null,
      reviewNote: null,
      currentJobId: null,
      ai: { model: "opus-5-5", effort: null },
      referenceIds: ["R1"],
      posted: [],
      version: 3,
      createdAt: "",
      updatedAt: "",
      seriesId: "S1",
      roles: { mainId: "A", villainId: "GONE" },
      ...over,
    }) as Story;
  const chars = [
    { characterId: "A", name: "Ana" },
    { characterId: "CAR", name: "Rosso", kind: "car" },
  ] as unknown as Character[];

  it("leaves out characters that are gone, keeps the series, the references and the AI", () => {
    const form = reuseForm(base(), null, chars);
    expect(form.characterIds).toEqual(["A", "CAR"]);
    expect(form.roles).toEqual({ mainId: "A" });
    expect(form.seriesId).toBe("S1");
    expect(form.referenceIds).toEqual(["R1"]);
    expect(form.ai).toEqual({ model: "opus-5-5" });
    expect(form.title).toBe("Chase 2");
    expect(form.captionsOn).toBe(false);
    expect(form.script).toBeUndefined();
  });

  it("a video in no series stays in no series", () => {
    expect(reuseForm(base({ seriesId: undefined }), null, chars).seriesId).toBeNull();
  });

  it("the owner's own script comes back word for word", () => {
    const own = { scenes: [
      { sceneId: "s1", what: "Ana walks to Rosso.", caption: "Let's go!", who: ["A", "CAR"], place: "road_day", leaveOut: [] },
      { sceneId: "s2", what: "They drive off.", caption: null, who: [], place: null, leaveOut: [] },
    ] };
    const form = reuseForm(base({ ownScript: own as Story["ownScript"] }), null, chars);
    expect(form.script!.scenes.map((s) => s.what)).toEqual(["Ana walks to Rosso.", "They drive off."]);
    expect(form.script!.scenes[0]!.caption).toBe("Let's go!");
  });

  it("an AI script's people and cars become each scene's Who", () => {
    const script = {
      cast: { c1: { characterId: "A" } },
      cars: { k1: { characterId: "CAR" } },
      captions: [{ id: "c1", at: 5, dur: 2, text: "Home at last" }],
      scenes: [
        { sceneId: "s1", title: "Off they go", durationSec: 4, note: null, caption: "Vroom", set: "road_day", actors: [{ castId: "c1" }], props: [{ propId: "p", kind: "car", castId: "k1" }], beats: [] },
        { sceneId: "s2", title: "Home", durationSec: 4, note: "Ana parks Rosso by the house.", caption: null, set: "no_such_place", actors: [], props: [], beats: [] },
      ],
    } as unknown as StoryScript;
    const scenes = scenesOfScript(script, ["A", "CAR"]);
    expect(scenes[0]).toEqual({ what: "Off they go", caption: "Vroom", who: ["A", "CAR"], place: "road_day" });
    expect(scenes[1]).toEqual({ what: "Home. Ana parks Rosso by the house.", caption: "Home at last", who: [] });
  });
});
