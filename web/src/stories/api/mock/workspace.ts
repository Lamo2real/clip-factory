// Lamo Stories mock: the workspace part (docs/CONTRACTS.md §45.16.8): the workspace list (Lamo Clips built in, then
// "Lamo Stories", made on first use like the API), its settings with a version check, the providers' states and the
// checked driving-safety guidance (stories/config/guidance.json, the same file the agent and the API bundle). The
// defaults are stories/config/workspace-defaults.json, the one file the API's guard reads too (§45.33).
import defaultsFile from "../../../../../stories/config/workspace-defaults.json";
import guidanceFile from "../../../../../stories/config/guidance.json";
import { ApiError } from "../../../api/errors.ts";
import { RESOLUTIONS, type GuidanceTopic, type ProductionJob, type ProviderStatus, type StoriesApi, type StoriesConfig, type VideoAspect, type Workspace } from "../types.ts";
import { CLIPS_WORKSPACE_ID, delay, DAY, FIRST_STORIES_WORKSPACE_ID, ago, mockId, type MockStore } from "./store.ts";

export const KEYS = ["listWorkspaces", "getWorkspace", "patchWorkspace", "providers", "tryNovaReel", "guidance"] as const;

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
      workspaceName: "Lamo Stories",
      workspaceType: "stories",
      builtin: false,
      configuration: structuredClone(DEFAULT_CONFIG),
      version: 1,
      createdAt: ago(9 * DAY),
      updatedAt: ago(2 * DAY),
    },
  ];
  // The image provider's last real call (the agent writes it after a portrait job, §45.11.6). None yet.
  store.knobs.novaCanvas = store.knobs.novaCanvas ?? null;
}

/** The workspace, or the API's 404 / 409 for an id that is not one or not a Lamo Stories workspace. */
export function storiesWorkspace(store: MockStore, ws: string): Workspace & { configuration: StoriesConfig } {
  const found = store.workspaces.find((w) => w.workspaceId === ws);
  if (!found) throw new ApiError(404, "not_found", "We could not find that workspace.");
  if (found.workspaceType !== "stories") throw new ApiError(409, "conflict", "That is a Lamo Stories page. Switch to Lamo Stories first.");
  return found as Workspace & { configuration: StoriesConfig };
}

const CATEGORIES = ["1", "2", "23", "24", "27"];
const PRIVACY = ["public", "unlisted", "private"];
const IMAGES = ["builtin-rig", "nova-canvas"];
const VIDEO = ["builtin-2d", "nova-reel"];
const QUALITY = ["standard", "high", "best"];
const KEEP_REFERENCES = ["all", "study_only", "days_30", "days_90"];
const KEEP_CHAT_PICTURES = ["all", "days_30", "days_90"];
const EXTRA_FORMATS = ["webm", "mov"];

function checkConfig(c: Partial<StoriesConfig>): void {
  const bad = (field: string, message: string) => new ApiError(400, "bad_request", message, field);
  if (c.defaultDurationSec !== undefined && (!Number.isInteger(c.defaultDurationSec) || c.defaultDurationSec < 15 || c.defaultDurationSec > 90))
    throw bad("defaultDurationSec", "Pick a length from 15 to 90 seconds.");
  if (c.youtubeCategory !== undefined && !CATEGORIES.includes(c.youtubeCategory)) throw bad("youtubeCategory", "Pick one of the YouTube categories in the list.");
  if (c.youtubePrivacy !== undefined && !PRIVACY.includes(c.youtubePrivacy)) throw bad("youtubePrivacy", "Pick who can see the videos on YouTube.");
  if (c.providers?.images !== undefined && !IMAGES.includes(c.providers.images)) throw bad("providers", "Pick how character pictures are made.");
  if (c.providers?.video !== undefined && !VIDEO.includes(c.providers.video)) throw bad("providers", "Pick how videos are made.");
  if (c.providers?.audio !== undefined && c.providers.audio !== "builtin-synth") throw bad("providers", "Pick how sounds are made.");
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

// ---------- "Try it" on Amazon Nova Reel (§45.35 D2) ----------

/** The mock's words for Nova Reel not being ready (the providers row's own line, as the API's NOT_READY). */
export const REEL_NOT_READY =
  "Amazon Nova Reel is not ready yet: its storage place in the USA (N. Virginia) is not switched on. Pick Built-in animation in Settings › Video, or finish its setup.";
/** What the pretend Amazon Bedrock says when the account may not use Nova Reel (knob `reelDenied`). */
export const REEL_DENIED = "Amazon Bedrock said this account has no access to Amazon Nova Reel. Turn it on in the Bedrock console (Model access) in US East (N. Virginia), then tap Try it.";
export const REEL_BUSY = "Amazon Nova Reel is being tried. Wait until it is done.";

type ReelRecord = { state: "on" | "needs_setup"; checkedAt: string; lastError?: string };

/** The newest "Try it" job (store.jobs keeps it, as PJOB# does), finished once its time is up. */
function reelTry(store: MockStore): ProductionJob | null {
  const job = [...store.jobs].reverse().find((j) => j.jobType === "provider_check" && j.contentId === "nova-reel") ?? null;
  if (!job || (job.status !== "queued" && job.status !== "running")) return job;
  const ms = typeof store.knobs.reelTryMs === "number" ? store.knobs.reelTryMs : 2500;
  const started = Date.parse(job.createdAt);
  const step = job.steps[0]!;
  if (Date.now() - started < ms / 3) return job;
  if (Date.now() - started < ms) {
    Object.assign(job, { status: "running", progress: 0.5, updatedAt: new Date().toISOString() });
    Object.assign(step, { status: "running", startedAt: step.startedAt ?? new Date().toISOString() });
    return job;
  }
  // One 6-second test shot into the US bucket: only when the bucket is switched on (knob `reelBucket`), and Bedrock
  // may still refuse it (knob `reelDenied`); the test file is deleted after (nothing lands in the Library).
  const at = new Date().toISOString();
  const problem = store.knobs.reelBucket !== true ? REEL_NOT_READY : store.knobs.reelDenied === true ? REEL_DENIED : null;
  store.knobs.novaReel = problem ? ({ state: "needs_setup", checkedAt: at, lastError: problem } satisfies ReelRecord) : ({ state: "on", checkedAt: at } satisfies ReelRecord);
  Object.assign(step, { status: problem ? "failed" : "done", finishedAt: at, message: problem ?? "Nova Reel made a 6-second test shot." });
  Object.assign(job, { status: problem ? "failed" : "ready", progress: 1, updatedAt: at });
  return job;
}

function providersFor(store: MockStore, config: StoriesConfig): ProviderStatus[] {
  const nova = store.knobs.novaCanvas as { state: "on" | "needs_setup"; checkedAt: string; lastError?: string } | null;
  const novaOn = config.providers.images === "nova-canvas";
  const check = reelTry(store);
  const reel = (store.knobs.novaReel ?? null) as ReelRecord | null;
  const reelPicked = config.providers.video === "nova-reel";
  return [
    { kind: "writer", id: "bedrock-claude", label: "Claude in Amazon Bedrock", state: "on", line: "Writes the stories. It is already set up." },
    { kind: "images", id: "builtin-rig", label: "Built-in characters", state: "on", line: "Draws every character the same way in every video." },
    !novaOn
      ? { kind: "images", id: "nova-canvas", label: "Amazon Nova Canvas", state: "off", line: "Off. Turn on AI pictures to make character portraits." }
      : nova?.state === "on"
        ? { kind: "images", id: "nova-canvas", label: "Amazon Nova Canvas", state: "on", line: "Makes character portraits. It worked last time.", checkedAt: nova.checkedAt }
        : {
            kind: "images",
            id: "nova-canvas",
            label: "Amazon Nova Canvas",
            state: "needs_setup",
            line: "Make one portrait to check it works. If Bedrock says no, turn on Nova Canvas in Europe (Ireland).",
            ...(nova ? { checkedAt: nova.checkedAt, lastError: nova.lastError } : {}),
          },
    { kind: "animation", id: "builtin-2d", label: "Built-in animation", state: "on", line: "Animates every scene. It is built in." },
    {
      kind: "animation",
      id: "nova-reel",
      // The API's label (providers.py), while its sentence names the maker's short name.
      label: "Amazon Nova Reel 1.1 (AI video)",
      // On only after a real call worked (a story's cut-away, or Try it, §45.35 D2).
      state: reelPicked ? (reel?.state === "on" ? "on" : "needs_setup") : "off",
      // The API's own sentence (§45.34): nothing switches to the built-in animation by itself.
      line: reel?.state === "on" ? "Makes 6-second AI shots for scenes with no characters (cut-aways). It worked when you tried it." : (reel?.lastError ?? REEL_NOT_READY),
      ...(reel ? { checkedAt: reel.checkedAt, ...(reel.lastError ? { lastError: reel.lastError } : {}) } : {}),
      // Its newest "Try it" job, so Settings › Video shows how it went (the API's `check`).
      check: check ? structuredClone(check) : null,
    },
    { kind: "audio", id: "builtin-synth", label: "Built-in sounds and music", state: "on", line: "Makes every sound effect, noise and tune. It is built in." },
  ];
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
        checkConfig(patch.configuration);
        const { providers, video, production, ...rest } = patch.configuration;
        const nextVideo = { ...w.configuration.video, ...(video ?? {}) };
        if (!(RESOLUTIONS[nextVideo.aspect as VideoAspect] ?? []).includes(nextVideo.resolution))
          throw new ApiError(400, "bad_request", "That size does not fit that shape. Pick one of its sizes.", "video");
        w.configuration = {
          ...w.configuration,
          ...rest,
          providers: { ...w.configuration.providers, ...(providers ?? {}) },
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
    async tryNovaReel(ws) {
      await delay(200);
      storiesWorkspace(store, ws);
      // One at a time (the API's 409), never behind the not-ready guard: that is how Nova Reel becomes ready.
      const now = reelTry(store);
      if (now && (now.status === "queued" || now.status === "running")) throw new ApiError(409, "conflict", REEL_BUSY);
      const at = new Date().toISOString();
      const job: ProductionJob = {
        jobId: mockId(),
        workspaceId: ws,
        contentType: "provider",
        contentId: "nova-reel",
        jobType: "provider_check",
        status: "queued",
        steps: [{ key: "check", label: "Try it", status: "pending" }],
        progress: 0,
        configuration: { run: ["check"], from: null, sceneIds: null, note: null },
        meta: { writerModel: null, engineVersion: null, seed: null, scriptVersion: null, targetSec: null, actualSec: null, safetyTopicId: null, providers: { animation: "nova-reel" }, models: [] },
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
