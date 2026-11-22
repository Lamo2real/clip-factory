// The Lamo Stories mock's AI, skills and memory parts (docs/CONTRACTS.md §45.16.8, §45.25–§45.27, §45.29): the
// resolver passes the shared cases (stories/config/resolve-cases.json), the models are Lamo Stories' own (never Clip
// Factory's config/models.json), an effort a model does not offer is refused (never swapped), stale versions answer
// 409, a key never comes back, and every route keeps to Lamo Stories workspaces. Round 3 (§45.34): models the owner
// adds, the no-effort pair rule, picked stamps, the makers' use and per-unit prices, storage's place and Clean up now.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import resolveCases from "../../stories/config/resolve-cases.json";
import storiesModels from "../../stories/config/models.json";
import agentsFile from "../../stories/config/agents.json";
import type { MockStore } from "../src/stories/api/mock/store.ts";
import type { Effort, StoriesApi, TaskKind } from "../src/stories/api/types.ts";

// The mock's fake latency is for people; tests run without it.
vi.mock("../src/stories/api/mock/store.ts", async (load) => ({ ...(await load<typeof import("../src/stories/api/mock/store.ts")>()), delay: () => Promise.resolve() }));
const aiPart = await import("../src/stories/api/mock/ai.ts");
const memoryPart = await import("../src/stories/api/mock/memory.ts");
const skillsPart = await import("../src/stories/api/mock/skills.ts");
const { createStore } = await import("../src/stories/api/mock/store.ts");

let store: MockStore;
let api: Pick<StoriesApi, (typeof aiPart.KEYS)[number] | (typeof skillsPart.KEYS)[number] | (typeof memoryPart.KEYS)[number]> & { getTask(ws: string, id: string): Promise<unknown> };
type ResolveInput = Parameters<typeof aiPart.resolveEffective>[0];

beforeEach(() => {
  store = createStore();
  store.workspaces = [
    { workspaceId: "clips", workspaceName: "Lamo Clips", workspaceType: "clips", builtin: true, configuration: {}, version: 1 },
    { workspaceId: "stories", workspaceName: "Lamo Stories", workspaceType: "stories", builtin: false, configuration: {} as never, version: 1 },
  ];
  for (const part of [aiPart, skillsPart, memoryPart]) part.seed(store);
  store.knobs.checkModelsMs = 30;
  api = {
    ...aiPart.api(store),
    ...skillsPart.api(store),
    ...memoryPart.api(store),
    // getTask belongs to the ideas part (builder G); the check-models task lives in the shared store.tasks.
    getTask: async (_ws: string, id: string) => store.tasks.find((t) => t.taskId === id),
  };
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the resolver (§45.25)", () => {
  for (const c of resolveCases.cases as unknown as { name: string; task: TaskKind; expect: Record<string, string> }[])
    it(`passes the shared case: ${c.name}`, () => {
      const out = aiPart.resolveEffective(c as unknown as ResolveInput);
      if ("error" in c.expect) {
        expect("error" in out && out.error).toBe(c.expect.error);
      } else {
        expect(out).toMatchObject({ model: c.expect.model, effort: c.expect.effort, from: c.expect.from, effortApplied: true });
      }
    });

  it("refuses an effort the model does not offer, never swapping it, and leaves effort out for a model with none", () => {
    const models = [
      { key: "a", label: "Model A", provider: "Amazon Bedrock", modelId: "a", efforts: ["low", "medium", "high"] as Effort[], defaultEffort: "medium" as Effort, vision: true, pricing: null },
      { key: "b", label: "Model B", provider: "Amazon Bedrock", modelId: "b", efforts: [] as Effort[], defaultEffort: null, vision: false, pricing: null },
    ];
    expect(aiPart.resolveEffective({ task: "chat", ai: { defaultModel: "a", defaultEffort: "max" } }, models)).toEqual({ error: "effort", message: "Model A does not offer Maximum. Pick another level." });
    expect(aiPart.resolveEffective({ task: "chat", ai: { defaultModel: "b", defaultEffort: "max" } }, models)).toEqual({ model: "b", effort: null, effortApplied: false, from: "default" });
  });
});

describe("AI configuration", () => {
  it("lists Lamo Stories' own models (stories/config/models.json), a denied one, one with no price and one with no effort setting", async () => {
    const { models, ai, agents, tasks } = await api.getAi("stories");
    for (const m of storiesModels.models) expect(models.find((x) => x.key === m.key)).toMatchObject({ label: m.label, provider: m.provider, modelId: m.modelId, efforts: m.efforts });
    expect(models.some((m) => m.status === "denied" && m.statusLine.length > 20)).toBe(true);
    expect(models.some((m) => m.price === null)).toBe(true);
    expect(models.some((m) => m.efforts.length === 0)).toBe(true);
    expect(ai).toMatchObject({ defaultModel: storiesModels.defaultModel, defaultEffort: storiesModels.defaultEffort, version: 0 });
    expect(agents.map((a) => a.agentId)).toEqual(agentsFile.agents.map((a) => a.agentId));
    expect(new Set(tasks.map((t) => t.kind)).size).toBe(11);
    for (const t of tasks) expect(t.effective.model).toBeTruthy();
  });

  it("saves on top of its version, refuses a stale one, an unknown model and an effort the model does not offer", async () => {
    const saved = await api.putAi("stories", { defaultModel: "fable-5-2", defaultEffort: "medium", tasks: { captions: { effort: "low" }, storyboard: { model: "sonnet-5-5" } }, prices: {}, version: 0 });
    expect(saved.version).toBe(1);
    await expect(api.putAi("stories", { ...saved, version: 0 })).rejects.toMatchObject({ code: "conflict" });
    await expect(api.putAi("stories", { ...saved, defaultModel: "gpt-9" })).rejects.toMatchObject({ status: 400, field: "defaultModel" });
    await expect(api.putAi("stories", { ...saved, tasks: { nope: {} } as never })).rejects.toMatchObject({ status: 400 });
    const { tasks } = await api.getAi("stories");
    expect(tasks.find((t) => t.kind === "storyboard")?.effective).toMatchObject({ model: "sonnet-5-5", from: "task", effortApplied: true });
    expect(tasks.find((t) => t.kind === "captions")?.effective).toMatchObject({ effort: "low" });
    // The quality agent has its own model; a task without one takes it from the agent.
    expect(tasks.find((t) => t.kind === "fact_check")?.effective).toMatchObject({ model: "opus-5-5", from: "agent" });
  });

  it("checks every model with a task that walks queued → running → done; the denied one stays denied with Bedrock's reason", async () => {
    const task = await api.checkModels("stories");
    expect(task).toMatchObject({ kind: "check_models", status: "queued" });
    await wait(60);
    const done = (await api.getTask("stories", task.taskId)) as { status: string; result: { models: { key: string; status: string }[] } };
    expect(done.status).toBe("done");
    expect(done.result.models.find((m) => m.key === "fable-5-1")?.status).toBe("denied");
    const { models } = await api.getAi("stories");
    expect(models.filter((m) => m.status === "not_checked")).toEqual([]);
    expect(models.find((m) => m.key === "sonnet-5-5")).toMatchObject({ status: "ok" });
  });

  it("keeps the owner's price, marked as his, and works costs out from it; clearing it puts the list price back", async () => {
    let usage = await api.usage("stories", 30);
    expect(usage.totals.find((t) => t.model === "nova-pro")).toMatchObject({ cost: null, currency: null });
    const m = await api.setModelPrice("stories", "nova-pro", { inputPer1M: 0.8, outputPer1M: 3.2, currency: "USD" });
    expect(m.price).toMatchObject({ inputPer1M: 0.8, outputPer1M: 3.2, source: "owner" });
    usage = await api.usage("stories", 30);
    expect(usage.totals.find((t) => t.model === "nova-pro")?.cost).toBeGreaterThan(0);
    const opus = await api.setModelPrice("stories", "opus-5-5", { inputPer1M: 5, outputPer1M: 25, currency: "USD" });
    expect(opus.price?.source).toBe("owner");
    expect((await api.setModelPrice("stories", "opus-5-5", null)).price?.source).toBe("anthropic_list");
    await expect(api.setModelPrice("stories", "opus-5-5", { inputPer1M: -1, outputPer1M: 1, currency: "USD" })).rejects.toMatchObject({ status: 400 });
  });

  it("gives at most 30 days of usage per model and day, with totals that add up", async () => {
    const usage = await api.usage("stories", 99);
    expect(usage.days.length).toBeLessThanOrEqual(30);
    for (const t of usage.totals) {
      const sum = usage.days.flatMap((d) => d.byModel).filter((b) => b.model === t.model).reduce((a, b) => a + b.input, 0);
      expect(sum).toBe(t.input);
    }
    expect(usage.renderMinutes).toBeGreaterThan(0);
    expect((await api.usage("stories", 7)).days.length).toBeLessThanOrEqual(7);
  });
});

describe("agents", () => {
  it("edits on top of the version, resets the instructions, refuses unknown skills and efforts the model does not offer", async () => {
    const a = await api.getAgent("stories", "creative_director");
    const edited = await api.patchAgent("stories", "creative_director", { version: a.version, instructions: "Be funny.", model: "nova-pro", effort: null });
    expect(edited).toMatchObject({ instructions: "Be funny.", model: "nova-pro", version: a.version + 1 });
    await expect(api.patchAgent("stories", "creative_director", { version: a.version, active: false })).rejects.toMatchObject({ code: "conflict" });
    await expect(api.patchAgent("stories", "creative_director", { version: edited.version, skillIds: ["nope"] })).rejects.toMatchObject({ field: "skillIds" });
    const reset = await api.patchAgent("stories", "creative_director", { reset: true });
    expect(reset.instructions).toBe(reset.defaultInstructions);
    expect(reset.instructions).toBe(agentsFile.agents[0]!.instructions);
  });

  it("lets the quality agent be switched off (driving-safety videos are still checked by the agent's own rule)", async () => {
    const q = await api.getAgent("stories", "quality_assurance");
    expect((await api.patchAgent("stories", "quality_assurance", { version: q.version, active: false })).active).toBe(false);
  });
});

describe("provider keys and storage", () => {
  it("answers the key routes as the API does: none takes a key today, a key never comes back, only its last four", async () => {
    // Today's providers all use Lamo Stories' own AWS access (400); an id that takes no key is not found (404).
    await expect(api.setProviderKey("stories", "builtin-2d", "x")).rejects.toMatchObject({ status: 400 });
    await expect(api.setProviderKey("stories", "nova-reel", "sk-live-1234567890abcdef4f2a")).rejects.toMatchObject({ status: 400 });
    await expect(api.setProviderKey("stories", "acme-voice", "sk-live-1234567890abcdef4f2a")).rejects.toMatchObject({ status: 404 });
    await expect(api.deleteProviderKey("stories", "acme-voice")).rejects.toMatchObject({ status: 404 });
    await expect(api.deleteProviderKey("stories", "builtin-synth")).rejects.toMatchObject({ status: 400 });
    // A provider that takes a key (listed for a test), answered with the ProviderStatus the providers list shows.
    store.knobs.keyedProviders = [{ kind: "audio", id: "acme-voice", label: "Acme Voice" }];
    const out = await api.setProviderKey("stories", "acme-voice", "sk-live-1234567890abcdef4f2a");
    expect(out).toEqual({
      kind: "audio",
      id: "acme-voice",
      label: "Acme Voice",
      state: "needs_setup",
      line: "Key saved · ends 4f2a. It is checked on its first real call.",
      // §45.34: whether a key is saved, its last four and when (never the key).
      key: { saved: true, hint: "4f2a", savedAt: expect.any(String) },
    });
    expect(JSON.stringify(out)).not.toContain("1234567890");
    expect((await api.setProviderKey("stories", "acme-voice", "short-key")).line).toBe("Key saved. It is checked on its first real call.");
    await expect(api.setProviderKey("stories", "acme-voice", "  ")).rejects.toMatchObject({ field: "key" });
    await api.deleteProviderKey("stories", "acme-voice");
    await expect(api.deleteProviderKey("stories", "acme-voice")).resolves.toBeUndefined();
  });

  it("keeps prices by model key or provider id in the configuration, and refuses any other id", async () => {
    const now = (await api.getAi("stories")).ai;
    // §45.34: a maker's price is for one unit (perUnit with its unit, the token prices 0).
    const reel = { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: null, cacheWritePer1M: null, longContext: null, currency: "USD", source: "owner" as const, note: "Your price for a second of video.", perUnit: 0.08, unit: "second" as const };
    const saved = await api.putAi("stories", { ...now, prices: { "nova-reel": reel } });
    expect(saved.prices["nova-reel"]).toMatchObject({ inputPer1M: 0, outputPer1M: 0, perUnit: 0.08, unit: "second", source: "owner", note: "Your price for a second of video." });
    await expect(api.putAi("stories", { ...saved, prices: { "acme-motion": reel } })).rejects.toMatchObject({ status: 400, field: "prices" });
    await expect(api.putAi("stories", { ...saved, prices: { "nova-reel": { ...reel, inputPer1M: 200_000 } } })).rejects.toMatchObject({ status: 400 });
    // The old way (a unit price kept as a price for a million units) is refused, and so is a picture price per second.
    await expect(api.putAi("stories", { ...saved, prices: { "nova-reel": { ...reel, inputPer1M: 80_000, perUnit: null } } })).rejects.toMatchObject({ status: 400, field: "perUnit" });
    await expect(api.putAi("stories", { ...saved, prices: { "nova-canvas": reel } })).rejects.toMatchObject({ status: 400, field: "unit" });
    // A model's price has no unit.
    await expect(api.putAi("stories", { ...saved, prices: { "opus-5-5": reel } })).rejects.toMatchObject({ status: 400, field: "perUnit" });
    const cleared = await api.putAi("stories", { ...saved, prices: {} });
    expect(cleared.prices).toEqual({});
  });

  it("adds storage up by kind from the workspace's files", async () => {
    store.assets = [
      { assetId: "1", kind: "final_video", storyId: "s", characterId: null, title: "A", url: "", contentType: "video/mp4", bytes: 1000, version: 1, createdAt: "", meta: {} },
      { assetId: "2", kind: "scene_clip", storyId: "s", characterId: null, title: "A", url: "", contentType: "video/mp4", bytes: 300, version: 1, createdAt: "", meta: {} },
      { assetId: "3", kind: "portrait", storyId: null, characterId: "c", title: "B", url: "", contentType: "image/png", bytes: 7, version: null, createdAt: "", meta: {} },
    ];
    const s = await api.storage("stories");
    expect(s.bytes).toMatchObject({ videos: 1000, scenes: 300, other: 7 });
    expect(s.bytes.skills).toBeGreaterThan(0);
  });
});

describe("skills", () => {
  it("lists the built-ins first (read-only, can be switched off) and says which agents use each", async () => {
    const list = await api.listSkills("stories");
    expect(list.slice(0, 3).map((s) => s.builtin)).toEqual([true, true, true]);
    const nonverbal = list.find((s) => s.skillId === "nonverbal-storytelling")!;
    expect(nonverbal.agentIds).toEqual(expect.arrayContaining(["creative_director", "storyboard", "character"]));
    await expect(api.putSkill("stories", nonverbal.skillId, { version: nonverbal.version, title: "Mine" })).rejects.toMatchObject({ code: "conflict" });
    await expect(api.deleteSkill("stories", nonverbal.skillId)).rejects.toMatchObject({ code: "conflict" });
    expect((await api.putSkill("stories", nonverbal.skillId, { version: nonverbal.version, enabled: false })).enabled).toBe(false);
    expect((await api.getSkill("stories", nonverbal.skillId)).content).toMatch(/^---\nname: nonverbal-storytelling/);
  });

  it("copies the built-ins' front matter and opening lines exactly from stories/skills/", () => {
    for (const b of skillsPart.BUILTIN_SKILLS) {
      const real = readFileSync(join(import.meta.dirname, "..", "..", "stories", "skills", b.skillId, "SKILL.md"), "utf8");
      expect(real.startsWith(b.md), b.skillId).toBe(true);
      expect(skillsPart.frontMatter(b.md).name).toBe(b.skillId);
    }
    expect(readdirSync(join(import.meta.dirname, "..", "..", "stories", "skills")).sort()).toEqual(skillsPart.BUILTIN_SKILLS.map((b) => b.skillId).sort());
  });

  it("writes one in the app, keeps every save as a version (the last 10), restores any and deletes it from the agents too", async () => {
    let s = await api.createSkill("stories", { title: "Bounce", description: "When someone falls", instructions: "Bounce once." });
    expect(s).toMatchObject({ source: "written", builtin: false, enabled: true, revisions: [expect.any(Object)] });
    for (let i = 0; i < 11; i++) s = await api.putSkill("stories", s.skillId, { version: s.version, instructions: `Bounce ${i + 2} times.` });
    expect(s.revisions).toHaveLength(10);
    const old = s.revisions[4]!;
    s = await api.restoreSkill("stories", s.skillId, old.revisionId);
    expect((await api.getSkill("stories", s.skillId)).content).toContain("Bounce 8 times.");
    const a = await api.getAgent("stories", "storyboard");
    await api.patchAgent("stories", "storyboard", { version: a.version, skillIds: [...a.skillIds, s.skillId] });
    expect((await api.listSkills("stories")).find((x) => x.skillId === s.skillId)?.agentIds).toEqual(["storyboard"]);
    await api.deleteSkill("stories", s.skillId);
    expect((await api.getAgent("stories", "storyboard")).skillIds).not.toContain(s.skillId);
  });

  it("takes an upload: a presigned key first, then the skill; a second upload is a new version", async () => {
    await expect(api.skillUpload("stories", { filename: "notes.txt" })).rejects.toMatchObject({ field: "filename" });
    const up = await api.skillUpload("stories", { filename: "funny-falls.md" });
    expect(up.uploadUrl).toMatch(/^mock:/);
    expect(up.key).toMatch(new RegExp(`^ws/[^/]+/stories/skills/${up.skillId}/`));
    let s = await api.createSkill("stories", { skillId: up.skillId, key: up.key });
    expect(s).toMatchObject({ title: "Funny falls", source: "upload", format: "md" });
    const again = await api.skillUpload("stories", { filename: "funny-falls.zip", skillId: s.skillId });
    s = await api.putSkill("stories", s.skillId, { version: s.version, key: again.key });
    expect(s).toMatchObject({ format: "zip" });
    expect(s.revisions).toHaveLength(2);
  });
});

describe("memory", () => {
  it("lists newest first; adds, edits and deletes; keeps each line to 300 letters", async () => {
    const before = await api.listMemory("stories");
    expect(before.length).toBeGreaterThan(2);
    expect([...before].sort((a, b) => b.createdAt.localeCompare(a.createdAt))).toEqual(before);
    const item = await api.addMemory("stories", "  Pip waves   at the end ");
    expect(item).toMatchObject({ text: "Pip waves at the end", source: "owner" });
    expect((await api.listMemory("stories"))[0]?.memId).toBe(item.memId);
    await expect(api.addMemory("stories", "x".repeat(301))).rejects.toMatchObject({ field: "text" });
    await expect(api.addMemory("stories", " ")).rejects.toMatchObject({ field: "text" });
    expect((await api.patchMemory("stories", item.memId, "Pip waves twice")).text).toBe("Pip waves twice");
    await api.deleteMemory("stories", item.memId);
    await expect(api.deleteMemory("stories", item.memId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("workspace boundaries", () => {
  it("answers Lamo Clips' id with 409 and an unknown workspace with 404, on every route of these parts", async () => {
    const calls: [string, (ws: string) => Promise<unknown>][] = [
      ["getAi", (ws) => api.getAi(ws)],
      ["usage", (ws) => api.usage(ws)],
      ["storage", (ws) => api.storage(ws)],
      ["listSkills", (ws) => api.listSkills(ws)],
      ["listMemory", (ws) => api.listMemory(ws)],
      ["checkModels", (ws) => api.checkModels(ws)],
      ["getAgent", (ws) => api.getAgent(ws, "creative_director")],
      ["putAiModel", (ws) => api.putAiModel(ws, "custom-x", { label: "X", provider: "Amazon", modelId: "eu.amazon.nova-lite-v1:0", region: "eu-north-1", efforts: [], defaultEffort: null, vision: false, maxOutputTokens: 100, price: null })],
      ["deleteAiModel", (ws) => api.deleteAiModel(ws, "custom-x")],
      ["storageCleanup", (ws) => api.storageCleanup(ws)],
    ];
    for (const [name, call] of calls) {
      await expect(call("clips"), name).rejects.toMatchObject({ status: 409, message: "That is a Lamo Stories page. Switch to Lamo Stories first." });
      await expect(call("01JZ0000000000000000000000"), name).rejects.toMatchObject({ status: 404, message: "We could not find that workspace." });
    }
  });

  it("never reads Clip Factory's model list, skills or model setting (only Lamo Stories' own files)", () => {
    const dirs = [join(import.meta.dirname, "..", "src", "stories", "settings"), join(import.meta.dirname, "..", "src", "stories", "api", "mock")];
    const mine = [
      ...readdirSync(dirs[0]!).map((f) => join(dirs[0]!, f)),
      ...["ai.ts", "skills.ts", "memory.ts"].map((f) => join(dirs[1]!, f)),
      join(import.meta.dirname, "..", "src", "stories", "screens", "Settings.tsx"),
    ];
    for (const file of mine) {
      const text = readFileSync(file, "utf8");
      const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const i of imports) {
        // Clip Factory's config/models.json; Lamo Stories' own is stories/config/models.json.
        expect(i, file).not.toMatch(/(?<!stories\/)config\/models\.json$/);
        expect(i, file).not.toMatch(/lib\/models\.ts$/);
        expect(i, file).not.toMatch(/screens\/settings\//);
        expect(i, file).not.toMatch(/\/api\/index\.ts$/);
      }
    }
  });
});

describe("round 3 (§45.34)", () => {
  const def = { label: "Nova Premier", provider: "Amazon", modelId: "eu.amazon.nova-premier-v1:0", region: "eu-west-1", efforts: ["low", "high"] as Effort[], defaultEffort: "high" as Effort, vision: true, maxOutputTokens: 8000, price: null };

  it("adds, changes and lists a model the owner adds, merged after the bundled ones and marked custom", async () => {
    const m = await api.putAiModel("stories", "custom-nova-premier", def);
    expect(m).toMatchObject({ key: "custom-nova-premier", label: "Nova Premier", provider: "Amazon", modelId: "eu.amazon.nova-premier-v1:0", efforts: ["low", "high"], defaultEffort: "high", vision: true, status: "not_checked", custom: true, region: "eu-west-1", maxOutputTokens: 8000, price: null });
    const { models, tasks } = await api.getAi("stories");
    expect(models.map((x) => x.key)).toEqual([...storiesModels.models.map((x) => x.key), "nova-pro", "custom-nova-premier"]);
    expect(models.filter((x) => x.custom).map((x) => x.key)).toEqual(["custom-nova-premier"]);
    expect(models.find((x) => x.key === "opus-5-5")?.custom).toBe(false);
    // It can be used anywhere a model is: a task, with only the efforts it offers.
    const ai = (await api.getAi("stories")).ai;
    await expect(api.putAi("stories", { ...ai, tasks: { storyboard: { model: "custom-nova-premier", effort: "max" } } })).rejects.toMatchObject({ status: 400, message: "Nova Premier does not offer Maximum. Pick another level." });
    await api.putAi("stories", { ...ai, tasks: { storyboard: { model: "custom-nova-premier", effort: "low" } } });
    expect((await api.getAi("stories")).tasks.find((t) => t.kind === "storyboard")?.effective).toMatchObject({ model: "custom-nova-premier", effort: "low", from: "task" });
    expect(tasks.length).toBe(11);
    // Changing it keeps its key; a new id has to be checked again.
    const changed = await api.putAiModel("stories", "custom-nova-premier", { ...def, label: "Nova Premier 2", price: { inputPer1M: 2.5, outputPer1M: 12.5, cacheReadPer1M: null, cacheWritePer1M: null, longContext: null, currency: "USD", source: "owner", note: "x" } });
    expect(changed).toMatchObject({ label: "Nova Premier 2", price: { inputPer1M: 2.5, outputPer1M: 12.5, source: "owner" } });
  });

  it("refuses a bad key, a bundled key, more than 20 models and bad details, each with its field", async () => {
    await expect(api.putAiModel("stories", "nova-premier", def)).rejects.toMatchObject({ status: 400, field: "key" });
    await expect(api.putAiModel("stories", "custom-Nova", def)).rejects.toMatchObject({ status: 400, field: "key" });
    await expect(api.putAiModel("stories", "opus-5-5", def)).rejects.toMatchObject({ status: 400, field: "key" });
    await expect(api.putAiModel("stories", "custom-x", { ...def, label: " " })).rejects.toMatchObject({ field: "label" });
    await expect(api.putAiModel("stories", "custom-x", { ...def, label: "Claude Opus 5.5" })).rejects.toMatchObject({ field: "label" });
    await expect(api.putAiModel("stories", "custom-x", { ...def, provider: "" })).rejects.toMatchObject({ field: "provider" });
    await expect(api.putAiModel("stories", "custom-x", { ...def, modelId: "not a model" })).rejects.toMatchObject({ field: "modelId" });
    await expect(api.putAiModel("stories", "custom-x", { ...def, region: "Ireland" })).rejects.toMatchObject({ field: "region" });
    await expect(api.putAiModel("stories", "custom-x", { ...def, efforts: ["low", "low"] })).rejects.toMatchObject({ field: "efforts" });
    await expect(api.putAiModel("stories", "custom-x", { ...def, defaultEffort: "max" })).rejects.toMatchObject({ field: "defaultEffort" });
    await expect(api.putAiModel("stories", "custom-x", { ...def, efforts: [], defaultEffort: "low" })).rejects.toMatchObject({ field: "defaultEffort" });
    await expect(api.putAiModel("stories", "custom-x", { ...def, maxOutputTokens: 0 })).rejects.toMatchObject({ field: "maxOutputTokens" });
    await expect(api.putAiModel("stories", "custom-x", { ...def, extra: 1 } as never)).rejects.toMatchObject({ field: "extra" });
    // An ARN and an inference profile are fine; no efforts at all is fine (it runs at its own level).
    // (Its Region is the one the ARN names: a Region that does not fit is refused, §45.36 E4.)
    await api.putAiModel("stories", "custom-arn", { ...def, label: "By ARN", modelId: "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/eu.amazon.nova-pro-v1:0", region: "eu-north-1", efforts: [], defaultEffort: null });
    for (let i = 1; i < 20; i++) await api.putAiModel("stories", `custom-m${i}`, { ...def, label: `Model ${i}` });
    await expect(api.putAiModel("stories", "custom-m21", { ...def, label: "One too many" })).rejects.toMatchObject({ status: 400, message: "You can add up to 20 models. Remove one first." });
  });

  it("removes one only while no saved setting uses it (409 naming the setting); a bundled one never", async () => {
    await api.putAiModel("stories", "custom-nova-premier", def);
    const a = await api.getAgent("stories", "character");
    await api.patchAgent("stories", "character", { version: a.version, model: "custom-nova-premier" });
    await expect(api.deleteAiModel("stories", "custom-nova-premier")).rejects.toMatchObject({ status: 409, message: "Nova Premier is still used by the Character agent. Pick another model there first." });
    await api.patchAgent("stories", "character", { version: a.version + 1, model: null });
    await api.deleteAiModel("stories", "custom-nova-premier");
    expect((await api.getAi("stories")).models.some((m) => m.key === "custom-nova-premier")).toBe(false);
    await expect(api.deleteAiModel("stories", "custom-nova-premier")).rejects.toMatchObject({ status: 404 });
    await expect(api.deleteAiModel("stories", "opus-5-5")).rejects.toMatchObject({ status: 400 });
  });

  it("checks an added model like any other; one Bedrock does not know keeps Bedrock's sentence", async () => {
    await api.putAiModel("stories", "custom-nova-premier", def);
    store.knobs.bedrockUnknown = "custom-nova-premier";
    const task = await api.checkModels("stories", ["custom-nova-premier"]);
    await wait(60);
    const done = (await api.getTask("stories", task.taskId)) as { result: { models: { key: string; status: string; line: string }[] } };
    expect(done.result.models).toEqual([{ key: "custom-nova-premier", status: "not_found", line: expect.stringContaining("Amazon Bedrock said: The provided model identifier is invalid (eu.amazon.nova-premier-v1:0 in eu-west-1).") }]);
    expect((await api.getAi("stories")).models.find((m) => m.key === "custom-nova-premier")?.status).toBe("not_found");
  });

  it("refuses an effort saved with a model that has no effort setting in the same setting; an inherited one is fine", async () => {
    const ai = (await api.getAi("stories")).ai;
    await expect(api.putAi("stories", { ...ai, tasks: { chat: { model: "nova-pro", effort: "low" } } })).rejects.toMatchObject({ status: 400, message: "Amazon Nova Pro has no effort setting; it runs at its own level." });
    await api.putAi("stories", { ...ai, tasks: { chat: { model: "nova-pro" } } });
    const a = await api.getAgent("stories", "creative_director");
    await expect(api.patchAgent("stories", "creative_director", { version: a.version, model: "nova-pro", effort: "high" })).rejects.toMatchObject({ status: 400 });
  });

  it("stamps what the owner picked (environment, model, effort) and refuses anything else", async () => {
    const ai = (await api.getAi("stories")).ai;
    expect(aiPart.aiPicks(store).picked).toEqual({});
    const saved = await api.putAi("stories", { ...ai, picked: ["model"] });
    expect(Object.keys(aiPart.aiPicks(store).picked)).toEqual(["model"]);
    expect(saved).not.toHaveProperty("picked");
    await expect(api.putAi("stories", { ...saved, picked: ["colour"] as never })).rejects.toMatchObject({ status: 400, field: "picked" });
    await expect(api.putAi("stories", { ...saved, pickedAt: {} } as never)).rejects.toMatchObject({ status: 400, field: "pickedAt" });
  });

  it("counts the makers' use per day and in all, with render minutes; prices them per unit, the built-in animator free", async () => {
    let usage = await api.usage("stories", 30);
    const rig = usage.totalsByProvider!.find((p) => p.provider === "builtin-rig")!;
    expect(rig).toMatchObject({ unit: "second", cost: 0, currency: null });
    expect(usage.renderMinutes).toBeCloseTo(rig.units / 60, 0);
    const daySum = usage.days.reduce((a, d) => a + (d.renderMinutes ?? 0), 0);
    expect(Math.abs(daySum - usage.renderMinutes)).toBeLessThan(1);
    expect(usage.totalsByProvider!.find((p) => p.provider === "nova-canvas")).toMatchObject({ unit: "image", cost: null, currency: null });
    for (const t of usage.totalsByProvider!) expect(usage.days.flatMap((d) => d.byProvider ?? []).filter((b) => b.provider === t.provider).reduce((a, b) => a + b.units, 0)).toBe(t.units);
    const ai = (await api.getAi("stories")).ai;
    await api.putAi("stories", { ...ai, prices: { "nova-canvas": { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: null, cacheWritePer1M: null, longContext: null, currency: "USD", source: "owner", note: "x", perUnit: 0.04, unit: "image" } } });
    usage = await api.usage("stories", 30);
    const canvas = usage.totalsByProvider!.find((p) => p.provider === "nova-canvas")!;
    expect(canvas.currency).toBe("USD");
    expect(canvas.cost).toBeCloseTo(canvas.units * 0.04, 4);
    // Model rows never carry a provider id.
    expect(usage.totals.map((t) => t.model)).not.toContain("builtin-rig");
  });

  it("says where the files are, counts storyboards and captions under scenes, and Clean up now applies the keep choices", async () => {
    store.assets = [
      { assetId: "1", kind: "storyboard", storyId: "s", characterId: null, title: "A", url: "", contentType: "application/json", bytes: 40, version: 1, createdAt: "", meta: {} },
      { assetId: "2", kind: "captions", storyId: "s", characterId: null, title: "A", url: "", contentType: "text/plain", bytes: 2, version: 1, createdAt: "", meta: {} },
    ];
    const s = await api.storage("stories");
    expect(s.bytes).toMatchObject({ scenes: 42, other: 0 });
    expect(s.location).toEqual({ region: "eu-north-1", folder: "ws/{you}/stories/" });
    // Everything kept: nothing to clear.
    expect(await api.storageCleanup("stories")).toEqual({ removed: { files: 0, bytes: 0 } });
    (store.workspaces[1]!.configuration as never as { production: Record<string, unknown> }).production = { burnCaptions: true, scenesAtOnce: 2, keepVersions: "all", keepReferences: "study_only" };
    expect((await api.storageCleanup("stories")).removed.files).toBeGreaterThan(0);
    await expect(api.storageCleanup("clips")).rejects.toMatchObject({ status: 409 });
  });
});
