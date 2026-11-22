// Lamo Stories › Settings › AI › Add a model (docs/CONTRACTS.md §45.34 "Adding models without a release", request 2
// §3: "support adding new models and providers without rebuilding the application"). The owner adds a reasoning model
// hosted on Amazon Bedrock with its own details (a ModelDef: name, who makes it, the Bedrock model id or inference
// profile, its Region, the efforts it accepts (none is allowed), its own level, pictures or not, how much it may write
// and an optional price), saved by PUT …/ai/models/{key}. His models are listed with an "Added by you" mark, can be
// changed (Edit) or removed (Remove: a model a saved setting still uses is refused with the API's own sentence, shown
// here). Nothing is shown as working because it is listed: after a save the card suggests Check models, and a model
// Amazon Bedrock refuses keeps Bedrock's sentence; nothing is ever swapped for another model.
import { useId, useState, type ReactNode } from "react";
import { ApiError, friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { storiesApi } from "../api/client.ts";
import { CUSTOM_MODEL_KEY, EFFORT_LABEL, MAX_CUSTOM_MODELS, type Effort, type ModelDef, type ModelInfo, type Price } from "../api/types.ts";
import { Btn, cheer, Chip, MODEL_STATUS, Note, SetCard, SetPick, SetSelect, SetSwitch, SIcon, whenText } from "./bits.tsx";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Who makes the model: the usual Bedrock makers, or anyone else by name. */
const MAKERS = ["Anthropic", "Amazon", "Meta", "Mistral"] as const;
const SOMEONE_ELSE = "other";

/** Amazon Bedrock Regions, with the place first so the owner knows which one he means. Lamo Stories runs in Stockholm. */
export const REGIONS: { value: string; label: string }[] = [
  { value: "eu-north-1", label: "Europe (Stockholm) · eu-north-1" },
  { value: "eu-west-1", label: "Europe (Ireland) · eu-west-1" },
  { value: "eu-central-1", label: "Europe (Frankfurt) · eu-central-1" },
  { value: "eu-west-3", label: "Europe (Paris) · eu-west-3" },
  { value: "eu-south-1", label: "Europe (Milan) · eu-south-1" },
  { value: "us-east-1", label: "US East (N. Virginia) · us-east-1" },
  { value: "us-east-2", label: "US East (Ohio) · us-east-2" },
  { value: "us-west-2", label: "US West (Oregon) · us-west-2" },
  { value: "ap-northeast-1", label: "Asia Pacific (Tokyo) · ap-northeast-1" },
  { value: "ap-southeast-2", label: "Asia Pacific (Sydney) · ap-southeast-2" },
];
export const DEFAULT_REGION = "eu-north-1";
export const DEFAULT_MAX_TOKENS = 16_000;
const MAX_TOKENS = 200_000;

/** The key for a new model's name: `custom-` and its name in small letters, never one already taken. */
export function keyFor(label: string, taken: readonly string[]): string {
  const slug =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 34)
      .replace(/-+$/, "") || "model";
  let key = `custom-${slug}`;
  for (let n = 2; taken.includes(key); n++) key = `custom-${slug}-${n}`;
  return key;
}

/** A Bedrock model id, inference profile id or ARN: no spaces, at most 200 characters (Bedrock says the rest). */
export function modelIdProblem(id: string): string | null {
  const v = id.trim();
  if (!v) return "Paste the model ID from the Amazon Bedrock console.";
  if (v.length > 200 || /\s/.test(v) || !/^[A-Za-z0-9.:/_-]+$/.test(v)) return "That does not look like a Bedrock model ID. It looks like eu.amazon.nova-premier-v1:0.";
  return null;
}

interface Draft {
  label: string;
  maker: string;
  otherMaker: string;
  modelId: string;
  region: string;
  efforts: Effort[];
  defaultEffort: Effort | null;
  vision: boolean;
  maxTokens: string;
  priced: boolean;
  input: string;
  output: string;
  currency: string;
}

function draftOf(m: ModelInfo | null): Draft {
  const known = m && (MAKERS as readonly string[]).includes(m.provider);
  const price = m?.price ?? null;
  return {
    label: m?.label ?? "",
    maker: m ? (known ? m.provider : SOMEONE_ELSE) : "Anthropic",
    otherMaker: m && !known ? m.provider : "",
    modelId: m?.modelId ?? "",
    region: m?.region ?? DEFAULT_REGION,
    efforts: m ? [...m.efforts] : [],
    defaultEffort: m?.defaultEffort ?? null,
    vision: m?.vision ?? false,
    maxTokens: String(m?.maxOutputTokens ?? DEFAULT_MAX_TOKENS),
    priced: !!price,
    input: price ? String(price.inputPer1M) : "",
    output: price ? String(price.outputPer1M) : "",
    currency: price?.currency ?? "USD",
  };
}

const num = (s: string) => Number(s.replace(",", ".").trim());

/** The ModelDef the form describes, or the first thing to fix, in plain words. */
export function defOf(d: Draft): ModelDef | { problem: string } {
  const label = d.label.trim();
  if (!label) return { problem: "Give the model a name, like Nova Premier." };
  if (label.length > 60) return { problem: "Keep the name to 60 letters or fewer." };
  const provider = d.maker === SOMEONE_ELSE ? d.otherMaker.trim() : d.maker;
  if (!provider) return { problem: "Say who makes the model." };
  if (provider.length > 40) return { problem: "Keep who makes it to 40 letters or fewer." };
  const idProblem = modelIdProblem(d.modelId);
  if (idProblem) return { problem: idProblem };
  if (d.efforts.length && (!d.defaultEffort || !d.efforts.includes(d.defaultEffort))) return { problem: "Pick its own level, the one it uses when nothing else is set." };
  const tokens = num(d.maxTokens);
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > MAX_TOKENS) return { problem: `Type how many tokens it may write, a whole number from 1 to ${MAX_TOKENS.toLocaleString("en-GB")}.` };
  let price: Price | null = null;
  if (d.priced) {
    const i = num(d.input);
    const o = num(d.output);
    if (!d.input.trim() || !d.output.trim() || !Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0 || i > 100_000 || o > 100_000) return { problem: "Type both prices as numbers, like 2.5 and 12." };
    price = { inputPer1M: i, outputPer1M: o, cacheReadPer1M: null, cacheWritePer1M: null, longContext: null, currency: d.currency, source: "owner", note: "Your own price." };
  }
  return {
    label,
    provider,
    modelId: d.modelId.trim(),
    region: d.region,
    efforts: EFFORTS.filter((e) => d.efforts.includes(e)),
    defaultEffort: d.efforts.length ? d.defaultEffort : null,
    vision: d.vision,
    maxOutputTokens: tokens,
    price,
  };
}

/** A field with its label above it. */
function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <span className="st-stg-field">
      <label className="st-stg-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? <span className="st-stg-small">{hint}</span> : null}
    </span>
  );
}

function ModelForm({ start, editing, taken, onSaved, onCancel, ws }: { start: ModelInfo | null; editing: boolean; taken: string[]; onSaved: (m: ModelInfo) => void; onCancel: () => void; ws: string }) {
  const toast = useToast();
  const id = useId();
  const [d, setD] = useState<Draft>(() => draftOf(start));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const toggleEffort = (e: Effort) =>
    setD((x) => {
      const efforts = x.efforts.includes(e) ? x.efforts.filter((y) => y !== e) : EFFORTS.filter((y) => y === e || x.efforts.includes(y));
      // Its own level stays one of the levels it accepts: the first one ticked, until the owner picks another.
      const defaultEffort = x.defaultEffort && efforts.includes(x.defaultEffort) ? x.defaultEffort : (efforts[0] ?? null);
      return { ...x, efforts, defaultEffort };
    });
  const save = async (el: HTMLElement | null) => {
    if (busy) return;
    const def = defOf(d);
    if ("problem" in def) {
      setProblem(def.problem);
      toast.error(def.problem);
      return;
    }
    setProblem(null);
    const key = start?.key ?? keyFor(def.label, taken);
    if (!CUSTOM_MODEL_KEY.test(key)) {
      toast.error("Give the model a name with some letters or numbers in it.");
      return;
    }
    setBusy(true);
    try {
      const saved = await storiesApi().putAiModel(ws, key, def);
      cheer(el);
      toast.success(editing ? `${saved.label} is saved.` : `${saved.label} is added! Tap Check models to see if it answers.`);
      onSaved(saved);
    } catch (e) {
      const text = friendlyMessage(e);
      setProblem(text);
      toast.error(text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="st-stg-form st-stg-modelform"
      aria-label={editing ? `Change ${start?.label ?? "the model"}` : "Add a model"}
      onSubmit={(e) => {
        e.preventDefault();
        void save(e.currentTarget.querySelector("button[type=submit]"));
      }}
    >
      <Field id={`${id}-label`} label="Name">
        <input id={`${id}-label`} className="st-stg-input" value={d.label} maxLength={60} placeholder="Nova Premier" onChange={(e) => set({ label: e.target.value })} />
      </Field>
      <span className="st-stg-field">
        <span className="st-stg-label" id={`${id}-maker`}>
          Who makes it
        </span>
        <SetPick<string>
          label="Who makes it"
          value={d.maker}
          onChange={(v) => set({ maker: v })}
          options={[...MAKERS.map((m) => ({ value: m, label: m })), { value: SOMEONE_ELSE, label: "Someone else" }]}
        />
      </span>
      {d.maker === SOMEONE_ELSE ? (
        <Field id={`${id}-other`} label="Its maker's name">
          <input id={`${id}-other`} className="st-stg-input" value={d.otherMaker} maxLength={40} placeholder="Cohere" onChange={(e) => set({ otherMaker: e.target.value })} />
        </Field>
      ) : null}
      <Field
        id={`${id}-mid`}
        label="Bedrock model ID or inference profile"
        hint="Copy it from the Amazon Bedrock console: a model ID, an inference profile like eu.amazon.nova-premier-v1:0, or its ARN."
      >
        <input id={`${id}-mid`} className="st-stg-input st-stg-input--code" value={d.modelId} spellCheck={false} autoComplete="off" maxLength={200} placeholder="eu.amazon.nova-premier-v1:0" onChange={(e) => set({ modelId: e.target.value })} />
      </Field>
      <SetSelect label="AWS Region" value={d.region} options={REGIONS} onChange={(v) => set({ region: v })} />

      <span className="st-stg-field">
        <span className="st-stg-label" id={`${id}-eff`}>
          Effort levels it accepts
        </span>
        <span className="st-stg-toggles" role="group" aria-labelledby={`${id}-eff`}>
          {EFFORTS.map((e) => (
            <button key={e} type="button" className={`st-stg-toggle${d.efforts.includes(e) ? " is-on" : ""}`} aria-pressed={d.efforts.includes(e)} onClick={() => toggleEffort(e)}>
              {d.efforts.includes(e) ? <SIcon name="check" size={18} /> : null}
              {EFFORT_LABEL[e]}
            </button>
          ))}
        </span>
        <span className="st-stg-small">
          {d.efforts.length ? "Only these levels are ever sent to it." : "None ticked: it has no effort setting and runs at its own level. Lamo Stories never sends it one."}
        </span>
      </span>
      {d.efforts.length ? (
        <span className="st-stg-field">
          <span className="st-stg-label">Its own level</span>
          <SetPick<Effort> label="Its own level" value={d.defaultEffort} onChange={(v) => set({ defaultEffort: v })} options={d.efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] }))} />
        </span>
      ) : null}
      <SetSwitch label="It can look at pictures" description="On for models that read pictures, like chat photos and reference videos." checked={d.vision} onChange={(v) => set({ vision: v })} />
      <Field id={`${id}-max`} label="Most tokens it may write in one answer" hint="Its maker's page says this. 16,000 suits most stories.">
        <input id={`${id}-max`} className="st-stg-input" inputMode="numeric" value={d.maxTokens} onChange={(e) => set({ maxTokens: e.target.value })} />
      </Field>
      <SetSwitch label="I know its price" description="Without a price, its tokens are counted but no cost is worked out." checked={d.priced} onChange={(v) => set({ priced: v })} />
      {d.priced ? (
        <div className="st-stg-price__form">
          <Field id={`${id}-in`} label="Reading, per million tokens">
            <input id={`${id}-in`} className="st-stg-input" inputMode="decimal" value={d.input} placeholder="2.50" onChange={(e) => set({ input: e.target.value })} />
          </Field>
          <Field id={`${id}-out`} label="Writing, per million tokens">
            <input id={`${id}-out`} className="st-stg-input" inputMode="decimal" value={d.output} placeholder="12.50" onChange={(e) => set({ output: e.target.value })} />
          </Field>
          <SetSelect label="Currency" value={d.currency} onChange={(v) => set({ currency: v })} options={["USD", "EUR", "GBP"].map((c) => ({ value: c, label: c }))} />
        </div>
      ) : null}
      {problem ? (
        <Note tone="coral" role="alert">
          {problem}
        </Note>
      ) : null}
      <div className="st-stg-actions">
        <Btn main type="submit" off={busy ? "Saving…" : undefined}>
          <SIcon name={editing ? "check" : "plus"} size={20} />
          {busy ? "Saving…" : editing ? "Save the changes" : "Add the model"}
        </Btn>
        <Btn quiet onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </form>
  );
}

function OwnRow({ ws, m, onChanged, onEdit }: { ws: string; m: ModelInfo; onChanged: () => Promise<void>; onEdit: () => void }) {
  const toast = useToast();
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const s = MODEL_STATUS[m.status];
  const remove = async () => {
    setBusy(true);
    try {
      await storiesApi().deleteAiModel(ws, m.key);
      toast.info(`${m.label} is removed from Lamo Stories.`);
      setSure(false);
      await onChanged();
    } catch (e) {
      // A model a saved setting still uses stays: the API names that setting (409).
      const text = friendlyMessage(e);
      setRefused(e instanceof ApiError && e.code === "conflict" ? text : null);
      toast.error(text);
      setSure(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="st-stg-own" data-model={m.key}>
      <div className="st-stg-own__head">
        <span className="st-stg-own__name">{m.label}</span>
        <Chip tone="sky">Added by you</Chip>
        <Chip tone={s.tone}>{s.label}</Chip>
      </div>
      <p className="st-stg-small">
        Made by {m.provider} · on Amazon Bedrock{m.region ? ` in ${m.region}` : ""} · <code className="st-stg-code">{m.modelId}</code>
      </p>
      <p className="st-stg-small">
        {m.efforts.length ? `Levels: ${m.efforts.map((e) => EFFORT_LABEL[e]).join(", ")}. Its own: ${m.defaultEffort ? EFFORT_LABEL[m.defaultEffort] : "none"}.` : "No effort setting: it runs at its own level."}
        {m.vision ? " Looks at pictures." : " Words only."}
      </p>
      <p className="st-stg-small">
        {m.statusLine}
        {m.checkedAt ? ` (${whenText(m.checkedAt)})` : ""}
      </p>
      {refused ? (
        <Note tone="coral" role="alert">
          {refused}
        </Note>
      ) : null}
      {sure ? (
        <div className="st-stg-confirm" role="group" aria-label="Are you sure?">
          <p>
            <strong>Remove {m.label}?</strong> It goes from every list. Clip Factory is not touched.
          </p>
          <div className="st-stg-actions">
            <Btn danger main off={busy ? "Removing…" : undefined} onClick={() => void remove()}>
              Yes, remove it
            </Btn>
            <Btn quiet onClick={() => setSure(false)}>
              No, keep it
            </Btn>
          </div>
        </div>
      ) : (
        <div className="st-stg-actions">
          <Btn onClick={onEdit} label={`Edit ${m.label}`}>
            <SIcon name="pencil" size={20} />
            Edit
          </Btn>
          <Btn
            quiet
            danger
            onClick={() => {
              setRefused(null);
              setSure(true);
            }}
            label={`Remove ${m.label}`}
          >
            <SIcon name="trash" size={20} />
            Remove
          </Btn>
        </div>
      )}
    </li>
  );
}

/**
 * The "Add a model" card: the owner's own Bedrock models, the form, and after a save the suggestion to check it
 * (`check` is the section's Check models for just that model).
 */
export function OwnModels({ ws, models, onChanged, check }: { ws: string; models: ModelInfo[]; onChanged: () => Promise<void>; check: (key: string) => ReactNode }) {
  const [open, setOpen] = useState<"new" | string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const own = models.filter((m) => m.custom);
  const full = own.length >= MAX_CUSTOM_MODELS;
  const just = added ? models.find((m) => m.key === added) : undefined;
  return (
    <SetCard
      title="Add a model"
      icon="plus"
      id="add-a-model"
      lede="Use another AI model from Amazon Bedrock, with no new version of the app. Paste its ID from the Bedrock console, then check that it answers."
      actions={
        open === null ? (
          <Btn main off={full ? `You can add up to ${MAX_CUSTOM_MODELS} models. Remove one first.` : undefined} onClick={() => setOpen("new")}>
            <SIcon name="plus" size={20} />
            Add a model
          </Btn>
        ) : undefined
      }
    >
      {just && just.status === "not_checked" ? (
        <div className="st-stg-suggest" role="status">
          <Note tone="sun" icon="retry">
            {just.label} is listed, but it has not answered yet. Check it now: Amazon Bedrock says whether this account may use it.
          </Note>
          {check(just.key)}
        </div>
      ) : null}
      {open === "new" ? (
        <ModelForm
          ws={ws}
          start={null}
          editing={false}
          taken={models.map((m) => m.key)}
          onCancel={() => setOpen(null)}
          onSaved={(m) => {
            setOpen(null);
            setAdded(m.key);
            void onChanged();
          }}
        />
      ) : null}
      {own.length ? (
        <ul className="st-stg-owns" aria-label="Models you added">
          {own.map((m) =>
            open === m.key ? (
              <li key={m.key} className="st-stg-own">
                <ModelForm
                  ws={ws}
                  start={m}
                  editing
                  taken={models.map((x) => x.key)}
                  onCancel={() => setOpen(null)}
                  onSaved={(saved) => {
                    setOpen(null);
                    setAdded(saved.key);
                    void onChanged();
                  }}
                />
              </li>
            ) : (
              <OwnRow key={m.key} ws={ws} m={m} onChanged={onChanged} onEdit={() => setOpen(m.key)} />
            ),
          )}
        </ul>
      ) : open === null ? (
        <p className="st-stg-small">No models added yet. The ones above come with Lamo Stories; add any other Bedrock model here.</p>
      ) : null}
    </SetCard>
  );
}
