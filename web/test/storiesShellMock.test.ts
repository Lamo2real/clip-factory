// The in-memory Lamo Stories API, the shell's parts (docs/CONTRACTS.md §45.16.8): the workspace list and settings,
// social accounts in every connection state, publishing jobs in every status, the dashboard worked out from the
// store (Needs you, counts, numbers, activity), the Library's files, each platform's developer-app choice (§45.30),
// the onboarding (§45.29) with the AI stand-ins it needs, and the joining of the parts (a built method always wins
// over a not-built stub; deleteReference goes by its arguments).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { createStore, isNotBuilt, notBuilt, setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import { DEFAULT_CONFIG } from "../src/stories/api/mock/workspace.ts";
import defaults from "../../stories/config/workspace-defaults.json";
import { STORIES_PLATFORMS, type SocialAccount, type StoriesApi, type StoriesConfig } from "../src/stories/api/types.ts";

let api: StoriesApi;
let store: MockStore;

beforeEach(() => {
  setMockLatency(0);
  api = mockStoriesApi();
  store = (window as unknown as { __cfStoriesMock: { store: MockStore } }).__cfStoriesMock.store;
  store.knobs.publishMs = 5;
});

describe("workspaces", () => {
  it("lists Lamo Clips first, built in, then Lamo Stories", async () => {
    const list = await api.listWorkspaces();
    expect(list.map((w) => [w.workspaceId, w.workspaceType, w.builtin])).toEqual([
      ["clips", "clips", true],
      ["stories", "stories", false],
    ]);
  });

  it("answers the API's 404 and 409 for a workspace that is not one, or not a Lamo Stories one", async () => {
    await expect(api.dashboard("01JZ0000000000000000000000")).rejects.toMatchObject({ status: 404, message: "We could not find that workspace." });
    await expect(api.social("clips")).rejects.toMatchObject({ status: 409, message: "That is a Clips Funded page. Switch to Clips Funded first." });
  });

  it("saves settings on top of the version it was given, and refuses a stale one or a bad value", async () => {
    const w = await api.getWorkspace("stories");
    const next = await api.patchWorkspace("stories", { configuration: { defaultDurationSec: 60, providers: { images: "stability", video: "builtin-2d", audio: "builtin-synth" } }, version: w.version });
    expect(next.version).toBe(w.version + 1);
    expect(next.configuration).toMatchObject({ defaultDurationSec: 60, captionsOn: true, providers: { images: "stability" }, video: { quality: "high", fps: 30 } });
    await expect(api.patchWorkspace("stories", { configuration: { captionsOn: false }, version: w.version })).rejects.toMatchObject({ code: "conflict" });
    await expect(api.patchWorkspace("stories", { configuration: { defaultDurationSec: 10 }, version: next.version })).rejects.toMatchObject({ field: "defaultDurationSec" });
    await expect(api.patchWorkspace("stories", { configuration: { video: { quality: "ultra" as never, resolution: "1080x1920", aspect: "9:16", fps: 30 } }, version: next.version })).rejects.toMatchObject({ field: "video" });
  });

  it("starts from stories/config/workspace-defaults.json, the one file of StoriesConfig's defaults", () => {
    const { $comment: _c, ...file } = defaults as unknown as StoriesConfig & { $comment: string };
    expect(DEFAULT_CONFIG).toEqual(file);
    // Every key of StoriesConfig, and nothing else (a key added to the type must be added to the file).
    const keys: (keyof StoriesConfig)[] = ["defaultDurationSec", "captionsOn", "musicOn", "providers", "video", "production", "youtubeCategory", "youtubePrivacy", "xMonthlyLimitUsd"];
    expect(Object.keys(file).sort()).toEqual([...keys].sort());
    expect(store.workspaces.find((w) => w.workspaceId === "stories")?.configuration).toEqual(file);
  });

  it("shows a provider as working only after a real call: Stability AI and Luma AI Ray2 need a check once picked", async () => {
    const before = await api.providers("stories");
    expect(before.find((p) => p.id === "stability")?.state).toBe("off");
    expect(before.find((p) => p.id === "luma-ray")?.state).toBe("off");
    // Amazon ended Nova Canvas and Nova Reel (§45.37): they read ended, never off or on.
    expect(before.find((p) => p.id === "nova-canvas")?.state).toBe("ended");
    expect(before.find((p) => p.id === "nova-reel")?.state).toBe("ended");
    const w = await api.getWorkspace("stories");
    await api.patchWorkspace("stories", { configuration: { providers: { images: "stability", video: "luma-ray", audio: "builtin-synth" } }, version: w.version });
    const after = await api.providers("stories");
    expect(after.find((p) => p.id === "stability")?.state).toBe("needs_setup");
    expect(after.find((p) => p.id === "luma-ray")?.state).toBe("needs_setup");
  });

  it("serves the checked guidance list with each step's shown flag and resolved citations", async () => {
    const g = await api.guidance("stories");
    expect(g.topics).toHaveLength(12);
    const skid = g.topics.find((t) => t.id === "skid-recovery")!;
    expect(skid.steps.some((s) => !s.shown && s.why)).toBe(true);
    expect(skid.citations[0]).toMatchObject({ publisher: expect.any(String), url: expect.stringMatching(/^https:\/\//) });
  });
});

describe("social accounts", () => {
  const byStatus = (accounts: SocialAccount[]) => Object.fromEntries(accounts.map((a) => [a.platform, a.connectionStatus]));

  it("has five, one per platform, in every connection state, with Lamo Clips' own names alongside", async () => {
    const { accounts, clips } = await api.social("stories");
    expect(accounts.map((a) => a.platform)).toEqual(STORIES_PLATFORMS);
    expect(new Set(accounts.map((a) => a.connectionStatus))).toEqual(new Set(["connected", "choose_account", "needs_reconnect", "same_as_clips", "not_connected"]));
    const insta = accounts.find((a) => a.connectionStatus === "choose_account")!;
    expect(insta.choices?.some((c) => c.usedByClips)).toBe(true);
    expect(insta.choices?.some((c) => !c.usedByClips)).toBe(true);
    expect(accounts.some((a) => a.warning)).toBe(true);
    for (const a of accounts) {
      expect(a.socialAccountId).toBe(`stories.${a.platform}`);
      expect(a.limits.length).toBeGreaterThan(0);
    }
    expect(clips.map((c) => c.platform)).toEqual(STORIES_PLATFORMS);
    expect(JSON.stringify(clips)).not.toMatch(/token|secret/i);
  });

  it("connects and lands back on Lamo Stories › Connections with a result, like the real callback", async () => {
    const yt = await api.connectSocial("stories", "facebook");
    expect(yt.authorizeUrl).toBe("/stories/connections?platform=facebook&result=choose&ws=stories");
    store.knobs.connectResult = "connected";
    expect((await api.connectSocial("stories", "facebook")).authorizeUrl).toContain("result=connected");
    expect(byStatus((await api.social("stories")).accounts).facebook).toBe("connected");
  });

  it("picking Clip Factory's own Page is held as Clip Factory's, and nothing can share it (§45.37 G8)", async () => {
    const insta = (await api.social("stories")).accounts.find((a) => a.platform === "instagram")!;
    const clipsOwn = insta.choices!.find((c) => c.usedByClips)!;
    const picked = await api.chooseSocial("stories", "instagram", clipsOwn.id);
    expect(picked.connectionStatus).toBe("same_as_clips");
    expect(picked).not.toHaveProperty("sharedWithClips");
    // There is no "Use it for both": no such call, and the account stays Clip Factory's.
    expect((api as unknown as Record<string, unknown>).shareWithClips).toBeUndefined();
    expect((await api.social("stories")).accounts.find((a) => a.platform === "instagram")?.connectionStatus).toBe("same_as_clips");
    await expect(api.chooseSocial("stories", "youtube", "x")).rejects.toMatchObject({ status: 400 });
  });

  it("disconnect only forgets Lamo Stories' own account", async () => {
    const clipsBefore = structuredClone(store.clips);
    await api.disconnectSocial("stories", "youtube");
    const { accounts, clips } = await api.social("stories");
    expect(accounts.find((a) => a.platform === "youtube")).toMatchObject({ connectionStatus: "not_connected", externalAccountId: null });
    expect(clips).toEqual(clipsBefore);
  });

  it("says plainly when Lamo Clips has no app keys for a platform", async () => {
    store.knobs.noAppKeys = "x";
    const e = await api.connectSocial("stories", "x").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).message).toMatch(/^Clip Factory has no X app keys yet\./);
  });

  it("Check now records when the account was last checked; a dead sign-in turns it to connect again", async () => {
    const before = (await api.social("stories")).accounts.find((a) => a.platform === "youtube")!;
    const checked = await api.checkSocial("stories", "youtube");
    expect(Date.parse(checked.lastCheckedAt!)).toBeGreaterThan(Date.parse(before.lastCheckedAt!));
    store.knobs.tokenDead = "youtube";
    expect(await api.checkSocial("stories", "youtube")).toMatchObject({ connectionStatus: "needs_reconnect", reason: "token_dead" });
  });

  it("sends the account's reason as a code, the way the API does (the web says it in words), with the API's warning", async () => {
    const tiktok = (await api.social("stories")).accounts.find((a) => a.platform === "tiktok")!;
    expect(tiktok).toMatchObject({ connectionStatus: "needs_reconnect", reason: "keys_changed", warning: "The TikTok app keys changed. Connect again." });
    for (const a of (await api.social("stories")).accounts) if (a.reason !== null) expect(a.reason).toMatch(/^[a-z_]+$/);
  });
});

describe("developer apps (§45.30)", () => {
  const app = async (p: SocialAccount["platform"]) => (await api.social("stories")).accounts.find((a) => a.platform === p)!;
  const META = { choice: "own" as const, clientId: "1122334455667788", clientSecret: "abcdefabcdefabcdefabcdefabcdef12", configId: "5566778899001122" };

  it("shows each platform's choice; Facebook and Instagram can only use Lamo Stories' own Meta app", async () => {
    expect((await app("youtube")).app).toEqual({ choice: "clips", saved: true });
    expect((await app("instagram")).app).toMatchObject({ choice: "own", saved: true, hints: { clientId: "123456…3456", clientSecret: "••••cdef", configId: "…7654" } });
    await expect(api.setSocialApp("stories", "facebook", { choice: "clips" } as never)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/own Meta app/) });
    for (const a of (await api.social("stories")).accounts) expect(JSON.stringify(a)).not.toMatch(/0123456789abcdef0123456789abcdef|clientSecret":"[^•]/);
  });

  it("never connects without a choice, and own keys must be saved first (no fallback)", async () => {
    store.social = store.social.map((a) => (a.platform === "x" ? { ...a, app: { choice: null, saved: false }, connectionStatus: "not_connected" } : a));
    await expect(api.connectSocial("stories", "x")).rejects.toMatchObject({ status: 409, message: "Pick which X app Clips Funded uses first." });
    store.social = store.social.map((a) => (a.platform === "x" ? { ...a, app: { choice: "own", saved: false } } : a));
    await expect(api.connectSocial("stories", "x")).rejects.toMatchObject({ status: 409, message: "Paste your Clips Funded X app keys first." });
  });

  it("checks the key formats, keeps only masked hints, and a new app disconnects the account first", async () => {
    await expect(api.setSocialApp("stories", "youtube", { choice: "own", clientId: "nope", clientSecret: "GOCSPX-x" })).rejects.toMatchObject({ status: 400, field: "clientId" });
    const saved = await api.setSocialApp("stories", "youtube", { choice: "own", clientId: "123456789-abcdefghijklmnopqrstuvwxyz12.apps." + "googleusercontent.com", clientSecret: "GOCSPX-" + "abcdefghijklmnopqrstuvwxyz12" });
    expect(saved.app).toEqual({ choice: "own", saved: true, hints: { clientId: "123456….com", clientSecret: "••••yz12" } });
    expect(saved.connectionStatus).toBe("not_connected");
    expect(saved.limits.join(" ")).toMatch(/own Google project/);
    expect((await api.checkSocialApp("stories", "youtube")).code).toBe("not_connected");
    store.knobs.keysWrong = "youtube";
    expect(await api.checkSocialApp("stories", "youtube")).toMatchObject({ ok: false, code: "keys_wrong" });
    await api.deleteSocialApp("stories", "youtube");
    expect((await app("youtube")).app).toEqual({ choice: null, saved: false });
  });

  it("one own Meta app: its keys are saved and deleted for Instagram and Facebook at once, every key, not only the App ID", async () => {
    await api.setSocialApp("stories", "instagram", META);
    expect((await app("facebook")).app).toEqual((await app("instagram")).app);
    // The same App ID with a new secret (a mistyped one fixed) and a new configuration: Facebook follows.
    const fixed = { ...META, clientSecret: "ffffeeeeddddccccbbbbaaaa99998888", configId: "1111222233334444" };
    await api.setSocialApp("stories", "instagram", fixed);
    expect((await app("facebook")).app.hints).toEqual({ clientId: "112233…7788", clientSecret: "••••8888", configId: "…4444" });
    expect((await app("facebook")).app.hints).toEqual((await app("instagram")).app.hints);
    // Removing them on one card removes them on both.
    await api.deleteSocialApp("stories", "facebook");
    expect((await app("instagram")).app).toEqual({ choice: null, saved: false });
    expect((await app("facebook")).app).toEqual({ choice: null, saved: false });
    // YouTube's own app is its own: nothing else changes with it.
    const xBefore = (await app("x")).app;
    await api.setSocialApp("stories", "youtube", { choice: "own", clientId: "123456789-abcdefghijklmnopqrstuvwxyz12.apps." + "googleusercontent.com", clientSecret: "GOCSPX-" + "abcdefghijklmnopqrstuvwxyz12" });
    expect((await app("x")).app).toEqual(xBefore);
  });

  it("the same Meta keys on both cards keep a connected account (same app), new ones disconnect it", async () => {
    store.knobs.connectResult = "connected";
    await api.connectSocial("stories", "facebook");
    expect((await app("facebook")).connectionStatus).toBe("connected");
    await api.setSocialApp("stories", "facebook", { choice: "own", clientId: "1234567890123456", clientSecret: "0123456789abcdef0123456789abcdef", configId: "9876543210987654" });
    expect((await app("facebook")).connectionStatus).toBe("connected");
    await api.setSocialApp("stories", "facebook", META);
    expect((await app("facebook")).connectionStatus).toBe("not_connected");
  });
});

describe("the onboarding (§45.29)", () => {
  it("has eleven steps; the done-states come from what is really set up", async () => {
    const o = await api.getOnboarding("stories");
    expect(o.steps.map((s) => s.step)).toEqual(["ai", "model", "effort", "video", "agents", "instagram", "tiktok", "youtube", "facebook", "x", "done"]);
    expect(o.total).toBe(11);
    // X is held as Lamo Clips' own (same_as_clips): only a connected account ticks its platform (§45.34).
    expect(o.steps.filter((s) => s.state === "done").map((s) => s.step)).toEqual(["agents", "youtube"]);
    expect(o.done).toBe(2);
    // A save alone ticks nothing of 1 to 3 (§45.34): only what the owner picked on purpose does.
    const { ai } = await api.getAi("stories");
    const plain = await api.putAi("stories", { ...ai, defaultModel: "fable-5-2" });
    expect((await api.getOnboarding("stories")).steps.filter((s) => ["ai", "model", "effort"].includes(s.step)).map((s) => s.state)).toEqual(["todo", "todo", "todo"]);
    // "These look right" ticks 1, the default model 2, the default effort 3; a picked video provider ticks 4; a
    // connection ticks its platform.
    await api.putAi("stories", { ...plain, picked: ["environment", "model", "effort"] });
    const w = await api.getWorkspace("stories");
    await api.patchWorkspace("stories", { configuration: { providers: { images: "builtin-rig", video: "builtin-2d", audio: "builtin-synth" } }, version: w.version });
    store.knobs.connectResult = "connected";
    await api.connectSocial("stories", "facebook");
    const after = await api.getOnboarding("stories");
    expect(after.steps.filter((s) => s.state === "done").map((s) => s.step)).toEqual(["ai", "model", "effort", "video", "agents", "youtube", "facebook"]);
  });

  it("every step can be skipped and done later; only agents and done are ticked by hand", async () => {
    let o = await api.patchOnboarding("stories", { step: "tiktok", skipped: true });
    expect(o.steps.find((s) => s.step === "tiktok")?.state).toBe("skipped");
    o = await api.patchOnboarding("stories", { step: "tiktok", skipped: false });
    expect(o.steps.find((s) => s.step === "tiktok")?.state).toBe("todo");
    // The API's answers: a step that ticks itself is a 409 with its sentence; neither done nor skipped is a 400.
    await expect(api.patchOnboarding("stories", { step: "youtube", done: true })).rejects.toMatchObject({ status: 409, message: "This step ticks itself when YouTube is connected." });
    await expect(api.patchOnboarding("stories", { step: "video", done: true })).rejects.toMatchObject({ status: 409, message: "This step ticks itself when you pick how videos are made." });
    await expect(api.patchOnboarding("stories", { step: "tiktok" } as never)).rejects.toMatchObject({ status: 400, message: "Say whether the step is done or skipped." });
    // Done can be ticked like {finish: true}, and unticked again.
    o = await api.patchOnboarding("stories", { step: "done", done: true });
    expect(o.finishedAt).not.toBeNull();
    o = await api.patchOnboarding("stories", { step: "done", done: false });
    expect(o.finishedAt).toBeNull();
    expect(o.steps.find((s) => s.step === "done")?.state).toBe("todo");
    o = await api.patchOnboarding("stories", { finish: true });
    expect(o.finishedAt).not.toBeNull();
    expect(o.steps.find((s) => s.step === "done")?.state).toBe("done");
  });

  it("does not count a platform held as Lamo Clips' own (same_as_clips): it ticks once Lamo Stories' own is connected (§45.34)", async () => {
    // The seed's X is same_as_clips: nothing can be posted there, so the step stays to do.
    expect((await api.getOnboarding("stories")).steps.find((s) => s.step === "x")?.state).toBe("todo");
    // Signing in with a separate account made for Clips Funded (never "use it for both", §45.37 G8): it ticks.
    await api.connectSocial("stories", "x");
    expect((await api.social("stories")).accounts.find((a) => a.platform === "x")).toMatchObject({ connectionStatus: "connected", handle: "@fundedclips" });
    expect((await api.getOnboarding("stories")).steps.find((s) => s.step === "x")?.state).toBe("done");
  });

  it("step 4 ticks from providersPickedAt, so keeping the built-in animator is a pick too; an API that does not stamp it leaves it to do", async () => {
    const keepDefault = async () => {
      const w = await api.getWorkspace("stories");
      await api.patchWorkspace("stories", { configuration: { providers: { ...w.configuration.providers } }, version: w.version });
      return (await api.getOnboarding("stories")).steps.find((s) => s.step === "video")?.state;
    };
    store.knobs.providersNotStamped = true;
    expect(await keepDefault()).toBe("todo");
    // Another video maker is a pick by itself.
    let w = await api.getWorkspace("stories");
    await api.patchWorkspace("stories", { configuration: { providers: { ...w.configuration.providers, video: "luma-ray" } }, version: w.version });
    expect((await api.getOnboarding("stories")).steps.find((s) => s.step === "video")?.state).toBe("done");
    w = await api.getWorkspace("stories");
    await api.patchWorkspace("stories", { configuration: { providers: { ...w.configuration.providers, video: "builtin-2d" } }, version: w.version });
    expect((await api.getOnboarding("stories")).steps.find((s) => s.step === "video")?.state).toBe("todo");
    store.knobs.providersNotStamped = false;
    expect(await keepDefault()).toBe("done");
    expect(store.onboarding.providersPickedAt).not.toBeNull();
  });

  it("a brand-new studio starts at 0 of 11 with nothing connected and no app picked", async () => {
    (window as unknown as { __cfStoriesMock: unknown }).__cfStoriesMock = { knobs: { fresh: true } };
    const fresh = mockStoriesApi();
    expect((await fresh.getOnboarding("stories")).done).toBe(0);
    const { accounts } = await fresh.social("stories");
    expect(accounts.every((a) => a.connectionStatus === "not_connected" && a.app.choice === null)).toBe(true);
  });

  it("the AI stand-ins refuse an effort a model does not offer, and Check models really runs as a task", async () => {
    const { ai, models } = await api.getAi("stories");
    expect(models.map((m) => m.key)).toContain("opus-5-5");
    // Builder F2's seed keeps each model's last call (§45.25), so some start checked; the rest are not checked yet.
    const unchecked = models.filter((m) => m.status === "not_checked").map((m) => m.key);
    expect(unchecked.length).toBeGreaterThan(0);
    await expect(api.putAi("stories", { ...ai, defaultModel: "gpt-9" })).rejects.toMatchObject({ field: "defaultModel" });
    await expect(api.putAi("stories", { ...ai, version: ai.version + 5 })).rejects.toMatchObject({ code: "conflict" });
    store.knobs.modelDenied = "fable-5-1";
    const task = await api.checkModels("stories");
    await vi.waitFor(async () => expect((await api.getTask("stories", task.taskId)).status).toBe("done"), { timeout: 3000 });
    const checked = (await api.getAi("stories")).models;
    expect(checked.filter((m) => m.status === "not_checked")).toEqual([]);
    for (const k of unchecked) expect(checked.find((m) => m.key === k)?.status).toBe(k === "fable-5-1" ? "denied" : "ok");
    expect(checked.find((m) => m.key === "fable-5-1")?.status).toBe("denied");
    expect(checked.find((m) => m.key === "opus-5-5")?.status).toBe("ok");
  });
});

describe("publishing", () => {
  it("has a job in every status on the approved and published stories", async () => {
    const jobs = await api.listPublishing("stories");
    expect(new Set(jobs.map((j) => j.publishingStatus))).toEqual(new Set(["queued", "publishing", "posted", "failed", "needs_attention"]));
    for (const j of jobs) {
      expect(j.socialAccountId).toBe(`stories.${j.platform}`);
      expect(j.workspaceId).toBe("stories");
      expect(store.stories.some((s) => s.storyId === j.contentId)).toBe(true);
    }
    expect(jobs.find((j) => j.publishingStatus === "posted")?.metrics?.views).toBeGreaterThan(0);
  });

  it("stops a post to an account that is not connected (no default account), and posts to a connected one", async () => {
    const story = store.stories.find((s) => s.status === "approved")!;
    const made = await api.publish("stories", story.storyId, [
      { platform: "youtube", socialAccountId: "stories.youtube" },
      { platform: "facebook", socialAccountId: "stories.facebook" },
    ]);
    expect(made.find((j) => j.platform === "facebook")).toMatchObject({ publishingStatus: "needs_attention", error: expect.stringMatching(/not connected/) });
    expect(made.find((j) => j.platform === "youtube")?.publishingStatus).toBe("queued");
    await vi.waitFor(async () => {
      const yt = (await api.listPublishing("stories", story.storyId)).find((j) => j.publishingJobId === made[0]!.publishingJobId)!;
      expect(yt.publishingStatus).toBe("posted");
    });
    expect(store.stories.find((s) => s.storyId === story.storyId)?.status).toBe("published");
    await expect(api.publish("stories", story.storyId, [{ platform: "x", socialAccountId: "clips.x" }])).rejects.toMatchObject({ code: "conflict" });
  });

  it("Try again re-checks the account at the tap", async () => {
    const stuck = (await api.listPublishing("stories")).find((j) => j.platform === "tiktok" && j.publishingStatus === "needs_attention")!;
    const again = await api.retryPublishing("stories", stuck.publishingJobId);
    expect(again.publishingStatus).toBe("needs_attention");
    await expect(api.retryPublishing("stories", (await api.listPublishing("stories")).find((j) => j.publishingStatus === "posted")!.publishingJobId)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("the dashboard", () => {
  it("counts the stories and lists what needs the owner, each with its sentence and where to go", async () => {
    const d = await api.dashboard("stories");
    const stories = store.stories;
    expect(d.counts.made).toBe(stories.filter((s) => s.actualDurationSec !== null).length);
    expect(d.counts.review).toBe(stories.filter((s) => s.status === "review").length);
    expect(d.counts.published).toBe(stories.filter((s) => s.status === "published").length);
    expect(d.counts.needsYou).toBe(d.needsYou.length);
    // A stuck post, an account to connect again, an account warning, a story that needs a check.
    expect(d.needsYou.some((n) => n.publishingJobId && n.href.startsWith("/stories/review/"))).toBe(true);
    expect(d.needsYou.some((n) => !n.publishingJobId && n.platform === "tiktok" && n.href === "/stories/connections")).toBe(true);
    expect(d.needsYou.some((n) => n.platform === "instagram" && /Clip Factory may have lost Instagram/.test(n.sentence))).toBe(true);
    expect(d.needsYou.some((n) => n.storyId && !n.platform && /needs a check/.test(n.sentence))).toBe(true);
    for (const n of d.needsYou) expect(n.sentence.length).toBeGreaterThan(10);
    expect(d.accounts.map((a) => a.platform)).toEqual(STORIES_PLATFORMS);
    expect(d.producing.every((p) => p.progress >= 0 && p.progress <= 1)).toBe(true);
    expect(d.activity.length).toBeLessThanOrEqual(10);
    expect([...d.activity].sort((a, b) => b.at.localeCompare(a.at))).toEqual(d.activity);
  });

  it("sums the latest numbers over the posts, and says until when they come", async () => {
    const d = await api.dashboard("stories");
    const posted = store.publishing.filter((p) => p.publishingStatus === "posted" && p.metrics);
    expect(d.performance.views).toBe(posted.reduce((n, p) => n + (p.metrics?.views ?? 0), 0));
    expect(d.performance.posts).toBe(store.publishing.filter((p) => p.publishingStatus === "posted").length);
    expect(Date.parse(d.performance.lastAt!)).toBeGreaterThan(Date.now());
  });

  it("drops a stuck post once a later post of the same story on the same app went through", async () => {
    const stuck = store.publishing.find((p) => p.publishingStatus === "failed")!;
    store.publishing.push({ ...stuck, publishingJobId: "later", publishingStatus: "posted", createdAt: new Date().toISOString() });
    const d = await api.dashboard("stories");
    expect(d.needsYou.some((n) => n.publishingJobId === stuck.publishingJobId)).toBe(false);
  });
});

describe("the Library", () => {
  it("has every finished story's files and each character's pictures, newest first, with titles", async () => {
    const { items } = await api.library("stories", { limit: 100 });
    const kinds = new Set(items.map((i) => i.kind));
    for (const k of ["final_video", "cover", "storyboard", "scene_still", "scene_clip", "audio", "captions", "character_ref"]) expect(kinds.has(k as never), k).toBe(true);
    expect([...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((i) => i.assetId)).toEqual(items.map((i) => i.assetId));
    for (const i of items) expect(i.title.length).toBeGreaterThan(0);
  });

  it("filters by kind and story, and pages with a cursor", async () => {
    const story = store.stories.find((s) => s.status === "published")!;
    const videos = await api.library("stories", { kind: "final_video" });
    expect(videos.items.every((i) => i.kind === "final_video")).toBe(true);
    const mine = await api.library("stories", { storyId: story.storyId, limit: 100 });
    expect(mine.items.every((i) => i.storyId === story.storyId)).toBe(true);
    const first = await api.library("stories", { limit: 3 });
    expect(first.items).toHaveLength(3);
    const second = await api.library("stories", { limit: 3, cursor: first.nextCursor! });
    expect(second.items.map((i) => i.assetId)).not.toContain(first.items[0]!.assetId);
  });

  it("follows a story's new title (the route fills it in)", async () => {
    const story = store.stories.find((s) => s.status === "approved")!;
    story.title = "A brand new name";
    const { items } = await api.library("stories", { storyId: story.storyId });
    expect(items.every((i) => i.title === "A brand new name")).toBe(true);
  });
});

describe("joining the parts", () => {
  it("a built method always wins over a not-built stub", () => {
    const stub = notBuilt(["listStories"] as const);
    expect(isNotBuilt(stub.listStories)).toBe(true);
    expect(isNotBuilt(api.listStories)).toBe(false);
    expect(isNotBuilt(api.storyJobs)).toBe(false);
    expect(isNotBuilt(api.dashboard)).toBe(false);
  });

  it("starts from a clean store every time", () => {
    const s = createStore();
    expect(s.stories).toEqual([]);
    expect(s.activity).toEqual([]);
    expect(s.clips).toEqual([]);
    expect(s.onboarding).toEqual({ stepsDone: [], skipped: [], finishedAt: null, providersPickedAt: null });
  });

  it("deleteReference goes to a character's picture and deleteReferenceVideo to a reference video (the rename of §45.34)", async () => {
    // Both parts are built (builder G characters, builder H reference videos): deleteReference reaches the characters
    // part (no such character here), deleteReferenceVideo the references part (no such reference video here).
    await expect(api.deleteReference("stories", "c1", "a1")).rejects.toThrow("We could not find that character.");
    await expect(api.deleteReferenceVideo("stories", "r1")).rejects.toThrow("We could not find that reference video.");
  });
});
