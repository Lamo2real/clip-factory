// The AI parts the studio screens share (docs/CONTRACTS.md §45.25, §45.7, §45.9): which model and effort a button will
// use, the small "Model and effort for this one" menu (a ModelOverride that is never saved), the same menu for a
// video's own setting (Story.ai, kept with it), the task runner that polls a task every second with a line that names
// the model and the effort, and the list of which model and effort made each step of a video (job.meta.models).
//
// The models come from Lamo Stories' own settings (GET …/ai). When that cannot be read, the names come from Lamo
// Stories' own model list (stories/config/models.json); nothing here ever reads Clip Factory's models.
//
// A model the studio already knows is unusable (its last call said no access, not found or a problem) is never
// pre-picked (§45.36 E12): the menus show it with its status line, the usual choice skips it (and the model shown is the
// one sent), and the chip of one picked on purpose says so. Every exact model id ("Model ID … in {Region}") sits behind
// "Technical details" (§45.36 E8, E14), for production steps, AI tasks and chat answers alike.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/errors.ts";
import { A } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useLoad, usePoll } from "../../lib/hooks.ts";
import modelsFile from "../../../../stories/config/models.json";
import { storiesApi } from "../api/client.ts";
import { EFFORT_LABEL, STEP_ORDER, type AiSetting, type AiTask, type Effective, type Effort, type ModelInfo, type ModelOverride, type ModelUse, type ProductionJob, type StepKey, type Story, type TaskInfo, type TaskKind } from "../api/types.ts";
import { providerWords } from "../chat/models.ts";
import { storiesHref } from "../routes.ts";
import { Busy, Notice, Pick, StSheet, Tag, TechDetails } from "./kit.tsx";
import { say } from "./words.ts";

interface ModelEntry {
  key: string;
  label: string;
  provider: string;
  /** who runs it (§45.35 D8); missing from an older file */
  host?: string;
  modelId: string;
  efforts: string[];
  defaultEffort: string | null;
  vision: boolean;
}

const FILE = modelsFile as unknown as { defaultModel: string; defaultEffort: Effort; models: ModelEntry[] };

/** Lamo Stories' own model list, as the API would show it before any model was checked. */
export const LISTED_MODELS: ModelInfo[] = FILE.models.map((m) => ({
  key: m.key,
  label: m.label,
  provider: m.provider,
  ...(m.host ? { host: m.host } : {}),
  modelId: m.modelId,
  efforts: m.efforts as Effort[],
  defaultEffort: (m.defaultEffort as Effort | null) ?? null,
  vision: m.vision,
  status: "not_checked",
  statusLine: "Not checked yet.",
  checkedAt: null,
  price: null,
}));

export const LISTED_DEFAULT = { model: FILE.defaultModel, effort: FILE.defaultEffort };

/** What each task is called on a button's line. */
export const TASK_WORD: Partial<Record<TaskKind, string>> = {
  brainstorm: "Thinking of ideas",
  expand_idea: "Writing the full idea",
  variations: "Thinking of more like this",
  character_design: "Designing your character",
  storyboard: "Writing the story",
  scene_rewrite: "Writing a new take",
  fact_check: "Checking the facts",
  final_review: "Taking a last look",
  captions: "Writing the captions",
  text_edit: "Changing the words",
  animation_plan: "Planning the animation",
};

/** The agent each task belongs to (CONTRACTS §45.26). */
const TASK_AGENT: Record<TaskKind, TaskInfo["agentId"]> = {
  chat: "creative_director",
  brainstorm: "creative_director",
  expand_idea: "creative_director",
  variations: "creative_director",
  storyboard: "storyboard",
  scene_rewrite: "storyboard",
  captions: "storyboard",
  character_design: "character",
  reference_analysis: "video_analysis",
  fact_check: "quality_assurance",
  final_review: "quality_assurance",
  // §45.37 G5: short chat edits go with the chat; scene planning with the storyboard.
  text_edit: "creative_director",
  animation_plan: "storyboard",
};

/** The steps of a video and the words for them in the "Made with" list. */
const STEP_WORDS: Record<string, string> = {
  storyboard: "Write the story",
  scene_rewrite: "Write a new take",
  safety: "Check the facts",
  fact_check: "Check the facts",
  preview: "Last look",
  final_review: "Last look",
  captions: "Post captions",
  portrait: "Draw the picture",
};

/**
 * A step can make more than one call (the storyboard step writes the story, or a new take of some scenes, and then
 * the post captions), each its own record with its own `task` (§45.35 D5): those calls have their own words.
 */
const TASK_WORDS: Record<string, string> = {
  scene_rewrite: "Write a new take",
  captions: "Post captions",
  // §45.37 G5: the writer's re-staging pass (High), and a short chat edit (Low).
  animation_plan: "Plan the animation",
  text_edit: "Small word changes",
};

/** The words for one model record: its own task's when the step makes more than one call, else its step's. */
export function modelUseWords(u: Pick<ModelUse, "step" | "task">, steps: Record<string, string> = STEP_WORDS): string {
  return (u.task ? TASK_WORDS[u.task] : undefined) ?? steps[u.step] ?? STEP_WORDS[u.step] ?? u.step;
}

/** The re-staging pass comes after the call that wrote the story, and the captions last (the order the agent makes them). */
function taskRank(u: Pick<ModelUse, "task">): number {
  return u.task === "animation_plan" ? 1 : u.task === "captions" ? 2 : 0;
}

const AGENT_WORDS: Record<string, string> = {
  creative_director: "Creative director",
  video_analysis: "Video analysis",
  storyboard: "Storyboard",
  character: "Character",
  quality_assurance: "Quality check",
};

export interface AiInfo {
  models: ModelInfo[];
  tasks: TaskInfo[];
  /** false: Lamo Stories' settings could not be read, so the names come from the bundled list and no status is known */
  live: boolean;
  /** the workspace's default model (AICONFIG.defaultModel), the first choice when the usual one cannot be used */
  defaultModel?: string;
}

function listedTasks(): TaskInfo[] {
  const m = LISTED_MODELS.find((x) => x.key === LISTED_DEFAULT.model);
  const applied = !!m && m.efforts.length > 0;
  return (Object.keys(TASK_AGENT) as TaskKind[]).map((kind) => ({
    kind,
    label: TASK_WORD[kind] ?? kind,
    agentId: TASK_AGENT[kind],
    suggestedEffort: LISTED_DEFAULT.effort,
    effective: { model: LISTED_DEFAULT.model, effort: applied ? LISTED_DEFAULT.effort : null, effortApplied: applied, from: "default" },
  }));
}

export const LISTED_INFO: AiInfo = { models: LISTED_MODELS, tasks: listedTasks(), live: false };

/** Lamo Stories' models and what each task uses now (its own settings), read once per page. */
export function useAiInfo(ws: string): AiInfo {
  const loaded = useLoad(
    async () => {
      const r = await storiesApi().getAi(ws);
      return { models: r.models.length ? r.models : LISTED_MODELS, tasks: r.tasks.length ? r.tasks : listedTasks(), live: true, defaultModel: r.ai?.defaultModel ?? LISTED_DEFAULT.model } satisfies AiInfo;
    },
    ws,
    "st-s-ai",
  );
  return loaded.data ?? LISTED_INFO;
}

export function modelOf(info: AiInfo, key: string | null | undefined): ModelInfo | null {
  if (!key) return null;
  return info.models.find((m) => m.key === key) ?? LISTED_MODELS.find((m) => m.key === key) ?? null;
}

/** A model's name ("Claude Opus 5.5"), or its key when it is not in the list. */
export function modelName(info: AiInfo, key: string | null | undefined): string {
  if (!key) return "the usual model";
  return modelOf(info, key)?.label ?? key;
}

/** The name without "Claude " for a small button. */
export function shortName(label: string): string {
  return label.replace(/^Claude\s+/i, "");
}

export function effortName(effort: Effort | null | undefined): string {
  return effort ? EFFORT_LABEL[effort] : "";
}

/** What a task uses today (the API's own sum of its settings). */
export function usualFor(info: AiInfo, kind: TaskKind): Effective {
  const t = info.tasks.find((x) => x.kind === kind);
  if (t) return t.effective;
  return listedTasks().find((x) => x.kind === kind)!.effective;
}

/**
 * What runs when nothing is picked; `modelKnown`/`effortKnown` false when it is only a guess (settings not read).
 * `modelKept`: the model is one the owner kept on purpose (a video's, a reference's or a chat's own setting), so it is
 * never swapped by itself, even when the studio knows it cannot be used: the run asks first (§45.36 E12).
 */
export type Usual = Effective & { modelKnown?: boolean; effortKnown?: boolean; modelKept?: boolean };

/** A model and effort a call will use, and whether each part is known or only guessed (GET …/ai not read). */
export interface Planned {
  model: string;
  effort: Effort | null;
  effortApplied: boolean;
  changed: boolean;
  /** false: the model is the owner's usual one, which could not be read; the name in `model` is only a guess */
  modelKnown: boolean;
  effortKnown: boolean;
}

// ---------- Models the studio knows cannot be used (§45.36 E12) ----------

/** One set of status words everywhere (§45.36 E17): Settings, the menus and the chat say the same. */
export const MODEL_STATUS_WORD: Record<ModelInfo["status"], string> = {
  ok: "Works",
  not_checked: "Not checked yet",
  denied: "No access",
  not_found: "Not found",
  error: "Problem",
};

const UNUSABLE: readonly ModelInfo["status"][] = ["denied", "not_found", "error"];

/** The model, when Lamo Stories' settings say its last call was refused (no access, not found, a problem); else null. */
export function unusableModel(info: AiInfo, key: string | null | undefined): ModelInfo | null {
  if (!info.live || !key) return null;
  const m = info.models.find((x) => x.key === key);
  return m && UNUSABLE.includes(m.status) ? m : null;
}

/** "Claude Fable 5.1 has no access right now": why a model is skipped, in a few words. */
export function unusableWords(m: Pick<ModelInfo, "label" | "status">): string {
  if (m.status === "not_found") return `${m.label} is not found right now`;
  if (m.status === "error") return `${m.label} had a problem on its last call`;
  return `${m.label} has no access right now`;
}

/** The model to use instead: the workspace's default, else one that works, else one not checked yet (never `not`). */
function fallbackModel(info: AiInfo, not: string): ModelInfo | null {
  const usable = (m: ModelInfo) => m.key !== not && !UNUSABLE.includes(m.status);
  const def = info.defaultModel ? info.models.find((m) => m.key === info.defaultModel) : undefined;
  if (def && usable(def)) return def;
  return info.models.find((m) => usable(m) && m.status === "ok") ?? info.models.find(usable) ?? null;
}

/**
 * The usual, skipping a model the studio knows cannot be used (§45.36 E12): the workspace's default model (else one that
 * works) takes its place, with the same effort when it offers it. `skipped` names the model left out; it is null when
 * nothing was skipped (also when there is nothing better to offer: then the usual shows with its status).
 */
export function usableUsual(info: AiInfo, usual: Usual): Usual & { skipped: string | null } {
  // A model kept on purpose stays (it shows with its status, and the run asks first).
  const bad = usual.modelKept ? null : unusableModel(info, usual.model);
  const next = bad ? fallbackModel(info, usual.model) : null;
  if (!bad || !next) return { ...usual, skipped: null };
  const applied = next.efforts.length > 0;
  const effort = !applied ? null : usual.effort && next.efforts.includes(usual.effort) ? usual.effort : (next.defaultEffort ?? next.efforts[0] ?? null);
  return { model: next.key, effort, effortApplied: applied, from: usual.from, modelKnown: true, effortKnown: true, skipped: usual.model };
}

/**
 * What a run sends as its model and effort: the owner's pick, or, when the usual skipped a model the studio knows
 * cannot be used, the model the menu shows instead (so what the screen says is what runs, §45.36 E12). The effort goes
 * with it only when the owner picked one, or when the usual effort is one that model does not offer.
 */
export function sendPick(info: AiInfo, usual: Usual, pick: ModelOverride | null | undefined): ModelOverride | undefined {
  const own = cleanPick(pick);
  if (own?.model) return own;
  const base = usableUsual(info, usual);
  if (!base.skipped) return own;
  const out: ModelOverride = { model: base.model };
  const m = modelOf(info, base.model);
  if (own?.effort && m?.efforts.includes(own.effort)) out.effort = own.effort;
  else if (!own?.effort && base.effort && base.effort !== usual.effort) out.effort = base.effort;
  return out;
}

/**
 * The question before a run with a model the studio knows cannot be used, picked on purpose (§45.36 E12): picked for
 * this run, or kept with the video (or reference, or chat) when nothing is picked; null: go on. `instead` is the usual
 * without the bad model (the kept one when it works, else the workspace's default, else one that works).
 */
export function unusableAsk(info: AiInfo, usual: Usual, pick: ModelOverride | AiSetting | null | undefined): { bad: ModelInfo; instead: string } | null {
  const bad = unusableModel(info, pick?.model) ?? (!pick?.model && usual.modelKept ? unusableModel(info, usual.model) : null);
  if (!bad) return null;
  const base = usableUsual(info, { ...usual, modelKept: false });
  if (base.model === bad.key || unusableModel(info, base.model)) return null;
  return { bad, instead: base.model };
}

/** "Use {usual} instead" (§45.36 E12): that model for this run only, with the effort picked when it offers it. */
export function insteadPick(info: AiInfo, ask: { instead: string }, pick: ModelOverride | AiSetting | null | undefined): ModelOverride {
  const effort = pick?.effort && modelOf(info, ask.instead)?.efforts.includes(pick.effort) ? pick.effort : undefined;
  return effort ? { model: ask.instead, effort } : { model: ask.instead };
}

/**
 * The task a run's first model step asks for (§45.36 E12): the stand-in for a model that cannot be used is worked out
 * from that task's usual, so a run from the fact check never takes the writer's stand-in. Without `from` the run
 * starts at the video's first out-of-date step.
 */
export function runTask(from: StepKey | null | undefined, opts: { stale?: readonly StepKey[]; sceneIds?: boolean } = {}): TaskKind {
  const at = from ?? STEP_ORDER.find((k) => opts.stale?.includes(k)) ?? "storyboard";
  const i = STEP_ORDER.indexOf(at);
  if (i <= STEP_ORDER.indexOf("storyboard")) return opts.sceneIds ? "scene_rewrite" : "storyboard";
  if (i <= STEP_ORDER.indexOf("safety")) return "fact_check";
  return "final_review";
}

/** "Claude Fable 5.1 has no access right now. Use Claude Opus 5.5 instead?" with Use … and Try … anyway (§45.36 E12). */
export function UnusableSheet({ info, ask, onUse, onKeep, onClose }: { info: AiInfo; ask: { bad: ModelInfo; instead: string }; onUse: () => void; onKeep: () => void; onClose: () => void }) {
  const instead = modelName(info, ask.instead);
  return (
    <StSheet
      title={`${unusableWords(ask.bad)}. Use ${instead} instead?`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="st-btn" onClick={onKeep}>
            Try {ask.bad.label} anyway
          </button>
          <button type="button" className="st-btn st-btn--main" onClick={onUse}>
            Use {instead}
          </button>
        </>
      }
    >
      <p>{ask.bad.statusLine || `${ask.bad.label} said no on its last call.`}</p>
      <p className="st-s-field__hint">Clips Funded never swaps in another model by itself. You choose.</p>
    </StSheet>
  );
}

/** A model and effort put together over the usual: the chosen parts win, the rest stays as usual (merged apart). */
export function merged(info: AiInfo, usualIn: Usual, pick: ModelOverride | AiSetting | null | undefined): Planned {
  // The usual never names a model the studio knows cannot be used (§45.36 E12).
  const usual = usableUsual(info, usualIn);
  const model = pick?.model || usual.model;
  const m = modelOf(info, model);
  const offers = m ? m.efforts : [];
  const applied = m ? offers.length > 0 : usual.effortApplied;
  const effort = applied ? (pick?.effort ?? usual.effort ?? m?.defaultEffort ?? null) : null;
  const modelKnown = info.live || !!pick?.model || !!usual.modelKnown;
  const effortKnown = info.live || !!pick?.effort || !!usual.effortKnown || (modelKnown && !applied);
  return { model, effort, effortApplied: applied, changed: !!(pick?.model || pick?.effort), modelKnown, effortKnown };
}

/** The line for a call not answered yet: the names when they are known, "your usual …" when they could not be read. */
export function plannedLine(info: AiInfo, p: Pick<Planned, "model" | "effort" | "effortApplied"> & Partial<Pick<Planned, "modelKnown" | "effortKnown">>): string {
  const modelKnown = p.modelKnown ?? true;
  const effortKnown = p.effortKnown ?? true;
  if (modelKnown && effortKnown) return modelLine(info, p.model, p.effort, p.effortApplied);
  if (!modelKnown) return effortKnown && p.effort ? `your usual model · ${EFFORT_LABEL[p.effort]} effort` : "your usual model and effort";
  return `${modelName(info, p.model)} · your usual effort`;
}

/** "Claude Opus 5.5 · High effort" (or "… · its own effort level" when the model has no effort setting). */
export function modelLine(info: AiInfo, model: string | null, effort: Effort | null, effortApplied: boolean | null): string {
  const name = modelName(info, model);
  if (effortApplied === false) return `${name} · its own effort level`;
  return effort ? `${name} · ${EFFORT_LABEL[effort]} effort` : name;
}

/** A pick that names something only when the owner chose it (an empty pick is "the usual"). */
export function cleanPick(p: ModelOverride | null | undefined): ModelOverride | undefined {
  if (!p) return undefined;
  const out: ModelOverride = {};
  if (p.model) out.model = p.model;
  if (p.effort) out.effort = p.effort;
  return out.model || out.effort ? out : undefined;
}

const USUAL = "usual";

/** Every effort level any listed model offers (offered when the usual model is not known). */
const ALL_EFFORTS: Effort[] = (["low", "medium", "high", "xhigh", "max"] as Effort[]).filter((e) => LISTED_MODELS.some((m) => m.efforts.includes(e)));

/**
 * The small menu next to an AI button: which model and effort to use for this one tap (never saved), or, with
 * `keep`, for one video (its own setting, kept with it). The button itself always says what will run.
 */
export function ModelMenu({
  info,
  usual: usualIn,
  value,
  onChange,
  title = "Model and effort for this one",
  note = "Just for this one. Your settings stay the same.",
  usualWords = "From your Clips Funded settings",
  className = "",
  compact = false,
}: {
  info: AiInfo;
  /** what runs when nothing is picked here */
  usual: Usual;
  value: ModelOverride | AiSetting | null;
  onChange: (v: ModelOverride | null) => void;
  title?: string;
  note?: string;
  usualWords?: string;
  className?: string;
  /** only the icon until something is picked (beside a button on a small card) */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<string>(value?.model || USUAL);
  const [effort, setEffort] = useState<string>(value?.effort || USUAL);
  // The usual skips a model the studio knows cannot be used (§45.36 E12); `usualIn` is what the settings say.
  const usual = usableUsual(info, usualIn);
  const skipped = usual.skipped ? modelOf(info, usual.skipped) : null;
  const now = merged(info, usualIn, value);
  // The model that will run, when the studio knows it cannot be used (picked on purpose, or nothing better to offer).
  const nowBad = now.modelKnown ? unusableModel(info, now.model) : null;

  function show() {
    setModel(value?.model || USUAL);
    setEffort(value?.effort || USUAL);
    setOpen(true);
  }

  // Before Lamo Stories' settings are read, the usual model and effort are not known: nothing here names a guess.
  const usualModelKnown = info.live || !!usual.modelKnown;
  const usualEffortKnown = info.live || !!usual.effortKnown;
  const chosen = model === USUAL ? (usualModelKnown ? modelOf(info, usual.model) : null) : modelOf(info, model);
  const efforts = chosen ? chosen.efforts : model === USUAL && !usualModelKnown ? ALL_EFFORTS : [];
  const usualEffort = usualEffortKnown ? (usual.effort ?? chosen?.defaultEffort ?? null) : null;
  const usualMissing = effort === USUAL && !!usualEffort && !!chosen && efforts.length > 0 && !efforts.includes(usualEffort);
  const pickedMissing = effort !== USUAL && !efforts.includes(effort as Effort);
  const status = chosen && chosen.status !== "ok" && chosen.status !== "not_checked" ? chosen.statusLine : null;

  function done() {
    const out: ModelOverride = {};
    if (model !== USUAL) out.model = model;
    if (effort !== USUAL && efforts.includes(effort as Effort)) out.effort = effort as Effort;
    onChange(out.model || out.effort ? out : null);
    setOpen(false);
  }

  const words = now.modelKnown
    ? `${shortName(modelName(info, now.model))}${now.effortKnown && now.effortApplied && now.effort ? ` · ${EFFORT_LABEL[now.effort]}` : ""}`
    : `Usual${now.effortKnown && now.effort ? ` · ${EFFORT_LABEL[now.effort]}` : ""}`;
  return (
    <>
      <button
        type="button"
        className={`st-btn st-s-ai-btn${now.changed ? " is-set" : ""}${nowBad ? " is-bad" : ""}${compact && !nowBad ? " is-compact" : ""}${className ? ` ${className}` : ""}`}
        aria-haspopup="dialog"
        aria-label={`${title}: ${spoken(info, now)}${nowBad ? `, ${MODEL_STATUS_WORD[nowBad.status].toLowerCase()}` : ""}${now.changed ? (note.startsWith("Kept") ? ", kept with this video" : ", just this one") : ""}`}
        title={nowBad ? nowBad.statusLine || undefined : undefined}
        onClick={show}
      >
        <Icon name="sliders" size={18} aria-hidden="true" />
        {!compact || now.changed || nowBad ? <span className="st-s-ai-btn__words">{words}</span> : null}
        {nowBad ? <span className="st-s-ai-btn__status">{MODEL_STATUS_WORD[nowBad.status]}</span> : null}
        {now.changed ? <span className="st-s-ai-btn__set">{note.startsWith("Kept") ? "Kept" : "Just this one"}</span> : null}
      </button>
      {open ? (
        <StSheet
          title={title}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button
                type="button"
                className="st-btn"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                Use the usual
              </button>
              <button type="button" className="st-btn st-btn--main" aria-disabled={usualMissing || pickedMissing || undefined} onClick={() => !(usualMissing || pickedMissing) && done()}>
                Done
              </button>
            </>
          }
        >
          <p className="st-s-field__hint">{note}</p>
          <Pick
            label="Model"
            big
            value={model}
            onChange={(v) => {
              setModel(v);
              const m = v === USUAL ? (usualModelKnown ? modelOf(info, usual.model) : null) : modelOf(info, v);
              if (effort !== USUAL && m && !m.efforts.includes(effort as Effort)) setEffort(USUAL);
            }}
            options={[
              usualModelKnown
                ? {
                    value: USUAL,
                    label: `Usual: ${modelName(info, usual.model)}`,
                    line: skipped ? `${unusableWords(skipped)}, so the usual is this one.` : usual.from === "project" && usual.modelKnown ? "Kept with this video" : usualWords,
                  }
                : { value: USUAL, label: "Your usual model", line: "Your Clips Funded settings could not be read just now, so its name is not shown." },
              ...info.models.map((m) => ({ value: m.key, label: m.label, line: modelStatusWords(m, info.live) })),
            ]}
            className="st-s-ai-models"
          />
          {status ? <Notice tone="bad">{status} You can still try it: Clips Funded never swaps in another model.</Notice> : null}
          {chosen && efforts.length === 0 ? (
            <p className="st-s-field__hint">This model has no effort setting; it runs at its own level.</p>
          ) : (
            <Pick
              label="Effort"
              value={effort}
              onChange={setEffort}
              options={[{ value: USUAL, label: usualEffort ? `Usual (${EFFORT_LABEL[usualEffort]})` : usualEffortKnown ? "Usual" : "Your usual effort" }, ...efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] }))]}
              className="st-s-ai-efforts"
            />
          )}
          {usualMissing && chosen && usualEffort ? <Notice tone="bad">{`${chosen.label} does not offer ${EFFORT_LABEL[usualEffort]}. Pick another level.`}</Notice> : null}
          {/* Only for a model with effort levels: one with no effort setting has nothing to make longer (§45.36 E17). */}
          {chosen && efforts.length === 0 ? null : <p className="st-s-field__hint">More effort thinks longer and costs more. Less is quicker.</p>}
        </StSheet>
      ) : null}
    </>
  );
}

/** What the menu's button says to a screen reader: "Claude Opus 5.5, High effort". */
function spoken(info: AiInfo, p: Planned): string {
  if (!p.modelKnown) return p.effortKnown && p.effort ? `your usual model, ${EFFORT_LABEL[p.effort]} effort` : "your usual model and effort";
  const name = modelName(info, p.model);
  if (!p.effortApplied) return `${name}, its own effort level`;
  if (!p.effortKnown) return `${name}, your usual effort`;
  return p.effort ? `${name}, ${EFFORT_LABEL[p.effort]} effort` : name;
}

/** A model's line in the menu: who makes it, then its status in the one word set, and for one that said no, why. */
export function modelStatusWords(m: ModelInfo, live: boolean): string {
  const who = providerWords(m);
  const by = who ? `${who}. ` : "";
  if (!live) return `${by}Not checked yet.`;
  if (m.status === "ok") return `${by}Works.`;
  if (m.status === "not_checked") return `${by}Not checked yet.`;
  return `${by}${MODEL_STATUS_WORD[m.status]}: ${m.statusLine || "The last try did not work."}`;
}

export type TaskPhase = "idle" | "working" | "done" | "failed";

/** How many reads of a task in a row may fail (a flaky connection) before the line says it stopped. */
const MAX_MISSES = 4;

/** A read that will keep failing the same way (the task is gone, not this workspace's, the request is wrong). */
function lasting(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

/**
 * Runs one AI task: starts it, then reads it every second while it is queued or running, and calls `onDone` with
 * the finished task. A read that keeps failing ends it as failed, with its sentence and Try again.
 *
 * `again` is how Try again asks: it builds the request anew from what the screen holds now (the model and effort
 * picked since, the words typed), so a model swapped in after a refusal is the one sent. Without it, Try again
 * repeats the last request as it was.
 */
export function useAiTask(ws: string, onDone: (task: AiTask) => void, again?: () => void) {
  const [task, setTask] = useState<AiTask | null>(null);
  const [phase, setPhase] = useState<TaskPhase>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const last = useRef<(() => Promise<AiTask>) | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const againRef = useRef(again);
  againRef.current = again;
  const misses = useRef(0);
  // Set at once when a task starts and until it ends: a double tap (or Enter twice) in the same moment starts one task.
  const working = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const settle = useCallback((t: AiTask) => {
    if (!live.current) return;
    setTask(t);
    if (t.status === "done") {
      working.current = false;
      setPhase("done");
      doneRef.current(t);
    } else if (t.status === "failed") {
      working.current = false;
      setPhase("failed");
      setProblem(t.error || "The helper stopped. Tap Try again.");
    }
  }, []);

  const start = useCallback(
    async (begin: () => Promise<AiTask>) => {
      if (working.current) return;
      working.current = true;
      last.current = begin;
      misses.current = 0;
      setProblem(null);
      setTask(null);
      setPhase("working");
      setStarted(Date.now());
      try {
        settle(await begin());
      } catch (e) {
        working.current = false;
        if (!live.current) return;
        setPhase("failed");
        setProblem(say(e, "The helper is busy. Try again in a minute."));
      }
    },
    [settle],
  );

  usePoll(
    async () => {
      setTick((n) => n + 1);
      if (!task) return;
      let next: AiTask;
      try {
        next = await storiesApi().getTask(ws, task.taskId);
      } catch (e) {
        if (!live.current) return;
        misses.current += 1;
        if (lasting(e) || misses.current >= MAX_MISSES) {
          working.current = false;
          setPhase("failed");
          setProblem(say(e, "We lost touch with the helper. Tap Try again."));
          return;
        }
        throw e; // a passing hiccup: the poll waits a little longer, then reads again
      }
      misses.current = 0;
      settle(next);
    },
    phase === "working" && !!task,
    1000,
  );

  const retry = useCallback(() => {
    if (againRef.current) againRef.current();
    else if (last.current) void start(last.current);
  }, [start]);

  const reset = useCallback(() => {
    working.current = false;
    setPhase("idle");
    setTask(null);
    setProblem(null);
  }, []);

  const seconds = started === null ? 0 : Math.max(0, Math.floor((Date.now() - started) / 1000));
  return { task, phase, problem, seconds, start, retry, reset };
}

/** What a task is doing now, in one line that names the model and the effort; or its plain failure with Try again. */
export function TaskLine({
  info,
  kind,
  run,
  expected,
}: {
  info: AiInfo;
  kind: TaskKind;
  run: ReturnType<typeof useAiTask>;
  /** what the request asked for (the usual merged with the menu), shown until the task itself says */
  expected: Pick<Planned, "model" | "effort" | "effortApplied"> & Partial<Pick<Planned, "modelKnown" | "effortKnown">>;
}) {
  if (run.phase === "working") {
    const t = run.task;
    const what = TASK_WORD[kind] ?? "Working";
    const line = t?.model ? modelLine(info, t.model, t.effort, t.effortApplied) : plannedLine(info, expected);
    return (
      <Busy>
        <span>
          {t?.status === "queued" ? `Getting ${line} ready…` : `${what} with ${line}…`}{" "}
          {/* One ch a digit and the " s": the "s" stays put as the seconds tick (Fraunces has no tabular figures). */}
          <span className="st-s-ai-secs" style={{ minWidth: `calc(${String(run.seconds).length}ch + 0.75em)` }}>
            {run.seconds} s
          </span>
          <span className="st-s-sr">. This usually takes 10 to 60 seconds.</span>
        </span>
      </Busy>
    );
  }
  if (run.phase === "failed" && run.problem) {
    return (
      <>
        <Notice
          tone="bad"
          action={
            <span className="st-s-ai-fix">
              <button type="button" className="st-btn st-btn--main" onClick={run.retry}>
                Try again
              </button>
              <SettingsFix sentence={run.problem} />
            </span>
          }
        >
          {run.problem}
        </Notice>
        {/* The model it stopped on, with its exact id behind the fold (§45.36 E8): the fact behind a no access or a Region. */}
        <TaskMade info={info} task={run.task} />
      </>
    );
  }
  if (run.phase === "done") return <TaskMade info={info} task={run.task} />;
  return null;
}

/**
 * What made a finished AI task (an idea, a full idea, captions, a character), or what a failed one was tried with: its
 * model and effort in words, and the exact model id and Region behind "Technical details", the same line production
 * steps have (§45.36 E8; the agent records them for a failed call too).
 */
export function TaskMade({ info, task }: { info: AiInfo; task: Pick<AiTask, "status" | "model" | "effort" | "effortApplied" | "modelId" | "region"> | null }) {
  if (!task || (task.status !== "done" && task.status !== "failed") || !task.model) return null;
  const id = modelIdLine(task);
  const word = task.status === "done" ? "Made with" : "Tried with";
  return (
    <div className={`st-s-taskmade${task.status === "failed" ? " st-s-taskmade--failed" : ""}`}>
      <p className="st-s-taskmade__line">
        {word} {modelLine(info, task.model, task.effort, task.effortApplied)}
      </p>
      {id ? (
        <TechDetails className="st-s-taskmade__tech">
          <p className="st-s-used__id">{id}</p>
        </TechDetails>
      ) : null}
    </div>
  );
}

type IdRecord = Pick<ModelUse, "step" | "task" | "modelId" | "region">;

/** The exact model ids of a list of records, one line each ("Write the story: Model ID … in eu-north-1"); null for none. */
export function ModelIdList({ used, steps }: { used: IdRecord[]; steps?: Record<string, string> }) {
  const lines = used.map((u) => ({ u, id: modelIdLine(u) })).filter((x): x is { u: IdRecord; id: string } => !!x.id);
  if (!lines.length) return null;
  return (
    <ul className="st-s-used__ids">
      {lines.map(({ u, id }, i) => (
        <li key={`${u.step}:${u.task ?? ""}:${i}`}>
          <span className="st-s-used__idstep">{modelUseWords(u, steps)}:</span> <span className="st-s-used__id">{id}</span>
        </li>
      ))}
    </ul>
  );
}

/** The same list folded away under "Technical details" (§45.36 E14); nothing when no record says its id. */
export function ModelIds({ used, steps }: { used: IdRecord[]; steps?: Record<string, string> }) {
  if (!used.some((u) => modelIdLine(u))) return null;
  return (
    <TechDetails className="st-s-used__tech">
      <ModelIdList used={used} steps={steps} />
    </TechDetails>
  );
}

/** The records ModelsUsed lists: while a run works, that run's; else every step of the video as it is now. */
export function usedOf(job: ProductionJob | null, jobs?: ProductionJob[] | null): ModelUse[] {
  const working = !!job && (job.status === "queued" || job.status === "running");
  return working || !jobs ? (job?.meta.models ?? []) : madeWith([job, ...jobs]);
}

/** The Lamo Stories setting a stop sentence sends the owner to (§45.25: "… in Lamo Stories › Settings › AI"). */
export function settingsFor(sentence: string | null | undefined): "ai" | "agents" | "video" | null {
  if (!sentence) return null;
  if (/Settings\s*›\s*Agents/i.test(sentence)) return "agents";
  if (/Settings\s*›\s*AI\b/i.test(sentence)) return "ai";
  if (/Settings\s*›\s*Video\b/i.test(sentence)) return "video";
  return null;
}

const FIX_WORDS: Record<"ai" | "agents" | "video", string> = { ai: "Open Settings › AI", agents: "Open Settings › Agents", video: "Open Settings › Video" };

/** The button that opens the setting a stop sentence names (nothing when it names none). */
export function SettingsFix({ sentence }: { sentence: string | null | undefined }) {
  const section = settingsFor(sentence);
  if (!section) return null;
  return (
    <A href={storiesHref({ name: "settings", section })} className="st-btn">
      {FIX_WORDS[section]}
    </A>
  );
}

/**
 * The exact model a step called (§45.35 D5): "Model ID global.anthropic.claude-opus-5-5 in eu-north-1", from the job's
 * own record; null for a record that does not say (an older run), so nothing is guessed from today's settings.
 */
export function modelIdLine(u: { modelId?: string | null; region?: string | null }): string | null {
  const id = typeof u.modelId === "string" ? u.modelId.trim() : "";
  if (!id) return null;
  const region = typeof u.region === "string" ? u.region.trim() : "";
  return `Model ID ${id}${region ? ` in ${region}` : ""}`;
}

/**
 * Whether this step stopped on its model (§45.34 "A failed model call still shows what was asked"): the record says
 * `failed`, or (an API that leaves that key out) an effort that was asked but not applied on a step that failed in
 * that run. Its model and effort are what the step was asked with; no answer came.
 */
export function stoppedOn(job: Pick<ProductionJob, "steps">, m: ModelUse): boolean {
  if (m.failed === true) return true;
  return !m.effortApplied && !!m.effort && job.steps.some((s) => s.key === m.step && s.status === "failed");
}

/**
 * Which model and effort made each step of the video as it is now: for each step, the newest run that finished it
 * (a later run of only some steps keeps the earlier runs' writer and checks), in the order of the steps. A step that
 * made more than one call keeps each of that run's calls once (the story and its post captions, §45.35 D5).
 */
export function madeWith(list: (ProductionJob | null | undefined)[]): ModelUse[] {
  const ids = new Set<string>();
  const jobs: ProductionJob[] = [];
  for (const j of list) {
    if (!j || ids.has(j.jobId)) continue;
    ids.add(j.jobId);
    jobs.push(j);
  }
  jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const from = new Map<string, string>(); // step -> the run that made it
  const out: ModelUse[] = [];
  for (const j of jobs)
    for (const u of j.meta.models) {
      const made = from.get(u.step);
      if (made !== undefined && made !== j.jobId) continue;
      if (made === undefined) {
        const step = j.steps.find((s) => s.key === u.step);
        if (step && step.status !== "done") continue; // it did not finish in that run, so an older run's is in the video
        from.set(u.step, j.jobId);
      }
      if (out.some((o) => o.step === u.step && (o.task ?? null) === (u.task ?? null))) continue;
      out.push(u);
    }
  const rank = (step: string) => {
    const i = (STEP_ORDER as readonly string[]).indexOf(step);
    return i < 0 ? STEP_ORDER.length : i;
  };
  return out.sort((a, b) => rank(a.step) - rank(b.step) || taskRank(a) - taskRank(b));
}

/**
 * Which model and effort made each step of a video, from the jobs' own records (CONTRACTS §45.25 "Recorded"): while
 * a run works, that run's; else, with `jobs`, every step of the video as it is now (see madeWith).
 */
export function ModelsUsed({
  info,
  job,
  jobs,
  title = "Made with",
  ids = true,
}: {
  info: AiInfo;
  job: ProductionJob | null;
  jobs?: ProductionJob[] | null;
  title?: string;
  /** false: the page shows the exact model ids in its own Technical details (ModelIdList) */
  ids?: boolean;
}) {
  const working = !!job && (job.status === "queued" || job.status === "running");
  const own = working || !jobs;
  const used = usedOf(job, jobs);
  if (!used.length) return null;
  // madeWith keeps only finished steps; a stopped one is told apart only in a run's own list.
  const stopped = (u: ModelUse) => stoppedOn(own && job ? job : { steps: [] }, u);
  return (
    <div className="st-s-used">
      <h3 className="st-s-details__title">{title}</h3>
      <ul className="st-s-used__list">
        {used.map((u, i) => (
          <li key={`${u.step}:${i}`} className="st-s-used__item">
            <div className="st-s-used__row">
              <span className="st-s-used__step">{modelUseWords(u)}</span>
              <span className="st-s-used__model">{stopped(u) ? modelLine(info, u.model, u.effort, null) : modelLine(info, u.model, u.effort, u.effortApplied)}</span>
              <Tag>{AGENT_WORDS[u.agentId] ?? u.agentId}</Tag>
              {stopped(u) ? <span className="st-s-used__note">This step stopped on this model. This is what it was asked with.</span> : !u.effortApplied ? <span className="st-s-used__note">This model has no effort setting; it ran at its own level.</span> : null}
            </div>
          </li>
        ))}
      </ul>
      {ids ? <ModelIds used={used} /> : null}
    </div>
  );
}

/** What the next run of this video uses when nothing else is picked: its own setting over the task's usual (the writer's). */
export function storyUsual(info: AiInfo, story: Pick<Story, "ai">, kind: TaskKind = "storyboard"): Usual {
  const base = usualFor(info, kind);
  if (!story.ai.model && !story.ai.effort) return base;
  const model = story.ai.model ?? base.model;
  const m = modelOf(info, model);
  const applied = m ? m.efforts.length > 0 : base.effortApplied;
  return { model, effort: applied ? (story.ai.effort ?? base.effort) : null, effortApplied: applied, from: "project", modelKnown: !!story.ai.model, effortKnown: !!story.ai.effort, modelKept: !!story.ai.model };
}

/**
 * What the next run of this video uses (CONTRACTS §45.34 Story.effective, the API's own sum of §45.25's levels); before
 * the API sends it, the same sum from Lamo Stories' settings. "Next run: Claude Opus 5.5 · High".
 */
export function nextRunLine(info: AiInfo, story: Pick<Story, "ai" | "effective">): string {
  // A model the studio knows cannot be used is skipped, as the remake menu does (§45.36 E12): the line names what runs.
  const e = story.effective ? usableUsual(info, { ...story.effective, modelKept: !!story.ai.model }) : null;
  if (e) return `Next run: ${modelName(info, e.model)} · ${e.effortApplied === false || !e.effort ? "its own effort level" : EFFORT_LABEL[e.effort]}`;
  const p = merged(info, storyUsual(info, story), null);
  if (!p.modelKnown) return "Next run: your usual model and effort";
  if (!p.effortApplied) return `Next run: ${modelName(info, p.model)} · its own effort level`;
  return `Next run: ${modelName(info, p.model)} · ${p.effortKnown && p.effort ? EFFORT_LABEL[p.effort] : "your usual effort"}`;
}

/** The "Next run: …" line of Review and Production (§45.34). */
export function NextRun({ info, story }: { info: AiInfo; story: Pick<Story, "ai" | "effective"> }) {
  return <p className="st-s-nextrun">{nextRunLine(info, story)}</p>;
}

/** The video's own model and effort, kept with it (§45.25 level 2): shown, and changed while it waits for review. */
export function StoryAi({ info, story, editable, onChange }: { info: AiInfo; story: Story; editable: boolean; onChange: (v: ModelOverride | null) => void }) {
  const own = story.ai.model || story.ai.effort;
  const name = story.ai.model ? modelName(info, story.ai.model) : info.live ? modelName(info, usualFor(info, "storyboard").model) : "Your usual model";
  const words = own ? `${name}${story.ai.effort ? ` · ${effortName(story.ai.effort)} effort` : ""} (kept with this video)` : "Your usual settings";
  if (!editable) return <span>{words}</span>;
  return (
    <span className="st-s-aiwho">
      <span>{words}</span>
      <ModelMenu
        info={info}
        usual={usualFor(info, "storyboard")}
        value={story.ai}
        onChange={onChange}
        title="Model and effort for this video"
        note="Kept with this video. Its remakes use it too. Your other settings stay the same."
      />
    </span>
  );
}
