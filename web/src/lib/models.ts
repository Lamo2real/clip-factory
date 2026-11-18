// The AI models the owner may pick for clip jobs (docs/DECISIONS.md ADR-42). The list, its order, the names and the
// one plain line under each come from config/models.json (`clipModels`, the one source of truth); the API checks the
// pick against the same list, and the agent turns it into a Bedrock model.
import config from "../../../config/models.json";

export interface ClipModel {
  key: string;
  label: string;
  /** One short line in plain words ("Cheapest, fastest."). */
  line: string;
}

const MODELS = config.models as Record<string, { label: string; line?: string }>;

export const CLIP_MODELS: readonly ClipModel[] = config.clipModels.map((key) => ({
  key,
  label: MODELS[key]?.label ?? key,
  line: MODELS[key]?.line ?? "",
}));

/** The model every job uses until the owner picks one (`agentModel`). */
export const DEFAULT_CLIP_MODEL: string = config.agentModel;

export function isClipModel(value: unknown): value is string {
  return typeof value === "string" && CLIP_MODELS.some((m) => m.key === value);
}

/** The owner's pick, or the default when it is missing or no longer offered (the API reads it the same way). */
export function currentClipModel(value: unknown): string {
  return isClipModel(value) ? value : DEFAULT_CLIP_MODEL;
}

/** "Claude Fable 5.1" for a model key; the key itself for one this app does not know. */
export function clipModelLabel(key: string): string {
  return MODELS[key]?.label ?? key;
}
