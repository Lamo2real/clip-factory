// Lamo Stories mock: the workspace part (docs/CONTRACTS.md §45.16.8): the workspace list (Lamo Clips built in, then
// "Lamo Stories", made on first use like the API), its settings with a version check, the providers' states and the
// checked driving-safety guidance (stories/config/guidance.json, the same file the agent and the API bundle). The
// defaults are stories/config/workspace-defaults.json, the one file the API's guard reads too (§45.33).
import defaultsFile from "../../../../../stories/config/workspace-defaults.json";
import guidanceFile from "../../../../../stories/config/guidance.json";
import { ApiError } from "../../../api/errors.ts";
import type { GuidanceTopic, ProviderStatus, StoriesApi, StoriesConfig, Workspace } from "../types.ts";
import { CLIPS_WORKSPACE_ID, delay, DAY, FIRST_STORIES_WORKSPACE_ID, ago, type MockStore } from "./store.ts";

export const KEYS = ["listWorkspaces", "getWorkspace", "patchWorkspace", "providers", "guidance"] as const;

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
  if (c.production?.scenesAtOnce !== undefined && ![1, 2, 3].includes(c.production.scenesAtOnce)) throw bad("production", "Pick 1, 2 or 3 scenes at a time.");
  if (c.xMonthlyLimitUsd !== undefined && c.xMonthlyLimitUsd !== null && !(c.xMonthlyLimitUsd >= 0)) throw bad("xMonthlyLimitUsd", "Type an amount of 0 or more.");
}

function providersFor(store: MockStore, config: StoriesConfig): ProviderStatus[] {
  const nova = store.knobs.novaCanvas as { state: "on" | "needs_setup"; checkedAt: string; lastError?: string } | null;
  const novaOn = config.providers.images === "nova-canvas";
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
      label: "Amazon Nova Reel",
      state: config.providers.video === "nova-reel" ? "needs_setup" : "off",
      line: "Needs a storage place in the USA (N. Virginia), switched on by the owner. Until then videos use the built-in animation.",
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
        w.configuration = {
          ...w.configuration,
          ...rest,
          providers: { ...w.configuration.providers, ...(providers ?? {}) },
          video: { ...w.configuration.video, ...(video ?? {}) },
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
    async guidance(ws) {
      await delay(120);
      storiesWorkspace(store, ws);
      return guidanceTopics();
    },
  };
}
