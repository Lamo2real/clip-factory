// The AI parts the studio screens share (docs/CONTRACTS.md §45.25, §45.7, §45.9): which model and effort a button will
// use, the small "Model and effort for this one" menu (a ModelOverride that is never saved), the same menu for a
// video's own setting (Story.ai, kept with it), the task runner that polls a task every second with a line that names
// the model and the effort, and the list of which model and effort made each step of a video (job.meta.models).
//
// The models come from Lamo Stories' own settings (GET …/ai). When that cannot be read, the names come from Lamo
// Stories' own model list (stories/config/models.json); nothing here ever reads Clip Factory's models.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/errors.ts";
import { A } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useLoad, usePoll } from "../../lib/hooks.ts";
import modelsFile from "../../../../stories/config/models.json";
import { storiesApi } from "../api/client.ts";
import { EFFORT_LABEL, STEP_ORDER, type AiSetting, type AiTask, type Effective, type Effort, type ModelInfo, type ModelOverride, type ProductionJob, type Story, type TaskInfo, type TaskKind } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { Busy, Notice, Pick, StSheet, Tag } from "./kit.tsx";
import { say } from "./words.ts";

interface ModelEntry {
  key: string;
  label: string;
  provider: string;
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
      return { models: r.models.length ? r.models : LISTED_MODELS, tasks: r.tasks.length ? r.tasks : listedTasks(), live: true } satisfies AiInfo;
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

/** What runs when nothing is picked; `modelKnown`/`effortKnown` false when it is only a guess (settings not read). */
export type Usual = Effective & { modelKnown?: boolean; effortKnown?: boolean };

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

/** A model and effort put together over the usual: the chosen parts win, the rest stays as usual (merged apart). */
export function merged(info: AiInfo, usual: Usual, pick: ModelOverride | AiSetting | null | undefined): Planned {
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
  usual,
  value,
  onChange,
  title = "Model and effort for this one",
  note = "Just for this one. Your settings stay the same.",
  usualWords = "From your Lamo Stories settings",
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
  const now = merged(info, usual, value);

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
        className={`st-btn st-s-ai-btn${now.changed ? " is-set" : ""}${compact ? " is-compact" : ""}${className ? ` ${className}` : ""}`}
        aria-haspopup="dialog"
        aria-label={`${title}: ${spoken(info, now)}${now.changed ? (note.startsWith("Kept") ? ", kept with this video" : ", just this one") : ""}`}
        onClick={show}
      >
        <Icon name="sliders" size={18} aria-hidden="true" />
        {!compact || now.changed ? <span className="st-s-ai-btn__words">{words}</span> : null}
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
                ? { value: USUAL, label: `Usual: ${modelName(info, usual.model)}`, line: usual.from === "project" && usual.modelKnown ? "Kept with this video" : usualWords }
                : { value: USUAL, label: "Your usual model", line: "Your Lamo Stories settings could not be read just now, so its name is not shown." },
              ...info.models.map((m) => ({ value: m.key, label: m.label, line: modelStatusWords(m, info.live) })),
            ]}
            className="st-s-ai-models"
          />
          {status ? <Notice tone="bad">{status} You can still try it: Lamo Stories never swaps in another model.</Notice> : null}
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
          <p className="st-s-field__hint">More effort thinks longer and costs more. Less is quicker.</p>
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

function modelStatusWords(m: ModelInfo, live: boolean): string {
  const by = m.provider ? `${m.provider}. ` : "";
  if (!live) return `${by}Not checked yet.`;
  if (m.status === "ok") return `${by}Ready.`;
  if (m.status === "not_checked") return `${by}Not checked yet.`;
  return `${by}${m.statusLine || "Not available right now."}`;
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
      setPhase("done");
      doneRef.current(t);
    } else if (t.status === "failed") {
      setPhase("failed");
      setProblem(t.error || "The helper stopped. Tap Try again.");
    }
  }, []);

  const start = useCallback(
    async (begin: () => Promise<AiTask>) => {
      last.current = begin;
      misses.current = 0;
      setProblem(null);
      setTask(null);
      setPhase("working");
      setStarted(Date.now());
      try {
        settle(await begin());
      } catch (e) {
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
          {t?.status === "queued" ? `Getting ${line} ready…` : `${what} with ${line}…`} <span className="st-s-ai-secs">{run.seconds} s</span>
          <span className="st-s-sr">. This usually takes 10 to 60 seconds.</span>
        </span>
      </Busy>
    );
  }
  if (run.phase === "failed" && run.problem) {
    return (
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
    );
  }
  return null;
}

/** The Lamo Stories setting a stop sentence sends the owner to (§45.25: "… in Lamo Stories › Settings › AI"). */
export function settingsFor(sentence: string | null | undefined): "ai" | "agents" | null {
  if (!sentence) return null;
  if (/Settings\s*›\s*Agents/i.test(sentence)) return "agents";
  if (/Settings\s*›\s*AI\b/i.test(sentence)) return "ai";
  return null;
}

/** The button that opens the setting a stop sentence names (nothing when it names none). */
export function SettingsFix({ sentence }: { sentence: string | null | undefined }) {
  const section = settingsFor(sentence);
  if (!section) return null;
  return (
    <A href={storiesHref({ name: "settings", section })} className="st-btn">
      {section === "agents" ? "Open Settings › Agents" : "Open Settings › AI"}
    </A>
  );
}

type ModelUse = ProductionJob["meta"]["models"][number];

/**
 * Which model and effort made each step of the video as it is now: for each step, the newest run that finished it
 * (a later run of only some steps keeps the earlier runs' writer and checks), in the order of the steps.
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
  const out = new Map<string, ModelUse>();
  for (const j of jobs)
    for (const u of j.meta.models) {
      if (out.has(u.step)) continue;
      const step = j.steps.find((s) => s.key === u.step);
      if (step && step.status !== "done") continue; // it did not finish in that run, so an older run's is in the video
      out.set(u.step, u);
    }
  const rank = (step: string) => {
    const i = (STEP_ORDER as readonly string[]).indexOf(step);
    return i < 0 ? STEP_ORDER.length : i;
  };
  return [...out.values()].sort((a, b) => rank(a.step) - rank(b.step));
}

/**
 * Which model and effort made each step of a video, from the jobs' own records (CONTRACTS §45.25 "Recorded"): while
 * a run works, that run's; else, with `jobs`, every step of the video as it is now (see madeWith).
 */
export function ModelsUsed({ info, job, jobs, title = "Made with" }: { info: AiInfo; job: ProductionJob | null; jobs?: ProductionJob[] | null; title?: string }) {
  const working = !!job && (job.status === "queued" || job.status === "running");
  const used = working || !jobs ? (job?.meta.models ?? []) : madeWith([job, ...jobs]);
  if (!used.length) return null;
  return (
    <div className="st-s-used">
      <h3 className="st-s-details__title">{title}</h3>
      <ul className="st-s-used__list">
        {used.map((u, i) => (
          <li key={`${u.step}:${i}`} className="st-s-used__row">
            <span className="st-s-used__step">{STEP_WORDS[u.step] ?? u.step}</span>
            <span className="st-s-used__model">{modelLine(info, u.model, u.effort, u.effortApplied)}</span>
            <Tag>{AGENT_WORDS[u.agentId] ?? u.agentId}</Tag>
            {!u.effortApplied ? <span className="st-s-used__note">This model has no effort setting; it ran at its own level.</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the next run of this video uses when nothing else is picked: its own setting over the writer's usual. */
export function storyUsual(info: AiInfo, story: Pick<Story, "ai">): Usual {
  const base = usualFor(info, "storyboard");
  if (!story.ai.model && !story.ai.effort) return base;
  const model = story.ai.model ?? base.model;
  const m = modelOf(info, model);
  const applied = m ? m.efforts.length > 0 : base.effortApplied;
  return { model, effort: applied ? (story.ai.effort ?? base.effort) : null, effortApplied: applied, from: "project", modelKnown: !!story.ai.model, effortKnown: !!story.ai.effort };
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
