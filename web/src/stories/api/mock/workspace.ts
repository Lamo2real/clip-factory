// Lamo Stories mock: the workspace part (docs/CONTRACTS.md §45.16.8): the workspace list (Lamo Clips built in, then
// "Lamo Stories", made on first use like the API), its settings with a version check, the providers' states and the
// checked driving-safety guidance (stories/config/guidance.json, the same file the agent and the API bundle). The
// defaults are stories/config/workspace-defaults.json, the one file the API's guard reads too (§45.33).
// §45.37: the makers of the lead's one set (pictures builtin-rig, stability, own-images and the ended nova-canvas;
// video builtin-2d, luma-ray, own-video and the ended nova-reel; sound builtin-synth, polly (a spoken voice, opt-in),
// elevenlabs and own-sound), each maker's model (providers.imageModel, videoModel, audioModel: a key of the picked
// maker, null for its first model that has not ended) checked on save, a new pick of an ended maker refused with the
// API's sentence, Try it on Luma AI Ray2, and the keyed hosts listed with their key state (never the key).
import defaultsFile from "../../../../../stories/config/workspace-defaults.json";
import guidanceFile from "../../../../../stories/config/guidance.json";
import { ApiError } from "../../../api/errors.ts";
import {
  AMAZON_ENDED_ON,
  IMAGE_MAKERS,
  MAKER_FIELD_OF,
  makerModelsIn,
  RESOLUTIONS,
  SOUND_MAKERS,
  VIDEO_MAKERS,
  type GuidanceTopic,
  type MakerKind,
  type ProductionJob,
  type ProviderStatus,
  type StoriesApi,
  type StoriesConfig,
  type StoriesConfigPatch,
  type VideoAspect,
  type Workspace,
} from "../types.ts";
import { CLIPS_WORKSPACE_ID, delay, DAY, FIRST_STORIES_WORKSPACE_ID, ago, mockId, type MockStore } from "./store.ts";
import { allMakerModels, checkMakerPick, ENDED_MAKER_LABEL, endedSentence, hostHasKey, keyedHostStatus, MAKER_KIND, makerRowModels, usedMakerModel } from "./ai.ts";

export const KEYS = ["listWorkspaces", "getWorkspace", "patchWorkspace", "providers", "makerModels", "tryNovaReel", "tryMaker", "guidance"] as const;

/** StoriesConfig's defaults, from the one file (its "$comment" left out). */
export const DEFAULT_CONFIG: StoriesConfig = (() => {
  const { $comment: _comment, ...rest } = defaultsFile as unknown as StoriesConfig & { $comment?: string };
  return structuredClone(rest);
})();

const CLIPS: Workspace = { workspaceId: CLIPS_WORKSPACE_ID, workspaceName: "Lamo Clips", workspaceType: "clips", builtin: true, configuration: {}, version: 0 };

export function seed(store: MockStore): void {
  store.workspaces = [
    CLIPS,
    {
      workspaceId: FIRST_STORIES_WORKSPACE_ID,
      workspaceName: "Clip Factory Stories",
      workspaceType: "stories",
      builtin: false,
      configuration: structuredClone(DEFAULT_CONFIG),
      version: 1,
      createdAt: ago(9 * DAY),
      updatedAt: ago(2 * DAY),
    },
  ];
  // Test knob: moreStudios (a number, 1 to 8) adds that many more Lamo Stories workspaces after the first, so the
  // switchers show their short list (more than two workspaces).
  const more = typeof store.knobs.moreStudios === "number" ? Math.min(8, Math.max(0, Math.floor(store.knobs.moreStudios))) : 0;
  for (let i = 1; i <= more; i++)
    store.workspaces.push({
      workspaceId: `ws_studio_${i + 1}`,
      workspaceName: `Studio ${i + 1}`,
      workspaceType: "stories",
      builtin: false,
      configuration: structuredClone(DEFAULT_CONFIG),
      version: 1,
      createdAt: ago(DAY),
      updatedAt: ago(DAY),
    });
  // The picture maker's last real call (the agent writes it after a portrait job, §45.11.6). None yet.
  store.knobs.stability = store.knobs.stability ?? null;
}

/** The workspace, or the API's 404 / 409 for an id that is not one or not a Lamo Stories workspace. */
export function storiesWorkspace(store: MockStore, ws: string): Workspace & { configuration: StoriesConfig } {
  const found = store.workspaces.find((w) => w.workspaceId === ws);
  if (!found) throw new ApiError(404, "not_found", "We could not find that workspace.");
  if (found.workspaceType !== "stories") throw new ApiError(409, "conflict", "That is a Clip Factory Stories page. Switch to Clip Factory Stories first.");
  return found as Workspace & { configuration: StoriesConfig };
}

const CATEGORIES = ["1", "2", "23", "24", "27"];
const PRIVACY = ["public", "unlisted", "private"];
const IMAGES: string[] = IMAGE_MAKERS;
const VIDEO: string[] = VIDEO_MAKERS;
const AUDIO: string[] = SOUND_MAKERS;
/** Where the owner's own added models go (§45.37 G2): they need one of their kind before they can be picked. */
const OWN: Record<string, MakerKind> = { "own-images": "image", "own-video": "video", "own-sound": "audio" };
const QUALITY = ["standard", "high", "best"];
const KEEP_REFERENCES = ["all", "study_only", "days_30", "days_90"];
const KEEP_CHAT_PICTURES = ["all", "days_30", "days_90"];
const EXTRA_FORMATS = ["webm", "mov"];

/**
 * The makers after a PATCH (§45.37 G1): merged over the saved ones; a maker that changes without its model in the
 * same PATCH starts from its own first model (null), so another maker's model is never carried over.
 */
export function nextProviders(before: StoriesConfig["providers"], patch: Partial<StoriesConfig["providers"]> | undefined): StoriesConfig["providers"] {
  const next = { ...before, ...(patch ?? {}) };
  for (const kind of ["image", "video", "audio"] as const) {
    const { maker, model } = MAKER_FIELD_OF[kind];
    if (patch && patch[maker] !== undefined && patch[maker] !== before[maker] && !(model in patch)) next[model] = null;
  }
  return next;
}

function checkConfig(store: MockStore, c: StoriesConfigPatch, before: StoriesConfig): void {
  const bad = (field: string, message: string) => new ApiError(400, "bad_request", message, field);
  if (c.defaultDurationSec !== undefined && (!Number.isInteger(c.defaultDurationSec) || c.defaultDurationSec < 15 || c.defaultDurationSec > 90))
    throw bad("defaultDurationSec", "Pick a length from 15 to 90 seconds.");
  if (c.youtubeCategory !== undefined && !CATEGORIES.includes(c.youtubeCategory)) throw bad("youtubeCategory", "Pick one of the YouTube categories in the list.");
  if (c.youtubePrivacy !== undefined && !PRIVACY.includes(c.youtubePrivacy)) throw bad("youtubePrivacy", "Pick who can see the videos on YouTube.");
  if (c.providers?.images !== undefined && !IMAGES.includes(c.providers.images)) throw bad("providers", "Pick how character pictures are made.");
  if (c.providers?.video !== undefined && !VIDEO.includes(c.providers.video)) throw bad("providers", "Pick how videos are made.");
  if (c.providers?.audio !== undefined && !AUDIO.includes(c.providers.audio)) throw bad("providers", "Pick how sounds are made.");
  if (c.providers) {
    const next = nextProviders(before.providers, c.providers);
    for (const kind of ["image", "video", "audio"] as const) {
      const { maker: makerKey, model: modelKey } = MAKER_FIELD_OF[kind];
      const maker = next[makerKey];
      const changed = c.providers[makerKey] !== undefined && maker !== before.providers[makerKey];
      // As the API's makers.clean_providers: a stored pick is not looked at again, only what the body changes.
      if (!changed && !(modelKey in c.providers)) continue;
      // An ended maker stays readable as an older pick, but is never picked again (§45.37).
      if (changed && ENDED_MAKER_LABEL[maker]) throw bad("providers", endedSentence(ENDED_MAKER_LABEL[maker]!));
      // The owner's own maker needs one of his models of that kind first.
      if (changed && OWN[maker] && !allMakerModels(store).some((m) => m.custom && m.kind === OWN[maker]))
        throw bad("providers", `Add your own ${MAKER_KIND[kind].noun} model in Settings › Video first.`);
      // Each maker's model is one of that maker's (§45.37 G1).
      checkMakerPick(store, kind, maker, next[modelKey]);
    }
  }
  if (c.video?.quality !== undefined && !QUALITY.includes(c.video.quality)) throw bad("video", "Pick a picture quality.");
  // The shape and its size (§45.34): the resolution must be one of that shape's; 30 fps is the only rate.
  if (c.video?.aspect !== undefined && !(c.video.aspect in RESOLUTIONS)) throw bad("video", "Pick 9:16, 1:1 or 16:9.");
  if (c.video?.fps !== undefined && c.video.fps !== 30) throw bad("video", "Videos are made at 30 frames a second.");
  if (c.production?.scenesAtOnce !== undefined && ![1, 2, 3].includes(c.production.scenesAtOnce)) throw bad("production", "Pick 1, 2 or 3 scenes at a time.");
  if (c.production?.keepReferences !== undefined && !KEEP_REFERENCES.includes(c.production.keepReferences)) throw bad("production", "Pick how long reference videos are kept.");
  if (c.production?.keepChatPictures !== undefined && !KEEP_CHAT_PICTURES.includes(c.production.keepChatPictures)) throw bad("production", "Pick how long chat pictures are kept.");
  if (c.production?.extraFormats !== undefined) {
    const f = c.production.extraFormats;
    if (!Array.isArray(f) || f.some((x) => !EXTRA_FORMATS.includes(x)) || new Set(f).size !== f.length) throw bad("production", "Pick WebM, MOV or both, each once.");
  }
  if (c.xMonthlyLimitUsd !== undefined && c.xMonthlyLimitUsd !== null && !(c.xMonthlyLimitUsd >= 0)) throw bad("xMonthlyLimitUsd", "Type an amount of 0 or more.");
}

// ---------- "Try it" on Luma AI Ray2 (§45.37; Nova Reel's before Amazon ended it, §45.35 D2) ----------

/** The API's not-ready sentence for Luma AI Ray2, word for word (the lead's ids file). */
export const LUMA_NOT_READY =
  "Luma AI Ray2 is not ready yet: it needs a storage bucket in the United States (Oregon), which is switched off, and Luma AI Ray2 turned on for your account. Pick Built-in animation in Settings › Video, or finish its setup.";
/** What the pretend Amazon Bedrock says when the account may not use Luma AI Ray2 (knob `lumaDenied`). */
export const LUMA_DENIED = "Amazon Bedrock said this account has no access to Luma AI Ray2. Turn it on in the Bedrock console (Model access) in US West (Oregon), then tap Try it.";
export const LUMA_BUSY = "Luma AI Ray2 is being tried. Wait until it is done.";
/** The API's lines for the owner's own video model's Try it (providers.CHECK_BUSY_LINE, routes/core.check_provider). */
export const OWN_VIDEO_BUSY = "Your own video model is being tried. Wait until it is done.";
export const OWN_VIDEO_FIRST = "Add a video model first: tap Add a model in Clip Factory Stories › Settings › Video.";
/** The API's not-ready sentence for the owner's own video model (providers.NOT_READY["own-video"]). */
export const OWN_VIDEO_NOT_READY =
  "Your own video model is not ready yet: it needs a storage bucket in the United States (Oregon), which is switched off, and the model turned on for your account. Pick Built-in animation in Settings › Video, or finish its setup and tap Try it.";
/** Nova Reel's Try it is gone: Amazon ended the model (a call could only fail). */
export const REEL_ENDED = endedSentence({ label: "Amazon Nova Reel", kind: "video" });

type TryRecord = { state: "on" | "needs_setup"; checkedAt: string; lastError?: string };

/** The newest "Try it" job of a maker (store.jobs keeps it, as PJOB# does), finished once its time is up. */
function tryJob(store: MockStore, providerId: string): ProductionJob | null {
  const job = [...store.jobs].reverse().find((j) => j.jobType === "provider_check" && j.contentId === providerId) ?? null;
  if (!job || (job.status !== "queued" && job.status !== "running")) return job;
  const ms = typeof store.knobs.tryMs === "number" ? store.knobs.tryMs : typeof store.knobs.reelTryMs === "number" ? store.knobs.reelTryMs : 2500;
  const started = Date.parse(job.createdAt);
  const step = job.steps[0]!;
  if (Date.now() - started < ms / 3) return job;
  if (Date.now() - started < ms) {
    Object.assign(job, { status: "running", progress: 0.5, updatedAt: new Date().toISOString() });
    Object.assign(step, { status: "running", startedAt: step.startedAt ?? new Date().toISOString() });
    return job;
  }
  // One 5-second test shot into the Oregon bucket: only when the bucket is switched on (knob `lumaBucket`), and
  // Bedrock may still refuse it (knob `lumaDenied`); the test file is deleted after (nothing lands in the Library).
  const at = new Date().toISOString();
  const mine = providerId === "own-video";
  const problem = store.knobs.lumaBucket !== true ? (mine ? OWN_VIDEO_NOT_READY : LUMA_NOT_READY) : store.knobs.lumaDenied === true ? LUMA_DENIED : null;
  const record = problem ? ({ state: "needs_setup", checkedAt: at, lastError: problem } satisfies TryRecord) : ({ state: "on", checkedAt: at } satisfies TryRecord);
  if (mine) store.knobs.ownVideo = record;
  else store.knobs.lumaRay = record;
  Object.assign(step, { status: problem ? "failed" : "done", finishedAt: at, message: problem ?? (mine ? "Your own video model made a test shot." : "Luma AI Ray2 made a 5-second test shot.") });
  Object.assign(job, { status: problem ? "failed" : "ready", progress: 1, updatedAt: at });
  return job;
}

/** A maker that is not picked yet: off, with what it does. */
const off = (kind: ProviderStatus["kind"], id: string, label: string, line: string): ProviderStatus => ({ kind, id, label, state: "off", line });

/** An ended maker's row (§45.37, the API's providers.status): the day it ended and its one-tap replacement. */
function ended(kind: ProviderStatus["kind"], id: "nova-canvas" | "nova-reel", label: string, replacement: string): ProviderStatus {
  return { kind, id, label, state: "ended", line: "Ended by Amazon on 30 Sep 2026.", endedAt: AMAZON_ENDED_ON, replacement };
}

const ROW_KIND: Partial<Record<ProviderStatus["kind"], MakerKind>> = { images: "image", animation: "video", audio: "audio" };
const BUILTIN_MAKERS = ["builtin-rig", "builtin-2d", "builtin-synth"];

/**
 * A maker row as the API's providers.statuses sends it (§45.37 G1, G2): `picked`, the model it uses (`model`, null for
 * a built-in or ended maker) and, on every maker that is not built in, its models with their access checks.
 */
function withModels(store: MockStore, config: StoriesConfig, row: ProviderStatus): ProviderStatus {
  const kind = ROW_KIND[row.kind];
  if (!kind) return row;
  const { maker, model } = MAKER_FIELD_OF[kind];
  const picked = config.providers[maker] === row.id;
  const builtin = BUILTIN_MAKERS.includes(row.id);
  const used = builtin || row.state === "ended" ? null : usedMakerModel(store, { ...config.providers, [maker]: row.id, [model]: picked ? config.providers[model] : null }, kind);
  return { ...row, picked, model: used, ...(builtin ? {} : { models: makerRowModels(store, row.id) }) };
}

/** The owner's own maker of a kind: off until picked; then not ready until its first real work (§45.11.6). */
function own(store: MockStore, config: StoriesConfig, kind: MakerKind, providerKind: ProviderStatus["kind"], id: string, label: string, noun: string): ProviderStatus {
  const models = allMakerModels(store).filter((m) => m.custom && m.kind === kind);
  const { maker, model } = MAKER_FIELD_OF[kind];
  // The owner's own video model has a Try it, like Luma AI Ray2 (the API's providers.CHECKABLE): on only after its test shot.
  const tried = kind === "video" ? ((store.knobs.ownVideo ?? null) as TryRecord | null) : null;
  const check = kind === "video" ? { check: structuredClone(tryJob(store, id)) } : {};
  if (config.providers[maker] !== id) return { ...off(providerKind, id, label, models.length ? `Off. Uses a ${noun} model you added.` : `Add your own ${noun} model first.`), ...check };
  const picked = models.find((m) => m.key === config.providers[model]) ?? models[0];
  if (!picked) return { kind: providerKind, id, label, state: "needs_setup", line: `Add your own ${noun} model first.`, ...check };
  if (picked.hostId !== "bedrock" && !hostHasKey(store, picked.hostId)) return { kind: providerKind, id, label, state: "needs_setup", line: `Paste the key for ${picked.label} under Provider keys first.` };
  if (tried?.state === "on") return { kind: providerKind, id, label, state: "on", line: `It uses ${picked.label}. It worked when you tried it.`, checkedAt: tried.checkedAt, ...check };
  if (kind === "video")
    return { kind: providerKind, id, label, state: "needs_setup", line: tried?.lastError ?? OWN_VIDEO_NOT_READY, ...(tried ? { checkedAt: tried.checkedAt, lastError: tried.lastError } : {}), ...check };
  return { kind: providerKind, id, label, state: "needs_setup", line: `It uses ${picked.label}. It is shown as working after its first real work.` };
}

function providersFor(store: MockStore, config: StoriesConfig): ProviderStatus[] {
  const picture = (store.knobs.stability ?? null) as TryRecord | null;
  const check = tryJob(store, "luma-ray");
  const luma = (store.knobs.lumaRay ?? null) as TryRecord | null;
  const p = config.providers;
  const eleven = keyedHostStatus(store, "elevenlabs");
  const rows: ProviderStatus[] = [
    { kind: "writer", id: "bedrock-claude", label: "Claude on Amazon Bedrock", state: "on", line: "Writes the stories. It is already set up." },
    { kind: "images", id: "builtin-rig", label: "Built-in characters", state: "on", line: "Draws every character the same way in every video." },
    p.images !== "stability"
      ? off("images", "stability", "Stability AI pictures", "Off. AI portraits of your characters, by Stability AI on Amazon Bedrock. Runs in the US (Oregon).")
      : picture?.state === "on"
        ? { kind: "images", id: "stability", label: "Stability AI pictures", state: "on", line: "Makes character portraits. It worked last time.", checkedAt: picture.checkedAt }
        : {
            kind: "images",
            id: "stability",
            label: "Stability AI pictures",
            state: "needs_setup",
            line: "Make one portrait to check it works. If Amazon Bedrock says no, turn on Stability AI's models in US West (Oregon).",
            ...(picture ? { checkedAt: picture.checkedAt, lastError: picture.lastError } : {}),
          },
    own(store, config, "image", "images", "own-images", "Your own picture model", "picture"),
    ended("images", "nova-canvas", "Amazon Nova Canvas (AI pictures)", "stability"),
    { kind: "animation", id: "builtin-2d", label: "Built-in animation", state: "on", line: "Animates every scene. It is built in." },
    {
      kind: "animation",
      id: "luma-ray",
      label: "Luma AI Ray2 (AI video)",
      // On only after a real call worked (a story's cut-away, or Try it).
      state: p.video === "luma-ray" ? (luma?.state === "on" ? "on" : "needs_setup") : "off",
      // The API's own sentence: nothing switches to the built-in animation by itself.
      line: luma?.state === "on" ? "Makes 5-second AI shots for scenes with no characters (cut-aways). It worked when you tried it." : (luma?.lastError ?? LUMA_NOT_READY),
      ...(luma ? { checkedAt: luma.checkedAt, ...(luma.lastError ? { lastError: luma.lastError } : {}) } : {}),
      check: check ? structuredClone(check) : null,
    },
    own(store, config, "video", "animation", "own-video", "Your own video model", "video"),
    ended("animation", "nova-reel", "Amazon Nova Reel 1.1 (AI video)", "luma-ray"),
    { kind: "audio", id: "builtin-synth", label: "Built-in sounds and music", state: "on", line: "Makes every sound effect, noise and tune. It is built in." },
    {
      ...eleven,
      kind: "audio",
      label: "ElevenLabs sound effects and music",
      state: p.audio === "elevenlabs" ? eleven.state : "off",
      line: eleven.key?.saved ? eleven.line : "Sound effects and a music bed with no singing, from ElevenLabs with your own key. Never a voice.",
    },
    own(store, config, "audio", "audio", "own-sound", "Your own sound model", "sound"),
    p.audio === "polly"
      ? { kind: "audio", id: "polly", label: "A spoken voice (Amazon Polly)", state: "needs_setup", line: "Speaks words aloud with Amazon Polly in Europe (Ireland). It is shown as working after it speaks in a video." }
      : off("audio", "polly", "A spoken voice (Amazon Polly)", "Adds words spoken aloud. Your videos are made without a voice unless you pick this."),
    // The keyed hosts an added AI model can run on (§45.37 G4), with their key state; never the key.
    keyedHostStatus(store, "anthropic"),
    keyedHostStatus(store, "openai_compatible"),
  ];
  return rows.map((r) => withModels(store, config, r));
}

interface FileStep {
  id: string;
  text: string;
  shown: boolean;
  why?: string;
}
interface FileTopic {
  id: string;
  title: string;
  steps: FileStep[];
  donts: FileStep[];
  caveats: string[];
  citations: string[];
}
interface FileSource {
  publisher: string;
  title: string;
  url: string;
  section?: string;
}

/** GET …/guidance's shape from the checked guidance file: every step with its `shown` flag, citations resolved. */
export function guidanceTopics(): { topics: GuidanceTopic[]; checkedAt: string } {
  const file = guidanceFile as unknown as { checkedAt: string; sources: Record<string, FileSource>; topics: FileTopic[] };
  const step = (s: FileStep) => ({ id: s.id, text: s.text, shown: s.shown, ...(s.why ? { why: s.why } : {}) });
  return {
    checkedAt: file.checkedAt,
    topics: file.topics.map((t) => ({
      id: t.id,
      title: t.title,
      steps: t.steps.map(step),
      donts: t.donts.map(step),
      caveats: t.caveats,
      citations: t.citations
        .map((c) => file.sources[c])
        .filter((s): s is FileSource => !!s)
        .map((s) => ({ publisher: s.publisher, title: s.title, url: s.url, ...(s.section ? { section: s.section } : {}) })),
    })),
  };
}

const copy = <T>(v: T): T => structuredClone(v);

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  return {
    async listWorkspaces() {
      await delay(120);
      return copy(store.workspaces);
    },
    async getWorkspace(ws) {
      await delay(80);
      const found = store.workspaces.find((w) => w.workspaceId === ws);
      if (!found) throw new ApiError(404, "not_found", "We could not find that workspace.");
      return copy(found);
    },
    async patchWorkspace(ws, patch) {
      await delay(200);
      const w = storiesWorkspace(store, ws);
      if (patch.version !== w.version) throw new ApiError(409, "conflict", "These settings changed somewhere else. We loaded the new ones: check them and save again.");
      if (patch.workspaceName !== undefined) {
        const name = patch.workspaceName.trim();
        if (!name || name.length > 40) throw new ApiError(400, "bad_request", "Give it a name of 1 to 40 letters.", "workspaceName");
        w.workspaceName = name;
      }
      if (patch.configuration) {
        checkConfig(store, patch.configuration, w.configuration);
        const { providers, video, production, ...rest } = patch.configuration;
        const nextVideo = { ...w.configuration.video, ...(video ?? {}) };
        if (!(RESOLUTIONS[nextVideo.aspect as VideoAspect] ?? []).includes(nextVideo.resolution))
          throw new ApiError(400, "bad_request", "That size does not fit that shape. Pick one of its sizes.", "video");
        w.configuration = {
          ...w.configuration,
          ...rest,
          providers: nextProviders(w.configuration.providers, providers),
          video: nextVideo,
          production: { ...w.configuration.production, ...(production ?? {}) },
        };
        // Onboarding step 4 ("Pick how videos are made") comes from real state: the workspace's providersPickedAt,
        // stamped by a PATCH that carries configuration.providers (the API's onboarding rule, §45.33). Knob
        // `providersNotStamped` plays an API whose PATCH does not stamp it yet: keeping the built-in default then
        // never ticks step 4 (only another provider does).
        if (providers && !store.knobs.providersNotStamped) store.onboarding.providersPickedAt = new Date().toISOString();
      }
      w.version += 1;
      w.updatedAt = new Date().toISOString();
      return copy(w);
    },
    async providers(ws) {
      await delay(120);
      return providersFor(store, storiesWorkspace(store, ws).configuration);
    },
    // As the client does it (http.ts): the models of the maker rows of GET …/providers, each once (no route of their own).
    async makerModels(ws) {
      await delay(120);
      return makerModelsIn(providersFor(store, storiesWorkspace(store, ws).configuration));
    },
    async tryNovaReel(ws) {
      await delay(200);
      storiesWorkspace(store, ws);
      // Amazon ended Nova Reel: a test shot could only fail, so the API refuses it (§45.37).
      throw new ApiError(409, "conflict", REEL_ENDED);
    },
    async tryMaker(ws, providerId) {
      await delay(200);
      storiesWorkspace(store, ws);
      if (providerId !== "luma-ray" && providerId !== "own-video") throw new ApiError(404, "not_found", "Only Luma AI Ray2 and your own video model have a Try it.");
      // The owner's own video model needs one first (the API's providers.try_problem).
      if (providerId === "own-video" && !allMakerModels(store).some((m) => m.custom && m.kind === "video")) throw new ApiError(409, "conflict", OWN_VIDEO_FIRST);
      // One at a time (the API's 409), never behind the not-ready guard: that is how the maker becomes ready.
      const now = tryJob(store, providerId);
      if (now && (now.status === "queued" || now.status === "running")) throw new ApiError(409, "conflict", providerId === "own-video" ? OWN_VIDEO_BUSY : LUMA_BUSY);
      const at = new Date().toISOString();
      const job: ProductionJob = {
        jobId: mockId(),
        workspaceId: ws,
        contentType: "provider",
        contentId: providerId,
        jobType: "provider_check",
        status: "queued",
        steps: [{ key: "check", label: "Try it", status: "pending" }],
        progress: 0,
        configuration: { run: ["check"], from: null, sceneIds: null, note: null },
        meta: { writerModel: null, engineVersion: null, seed: null, scriptVersion: null, targetSec: null, actualSec: null, safetyTopicId: null, providers: { animation: providerId }, models: [] },
        createdAt: at,
        updatedAt: at,
      };
      store.jobs.push(job);
      return copy(job);
    },
    async guidance(ws) {
      await delay(120);
      storiesWorkspace(store, ws);
      return guidanceTopics();
    },
  };
}
