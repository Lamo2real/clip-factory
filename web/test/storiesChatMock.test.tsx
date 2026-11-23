// The Lamo Stories mock's chat and references parts (docs/CONTRACTS.md §45.16.8, §45.25, §45.27, §45.28): the same
// model and effort rules as the API and the agent (every case of stories/config/resolve-cases.json), a send that
// streams and ends with a button, Stop, an override that is never saved, refusals that never swap the model, pictures,
// memory; reference videos uploaded in parts, analyzed in three steps, deleted. In memory only; nothing leaves.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import * as chat from "../src/stories/api/mock/chat.ts";
import * as references from "../src/stories/api/mock/references.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import type { StoriesApi } from "../src/stories/api/types.ts";

const CASES = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "stories", "config", "resolve-cases.json"), "utf8")) as {
  cases: { name: string; task: string; request?: object; conversation?: object; project?: object; agent?: object; ai: object; expect: { model?: string; effort?: string; from?: string; error?: string } }[];
};

let store: MockStore;
let api: Pick<StoriesApi, (typeof chat.KEYS)[number] | (typeof references.KEYS)[number]>;

beforeEach(() => {
  store = createStore();
  store.workspaces.push(
    { workspaceId: "clips", workspaceName: "Lamo Clips", workspaceType: "clips", builtin: true, configuration: {}, version: 0 },
    { workspaceId: "stories", workspaceName: "Lamo Stories", workspaceType: "stories", builtin: false, configuration: {} as never, version: 1 },
  );
  chat.seed(store);
  references.seed(store);
  store.knobs.chatThinkMs = 0;
  store.knobs.chatChunkMs = 1;
  api = { ...chat.api(store), ...references.api(store) };
});

/** Runs every pretend answer and analysis to its end. */
function finish() {
  chat.advance(store, Date.now() + 120_000);
  references.advance(store, Date.now() + 120_000);
}

describe("the model and effort rules (shared cases)", () => {
  for (const c of CASES.cases)
    it(c.name, () => {
      const r = chat.resolve({ request: c.request ?? null, conversation: c.conversation ?? null, project: c.project ?? null, task: (c.ai as { tasks?: Record<string, object> }).tasks?.[c.task] ?? null, agent: c.agent ?? null, ai: c.ai });
      if (c.expect.error) {
        expect("error" in r && r.error).toBe(c.expect.error);
        return;
      }
      expect("error" in r).toBe(false);
      if ("error" in r) return;
      expect([r.model, r.effort, r.from]).toEqual([c.expect.model, c.expect.effort, c.expect.from]);
      expect(r.effortApplied).toBe(true);
    });

  it("refuses an effort the model does not offer with the sentence, never another level", () => {
    const save = chat.MODELS.find((m) => m.key === "haiku-5-5")!.efforts;
    chat.MODELS.find((m) => m.key === "haiku-5-5")!.efforts = ["low", "medium", "high"];
    try {
      const r = chat.resolve({ request: { model: "haiku-5-5", effort: "max" }, ai: {} });
      expect(r).toEqual({ error: "effort", sentence: "Claude Haiku 5.5 does not offer Maximum. Pick another level." });
    } finally {
      chat.MODELS.find((m) => m.key === "haiku-5-5")!.efforts = save;
    }
  });

  it("leaves the effort out (effortApplied false) for a model with no effort setting", () => {
    const m = chat.MODELS.find((x) => x.key === "sonnet-5-5")!;
    const save = m.efforts;
    m.efforts = [];
    try {
      expect(chat.resolve({ conversation: { model: "sonnet-5-5", effort: "high" }, ai: {} })).toEqual({ model: "sonnet-5-5", effort: null, effortApplied: false, from: "conversation" });
    } finally {
      m.efforts = save;
    }
  });
});

describe("chat", () => {
  it("lists the workspace's conversations newest first, each with what the next message uses", async () => {
    const list = await api.listConversations("stories");
    expect(list.map((c) => c.convId)).toEqual([chat.SEED_IDS.conversations.winter, chat.SEED_IDS.conversations.hooks]);
    expect(list[0]!.effective).toEqual({ model: "opus-5-5", effort: "high", effortApplied: true, from: "default" });
    expect(list[1]!.effective).toEqual({ model: "sonnet-5-5", effort: "medium", effortApplied: true, from: "conversation" });
  });

  it("follows the workspace's AI settings and the creative director's own setting", async () => {
    store.ai = { defaultModel: "fable-5-1", defaultEffort: "low", tasks: {}, prices: {}, version: 1 };
    expect((await api.createConversation("stories", {})).effective).toMatchObject({ model: "fable-5-1", effort: "low", from: "default" });
    store.ai.tasks.chat = { effort: "xhigh" };
    expect((await api.createConversation("stories", {})).effective).toMatchObject({ model: "fable-5-1", effort: "xhigh", from: "default" });
    store.agents.push({ agentId: "creative_director", name: "Creative director", tasks: ["chat"], instructions: "", defaultInstructions: "", active: true, model: "haiku-5-5", effort: null, skillIds: [], version: 1, updatedAt: "" });
    expect((await api.createConversation("stories", {})).effective).toMatchObject({ model: "haiku-5-5", effort: "xhigh", from: "agent" });
  });

  it("keeps Lamo Clips and other workspaces out", async () => {
    await expect(api.listConversations("clips")).rejects.toMatchObject({ status: 409 });
    await expect(api.listConversations("01JSTNOPE00000000000000000")).rejects.toMatchObject({ status: 404 });
    await expect(api.getConversation("stories", "nope")).rejects.toMatchObject({ status: 404, message: "We could not find that chat." });
  });

  it("sends: the user message at once, an answer that streams, then its button", async () => {
    const conv = await api.createConversation("stories", {});
    store.knobs.chatChunkMs = 1000;
    const sent = await api.sendMessage("stories", conv.convId, { text: "Three funny ideas about snow" });
    expect(sent.user).toMatchObject({ role: "user", text: "Three funny ideas about snow", status: "done" });
    expect(sent.assistant).toMatchObject({ role: "assistant", status: "pending", text: "", model: "opus-5-5", effort: "high", effortApplied: true });
    chat.advance(store, Date.parse(sent.assistant.createdAt) + 1500);
    const mid = (await api.getConversation("stories", conv.convId, { after: sent.user.msgId })).messages;
    expect(mid).toHaveLength(1);
    expect(mid[0]!.status).toBe("streaming");
    expect(mid[0]!.text.length).toBeGreaterThan(0);
    finish();
    const { conversation, messages } = await api.getConversation("stories", conv.convId);
    const answer = messages.at(-1)!;
    expect(answer.status).toBe("done");
    expect(answer.actions).toEqual([expect.objectContaining({ kind: "save_idea", label: "Save this idea" })]);
    expect(answer.usage).not.toBeNull();
    expect(conversation.title).toBe("Three funny ideas about snow");
    expect(conversation.lastMessageAt).not.toBeNull();
  });

  it("uses a just-this-message override for that message only (never saved)", async () => {
    const conv = await api.createConversation("stories", {});
    const sent = await api.sendMessage("stories", conv.convId, { text: "Be clever", override: { model: "fable-5-2", effort: "max" } });
    expect([sent.assistant.model, sent.assistant.effort]).toEqual(["fable-5-2", "max"]);
    const after = (await api.getConversation("stories", conv.convId)).conversation;
    expect([after.model, after.effort, after.effective.model, after.effective.effort]).toEqual([null, null, "opus-5-5", "high"]);
  });

  it("saves the conversation's own setting, and refuses an unknown model with its sentence", async () => {
    const conv = await api.createConversation("stories", {});
    const next = await api.patchConversation("stories", conv.convId, { model: "sonnet-5-5", effort: "low" });
    expect(next.effective).toEqual({ model: "sonnet-5-5", effort: "low", effortApplied: true, from: "conversation" });
    await expect(api.patchConversation("stories", conv.convId, { model: "gpt-9" })).rejects.toMatchObject({ status: 400, message: "We don't know that model. Pick one from the list." });
    await expect(api.patchConversation("stories", conv.convId, { title: "" })).rejects.toMatchObject({ status: 400 });
    expect((await api.patchConversation("stories", conv.convId, { title: "Snow ideas", projectRef: { kind: "reference", id: references.SEED_IDS.analyzed } })).projectRef).toEqual({ kind: "reference", id: references.SEED_IDS.analyzed });
  });

  it("stops an answer where it is", async () => {
    const conv = await api.createConversation("stories", {});
    store.knobs.chatChunkMs = 10_000;
    const sent = await api.sendMessage("stories", conv.convId, { text: "Go on" });
    chat.advance(store, Date.parse(sent.assistant.createdAt) + 20);
    const stopped = await api.stopMessage("stories", conv.convId, sent.assistant.msgId);
    expect(stopped.status).toBe("stopped");
    finish();
    expect((await api.getConversation("stories", conv.convId)).messages.at(-1)!.status).toBe("stopped");
  });

  it("fails a refused model with its own sentence, and never answers with another model", async () => {
    const conv = await api.createConversation("stories", { model: "fable-5-2" });
    store.knobs.chatDenied = ["fable-5-2"];
    const sent = await api.sendMessage("stories", conv.convId, { text: "Hello" });
    finish();
    const m = (await api.getConversation("stories", conv.convId)).messages.find((x) => x.msgId === sent.assistant.msgId)!;
    expect(m.status).toBe("failed");
    expect(m.model).toBe("fable-5-2");
    expect(m.error).toBe("Claude Fable 5.2 isn't available right now: this account cannot use it yet. Pick another model in Clip Factory Stories › Settings › AI, or try again.");
  });

  it("says so when the creative director is switched off", async () => {
    store.agents.push({ agentId: "creative_director", name: "Creative director", tasks: ["chat"], instructions: "", defaultInstructions: "", active: false, model: null, effort: null, skillIds: [], version: 1, updatedAt: "" });
    const conv = await api.createConversation("stories", {});
    await api.sendMessage("stories", conv.convId, { text: "Hello" });
    finish();
    expect((await api.getConversation("stories", conv.convId)).messages.at(-1)!.error).toBe("Creative director is switched off. Switch it on in Clip Factory Stories › Settings › Agents.");
  });

  it("takes pictures up to 5 MB, only the ones uploaded to this chat", async () => {
    const conv = await api.createConversation("stories", {});
    await expect(api.chatAttachment("stories", conv.convId, { filename: "a.gif", contentType: "image/gif", size: 10 })).rejects.toMatchObject({ status: 400 });
    await expect(api.chatAttachment("stories", conv.convId, { filename: "a.png", contentType: "image/png", size: 5 * 1024 * 1024 + 1 })).rejects.toMatchObject({ status: 413, code: "too_large" });
    const up = await api.chatAttachment("stories", conv.convId, { filename: "a.png", contentType: "image/png", size: 1000 });
    expect(up.uploadUrl).toMatch(/^mock:/);
    await expect(api.sendMessage("stories", conv.convId, { text: "Look", attachments: [{ assetId: "nope" }] })).rejects.toMatchObject({ status: 400 });
    const sent = await api.sendMessage("stories", conv.convId, { text: "Look", attachments: [{ assetId: up.assetId }] });
    expect(sent.user.attachments).toEqual([{ assetId: up.assetId, url: expect.stringContaining(up.assetId), contentType: "image/png" }]);
  });

  it("refuses a second message while an answer is still being written", async () => {
    const conv = await api.createConversation("stories", {});
    store.knobs.chatChunkMs = 10_000;
    await api.sendMessage("stories", conv.convId, { text: "One" });
    await expect(api.sendMessage("stories", conv.convId, { text: "Two" })).rejects.toBeInstanceOf(ApiError);
  });

  it("remembers what the owner asks it to, in the workspace memory", async () => {
    const conv = await api.createConversation("stories", {});
    await api.sendMessage("stories", conv.convId, { text: "Please remember that Lamo likes slapstick endings." });
    finish();
    expect(store.memory.map((m) => [m.text, m.source])).toEqual([["Lamo likes slapstick endings", "chat"]]);
  });

  it("deletes a conversation with its messages", async () => {
    await api.deleteConversation("stories", chat.SEED_IDS.conversations.winter);
    expect(store.messages.some((m) => m.convId === chat.SEED_IDS.conversations.winter)).toBe(false);
    await expect(api.getConversation("stories", chat.SEED_IDS.conversations.winter)).rejects.toMatchObject({ status: 404 });
  });

  it("offers each kind of button for the right question", () => {
    expect(chat.answerFor(store, "Help me make a new character", null).actions[0]!.kind).toBe("save_character");
    // The agent's own shape (tools.py offer_make_video): { story: StoryInput }.
    expect(chat.answerFor(store, "Let's make a video", null).actions[0]).toMatchObject({ kind: "make_video", payload: { story: { durationSec: 40, brief: { category: "comedy" } } } });
    expect(chat.answerFor(store, "Analyze my reference", null).actions[0]).toEqual({ kind: "analyze_reference", label: "Analyze this reference video", payload: { refId: references.SEED_IDS.ready } });
    expect(chat.answerFor(store, "Ideas please", null).actions[0]!.kind).toBe("save_idea");
    // A chat about a story: the agent's propose_story_change for the whole story (a note, no scenes).
    store.stories.push({ storyId: "01JSTST0000000000000000001" } as never);
    expect(chat.answerFor(store, "Make the middle slower", { kind: "story", id: "01JSTST0000000000000000001" }).actions[0]).toEqual({
      kind: "remake_scene",
      label: "Make these changes",
      payload: { storyId: "01JSTST0000000000000000001", sceneIds: [], note: "Make the middle slower" },
    });
  });
});

describe("references", () => {
  it("uploads in parts of 100 MB and needs every part to finish", async () => {
    const size = 250 * 1024 * 1024;
    await expect(api.createReference("stories", { filename: "a.avi", contentType: "video/x-msvideo", size, title: "A" })).rejects.toMatchObject({ status: 400, message: "Pick an MP4 or MOV video." });
    await expect(api.createReference("stories", { filename: "a.mp4", contentType: "video/mp4", size: 3 * 1024 ** 3, title: "A" })).rejects.toMatchObject({ status: 413 });
    const made = await api.createReference("stories", { filename: "a.mp4", contentType: "video/mp4", size, title: "Skating" });
    expect(made.reference.status).toBe("uploading");
    expect(made.upload.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    await expect(api.completeReference("stories", made.reference.refId, [{ partNumber: 1, etag: "a" }])).rejects.toMatchObject({ status: 400 });
    await expect(api.analyzeReference("stories", made.reference.refId)).rejects.toMatchObject({ status: 409 });
    const done = await api.completeReference("stories", made.reference.refId, [1, 2, 3].map((n) => ({ partNumber: n, etag: `"e${n}"` })));
    expect(done.status).toBe("ready");
  });

  it("analyzes in three steps with the run's model, then shows the analysis", async () => {
    const id = references.SEED_IDS.ready;
    const started = await api.analyzeReference("stories", id, { model: "haiku-5-5", effort: "medium" });
    expect(started.job.steps.map((s) => s.label)).toEqual(["Look at it", "Listen", "Write it up"]);
    expect(started.job.meta.models[0]).toMatchObject({ model: "haiku-5-5", effort: "medium", agentId: "video_analysis" });
    expect(started.reference.status).toBe("analyzing");
    await expect(api.analyzeReference("stories", id)).rejects.toMatchObject({ status: 409 });
    references.advance(store, Date.parse(started.job.createdAt) + 2000);
    // The contract's answer (§45.34): { reference, analysis, job }, the job of currentJobId with each step's state.
    expect(Object.keys(await api.getReference("stories", id)).sort()).toEqual(["analysis", "job", "reference"]);
    const mid = await api.getReference("stories", id);
    expect(mid.job?.jobId).toBe(started.job.jobId);
    expect(mid.job?.steps.map((s) => [s.key, s.status])).toEqual([
      ["look", "done"],
      ["listen", "running"],
      ["write", "pending"],
    ]);
    finish();
    const r = await api.getReference("stories", id);
    expect(r.reference.status).toBe("analyzed");
    expect(r.reference.analyzedWith).toEqual({ model: "haiku-5-5", effort: "medium" });
    expect(r.reference.ai).toEqual({ model: null, effort: null });
    expect(Object.keys(r.analysis!).sort()).toEqual(["avoid", "borrow", "captions", "gags", "hook", "pacing", "shots", "sound", "summary"]);
    expect(r.analysis!.shots.length).toBeGreaterThan(2);
  });

  it("fails an analysis with its sentence", async () => {
    store.knobs.refFail = "We could not open that video. Upload it again as MP4 or MOV.";
    await api.analyzeReference("stories", references.SEED_IDS.ready);
    finish();
    const r = await api.getReference("stories", references.SEED_IDS.ready);
    expect(r.reference.status).toBe("failed");
    expect(r.analysis).toBeNull();
    store.knobs.refJobInGet = true;
    const withJob = (await api.getReference("stories", references.SEED_IDS.ready)) as Awaited<ReturnType<StoriesApi["getReference"]>> & { job?: { status: string; error?: string } };
    expect(withJob.job).toMatchObject({ status: "failed", error: "We could not open that video. Upload it again as MP4 or MOV." });
  });

  it("a failed re-run keeps the last analysis and goes back to analyzed, as the agent does", async () => {
    const id = references.SEED_IDS.analyzed;
    const old = (await api.getReference("stories", id)).analysis;
    expect(old).not.toBeNull();
    store.knobs.refFail = "Claude Fable 5.2 isn't available right now: no access. Pick another model in Clip Factory Stories › Settings › AI, or try again.";
    await api.analyzeReference("stories", id, { model: "fable-5-2" });
    // While it runs, the last analysis is still answered (the API reads analysis.json whatever the status).
    expect((await api.getReference("stories", id)).analysis).toEqual(old);
    finish();
    const r = await api.getReference("stories", id);
    expect(r.reference.status).toBe("analyzed");
    expect(r.reference.analyzedWith).toEqual({ model: "opus-5-5", effort: "high" });
    expect(r.analysis).toEqual(old);
    expect(store.jobs.find((j) => j.contentId === id)).toMatchObject({ status: "failed", error: expect.stringContaining("Settings › AI") });
  });

  it("renames and deletes a reference video; a character's picture delete is not a video delete", async () => {
    expect((await api.patchReference("stories", references.SEED_IDS.analyzed, { title: "Penguin skates" })).title).toBe("Penguin skates");
    await expect(api.patchReference("stories", references.SEED_IDS.analyzed, { title: " " })).rejects.toMatchObject({ status: 400 });
    // A reference video is deleteReferenceVideo (§45.34); deleteReference (a character's picture) is not this part's.
    expect("deleteReference" in api).toBe(false);
    expect(store.references).toHaveLength(2);
    await api.deleteReferenceVideo("stories", references.SEED_IDS.analyzed);
    expect((await api.listReferences("stories")).map((r) => r.refId)).toEqual([references.SEED_IDS.ready]);
  });
});
