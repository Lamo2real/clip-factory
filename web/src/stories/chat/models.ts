// The reasoning models Lamo Stories may use, as the chat and the reference page show them (docs/CONTRACTS.md §45.25,
// §45.27, §45.28). The server's list (GET …/ai: ModelInfo with each model's status) is the one that counts; the names,
// the efforts each model offers and its one plain line also come from stories/config/models.json (Lamo Stories' own
// list, never Clip Factory's config/models.json), so the chat can still name the model while that list loads or when
// it fails (then every status reads "Not checked yet" and the page says the list did not load).
import { useCallback, useEffect, useState } from "react";
import config from "../../../../stories/config/models.json";
import { storiesApi } from "../api/client.ts";
import { EFFORT_LABEL, type Effort, type Effective, type ModelInfo, type ModelOverride, type StoriesAiConfig, type TaskInfo } from "../api/types.ts";

export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** One short line per effort, in plain words. */
export const EFFORT_LINE: Record<Effort, string> = {
  low: "Quick and light.",
  medium: "Balanced.",
  high: "Thinks harder.",
  xhigh: "Thinks a lot. Slower.",
  max: "Thinks the most. The slowest.",
};

export interface ModelView extends ModelInfo {
  /** One plain line about the model, from stories/config/models.json. */
  line: string;
  /** who runs it, e.g. "Amazon Bedrock" (§45.35 D8: ModelInfo.host); `provider` is who makes it */
  host?: string;
}

interface FileModel {
  key: string;
  label: string;
  provider: string;
  /** who runs it (§45.35 D8); a file older than that leaves it out */
  host?: string;
  modelId: string;
  efforts: string[];
  defaultEffort: string | null;
  vision: boolean;
  line?: string;
}

const FILE_MODELS = (config.models as FileModel[]).map((m) => ({
  ...m,
  efforts: m.efforts.filter((e): e is Effort => (EFFORTS as string[]).includes(e)),
  defaultEffort: (EFFORTS as string[]).includes(m.defaultEffort ?? "") ? (m.defaultEffort as Effort) : null,
}));

/** Lamo Stories' own defaults when no AI configuration was saved yet (stories/config/models.json). */
export const FILE_DEFAULT: { model: string; effort: Effort } = {
  model: config.defaultModel,
  effort: (EFFORTS as string[]).includes(config.defaultEffort) ? (config.defaultEffort as Effort) : "high",
};

/** The file's list as ModelViews, every status unknown (used until, or instead of, the server's list). */
export function fileModels(): ModelView[] {
  return FILE_MODELS.map((m) => ({
    key: m.key,
    label: m.label,
    provider: m.provider,
    ...(m.host ? { host: m.host } : {}),
    modelId: m.modelId,
    efforts: [...m.efforts],
    defaultEffort: m.defaultEffort,
    vision: m.vision,
    status: "not_checked",
    statusLine: "",
    checkedAt: null,
    price: null,
    line: m.line ?? "",
  }));
}

/** The server's list with each model's plain line added from the file. */
export function withLines(models: ModelInfo[]): ModelView[] {
  return models.map((m) => ({ ...m, line: FILE_MODELS.find((f) => f.key === m.key)?.line ?? "" }));
}

/** Where every Lamo Stories model runs today (§45.35 D8): a model with no `host` of its own runs there. */
export const DEFAULT_HOST = "Amazon Bedrock";

/**
 * Who makes a model and who runs it, in words (§45.35 D8): "Anthropic on Amazon Bedrock", "Meta on Amazon Bedrock".
 * An older list that names only the host as its provider ("Amazon Bedrock") says just that, never "Amazon Bedrock on
 * Amazon Bedrock"; null when neither is known.
 */
export function providerWords(m: { provider?: string | null; host?: string | null } | null | undefined): string | null {
  if (!m) return null;
  const maker = (m.provider ?? "").trim();
  const host = (m.host ?? "").trim() || DEFAULT_HOST;
  if (!maker) return m.host?.trim() ? host : null;
  return maker === host ? host : `${maker} on ${host}`;
}

export function findModel(models: readonly ModelView[], key: string | null | undefined): ModelView | null {
  return (key && models.find((m) => m.key === key)) || null;
}

/** "Claude Opus 5.5"; an unknown key is shown as it is (the server refuses it with its own sentence). */
export function modelLabel(models: readonly ModelView[], key: string | null | undefined): string {
  if (!key) return "the default model";
  return findModel(models, key)?.label ?? FILE_MODELS.find((m) => m.key === key)?.label ?? key;
}

/** "High", or the model's own level when it has no effort setting. */
export function effortLabel(effort: Effort | null | undefined): string {
  return effort ? EFFORT_LABEL[effort] : "Its own level";
}

export const NO_EFFORT_LINE = "This model has no effort setting; it runs at its own level.";

/** The sentence when a model does not offer an effort (the server refuses it the same way, never swapping it). */
export function effortProblem(model: ModelView | null, effort: Effort | null | undefined): string | null {
  if (!model || !effort) return null;
  if (!model.efforts.length) return null;
  return model.efforts.includes(effort) ? null : `${model.label} does not offer ${EFFORT_LABEL[effort]}. Pick another level.`;
}

export type Tone = "sun" | "coral" | "mint" | "sky";

/**
 * What the last real call to the model said, in two or three words (shown before sending, §45.25), in the one word set
 * Settings and the studio use too (§45.36 E17): Works, Not checked yet, No access, Not found, Problem.
 */
export function statusWords(m: Pick<ModelInfo, "status" | "statusLine"> | null): { tone: Tone; text: string; line: string } {
  if (!m) return { tone: "sky", text: "Not checked yet", line: "" };
  const failed = m.statusLine || "The last try did not work. Pick another model, or try again.";
  switch (m.status) {
    case "ok":
      return { tone: "mint", text: "Works", line: m.statusLine };
    case "not_checked":
      return { tone: "sky", text: "Not checked yet", line: m.statusLine };
    case "denied":
      return { tone: "coral", text: "No access", line: failed };
    case "not_found":
      return { tone: "coral", text: "Not found", line: failed };
    case "error":
      return { tone: "coral", text: "Problem", line: failed };
  }
}

/** What the next request uses with a just-this-once override on top (model and effort are merged separately). */
export function withOverride(effective: Pick<Effective, "model" | "effort">, override: ModelOverride | null): { model: string; effort: Effort | null } {
  return { model: override?.model ?? effective.model, effort: override?.effort ?? effective.effort };
}

/**
 * A project's own setting (a reference video's `ai`, §45.25 level 2) over the task's effective values (levels 3–5,
 * from GET …/ai), then a per-run override on top. Model and effort are merged separately.
 */
export function projectEffective(
  task: Pick<Effective, "model" | "effort"> | null,
  own: { model: string | null; effort: Effort | null } | null,
  override: ModelOverride | null,
): { model: string; effort: Effort | null } {
  const model = override?.model ?? own?.model ?? task?.model ?? FILE_DEFAULT.model;
  const effort = override?.effort ?? own?.effort ?? task?.effort ?? FILE_DEFAULT.effort;
  return { model, effort };
}

// ---------- The server's list, loaded once per page visit and shared by the chat and the reference page ----------

export interface ModelsState {
  models: ModelView[];
  tasks: TaskInfo[] | null;
  ai: StoriesAiConfig | null;
  /** The server's list did not load: the names come from the file and no status is known. */
  problem: string | null;
  loading: boolean;
  reload: () => void;
}

const LIST_FAILED = "The model list did not load, so the checks are not shown.";
const cache = new Map<string, { models: ModelView[]; tasks: TaskInfo[]; ai: StoriesAiConfig }>();

/** Test hook: forget the shared list. */
export function forgetModels(): void {
  cache.clear();
}

export function useModels(ws: string): ModelsState {
  const remembered = cache.get(ws) ?? null;
  const [data, setData] = useState(remembered);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(!remembered);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    storiesApi()
      .getAi(ws)
      .then((r) => {
        if (!live) return;
        const next = { models: withLines(r.models), tasks: r.tasks, ai: r.ai };
        cache.set(ws, next);
        setData(next);
        setProblem(null);
      })
      .catch(() => {
        if (live) setProblem(LIST_FAILED);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [ws, round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { models: data?.models ?? fileModels(), tasks: data?.tasks ?? null, ai: data?.ai ?? null, problem: data ? null : problem, loading, reload };
}
