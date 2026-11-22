// Lamo Stories › Settings › AI (docs/CONTRACTS.md §45.25, §45.29 AI): the owner's own control over the reasoning
// models. The default model (each with its provider and the result of its last real call) and the default effort
// (only the levels the picked model offers; "This model has no effort setting" where it has none), Check models (one
// tiny real call per model, through Lamo Stories' agent), each agent's and each task's model and effort ("Workspace
// default" otherwise, the suggested effort as a hint, what it uses now as the API worked it out), usage and cost for
// 30 days, prices for models with no known price, the providers with their state and keys, and the owner's own Bedrock
// models (Add a model, §45.34). Picking the default model or effort here says so to the API (`picked`, which ticks
// setup steps 2 and 3). Nothing is ever swapped for something else: an effort a model does not offer is refused with
// the sentence, never changed silently.
import { useCallback, useRef, useState } from "react";
import { ApiError, friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad, usePoll } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import type { Agent, AgentId, AiPicked, AiTask, Effort, ModelInfo, Price, ProviderStatus, StoriesAiConfig, TaskInfo, TaskKind } from "../api/types.ts";
import { EFFORT_LABEL } from "../api/types.ts";
import { Btn, cheer, Chip, effortWord, Failed, Loading, madeBy, MODEL_STATUS, money, Note, Progress, refusedLine, SavedMark, SetCard, SetPick, SetSelect, SIcon, statusSuffix, useOnThisPage, useSaved, whenText } from "./bits.tsx";
import { useAi, type AiData } from "./data.ts";
import { OwnModels } from "./OwnModels.tsx";
import { keepName, ProviderKeys, ProviderRow } from "./ProviderKeys.tsx";
import { UsageCard } from "./UsageCard.tsx";

const KIND_WORD: Record<ProviderStatus["kind"], string> = {
  writer: "Thinks and writes (the AI models above)",
  images: "Makes pictures",
  animation: "Makes the video",
  audio: "Makes sounds and music",
};

export function modelOf(models: ModelInfo[], key: string | null | undefined): ModelInfo | undefined {
  return models.find((m) => m.key === key);
}

/** "Claude Opus 5.5 · High", or "… · its own level" for a model with no effort setting. */
export function pairText(models: ModelInfo[], model: string, effort: Effort | null): string {
  const m = modelOf(models, model);
  return `${m?.label ?? model} · ${m && !m.efforts.length ? "its own level" : effortWord(effort)}`;
}

/** The sentence when an effort is not one the model offers (the API answers the same, §45.25). */
export function notOffered(m: ModelInfo, e: Effort): string {
  return `${m.label} does not offer ${EFFORT_LABEL[e]}. Pick another level.`;
}

export function offers(m: ModelInfo | undefined, e: Effort | null | undefined): boolean {
  return !m || !e || !m.efforts.length || m.efforts.includes(e);
}

const FROM_WORD: Record<TaskInfo["effective"]["from"], string> = {
  request: "just for one request",
  conversation: "the chat's own setting",
  project: "the video's own setting",
  task: "set for this task",
  agent: "the agent's setting",
  default: "workspace default",
};

// ---------- Check models ----------

/** How long Check models is followed before the page stops waiting, and how many failed asks in a row it takes. */
export const CHECK_GIVE_UP_MS = 120_000;
export const CHECK_MISSES = 3;
const CHECK_STOPPED = "The check stopped before it finished. Try again.";

/** Check models: one tiny real call per model (or only `only`), followed until it finishes. */
export function CheckModels({ ws, count, onDone, only }: { ws: string; count: number; onDone: () => Promise<void>; only?: string[] }) {
  const toast = useToast();
  const [task, setTask] = useState<AiTask | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const started = useRef(0);
  const misses = useRef(0);
  const running = !!task && (task.status === "queued" || task.status === "running");
  const stop = useCallback(
    async (message: string) => {
      setTask(null);
      await onDone();
      toast.error(message);
    },
    [onDone, toast],
  );
  const tick = useCallback(async () => {
    if (!task) return;
    let next: AiTask;
    try {
      next = await storiesApi().getTask(ws, task.taskId);
      misses.current = 0;
    } catch (e) {
      // A task that is gone cannot finish; anything else is tried a few more times.
      misses.current += 1;
      const gone = e instanceof ApiError && e.code === "not_found";
      if (gone || misses.current >= CHECK_MISSES || Date.now() - started.current > CHECK_GIVE_UP_MS) await stop(e instanceof ApiError && !gone ? friendlyMessage(e) : CHECK_STOPPED);
      return;
    }
    if ((next.status === "queued" || next.status === "running") && Date.now() - started.current > CHECK_GIVE_UP_MS) {
      await stop("The check is taking too long. Try again in a minute.");
      return;
    }
    setTask(next);
    if (next.status === "done") {
      await onDone();
      const results = (next.result?.models as { status: string }[] | undefined) ?? [];
      const works = results.filter((r) => r.status === "ok").length;
      const no = results.length - works;
      cheer(anchor);
      toast.success(
        results.length === 1
          ? works
            ? "Checked it: it works!"
            : "Checked it: Amazon Bedrock said no. Its card says why."
          : results.length
            ? `Checked ${results.length} models: ${works} work${no ? `, ${no} said no` : ""}.`
            : "All checked.",
      );
    } else if (next.status === "failed") {
      await onDone();
      toast.error(next.error ?? CHECK_STOPPED);
    }
  }, [task, ws, onDone, toast, anchor, stop]);
  usePoll(tick, running, 1000);
  return (
    <div className="st-stg-check">
      <Btn
        main
        off={running ? "Checking…" : undefined}
        onClick={(e) => {
          const el = e.currentTarget;
          setAnchor(el);
          started.current = Date.now();
          misses.current = 0;
          void storiesApi()
            .checkModels(ws, only)
            .then(setTask)
            .catch((err: unknown) => toast.error(friendlyMessage(err)));
        }}
      >
        <SIcon name="retry" size={20} />
        {running ? "Checking…" : "Check models"}
      </Btn>
      {running ? <Progress value={null} label={only ? `Checking ${only.length === 1 ? "the model" : `${only.length} models`}` : `Checking ${count} models`} /> : null}
      {running ? <span className="st-stg-small">One tiny real call to each model. It takes a few seconds.</span> : null}
    </div>
  );
}

// ---------- Default model and effort ----------

function ModelOptionLine({ m }: { m: ModelInfo }) {
  const here = useOnThisPage();
  return (
    <>
      {madeBy(m)} · {here(m.statusLine)}
      {m.checkedAt ? ` (${whenText(m.checkedAt)})` : ""}
    </>
  );
}

function DefaultModel({ data, pending, onPick, ws, reload }: { data: AiData; pending: string | null; onPick: (key: string) => void; ws: string; reload: () => Promise<void> }) {
  const shown = pending ?? data.ai.defaultModel;
  const picked = modelOf(data.models, shown);
  const here = useOnThisPage();
  const found = refusedLine(picked);
  const refused = found ? here(found) : null;
  return (
    <SetCard
      title="Default model"
      icon="chip"
      lede="The model every agent and task uses unless you give it its own. You can change it any time."
      actions={<CheckModels ws={ws} count={data.models.length} onDone={reload} />}
    >
      <p className="st-stg-active" aria-live="polite">
        <span className="st-stg-active__word">Active now</span>
        <strong>Model: {modelOf(data.models, data.ai.defaultModel)?.label ?? data.ai.defaultModel}</strong>
        <strong>Effort: {modelOf(data.models, data.ai.defaultModel)?.efforts.length ? effortWord(data.ai.defaultEffort) : "its own level"}</strong>
      </p>
      <SetPick
        label="Default model"
        stack
        value={shown}
        onChange={onPick}
        options={data.models.map((m) => ({
          value: m.key,
          label: m.label,
          chip: (
            <span className="st-stg-chips">
              {m.custom ? <Chip tone="sky">Added by you</Chip> : null}
              <Chip tone={MODEL_STATUS[m.status].tone}>{MODEL_STATUS[m.status].label}</Chip>
            </span>
          ),
          line: <ModelOptionLine m={m} />,
        }))}
      />
      {refused ? (
        <Note tone="coral" role="alert">
          {refused} Pick another model, or fix it and tap Check models.
        </Note>
      ) : null}
    </SetCard>
  );
}

function DefaultEffort({ data, pending, onPick }: { data: AiData; pending: string | null; onPick: (e: Effort) => void }) {
  const m = modelOf(data.models, pending ?? data.ai.defaultModel);
  const value = pending ? null : data.ai.defaultEffort;
  // "How hard it thinks" only for a model that has levels: one with none never hears about them (§45.36 E17).
  const lede = m && !m.efforts.length ? "This model picks how hard it thinks by itself." : "How hard the model thinks. Higher is slower and costs more. Lower is quick.";
  return (
    <SetCard title="Default effort" icon="ruler" lede={lede}>
      {!m ? null : !m.efforts.length ? (
        <Note tone="sky">This model has no effort setting; it runs at its own level.</Note>
      ) : (
        <>
          {pending && !m.efforts.includes(data.ai.defaultEffort) ? (
            <Note tone="sun" role="alert">
              {notOffered(m, data.ai.defaultEffort)} Your new model is saved once you pick one.
            </Note>
          ) : null}
          <SetPick
            label="Default effort"
            value={value}
            onChange={onPick}
            options={m.efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e], line: e === m.defaultEffort ? "The model's own level" : undefined }))}
          />
          <p className="st-stg-small">
            {m.label} offers {m.efforts.length === 5 ? "every level" : m.efforts.map((e) => EFFORT_LABEL[e]).join(", ")}
            {m.defaultEffort ? `. Its own level is ${EFFORT_LABEL[m.defaultEffort]}.` : "."}
          </p>
        </>
      )}
    </SetCard>
  );
}

// ---------- Each agent and each task ----------

interface RowDraft {
  /** "agent:{id}" or "task:{kind}" */
  row: string;
  /** what the owner picked: a model key, or null for the one it inherits */
  raw: string | null;
  /** the model that choice runs on */
  model: string;
}

function modelOptions(models: ModelInfo[], inherit: string) {
  return [{ value: "", label: inherit }, ...models.map((m) => ({ value: m.key, label: `${m.label}${m.custom ? " · added by you" : ""}${statusSuffix(m)}` }))];
}

function effortOptions(m: ModelInfo | undefined, inherit: string) {
  return [{ value: "", label: inherit }, ...(m?.efforts ?? []).map((e) => ({ value: e, label: EFFORT_LABEL[e] }))];
}

function AssignRow({
  name,
  sub,
  models,
  model,
  effort,
  inheritModel,
  inheritEffort,
  usesModel,
  usesEffort,
  uses,
  draft,
  suggested,
  onModel,
  onEffort,
  rowId,
}: {
  name: string;
  sub: string;
  models: ModelInfo[];
  model: string | null;
  effort: Effort | null;
  inheritModel: string;
  inheritEffort: string;
  /** the model and effort this row runs with (for the effort list and the warnings) */
  usesModel: ModelInfo | undefined;
  usesEffort: Effort | null;
  uses: string;
  draft: RowDraft | null;
  suggested?: Effort;
  onModel: (v: string | null) => void;
  onEffort: (v: Effort | null) => void;
  rowId: string;
}) {
  const shownModel = draft ? (draft.raw ?? "") : (model ?? "");
  const effortModel = draft ? modelOf(models, draft.model) : usesModel;
  const needsEffort = !!draft;
  const effortBroken = !draft && usesModel && usesEffort && usesModel.efforts.length > 0 && !usesModel.efforts.includes(usesEffort);
  // The refusal is spelled out where the model is picked; rows that only inherit it get a short chip.
  const here = useOnThisPage();
  const said = draft || model ? refusedLine(draft ? modelOf(models, draft.model) : usesModel) : null;
  const refused = said ? here(said) : null;
  const inheritedNo = !refused && usesModel && usesModel.status !== "ok" && usesModel.status !== "not_checked" ? MODEL_STATUS[usesModel.status] : null;
  return (
    <li className="st-stg-assign__row" data-row={rowId}>
      <div className="st-stg-assign__name">
        <span className="st-stg-assign__title">{name}</span>
        <span className="st-stg-small">{sub}</span>
      </div>
      <div className="st-stg-assign__pick">
        <span className="st-stg-assign__lab" aria-hidden="true">
          Model
        </span>
        <SetSelect label={`Model for ${name}`} hideLabel value={shownModel} options={modelOptions(models, inheritModel)} onChange={(v) => onModel(v || null)} />
      </div>
      <div className="st-stg-assign__pick">
        <span className="st-stg-assign__lab" aria-hidden="true">
          Effort
        </span>
        {effortModel && !effortModel.efforts.length ? (
          <span className="st-stg-assign__none">No effort setting</span>
        ) : (
          <SetSelect
            label={`Effort for ${name}`}
            hideLabel
            value={needsEffort ? "pick" : (effort ?? "")}
            invalid={needsEffort || !!effortBroken}
            options={needsEffort ? [{ value: "pick", label: "Pick a level" }, ...effortOptions(effortModel, inheritEffort).slice(1)] : effortOptions(effortModel, inheritEffort)}
            onChange={(v) => v !== "pick" && onEffort((v || null) as Effort | null)}
          />
        )}
      </div>
      <div className="st-stg-assign__now">
        <span className="st-stg-small">Uses now</span>
        <span className="st-stg-assign__uses">
          {uses}
          {inheritedNo ? <Chip tone={inheritedNo.tone}>{inheritedNo.label}</Chip> : null}
        </span>
        {suggested ? (
          <span className="st-stg-assign__hint">
            Suggested: {EFFORT_LABEL[suggested]}
            {usesEffort !== suggested && offers(usesModel, suggested) && usesModel?.efforts.length ? (
              <Btn quiet small onClick={() => onEffort(suggested)} label={`Use ${EFFORT_LABEL[suggested]} for ${name}`}>
                Use it
              </Btn>
            ) : null}
          </span>
        ) : null}
      </div>
      {needsEffort && effortModel && effort ? (
        <Note tone="sun" role="alert">
          {notOffered(effortModel, effort)}
        </Note>
      ) : null}
      {effortBroken && usesModel && usesEffort ? <Note tone="sun">{notOffered(usesModel, usesEffort)}</Note> : null}
      {refused ? <Note tone="coral">{refused}</Note> : null}
    </li>
  );
}

function Assignments({ data, saveAi, saveAgent }: { data: AiData; saveAi: (next: Omit<StoriesAiConfig, "version">) => Promise<boolean>; saveAgent: (id: AgentId, patch: { model?: string | null; effort?: Effort | null }) => Promise<Agent | null> }) {
  const toast = useToast();
  const [draft, setDraft] = useState<RowDraft | null>(null);
  // A model with no effort setting takes no effort in the same setting (the API refuses the pair, §45.34): picking
  // one for a row that has its own effort saves the model alone and says why.
  const noLevels = (key: string | null) => {
    const m = key ? modelOf(models, key) : undefined;
    return m && !m.efforts.length ? m : null;
  };
  const { ai, models, agents, tasks } = data;
  const defText = "Workspace default";
  const defEffort = "Workspace default";

  const agentRows = agents.map((a) => {
    const usesModel = modelOf(models, a.model ?? ai.defaultModel);
    const usesEffort = usesModel && !usesModel.efforts.length ? null : (a.effort ?? ai.defaultEffort);
    const row = `agent:${a.agentId}`;
    return (
      <AssignRow
        key={row}
        rowId={row}
        name={a.name}
        sub={a.active ? `${a.tasks.length} ${a.tasks.length === 1 ? "task" : "tasks"}` : "Switched off"}
        models={models}
        model={a.model}
        effort={a.effort}
        inheritModel={defText}
        inheritEffort={defEffort}
        usesModel={usesModel}
        usesEffort={usesEffort}
        uses={pairText(models, a.model ?? ai.defaultModel, usesEffort)}
        draft={draft?.row === row ? draft : null}
        onModel={(v) => {
          const next = modelOf(models, v ?? ai.defaultModel);
          if (a.effort && next && !offers(next, a.effort)) return setDraft({ row, raw: v, model: v ?? ai.defaultModel });
          setDraft(null);
          const plain = a.effort ? noLevels(v) : null;
          if (plain) toast.info(`${plain.label} has no effort setting; it runs at its own level. ${a.name}'s own effort is cleared.`);
          void saveAgent(a.agentId, plain ? { model: v, effort: null } : { model: v });
        }}
        onEffort={(v) => {
          const pend = draft?.row === row ? draft : null;
          setDraft(null);
          void saveAgent(a.agentId, pend ? { model: pend.raw, effort: v } : { effort: v });
        }}
      />
    );
  });

  const setTask = (kind: TaskKind, set: { model?: string; effort?: Effort }) => {
    const next = { ...ai.tasks };
    if (!set.model && !set.effort) delete next[kind];
    else next[kind] = { ...(set.model ? { model: set.model } : {}), ...(set.effort ? { effort: set.effort } : {}) };
    void saveAi({ defaultModel: ai.defaultModel, defaultEffort: ai.defaultEffort, tasks: next, prices: ai.prices });
  };

  const taskRows = tasks.map((t) => {
    const set = ai.tasks[t.kind] ?? {};
    const agent = agents.find((a) => a.agentId === t.agentId);
    const inheritKey = agent?.model ?? ai.defaultModel;
    const inheritModel = agent?.model ? "Same as its agent" : defText;
    const usesModel = modelOf(models, t.effective.model);
    const inheritEffort = agent?.effort ? "Same as its agent" : defEffort;
    const row = `task:${t.kind}`;
    return (
      <AssignRow
        key={row}
        rowId={row}
        name={t.label}
        sub={`${agent?.name ?? t.agentId} agent · ${FROM_WORD[t.effective.from]}`}
        models={models}
        model={set.model ?? null}
        effort={set.effort ?? null}
        inheritModel={inheritModel}
        inheritEffort={inheritEffort}
        usesModel={usesModel}
        usesEffort={t.effective.effort}
        uses={pairText(models, t.effective.model, t.effective.effort)}
        suggested={t.suggestedEffort}
        draft={draft?.row === row ? draft : null}
        onModel={(v) => {
          const next = modelOf(models, v ?? inheritKey);
          if (set.effort && next && !offers(next, set.effort)) return setDraft({ row, raw: v, model: v ?? inheritKey });
          setDraft(null);
          const plain = set.effort ? noLevels(v) : null;
          if (plain) toast.info(`${plain.label} has no effort setting; it runs at its own level. ${t.label}'s own effort is cleared.`);
          setTask(t.kind, { ...(v ? { model: v } : {}), ...(set.effort && !plain ? { effort: set.effort } : {}) });
        }}
        onEffort={(v) => {
          const pend = draft?.row === row ? draft : null;
          setDraft(null);
          const model = pend ? pend.raw : set.model;
          setTask(t.kind, { ...(model ? { model } : {}), ...(v ? { effort: v } : {}) });
        }}
      />
    );
  });

  return (
    <SetCard
      title="Each agent and each task"
      icon="people"
      lede="Give one agent or one task its own model or effort. A task first uses its own, then its agent's, then the workspace default."
    >
      <div className="st-stg-assign__cols" aria-hidden="true">
        <span>Who</span>
        <span>Model</span>
        <span>Effort</span>
        <span>Uses now</span>
      </div>
      <h4 className="st-stg-subhead">Agents</h4>
      <ul className="st-stg-assign" aria-label="Each agent's model and effort">
        {agentRows}
      </ul>
      <h4 className="st-stg-subhead">Tasks</h4>
      <ul className="st-stg-assign" aria-label="Each task's model and effort">
        {taskRows}
      </ul>
    </SetCard>
  );
}

// ---------- Prices ----------

function priceText(p: Price): string {
  return `${money(p.inputPer1M, p.currency)} in · ${money(p.outputPer1M, p.currency)} out, for a million tokens`;
}

function PriceRow({ ws, m, onSaved }: { ws: string; m: ModelInfo; onSaved: (m: ModelInfo) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(m.price ? String(m.price.inputPer1M) : "");
  const [output, setOutput] = useState(m.price ? String(m.price.outputPer1M) : "");
  const [currency, setCurrency] = useState(m.price?.currency ?? "USD");
  const [busy, setBusy] = useState(false);
  const owner = m.price?.source === "owner";
  const here = useOnThisPage();
  const save = async (el: HTMLElement | null) => {
    const i = Number(input.replace(",", "."));
    const o = Number(output.replace(",", "."));
    if (!input.trim() || !output.trim() || !Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) {
      toast.error("Type both prices as numbers, like 4 and 20.");
      return;
    }
    setBusy(true);
    try {
      onSaved(await storiesApi().setModelPrice(ws, m.key, { inputPer1M: i, outputPer1M: o, currency }));
      setOpen(false);
      cheer(el);
      toast.success(`${m.label}'s price is saved. Costs use it from now on.`);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    try {
      onSaved(await storiesApi().setModelPrice(ws, m.key, null));
      toast.info(`Your price for ${m.label} is removed.`);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="st-stg-price">
      <div className="st-stg-price__head">
        <span className="st-stg-price__name">{m.label}</span>
        {m.price ? <Chip tone={owner ? "sky" : "mint"}>{owner ? "Your price" : "List price"}</Chip> : <Chip tone="sun">No price set.</Chip>}
      </div>
      {m.price ? <p className="st-stg-price__text">{priceText(m.price)}</p> : <p className="st-stg-price__text">Tokens are counted, but no cost is worked out until you type its price.</p>}
      {m.price && !owner ? <p className="st-stg-small">{here(m.price.note, "here")}</p> : null}
      {open ? (
        <form
          className="st-stg-price__form"
          onSubmit={(e) => {
            e.preventDefault();
            void save(e.currentTarget.querySelector("button[type=submit]"));
          }}
        >
          <span className="st-stg-field">
            <label className="st-stg-label" htmlFor={`in-${m.key}`}>
              Reading, per million tokens
            </label>
            <input id={`in-${m.key}`} className="st-stg-input" inputMode="decimal" value={input} placeholder="4.00" onChange={(e) => setInput(e.target.value)} />
          </span>
          <span className="st-stg-field">
            <label className="st-stg-label" htmlFor={`out-${m.key}`}>
              Writing, per million tokens
            </label>
            <input id={`out-${m.key}`} className="st-stg-input" inputMode="decimal" value={output} placeholder="20.00" onChange={(e) => setOutput(e.target.value)} />
          </span>
          <SetSelect label="Currency" value={currency} onChange={setCurrency} options={["USD", "EUR", "GBP"].map((c) => ({ value: c, label: c }))} />
          <div className="st-stg-actions">
            <Btn main type="submit" off={busy ? "Saving…" : undefined}>
              Save the price
            </Btn>
            <Btn quiet onClick={() => setOpen(false)}>
              Cancel
            </Btn>
          </div>
        </form>
      ) : (
        <div className="st-stg-actions">
          <Btn onClick={() => setOpen(true)} label={`${m.price ? "Type your own price" : "Type a price"} for ${m.label}`}>
            {m.price ? "Type your own price" : "Type a price"}
          </Btn>
          {owner ? (
            <Btn quiet off={busy ? "Working…" : undefined} onClick={() => void clear()} label={`Remove your price for ${m.label}`}>
              Remove my price
            </Btn>
          ) : null}
        </div>
      )}
    </li>
  );
}

function Prices({ ws, models, onSaved }: { ws: string; models: ModelInfo[]; onSaved: (m: ModelInfo) => void }) {
  return (
    <SetCard title="Prices" icon="coin" lede="What each model costs. Amazon Bedrock bills its own price, so you can type the one on your bill.">
      <ul className="st-stg-prices" aria-label="Each model's price">
        {models.map((m) => (
          <PriceRow key={m.key} ws={ws} m={m} onSaved={onSaved} />
        ))}
      </ul>
      <p className="st-stg-small">The picture and video makers' prices are in Settings › Video.</p>
    </SetCard>
  );
}

// ---------- Providers ----------

function Providers({ ws, providers, error, onChange }: { ws: string; providers: ProviderStatus[] | null; error: string | null; onChange: (p: ProviderStatus) => void }) {
  return (
    <SetCard title="Providers" icon="plug" lede="Who does each kind of work. The AI models think and write; pictures, video and sound have makers of their own (Settings › Video).">
      {error && !providers ? <p className="st-stg-small">{error}</p> : null}
      {providers ? (
        <>
          <ul className="st-stg-providers" aria-label="Providers">
            {providers.map((p) => (
              <ProviderRow key={`${p.kind}-${p.id}`} p={p} what={KIND_WORD[p.kind]} />
            ))}
          </ul>
          <h4 className="st-stg-subhead">Provider keys</h4>
          <ProviderKeys ws={ws} providers={providers} onChange={onChange} />
        </>
      ) : null}
    </SetCard>
  );
}

// ---------- The section ----------

export function AiSection({ ws }: { ws: string }) {
  const ai = useAi(ws);
  const providers = useLoad(() => storiesApi().providers(ws), ws, "st-settings-providers");
  const usage = useLoad(() => storiesApi().usage(ws, 30), ws, "st-settings-usage");
  const { saved, flash } = useSaved();
  const [pending, setPending] = useState<string | null>(null);
  const { data, saveAi, saveAgent, setData } = ai;

  if (!data) return ai.error ? <Failed message={ai.error} onRetry={() => void ai.reload()} /> : <Loading label="Opening the AI settings…" />;

  const save = async (next: Omit<StoriesAiConfig, "version">, picked: AiPicked[]) => {
    if (await saveAi(next, picked)) flash();
  };
  const pickModel = (key: string) => {
    const m = modelOf(data.models, key);
    if (!m) return;
    if (m.efforts.length && !m.efforts.includes(data.ai.defaultEffort)) {
      // Never swapped: the owner picks the level this model offers, then both are saved.
      setPending(key);
      return;
    }
    setPending(null);
    void save({ ...data.ai, defaultModel: key }, ["model"]);
  };
  const pickEffort = (e: Effort) => {
    const model = pending ?? data.ai.defaultModel;
    const both = pending !== null;
    setPending(null);
    void save({ ...data.ai, defaultModel: model, defaultEffort: e }, both ? ["model", "effort"] : ["effort"]);
  };

  return (
    <div className="st-stg-cards">
      <div className="st-stg-bar">
        <p className="st-stg-small">Lamo Stories' own models. Clip Factory's model setting is separate and stays as it is.</p>
        <SavedMark saved={saved} busy={ai.busy} />
      </div>
      <DefaultModel data={data} pending={pending} onPick={pickModel} ws={ws} reload={ai.reload} />
      <DefaultEffort data={data} pending={pending} onPick={pickEffort} />
      <OwnModels ws={ws} models={data.models} onChanged={ai.reload} check={(key) => <CheckModels ws={ws} count={1} only={[key]} onDone={ai.reload} />} />
      <Assignments
        data={data}
        saveAi={async (next) => {
          const ok = await saveAi(next);
          if (ok) flash();
          return ok;
        }}
        saveAgent={async (id, patch) => {
          const out = await saveAgent(id, patch);
          if (out) flash();
          return out;
        }}
      />
      <UsageCard usage={usage.data} models={data.models} error={usage.error} />
      <Prices
        ws={ws}
        models={data.models}
        onSaved={(m) => {
          setData((d) => (d ? { ...d, models: d.models.map((x) => (x.key === m.key ? m : x)) } : d));
          void usage.reload();
          void ai.reload();
        }}
      />
      <Providers
        ws={ws}
        providers={providers.data}
        error={providers.error}
        onChange={(p) => providers.setData((list) => (list ? list.map((x) => (x.id === p.id ? keepName(x, p) : x)) : list))}
      />
    </div>
  );
}
