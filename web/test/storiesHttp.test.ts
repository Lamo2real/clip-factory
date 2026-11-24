// The Lamo Stories HTTP client (docs/CONTRACTS.md §45.5): every StoriesApi method calls its own route under
// /v1/workspaces with the owner's token, unwraps the answer, retries once after a 401 with a fresh token, turns the
// error envelope into an ApiError with the server's sentence, and announces a sign-in that is really gone.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { onSignedOut } from "../src/lib/auth.ts";
import { errorAccount, httpStoriesApi, StoriesApiError } from "../src/stories/api/http.ts";
import type { StoriesApi } from "../src/stories/api/types.ts";

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | null;
}

function fake(answer: (c: Call) => { status: number; body?: unknown } = () => ({ status: 200, body: {} })) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.authorization ?? null };
    calls.push(call);
    const a = answer(call);
    return new Response(a.status === 204 ? null : JSON.stringify(a.body ?? {}), { status: a.status, headers: { "content-type": "application/json" } });
  });
  const tokens = { accessToken: vi.fn(async (fresh?: boolean) => (fresh ? "fresh-token" : "old-token")) };
  const api = httpStoriesApi({ baseUrl: "https://api.example/", auth: tokens, fetcher: fetcher as unknown as typeof fetch });
  return { api, calls, tokens };
}

const B = "https://api.example/v1/workspaces";

type Case = [keyof StoriesApi, (api: StoriesApi) => Promise<unknown>, string, string, unknown, unknown, unknown];

/** [method name, the call, HTTP method, URL, body sent, server answer, what the method returns] */
const CASES: Case[] = [
  ["listWorkspaces", (a) => a.listWorkspaces(), "GET", B, undefined, { workspaces: [1] }, [1]],
  ["getWorkspace", (a) => a.getWorkspace("stories"), "GET", `${B}/stories`, undefined, { workspace: 2 }, 2],
  ["patchWorkspace", (a) => a.patchWorkspace("stories", { configuration: { captionsOn: false }, version: 3 }), "PATCH", `${B}/stories`, { configuration: { captionsOn: false }, version: 3 }, { workspace: 4 }, 4],
  ["dashboard", (a) => a.dashboard("stories"), "GET", `${B}/stories/dashboard`, undefined, { dashboard: 5 }, 5],
  ["listIdeas", (a) => a.listIdeas("stories", "saved"), "GET", `${B}/stories/ideas?status=saved`, undefined, { ideas: [6] }, [6]],
  ["createIdea", (a) => a.createIdea("stories", { title: "t", logline: "l", category: "comedy" }), "POST", `${B}/stories/ideas`, { title: "t", logline: "l", category: "comedy" }, { idea: 7 }, 7],
  ["patchIdea", (a) => a.patchIdea("stories", "i1", { title: "u" }), "PATCH", `${B}/stories/ideas/i1`, { title: "u" }, { idea: 8 }, 8],
  ["deleteIdea", (a) => a.deleteIdea("stories", "i1"), "DELETE", `${B}/stories/ideas/i1`, undefined, null, undefined],
  ["generateIdeas", (a) => a.generateIdeas("stories", { topic: "ice", count: 2, override: { effort: "low" } }), "POST", `${B}/stories/ideas/generate`, { topic: "ice", count: 2, override: { effort: "low" } }, { task: 9 }, 9],
  ["expandIdea", (a) => a.expandIdea("stories", "i1", { durationSec: 45 }), "POST", `${B}/stories/ideas/i1/expand`, { durationSec: 45 }, { task: 10 }, 10],
  ["ideaVariations", (a) => a.ideaVariations("stories", "i1"), "POST", `${B}/stories/ideas/i1/variations`, {}, { task: 11 }, 11],
  ["getTask", (a) => a.getTask("stories", "t1"), "GET", `${B}/stories/tasks/t1`, undefined, { task: 111 }, 111],
  ["listCharacters", (a) => a.listCharacters("stories"), "GET", `${B}/stories/characters`, undefined, { characters: [12] }, [12]],
  ["createCharacter", (a) => a.createCharacter("stories", { name: "Pip" } as never), "POST", `${B}/stories/characters`, { name: "Pip" }, { character: 13 }, 13],
  ["getCharacter", (a) => a.getCharacter("stories", "c1"), "GET", `${B}/stories/characters/c1`, undefined, { character: 14 }, 14],
  ["putCharacter", (a) => a.putCharacter("stories", "c1", { name: "Pip", version: 2 } as never), "PUT", `${B}/stories/characters/c1`, { name: "Pip", version: 2 }, { character: 15 }, 15],
  ["deleteCharacter", (a) => a.deleteCharacter("stories", "c1"), "DELETE", `${B}/stories/characters/c1`, undefined, null, undefined],
  ["referenceUpload", (a) => a.referenceUpload("stories", "c1", { filename: "a.png", contentType: "image/png", size: 10 }), "POST", `${B}/stories/characters/c1/references`, { filename: "a.png", contentType: "image/png", size: 10 }, { assetId: "a", uploadUrl: "u", headers: {} }, { assetId: "a", uploadUrl: "u", headers: {} }],
  ["referenceComplete", (a) => a.referenceComplete("stories", "c1", "a1"), "POST", `${B}/stories/characters/c1/references/a1/complete`, undefined, { character: 16 }, 16],
  ["deleteReference", (a) => a.deleteReference("stories", "c1", "a1"), "DELETE", `${B}/stories/characters/c1/references/a1`, undefined, { character: 17 }, 17],
  ["makePortrait", (a) => a.makePortrait("stories", "c1"), "POST", `${B}/stories/characters/c1/portrait`, undefined, { job: 18 }, 18],
  ["designUpload", (a) => a.designUpload("stories", { filename: "d.jpg", contentType: "image/jpeg", size: 9 }), "POST", `${B}/stories/characters/design/uploads`, { filename: "d.jpg", contentType: "image/jpeg", size: 9 }, { assetId: "d", uploadUrl: "u", headers: {} }, { assetId: "d", uploadUrl: "u", headers: {} }],
  ["designCharacter", (a) => a.designCharacter("stories", { description: "a bean", referenceAssetId: "d" }), "POST", `${B}/stories/characters/design`, { description: "a bean", referenceAssetId: "d" }, { task: 181 }, 181],
  ["listStories", (a) => a.listStories("stories", { status: "all", limit: 50, cursor: "x" }), "GET", `${B}/stories/stories?status=all&limit=50&cursor=x`, undefined, { stories: [19] }, { stories: [19], nextCursor: null }],
  ["createStory", (a) => a.createStory("stories", { characterIds: ["c1"] }), "POST", `${B}/stories/stories`, { characterIds: ["c1"] }, { story: 1, job: 2 }, { story: 1, job: 2 }],
  ["getStory", (a) => a.getStory("stories", "s1"), "GET", `${B}/stories/stories/s1`, undefined, { story: 20 }, { story: 20, job: null, script: null }],
  ["storyJobs", (a) => a.storyJobs("stories", "s1"), "GET", `${B}/stories/stories/s1/jobs`, undefined, { jobs: [21] }, [21]],
  ["patchStory", (a) => a.patchStory("stories", "s1", { version: 3, title: "t" }), "PATCH", `${B}/stories/stories/s1`, { version: 3, title: "t" }, { story: 22, script: 23 }, { story: 22, script: 23 }],
  ["deleteStory", (a) => a.deleteStory("stories", "s1"), "DELETE", `${B}/stories/stories/s1`, undefined, null, undefined],
  ["produce", (a) => a.produce("stories", "s1", { from: "scenes", sceneIds: ["a"] }), "POST", `${B}/stories/stories/s1/produce`, { from: "scenes", sceneIds: ["a"] }, { story: 1, job: 2 }, { story: 1, job: 2 }],
  ["cancelStory", (a) => a.cancelStory("stories", "s1"), "POST", `${B}/stories/stories/s1/cancel`, undefined, { story: 24 }, { story: 24, job: null }],
  ["approve", (a) => a.approve("stories", "s1", 7), "POST", `${B}/stories/stories/s1/approve`, { version: 7 }, { story: 25 }, 25],
  ["reject", (a) => a.reject("stories", "s1", "no"), "POST", `${B}/stories/stories/s1/reject`, { reason: "no" }, { story: 26 }, 26],
  ["requestChanges", (a) => a.requestChanges("stories", "s1", { note: "more", sceneIds: ["a"] }), "POST", `${B}/stories/stories/s1/changes`, { note: "more", sceneIds: ["a"] }, { story: 1, job: 2 }, { story: 1, job: 2 }],
  ["writeCaptions", (a) => a.writeCaptions("stories", "s1", { override: { model: "haiku-5-5" } }), "POST", `${B}/stories/stories/s1/captions`, { override: { model: "haiku-5-5" } }, { task: 182 }, 182],
  ["download", (a) => a.download("stories", "s1"), "GET", `${B}/stories/stories/s1/download`, undefined, { url: "u", filename: "f.mp4" }, { url: "u", filename: "f.mp4" }],
  ["library", (a) => a.library("stories", { kind: "cover", storyId: "s1", limit: 10 }), "GET", `${B}/stories/library?kind=cover&storyId=s1&limit=10`, undefined, { items: [27], nextCursor: "n" }, { items: [27], nextCursor: "n" }],
  ["providers", (a) => a.providers("stories"), "GET", `${B}/stories/providers`, undefined, { providers: [28] }, [28]],
  // Nova Reel's Try it (§45.35 D2, builder W4b): one 6-second test shot, a provider_check job.
  ["tryNovaReel", (a) => a.tryNovaReel("stories"), "POST", `${B}/stories/providers/nova-reel/check`, undefined, { job: 28.5 }, 28.5],
  // §45.37: Try it moved to Luma AI Ray2 (one 5-second test shot), the same route shape by the maker's id.
  ["tryMaker", (a) => a.tryMaker("stories", "luma-ray"), "POST", `${B}/stories/providers/luma-ray/check`, undefined, { job: 28.6 }, 28.6],
  ["guidance", (a) => a.guidance("stories"), "GET", `${B}/stories/guidance`, undefined, { topics: [], checkedAt: "c" }, { topics: [], checkedAt: "c" }],
  ["social", (a) => a.social("stories"), "GET", `${B}/stories/social`, undefined, { accounts: [], clips: [] }, { accounts: [], clips: [] }],
  ["connectSocial", (a) => a.connectSocial("stories", "youtube"), "POST", `${B}/stories/social/youtube/connect`, undefined, { authorizeUrl: "https://a", expiresAt: "e" }, { authorizeUrl: "https://a", expiresAt: "e" }],
  ["chooseSocial", (a) => a.chooseSocial("stories", "instagram", "p1"), "POST", `${B}/stories/social/instagram/choose`, { choiceId: "p1" }, { account: 29 }, 29],
  ["checkSocial", (a) => a.checkSocial("stories", "tiktok"), "POST", `${B}/stories/social/tiktok/check`, undefined, { account: 31 }, 31],
  ["tiktokCreatorInfo", (a) => a.tiktokCreatorInfo("stories"), "GET", `${B}/stories/social/tiktok/creator-info`, undefined, { creator: 32 }, 32],
  ["disconnectSocial", (a) => a.disconnectSocial("stories", "facebook"), "DELETE", `${B}/stories/social/facebook`, undefined, null, undefined],
  ["setSocialApp", (a) => a.setSocialApp("stories", "youtube", { choice: "clips" }), "PUT", `${B}/stories/social/youtube/app`, { choice: "clips" }, { account: 41 }, 41],
  ["checkSocialApp", (a) => a.checkSocialApp("stories", "instagram"), "POST", `${B}/stories/social/instagram/app/check`, undefined, { check: 42 }, 42],
  ["deleteSocialApp", (a) => a.deleteSocialApp("stories", "x"), "DELETE", `${B}/stories/social/x/app`, undefined, null, undefined],

  ["getAi", (a) => a.getAi("stories"), "GET", `${B}/stories/ai`, undefined, { ai: 1, models: [], agents: [], tasks: [] }, { ai: 1, models: [], agents: [], tasks: [] }],
  ["putAi", (a) => a.putAi("stories", { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 2 }), "PUT", `${B}/stories/ai`, { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 2 }, { ai: 43 }, 43],
  ["putAiModel", (a) => a.putAiModel("stories", "custom-nova-premier", { label: "Nova Premier", provider: "Amazon", modelId: "eu.amazon.nova-premier-v1:0", region: "eu-west-1", efforts: [], defaultEffort: null, vision: true, maxOutputTokens: 8000, price: null }), "PUT", `${B}/stories/ai/models/custom-nova-premier`, { label: "Nova Premier", provider: "Amazon", modelId: "eu.amazon.nova-premier-v1:0", region: "eu-west-1", efforts: [], defaultEffort: null, vision: true, maxOutputTokens: 8000, price: null }, { model: 431 }, 431],
  ["deleteAiModel", (a) => a.deleteAiModel("stories", "custom-nova-premier"), "DELETE", `${B}/stories/ai/models/custom-nova-premier`, undefined, null, undefined],
  ["checkModels", (a) => a.checkModels("stories", ["opus-5-5"]), "POST", `${B}/stories/ai/check-models`, { models: ["opus-5-5"] }, { task: 44 }, 44],
  ["setModelPrice", (a) => a.setModelPrice("stories", "opus-5-5", null), "PUT", `${B}/stories/ai/prices/opus-5-5`, {}, { model: 45 }, 45],
  // §45.37 G1, G2: the picture, video and sound makers' models, and the owner's own, come on the maker rows of
  // GET …/providers (there is no route of their own), each once.
  [
    "makerModels",
    (a) => a.makerModels("stories"),
    "GET",
    `${B}/stories/providers`,
    undefined,
    { providers: [{ id: "builtin-rig" }, { id: "stability", models: [{ key: "stable-image-core" }] }, { id: "own-images", models: [{ key: "custom-paint" }, { key: "stable-image-core" }] }, { id: "anthropic", key: { saved: true } }] },
    [{ key: "stable-image-core" }, { key: "custom-paint" }],
  ],
  [
    "putMakerModel",
    (a) => a.putMakerModel("stories", "custom-rain", { label: "Rain", provider: "ElevenLabs", kind: "audio", host: "elevenlabs", modelId: "eleven_text_to_sound_v2", price: null, note: "" }),
    "PUT",
    `${B}/stories/makers/models/custom-rain`,
    { label: "Rain", provider: "ElevenLabs", kind: "audio", host: "elevenlabs", modelId: "eleven_text_to_sound_v2", price: null, note: "" },
    { model: 452 },
    452,
  ],
  ["deleteMakerModel", (a) => a.deleteMakerModel("stories", "custom-rain"), "DELETE", `${B}/stories/makers/models/custom-rain`, undefined, null, undefined],
  ["usage", (a) => a.usage("stories", 30), "GET", `${B}/stories/usage?days=30`, undefined, { usage: 46 }, 46],
  ["getAgent", (a) => a.getAgent("stories", "storyboard"), "GET", `${B}/stories/agents/storyboard`, undefined, { agent: 47 }, 47],
  ["patchAgent", (a) => a.patchAgent("stories", "character", { reset: true }), "PATCH", `${B}/stories/agents/character`, { reset: true }, { agent: 48 }, 48],

  ["listSkills", (a) => a.listSkills("stories"), "GET", `${B}/stories/skills`, undefined, { skills: [49] }, [49]],
  ["skillUpload", (a) => a.skillUpload("stories", { filename: "SKILL.md" }), "POST", `${B}/stories/skills/uploads`, { filename: "SKILL.md" }, { skillId: "k", key: "y", uploadUrl: "u", headers: {} }, { skillId: "k", key: "y", uploadUrl: "u", headers: {} }],
  ["createSkill", (a) => a.createSkill("stories", { title: "t", description: "d", instructions: "i" }), "POST", `${B}/stories/skills`, { title: "t", description: "d", instructions: "i" }, { skill: 50 }, 50],
  ["getSkill", (a) => a.getSkill("stories", "k1"), "GET", `${B}/stories/skills/k1`, undefined, { skill: { skillId: "k1" }, content: "# Hi" }, { skillId: "k1", content: "# Hi" }],
  ["putSkill", (a) => a.putSkill("stories", "k1", { version: 2, enabled: false }), "PUT", `${B}/stories/skills/k1`, { version: 2, enabled: false }, { skill: 51 }, 51],
  ["deleteSkill", (a) => a.deleteSkill("stories", "k1"), "DELETE", `${B}/stories/skills/k1`, undefined, null, undefined],
  ["restoreSkill", (a) => a.restoreSkill("stories", "k1", "r2"), "POST", `${B}/stories/skills/k1/restore`, { revisionId: "r2" }, { skill: 52 }, 52],

  ["listConversations", (a) => a.listConversations("stories"), "GET", `${B}/stories/chat`, undefined, { conversations: [53] }, [53]],
  ["createConversation", (a) => a.createConversation("stories", { title: "Ice", model: null, effort: "high" }), "POST", `${B}/stories/chat`, { title: "Ice", model: null, effort: "high" }, { conversation: 54 }, 54],
  ["getConversation", (a) => a.getConversation("stories", "v1", { after: "m9" }), "GET", `${B}/stories/chat/v1?after=m9`, undefined, { conversation: 55, messages: [] }, { conversation: 55, messages: [] }],
  ["patchConversation", (a) => a.patchConversation("stories", "v1", { model: "fable-5-2" }), "PATCH", `${B}/stories/chat/v1`, { model: "fable-5-2" }, { conversation: 56 }, 56],
  ["deleteConversation", (a) => a.deleteConversation("stories", "v1"), "DELETE", `${B}/stories/chat/v1`, undefined, null, undefined],
  ["sendMessage", (a) => a.sendMessage("stories", "v1", { text: "hi", override: { model: "haiku-5-5" } }), "POST", `${B}/stories/chat/v1/messages`, { text: "hi", override: { model: "haiku-5-5" } }, { user: 1, assistant: 2 }, { user: 1, assistant: 2 }],
  ["chatAttachment", (a) => a.chatAttachment("stories", "v1", { filename: "p.png", contentType: "image/png", size: 3 }), "POST", `${B}/stories/chat/v1/attachments`, { filename: "p.png", contentType: "image/png", size: 3 }, { assetId: "p", uploadUrl: "u", headers: {} }, { assetId: "p", uploadUrl: "u", headers: {} }],
  ["stopMessage", (a) => a.stopMessage("stories", "v1", "m2"), "POST", `${B}/stories/chat/v1/messages/m2/stop`, undefined, { message: 57 }, 57],

  ["listMemory", (a) => a.listMemory("stories"), "GET", `${B}/stories/memory`, undefined, { memory: [58] }, [58]],
  ["addMemory", (a) => a.addMemory("stories", "Likes slapstick"), "POST", `${B}/stories/memory`, { text: "Likes slapstick" }, { item: 59 }, 59],
  ["patchMemory", (a) => a.patchMemory("stories", "e1", "Loves it"), "PATCH", `${B}/stories/memory/e1`, { text: "Loves it" }, { item: 60 }, 60],
  ["deleteMemory", (a) => a.deleteMemory("stories", "e1"), "DELETE", `${B}/stories/memory/e1`, undefined, null, undefined],

  ["listReferences", (a) => a.listReferences("stories"), "GET", `${B}/stories/references`, undefined, { references: [61] }, [61]],
  ["createReference", (a) => a.createReference("stories", { filename: "r.mp4", contentType: "video/mp4", size: 5, title: "Ref" }), "POST", `${B}/stories/references`, { filename: "r.mp4", contentType: "video/mp4", size: 5, title: "Ref" }, { reference: 1, upload: 2 }, { reference: 1, upload: 2 }],
  ["completeReference", (a) => a.completeReference("stories", "r1", [{ partNumber: 1, etag: "e" }]), "POST", `${B}/stories/references/r1/complete`, { parts: [{ partNumber: 1, etag: "e" }] }, { reference: 62 }, 62],
  ["analyzeReference", (a) => a.analyzeReference("stories", "r1", { effort: "max" }), "POST", `${B}/stories/references/r1/analyze`, { override: { effort: "max" } }, { reference: 1, job: 2 }, { reference: 1, job: 2 }],
  ["createReferenceFromLink", (a) => a.createReferenceFromLink("stories", { url: "https://www.tiktok.com/@a/video/1", title: "Skid" }), "POST", `${B}/stories/references/link`, { url: "https://www.tiktok.com/@a/video/1", title: "Skid" }, { reference: 1, job: 2 }, { reference: 1, job: 2 }],
  ["fetchReferenceAgain", (a) => a.fetchReferenceAgain("stories", "r1"), "POST", `${B}/stories/references/r1/fetch`, {}, { reference: 1, job: 2 }, { reference: 1, job: 2 }],
  ["getReference", (a) => a.getReference("stories", "r1"), "GET", `${B}/stories/references/r1`, undefined, { reference: 63 }, { reference: 63, analysis: null, job: null }],
  ["patchReference", (a) => a.patchReference("stories", "r1", { title: "New" }), "PATCH", `${B}/stories/references/r1`, { title: "New" }, { reference: 64 }, 64],
  ["deleteReferenceVideo", (a) => a.deleteReferenceVideo("stories", "r1"), "DELETE", `${B}/stories/references/r1`, undefined, null, undefined],

  ["getOnboarding", (a) => a.getOnboarding("stories"), "GET", `${B}/stories/onboarding`, undefined, { onboarding: 65 }, 65],
  ["patchOnboarding", (a) => a.patchOnboarding("stories", { step: "tiktok", skipped: true }), "PATCH", `${B}/stories/onboarding`, { step: "tiktok", skipped: true }, { onboarding: 66 }, 66],
  ["setProviderKey", (a) => a.setProviderKey("stories", "acme", "k-123"), "PUT", `${B}/stories/providers/acme/key`, { key: "k-123" }, { provider: 67 }, 67],
  ["deleteProviderKey", (a) => a.deleteProviderKey("stories", "acme"), "DELETE", `${B}/stories/providers/acme/key`, undefined, null, undefined],
  ["storage", (a) => a.storage("stories"), "GET", `${B}/stories/storage`, undefined, { storage: 68 }, 68],
  ["storageCleanup", (a) => a.storageCleanup("stories"), "POST", `${B}/stories/storage/cleanup`, undefined, { removed: { files: 3, bytes: 900 } }, { removed: { files: 3, bytes: 900 } }],
  ["publish", (a) => a.publish("stories", "s1", [{ platform: "youtube", socialAccountId: "stories.youtube" }]), "POST", `${B}/stories/stories/s1/publish`, { targets: [{ platform: "youtube", socialAccountId: "stories.youtube" }] }, { publishingJobs: [33] }, [33]],
  ["listPublishing", (a) => a.listPublishing("stories", "s1"), "GET", `${B}/stories/publishing?storyId=s1`, undefined, { publishingJobs: [34] }, [34]],
  ["retryPublishing", (a) => a.retryPublishing("stories", "p1", { confirmAccount: "UC1" }), "POST", `${B}/stories/publishing/p1/retry`, { confirmAccount: "UC1" }, { publishingJob: 35 }, 35],
  // My Mac posts TikTok (§47.10): the web's own Mac routes (the helper's ping, claim, step, done and stopped are its own).
  ["macStatus", (a) => a.macStatus("stories"), "GET", `${B}/stories/tiktok/mac`, undefined, { on: true, helper: null, account: null, queue: [] }, { on: true, helper: null, account: null, queue: [] }],
  ["macLogin", (a) => a.macLogin("stories"), "POST", `${B}/stories/tiktok/mac/login`, { action: "sign_in" }, { helper: 36 }, { helper: 36 }],
  ["macResume", (a) => a.macResume("stories"), "POST", `${B}/stories/tiktok/mac/request`, { action: "resume" }, { helper: 39 }, { helper: 39 }],
  ["macRetry", (a) => a.macRetry("stories", "p1", { notOnTikTok: true, confirmAccount: "-000new" }), "POST", `${B}/stories/publishing/p1/mac/retry`, { notOnTikTok: true, confirmAccount: "-000new" }, { job: 37 }, 37],
  ["macPosted", (a) => a.macPosted("stories", "p1", { link: "https://www.tiktok.com/@clips.funded/video/7400000000000000001" }), "POST", `${B}/stories/publishing/p1/mac/posted`, { link: "https://www.tiktok.com/@clips.funded/video/7400000000000000001" }, { job: 38 }, 38],
];

describe("every Lamo Stories route", () => {
  it("covers every method of StoriesApi", () => {
    const { api } = fake();
    expect(CASES.map((c) => c[0]).sort()).toEqual(Object.keys(api).sort());
  });

  it("offers no way to share an account with Clip Factory (§45.37 G8, the owner's hard rule)", () => {
    const { api } = fake();
    expect(Object.keys(api)).not.toContain("shareWithClips");
    expect(Object.keys(api).filter((k) => /share/i.test(k))).toEqual([]);
    expect(CASES.some((c) => c[3].includes("/share"))).toBe(false);
  });

  it("Check models sends the makers' models apart from the AI models, and either alone (§45.37 G2)", async () => {
    const { api, calls } = fake(() => ({ status: 200, body: { task: 1 } }));
    await api.checkModels("stories", undefined, ["stable-image-core", "luma-ray2"]);
    await api.checkModels("stories", ["opus-5-5"], ["polly-neural"]);
    await api.checkModels("stories");
    expect(calls.map((c) => c.body)).toEqual([{ makers: ["stable-image-core", "luma-ray2"] }, { models: ["opus-5-5"], makers: ["polly-neural"] }, {}]);
  });

  for (const [name, run, method, url, body, answer, result] of CASES)
    it(`${name}: ${method} ${url.replace(B, "/v1/workspaces")}`, async () => {
      const { api, calls } = fake(() => (answer === null ? { status: 204 } : { status: 200, body: answer }));
      await expect(run(api)).resolves.toEqual(result);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ method, url, body, auth: "Bearer old-token" });
    });

  it("deleteReference is a character's picture, deleteReferenceVideo a reference video (the rename of §45.34)", async () => {
    const { api, calls } = fake((c) => (c.method === "DELETE" && c.url.endsWith("/references/r1") ? { status: 204 } : { status: 200, body: { character: 17 } }));
    await expect(api.deleteReference("stories", "c1", "a1")).resolves.toBe(17);
    await expect(api.deleteReferenceVideo("stories", "r1")).resolves.toBeUndefined();
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["DELETE", `${B}/stories/characters/c1/references/a1`],
      ["DELETE", `${B}/stories/references/r1`],
    ]);
  });

  it("sends developer-app keys once and never puts them in the address", async () => {
    const { api, calls } = fake(() => ({ status: 200, body: { account: 1 } }));
    await api.setSocialApp("stories", "facebook", { choice: "own", clientId: "1234567890", clientSecret: "s3cr3t-value-0123456789abcdef01", configId: "9876543210" });
    expect(calls[0]!.url).toBe(`${B}/stories/social/facebook/app`);
    expect(calls[0]!.url).not.toMatch(/s3cr3t/);
    expect(calls[0]!.body).toEqual({ choice: "own", clientId: "1234567890", clientSecret: "s3cr3t-value-0123456789abcdef01", configId: "9876543210" });
  });

  it("round 3 (§45.34): Write them again with no body, a redesign by id, an extra copy by name, the page of older messages", async () => {
    const { api, calls } = fake((c) => ({ status: 200, body: c.url.endsWith("/captions") || c.url.endsWith("/design") ? { task: 1 } : c.url.includes("/chat/") ? { conversation: 2, messages: [] } : { url: "u", filename: "f.webm" } }));
    await api.writeCaptions("stories", "s1");
    await api.designCharacter("stories", { description: "a blue cap", characterId: "c1" });
    await expect(api.download("stories", "s1", { format: "webm" })).resolves.toEqual({ url: "u", filename: "f.webm" });
    await api.download("stories", "s1", { format: "mp4" });
    await api.getConversation("stories", "v1", { before: "m1" });
    await api.getConversation("stories", "v1");
    expect(calls.map((c) => [c.method, c.url.replace(B, ""), c.body])).toEqual([
      ["POST", "/stories/stories/s1/captions", {}],
      ["POST", "/stories/characters/design", { description: "a blue cap", characterId: "c1" }],
      ["POST", "/stories/stories/s1/download", { format: "webm" }],
      ["GET", "/stories/stories/s1/download", undefined],
      ["GET", "/stories/chat/v1?before=m1", undefined],
      ["GET", "/stories/chat/v1", undefined],
    ]);
  });

  it("getReference passes a link reference's fetch job through, and leaves it out when an older API sends none (§45.40)", async () => {
    const fetchJob = { jobId: "f1", jobType: "reference_fetch", status: "failed", error: "That video is gone. Check the link." };
    const { api } = fake((c) => ({ status: 200, body: c.url.endsWith("/r1") ? { reference: 1, analysis: null, job: null, fetchJob } : { reference: 2 } }));
    await expect(api.getReference("stories", "r1")).resolves.toEqual({ reference: 1, analysis: null, job: null, fetchJob });
    const older = await api.getReference("stories", "r2");
    expect("fetchJob" in older).toBe(false);
  });

  it("getReference passes the analysis job through, and patchReference sends the video's own setting", async () => {
    const job = { jobId: "j1", status: "failed", error: "Claude Fable 5.2 isn't available right now." };
    const { api, calls } = fake((c) => ({ status: 200, body: c.method === "GET" ? { reference: 1, analysis: null, job } : { reference: 2 } }));
    await expect(api.getReference("stories", "r1")).resolves.toEqual({ reference: 1, analysis: null, job });
    await expect(api.patchReference("stories", "r1", { ai: { model: "sonnet-5-5", effort: null } })).resolves.toBe(2);
    expect(calls[1]).toMatchObject({ method: "PATCH", body: { ai: { model: "sonnet-5-5", effort: null } } });
  });

  it("publish sends confirmAccount only on the target the owner said yes to", async () => {
    const { api, calls } = fake(() => ({ status: 202, body: { publishingJobs: [] } }));
    await api.publish("stories", "s1", [
      { platform: "youtube", socialAccountId: "stories.youtube" },
      { platform: "tiktok", socialAccountId: "stories.tiktok", confirmAccount: "-000open-id" },
    ]);
    expect(calls[0]!.body).toEqual({ targets: [{ platform: "youtube", socialAccountId: "stories.youtube" }, { platform: "tiktok", socialAccountId: "stories.tiktok", confirmAccount: "-000open-id" }] });
  });

  it("escapes ids in the path, so an id can never reach another route", async () => {
    const { api, calls } = fake(() => ({ status: 200, body: { idea: 1 } }));
    await api.patchIdea("stories", "a/../b?x", {});
    expect(calls[0]!.url).toBe(`${B}/stories/ideas/a%2F..%2Fb%3Fx`);
  });
});

describe("sign-in and errors", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries once with a fresh token after a 401", async () => {
    const { api, calls, tokens } = fake((c) => (c.auth === "Bearer old-token" ? { status: 401, body: {} } : { status: 200, body: { dashboard: 1 } }));
    await expect(api.dashboard("stories")).resolves.toBe(1);
    expect(calls.map((c) => c.auth)).toEqual(["Bearer old-token", "Bearer fresh-token"]);
    expect(tokens.accessToken).toHaveBeenLastCalledWith(true);
  });

  it("announces a sign-in that is really gone (401 after the retry)", async () => {
    const gone = vi.fn();
    const off = onSignedOut(gone);
    const { api } = fake(() => ({ status: 401, body: { error: { code: "unauthorized", message: "Your sign-in has ended." } } }));
    await expect(api.listWorkspaces()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(gone).toHaveBeenCalledTimes(1);
    off();
  });

  it("passes the server's own sentence on (the contract's error envelope)", async () => {
    const { api } = fake(() => ({ status: 409, body: { error: { code: "conflict", message: "That is a Clips Funded page. Switch to Clips Funded first." } } }));
    const e = await api.dashboard("clips").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, code: "conflict", message: "That is a Clips Funded page. Switch to Clips Funded first." });
  });

  it("keeps the account a publishing 409 names (error.account, §45.34) on its ApiError; a 409 without one has none", async () => {
    const sentence = "Clips Funded cannot tell if Clips Funded is Lamo Clips' TikTok, because TikTok gives each app its own id. Tap Post to Clips Funded if it is your Clips Funded TikTok.";
    const named = fake(() => ({ status: 409, body: { error: { code: "conflict", message: sentence, account: { externalAccountId: "-000open-id", accountName: "Clips Funded", handle: "@funded.clips" } } } }));
    const e = await named.api.publish("stories", "s1", [{ platform: "tiktok", socialAccountId: "stories.tiktok" }]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toBeInstanceOf(StoriesApiError);
    expect(e).toMatchObject({ status: 409, code: "conflict", message: sentence, account: { externalAccountId: "-000open-id", accountName: "Clips Funded", handle: "@funded.clips" } });
    const plain = fake(() => ({ status: 409, body: { error: { code: "conflict", message: "That post is not stuck.", account: { accountName: "no id" } } } }));
    const p = await plain.api.retryPublishing("stories", "p1").catch((x: unknown) => x);
    expect(p).toBeInstanceOf(ApiError);
    expect(p).not.toBeInstanceOf(StoriesApiError);
    expect(errorAccount({ error: { account: { externalAccountId: "UC1", accountName: 7, handle: "@x" } } })).toEqual({ externalAccountId: "UC1", accountName: null, handle: "@x" });
    expect(errorAccount(null)).toBeNull();
  });

  it("says the app cannot be reached when the network fails", async () => {
    const api = httpStoriesApi({
      baseUrl: "https://api.example",
      auth: { accessToken: async () => "t" },
      fetcher: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    await expect(api.social("stories")).rejects.toMatchObject({ code: "network" });
  });

  it("never sends a body or a token it does not have", async () => {
    const calls: Call[] = [];
    const api = httpStoriesApi({
      baseUrl: "https://api.example",
      auth: { accessToken: async () => null },
      fetcher: (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url: String(url), body: init?.body, auth: (init?.headers as Record<string, string>).authorization ?? null });
        return new Response(JSON.stringify({ providers: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await api.providers("stories");
    expect(calls[0]).toEqual({ method: "GET", url: `${B}/stories/providers`, body: undefined, auth: null });
  });
});
