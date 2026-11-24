// The chat's and the reference page's small parts (docs/CONTRACTS.md §45.16.1, §45.27, §45.28): the director's
// buttons (what each tap does, nothing for a payload that makes no sense, never an outside link), the hand-over to
// Production › New, the last open conversation kept inside cf.workspace without touching the rest, the message
// list's polling and merging, the safe answer text, the multipart upload (parts in order, progress over the file,
// one retry, Stop), the file checks and the model words.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoriesApi } from "../src/stories/api/client.ts";
import type { ChatAction, Message, StoriesApi } from "../src/stories/api/types.ts";
import { ActionCard, BROKEN, planFor } from "../src/stories/chat/actions.tsx";
import { forgetVisit, lastConversationId, rememberConversation, WORKSPACE_KEY } from "../src/stories/chat/device.ts";
import { settingsNamed } from "../src/stories/chat/fixit.tsx";
import { productionNewHref } from "../src/stories/chat/handoff.ts";
import { ago, clock, sentence, size } from "../src/stories/chat/kit.tsx";
import { afterId, askedBefore, mergeMessages, titleFrom } from "../src/stories/chat/messages.ts";
import { effortProblem, fileModels, FILE_DEFAULT, modelLabel, projectEffective, statusWords, withOverride } from "../src/stories/chat/models.ts";
import { blocks, ChatText } from "../src/stories/chat/text.tsx";
import { partRange, pictureProblem, putParts, titleFromName, UploadFailed, UploadStopped, videoProblem, videoType, type PartPut } from "../src/stories/chat/upload.ts";
import { matchStories, storiesHref } from "../src/stories/routes.ts";
import { ApiError } from "../src/api/errors.ts";

const msg = (id: string, role: Message["role"], status: Message["status"] = "done", text = ""): Message => ({
  msgId: id,
  convId: "c",
  role,
  text,
  attachments: [],
  status,
  model: null,
  effort: null,
  effortApplied: null,
  usage: null,
  actions: [],
  createdAt: "2026-11-21T12:00:00.000Z",
});

const act = (kind: ChatAction["kind"], payload: Record<string, unknown>): ChatAction => ({ kind, label: "Do it", payload });

/** A stand-in API that writes down every call. */
function recorder(ideas: { ideaId: string; title: string; logline: string; category: string }[] = []) {
  const calls: string[] = [];
  const fake = {
    listIdeas: vi.fn(async () => ideas),
    createIdea: vi.fn(async (_ws: string, i: { title: string; source?: string; characterIds?: string[] }) => {
      calls.push(`idea ${i.title} ${i.source} ${JSON.stringify(i.characterIds ?? [])}`);
      return { ideaId: "01JSTID0000000000000000009", ...i } as never;
    }),
    patchIdea: vi.fn(async (_ws: string, ideaId: string, patch: object) => {
      calls.push(`patch ${ideaId} ${JSON.stringify(patch)}`);
      return {} as never;
    }),
    requestChanges: vi.fn(async (_ws: string, storyId: string, body: object) => {
      calls.push(`changes ${storyId} ${JSON.stringify(body)}`);
      return {} as never;
    }),
  } as unknown as StoriesApi;
  return { calls, fake };
}

describe("the director's buttons", () => {
  it("Make the video with an idea only opens Production › New, filled in", () => {
    expect(planFor(act("make_video", { ideaId: "01JSTID0000000000000000001", characterIds: ["c1"], durationSec: 40, referenceIds: ["r1", "r2"] }))).toEqual({
      kind: "go",
      href: "/stories/production/new?idea=01JSTID0000000000000000001&ref=r1&ref=r2&cast=c1&sec=40",
    });
    expect(planFor(act("make_video", { brief: { title: "x", logline: "y", category: "horror" } })).kind).toBe("broken");
    expect(planFor(act("make_video", { characterIds: ["../../x"] })).kind).toBe("broken");
    expect(planFor(act("make_video", { story: { characterIds: ["c1"], durationSec: "long" } })).kind).toBe("broken");
  });

  it("Make the video keeps the drawing style the director offered (§45.45), and Production › New reads it", () => {
    for (const art of ["classic", "night_drive"] as const) {
      const plan = planFor(act("make_video", { story: { characterIds: ["01JSTCH0000000000000000001"], ideaId: "01JSTID0000000000000000001", durationSec: 45, art } }));
      const href = `/stories/production/new?idea=01JSTID0000000000000000001&cast=01JSTCH0000000000000000001&sec=45&art=${art}`;
      expect(plan).toEqual({ kind: "go", href });
      const page = matchStories("/stories/production/new", `?${href.split("?")[1]}`);
      expect(page).toMatchObject({ name: "production_new", art });
      expect(storiesHref(page)).toBe(href);
    }
    // left out, or null: the workspace's own style, and the address has no art
    expect(planFor(act("make_video", { story: { characterIds: ["c1"], art: null } }))).toEqual({ kind: "go", href: "/stories/production/new?cast=c1" });
    expect(matchStories("/stories/production/new", "?cast=c1")).not.toHaveProperty("art");
    expect(matchStories("/stories/production/new", "?art=noir")).not.toHaveProperty("art");
    // any other style is a broken button
    expect(planFor(act("make_video", { story: { characterIds: ["c1"], art: "noir" } })).kind).toBe("broken");
  });

  it("reads the agent's own payloads exactly as tools.py sends them", async () => {
    // offer_make_video with an idea: {"story": {"characterIds": [...], "ideaId": ..., "durationSec": ...}}
    expect(planFor(act("make_video", { story: { characterIds: ["01JSTCH0000000000000000001"], ideaId: "01JSTID0000000000000000001", durationSec: 45 } }))).toEqual({
      kind: "go",
      href: "/stories/production/new?idea=01JSTID0000000000000000001&cast=01JSTCH0000000000000000001&sec=45",
    });
    // offer_make_video with a short concept: the tap saves it as an idea, then Production › New opens with it.
    const { calls, fake } = recorder();
    setStoriesApi(fake);
    try {
      const plan = planFor(act("make_video", { story: { characterIds: ["01JSTCH0000000000000000001"], brief: { title: "Pip & ice", logline: "Pip slides.", category: "comedy" }, durationSec: 40 } }));
      expect(plan.kind).toBe("call");
      expect(calls).toEqual([]);
      if (plan.kind !== "call") return;
      const done = await plan.run("stories");
      expect(calls).toEqual(['idea Pip & ice ai ["01JSTCH0000000000000000001"]']);
      expect(done).toMatchObject({ go: true, href: "/stories/production/new?idea=01JSTID0000000000000000009&cast=01JSTCH0000000000000000001&sec=40" });
      // propose_story_change for the whole story: a note and no scenes.
      const whole = planFor(act("remake_scene", { storyId: "01JSTST0000000000000000001", sceneIds: [], note: "Slower in the middle" }));
      expect(whole.kind).toBe("call");
      if (whole.kind === "call") expect((await whole.run("stories")).text).toBe("Making those changes now!");
      // update_idea on a driving-safety idea: {"ideaId", "patch"} through PATCH …/ideas/{id}.
      const change = planFor(act("save_idea", { ideaId: "01JSTID0000000000000000002", patch: { logline: "Look twice at the crossing.", category: "driving_safety" } }));
      expect(change.kind).toBe("call");
      if (change.kind === "call") expect((await change.run("stories")).text).toBe("Saved the change!");
      // offer_save_idea: {"idea": {..., "source": "ai"}}
      const save = planFor(act("save_idea", { idea: { title: "Snow", logline: "It falls.", category: "comedy", source: "ai" } }));
      if (save.kind === "call") await save.run("stories");
      expect(calls.slice(1)).toEqual([
        'changes 01JSTST0000000000000000001 {"note":"Slower in the middle"}',
        'patch 01JSTID0000000000000000002 {"logline":"Look twice at the crossing.","category":"driving_safety"}',
        "idea Snow ai []",
      ]);
    } finally {
      setStoriesApi(null);
    }
  });

  it("a short concept already saved as an idea is used again, not saved twice", async () => {
    const { calls, fake } = recorder([{ ideaId: "01JSTID0000000000000000005", title: "Pip & ice", logline: "Pip slides.", category: "comedy" }]);
    setStoriesApi(fake);
    try {
      const plan = planFor(act("make_video", { story: { characterIds: [], brief: { title: "Pip & ice", logline: "Pip slides.", category: "comedy" } } }));
      expect(plan.kind === "call" && (await plan.run("stories")).href).toBe("/stories/production/new?idea=01JSTID0000000000000000005");
      expect(calls).toEqual([]);
    } finally {
      setStoriesApi(null);
    }
  });

  it("a malformed button is switched off and drawn without its preview, never crashing the chat", () => {
    const html = renderToStaticMarkup(<ActionCard ws="stories" id="m:0" action={act("save_character", { character: { name: { text: "Skid" }, look: { body: "round" } } })} />);
    expect(html).toContain(BROKEN);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain("st-chat-action__show");
    const noLabel = renderToStaticMarkup(<ActionCard ws="stories" id="m:1" action={{ kind: "save_idea", label: { x: 1 } as never, payload: { idea: { title: "T", logline: "L", category: "comedy" } } }} />);
    expect(noLabel).toContain("Save this idea");
  });

  it("the other buttons call the normal route only when run (on the tap)", async () => {
    const calls: string[] = [];
    const fake = {
      requestChanges: vi.fn(async (_ws: string, storyId: string, body: object) => {
        calls.push(`changes ${storyId} ${JSON.stringify(body)}`);
        return {} as never;
      }),
      analyzeReference: vi.fn(async (_ws: string, refId: string) => {
        calls.push(`analyze ${refId}`);
        return {} as never;
      }),
      createCharacter: vi.fn(async (_ws: string, c: { name: string }) => {
        calls.push(`character ${c.name}`);
        return { name: c.name, characterId: "ch1" } as never;
      }),
      createIdea: vi.fn(async (_ws: string, i: { title: string; source?: string }) => {
        calls.push(`idea ${i.title} ${i.source}`);
        return { ideaId: "01JSTID0000000000000000009" } as never;
      }),
    } as unknown as StoriesApi;
    setStoriesApi(fake);
    try {
      const plans = [
        planFor(act("remake_scene", { storyId: "s1", sceneIds: ["sc2"] })),
        planFor(act("remake_scene", { storyId: "s1", sceneIds: ["sc2"], note: " slower " })),
        planFor(act("analyze_reference", { refId: "r1" })),
        planFor(act("save_character", { character: { name: "Skid", look: { body: "round" } } })),
        planFor(act("save_idea", { idea: { title: "Snowman", logline: "Hat.", category: "comedy" } })),
      ];
      expect(calls).toEqual([]);
      const results = [];
      for (const p of plans) {
        expect(p.kind).toBe("call");
        if (p.kind === "call") results.push(await p.run("stories"));
      }
      expect(calls).toEqual(['changes s1 {"sceneIds":["sc2"]}', 'changes s1 {"sceneIds":["sc2"],"note":"slower"}', "analyze r1", "character Skid", "idea Snowman ai"]);
      expect(results.map((r) => r.href)).toEqual(["/stories/production/s1", "/stories/production/s1", "/stories/references/r1", "/stories/characters/ch1", "/stories/ideas"]);
    } finally {
      setStoriesApi(null);
    }
  });

  it("a button whose details make no sense does nothing (and says so)", () => {
    for (const a of [
      act("remake_scene", { storyId: "s1", sceneIds: [] }),
      act("remake_scene", { storyId: "s1", sceneIds: [], note: "  " }),
      act("save_idea", { ideaId: "i1", patch: {} }),
      act("save_idea", { ideaId: "i1", patch: { owner: "someone" } }),
      act("save_idea", { ideaId: "i1", patch: { category: "horror" } }),
      act("remake_scene", { sceneIds: ["a"] }),
      act("analyze_reference", { refId: 5 }),
      act("save_character", { character: { name: "" } }),
      act("save_idea", { idea: { title: "t", logline: "l", category: "nope" } }),
      act("open", { href: "https://evil.example/" }),
      act("open", { href: "//evil.example/stories" }),
      act("open", { href: "/settings" }),
      act("open", { href: "/stories/nope/at/all" }),
      { kind: "launch_rockets", label: "x", payload: {} } as unknown as ChatAction,
    ])
      expect(planFor(a).kind, JSON.stringify(a)).toBe("broken");
    expect(BROKEN).toMatch(/Ask the director again\.$/);
  });

  it("Open goes only to Lamo Stories pages", () => {
    expect(planFor(act("open", { href: "/stories/settings/memory" }))).toEqual({ kind: "go", href: "/stories/settings/memory" });
    expect(planFor(act("open", { kind: "character", id: "ch1" }))).toEqual({ kind: "go", href: "/stories/characters/ch1" });
  });

  it("a failure that names a setting offers the way there", () => {
    expect(settingsNamed("Claude Fable 5.2 isn't available right now: no access. Pick another model in Clips Funded › Settings › AI, or try again.")).toEqual({ ai: true, agents: false });
    expect(settingsNamed("The video analysis agent is switched off. Switch it on in Clips Funded › Settings › Agents.")).toEqual({ ai: false, agents: true });
    expect(settingsNamed(null)).toEqual({ ai: false, agents: false });
  });

  it("Use in a video hands one reference to Production › New", () => {
    expect(productionNewHref({ referenceIds: ["01JSTRF0000000000000000001"] })).toBe("/stories/production/new?ref=01JSTRF0000000000000000001");
    expect(productionNewHref({ referenceIds: ["a", "b", "c", "d"], durationSec: 200 })).toBe("/stories/production/new?ref=a&ref=b&ref=c");
  });
});

describe("the last open conversation (cf.workspace)", () => {
  beforeEach(() => {
    localStorage.clear();
    forgetVisit();
  });

  it("is kept inside cf.workspace, every other key untouched", () => {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ workspaceId: "stories", lastStoriesPath: "/stories/chat", lastClipsPath: "/jobs" }));
    rememberConversation("01JSTCV0000000000000000002");
    // The shell may write its whole choice; the keys that were there keep their values either way.
    expect(JSON.parse(localStorage.getItem(WORKSPACE_KEY)!)).toMatchObject({ workspaceId: "stories", lastStoriesPath: "/stories/chat", lastClipsPath: "/jobs", lastConversationId: "01JSTCV0000000000000000002" });
    expect(lastConversationId()).toBe("01JSTCV0000000000000000002");
    rememberConversation(null);
    expect(lastConversationId()).toBeNull();
    expect(JSON.parse(localStorage.getItem(WORKSPACE_KEY)!).lastClipsPath).toBe("/jobs");
  });

  it("keeps this visit's choice even when cf.workspace is rewritten from an older copy", () => {
    rememberConversation("01JSTCV0000000000000000001");
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ workspaceId: "stories", lastStoriesPath: "/stories/ideas" }));
    expect(lastConversationId()).toBe("01JSTCV0000000000000000001");
    forgetVisit();
    expect(lastConversationId()).toBeNull();
  });

  it("ignores anything broken or unsafe", () => {
    localStorage.setItem(WORKSPACE_KEY, "{not json");
    expect(lastConversationId()).toBeNull();
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ lastConversationId: "../../etc" }));
    expect(lastConversationId()).toBeNull();
    rememberConversation("bad id!");
    expect(JSON.parse(localStorage.getItem(WORKSPACE_KEY)!).lastConversationId).toBe("../../etc");
  });
});

describe("the message list", () => {
  it("polls from the last settled message before the one being written", () => {
    expect(afterId([])).toBeUndefined();
    expect(afterId([msg("1", "user"), msg("2", "assistant")])).toBe("2");
    expect(afterId([msg("1", "user"), msg("2", "assistant", "streaming")])).toBe("1");
    expect(afterId([msg("2", "assistant", "pending")])).toBeUndefined();
    expect(afterId([msg("1", "user"), msg("2", "assistant"), msg("local-1", "user", "pending")])).toBe("2");
  });

  it("folds a poll in: same id replaced, new ones added, this device's unsent ones last", () => {
    const prev = [msg("1", "user"), msg("2", "assistant", "streaming", "Hel"), msg("local-9", "user", "pending", "draft")];
    const next = mergeMessages(prev, [msg("2", "assistant", "done", "Hello"), msg("3", "user")]);
    expect(next.map((m) => `${m.msgId}:${m.status}:${m.text}`)).toEqual(["1:done:", "2:done:Hello", "3:done:", "local-9:pending:draft"]);
  });

  it("finds what Try again sends again, and names a new chat", () => {
    const list = [msg("1", "user", "done", "first"), msg("2", "assistant", "failed")];
    expect(askedBefore(list, "2")?.text).toBe("first");
    expect(titleFrom("Short one")).toBe("Short one");
    expect(titleFrom("Give me three funny ideas about ice and snow for Pip please")).toMatch(/…$/);
  });
});

describe("the answer's words", () => {
  it("draws paragraphs, lists and bold, and never markup or links", () => {
    expect(blocks("Hi\n\n- a\n- b\n1. one\n2. two\nend").map((b) => b.t)).toEqual(["p", "ul", "ol", "p"]);
    const html = renderToStaticMarkup(<ChatText text={'**Bold** <img src=x onerror="alert(1)"> [link](https://x.example)'} />);
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
  });
});

describe("the files", () => {
  it("checks pictures and videos before anything is sent", () => {
    expect(pictureProblem({ type: "image/gif", size: 10 })).toBe("Pick a PNG, JPG or WebP picture.");
    expect(pictureProblem({ type: "image/png", size: 5 * 1024 * 1024 + 1 })).toBe("That picture is too big. Pick one under 5 MB.");
    expect(pictureProblem({ type: "image/webp", size: 100 })).toBeNull();
    expect(videoType({ type: "", name: "clip.MOV" })).toBe("video/quicktime");
    expect(videoProblem({ type: "text/plain", name: "a.txt", size: 5 })).toBe("Pick an MP4 or MOV video.");
    expect(videoProblem({ type: "video/mp4", name: "a.mp4", size: 3 * 1024 ** 3 })).toBe("That video is too big. Pick one under 2 GB.");
    expect(titleFromName("my_fav-clip.mp4")).toBe("my fav clip");
  });

  it("cuts the file into as many parts as there are addresses", () => {
    expect(partRange(250, 3, 1)).toEqual([0, 84]);
    expect(partRange(250, 3, 3)).toEqual([168, 250]);
    expect(partRange(250, 3, 2, 100)).toEqual([100, 200]);
    expect(partRange(250, 3, 3, 100)).toEqual([200, 250]);
  });

  it("sends every part, reports progress over the whole file, tries a failed part once more", async () => {
    const tries = new Map<string, number>();
    const put: PartPut = async (url, body, onProgress) => {
      tries.set(url, (tries.get(url) ?? 0) + 1);
      if (url.endsWith("/2") && tries.get(url) === 1) throw new UploadFailed();
      onProgress(body.size / 2);
      onProgress(body.size);
      return `"etag-${url.slice(-1)}-${body.size}"`;
    };
    const seen: number[] = [];
    const file = new Blob([new Uint8Array(300)]);
    const parts = await putParts({ parts: [3, 1, 2].map((n) => ({ partNumber: n, url: `u/${n}` })) }, file, (p) => seen.push(p.fraction), new AbortController().signal, put);
    expect(parts).toEqual([
      { partNumber: 1, etag: '"etag-1-100"' },
      { partNumber: 2, etag: '"etag-2-100"' },
      { partNumber: 3, etag: '"etag-3-100"' },
    ]);
    expect(tries.get("u/2")).toBe(2);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]! >= 0).toBe(true);
  });

  it("gives up after the second failure, and Stop stops at once", async () => {
    const failing: PartPut = async () => {
      throw new UploadFailed();
    };
    await expect(putParts({ parts: [{ partNumber: 1, url: "u/1" }] }, new Blob(["x"]), () => undefined, new AbortController().signal, failing)).rejects.toBeInstanceOf(UploadFailed);
    const stop = new AbortController();
    const slow: PartPut = (_u, _b, _p, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new UploadStopped()));
      });
    const run = putParts({ parts: [{ partNumber: 1, url: "u/1" }, { partNumber: 2, url: "u/2" }] }, new Blob(["xy"]), () => undefined, stop.signal, slow);
    stop.abort();
    await expect(run).rejects.toBeInstanceOf(UploadStopped);
  });
});

describe("the model words", () => {
  it("names models from Lamo Stories' own list, with Opus 5.5 at High as the default", () => {
    const models = fileModels();
    expect(models.map((m) => m.label)).toEqual(["Claude Fable 5.2", "Claude Fable 5.1", "Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5"]);
    expect(FILE_DEFAULT).toEqual({ model: "opus-5-5", effort: "high" });
    expect(modelLabel(models, "fable-5-2")).toBe("Claude Fable 5.2");
    expect(modelLabel(models, "mystery")).toBe("mystery");
  });

  it("says when a model does not offer an effort, and what the last call said", () => {
    const haiku = { ...fileModels().find((m) => m.key === "haiku-5-5")!, efforts: ["low", "medium", "high"] as const };
    expect(effortProblem({ ...haiku, efforts: [...haiku.efforts] }, "max")).toBe("Claude Haiku 5.5 does not offer Maximum. Pick another level.");
    expect(effortProblem({ ...haiku, efforts: [...haiku.efforts] }, "high")).toBeNull();
    // One word set everywhere (§45.36 E17): Works, Not checked yet, No access, Not found, Problem.
    expect(statusWords({ status: "denied", statusLine: "Bedrock says no." })).toEqual({ tone: "coral", text: "No access", line: "Bedrock says no." });
    expect(statusWords({ status: "not_found", statusLine: "Bedrock does not know it." })).toEqual({ tone: "coral", text: "Not found", line: "Bedrock does not know it." });
    expect(statusWords({ status: "error", statusLine: "" }).text).toBe("Problem");
    expect(statusWords({ status: "ok", statusLine: "" }).text).toBe("Works");
    expect(statusWords(null).text).toBe("Not checked yet");
  });

  it("puts a just-this-once choice on top, model and effort separately", () => {
    expect(withOverride({ model: "opus-5-5", effort: "high" }, { effort: "low" })).toEqual({ model: "opus-5-5", effort: "low" });
    expect(withOverride({ model: "opus-5-5", effort: "high" }, { model: "fable-5-2" })).toEqual({ model: "fable-5-2", effort: "high" });
    expect(projectEffective({ model: "sonnet-5-5", effort: "medium" }, { model: null, effort: "max" }, null)).toEqual({ model: "sonnet-5-5", effort: "max" });
    expect(projectEffective(null, null, { model: "haiku-5-5" })).toEqual({ model: "haiku-5-5", effort: "high" });
  });
});

describe("words", () => {
  afterEach(() => vi.useRealTimers());
  it("uses the server's sentence, else a plain one", () => {
    expect(sentence(new ApiError(409, "conflict", "Wait for the answer first, or tap Stop."))).toBe("Wait for the answer first, or tap Stop.");
    expect(sentence(new TypeError("x is undefined"), "That did not work.")).toBe("That did not work.");
    expect(clock(62)).toBe("1:02");
    expect(size(41_500_000)).toBe("40 MB");
    expect(ago(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5 min ago");
  });
});
