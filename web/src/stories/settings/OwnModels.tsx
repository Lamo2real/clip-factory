// Lamo Stories › Settings › AI › Add a model (docs/CONTRACTS.md §45.34 "Adding models without a release", request 2
// §3: "support adding new models and providers without rebuilding the application"). The owner adds a reasoning model
// hosted on Amazon Bedrock with its own details (a ModelDef: name, who makes it, the Bedrock model id or inference
// profile, its Region, the efforts it accepts (none is allowed), its own level, pictures or not, how much it may write
// and an optional price), saved by PUT …/ai/models/{key}. His models are listed with an "Added by you" mark, can be
// changed (Edit) or removed (Remove: a model a saved setting still uses is refused with the API's own sentence, shown
// here). Nothing is shown as working because it is listed: after a save the card suggests Check models, and a model
// Amazon Bedrock refuses keeps Bedrock's sentence; nothing is ever swapped for another model.
//
// Round 4 (§45.35): each model also says how Lamo Stories calls it (D1): whether it takes an effort level the way
// Claude models do (effortField output_config, else none: no level is ever sent), whether it can use tools (the
// chat's actions; without them it only talks and tidy answers are asked for as text) and whether it takes Amazon
// Bedrock's prompt cache. They start right for its maker (Anthropic: all three; Amazon: the cache; anyone else: none)
// until the owner changes one. Changing its model ID or Region makes it "Not checked yet" again (D6), and every
// line says who makes it and who runs it ("Mistral on Amazon Bedrock", D8).
import { useId, useState, type ReactNode } from "react";
import { ApiError, friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { storiesApi } from "../api/client.ts";
import { callingFor, CUSTOM_MODEL_KEY, EFFORT_LABEL, MAX_CUSTOM_MODELS, type Effort, type EffortField, type ModelCalling, type ModelDef, type ModelInfo, type Price } from "../api/types.ts";
import { Btn, cheer, Chip, MODEL_STATUS, Note, SetCard, SetPick, SetSelect, SetSwitch, SIcon, whenText } from "./bits.tsx";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Who makes the model: the usual Bedrock makers, or anyone else by name. */
const MAKERS = ["Anthropic", "Amazon", "Meta", "Mistral"] as const;
const SOMEONE_ELSE = "other";

/**
 * Amazon Bedrock Regions, with the place first so the owner knows which one he means. Lamo Stories runs in Stockholm.
 * Any other Region (a new one included) is typed under "Another Region": the API takes every Region code.
 */
export const REGIONS: { value: string; label: string }[] = [
  { value: "eu-north-1", label: "Europe (Stockholm) · eu-north-1" },
  { value: "eu-west-1", label: "Europe (Ireland) · eu-west-1" },
  { value: "eu-west-2", label: "Europe (London) · eu-west-2" },
  { value: "eu-west-3", label: "Europe (Paris) · eu-west-3" },
  { value: "eu-central-1", label: "Europe (Frankfurt) · eu-central-1" },
  { value: "eu-central-2", label: "Europe (Zurich) · eu-central-2" },
  { value: "eu-south-1", label: "Europe (Milan) · eu-south-1" },
  { value: "eu-south-2", label: "Europe (Spain) · eu-south-2" },
  { value: "us-east-1", label: "US East (N. Virginia) · us-east-1" },
  { value: "us-east-2", label: "US East (Ohio) · us-east-2" },
  { value: "us-west-1", label: "US West (N. California) · us-west-1" },
  { value: "us-west-2", label: "US West (Oregon) · us-west-2" },
  { value: "us-gov-west-1", label: "AWS GovCloud (US-West) · us-gov-west-1" },
  { value: "us-gov-east-1", label: "AWS GovCloud (US-East) · us-gov-east-1" },
  { value: "ca-central-1", label: "Canada (Central) · ca-central-1" },
  { value: "sa-east-1", label: "South America (São Paulo) · sa-east-1" },
  { value: "ap-south-1", label: "Asia Pacific (Mumbai) · ap-south-1" },
  { value: "ap-south-2", label: "Asia Pacific (Hyderabad) · ap-south-2" },
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore) · ap-southeast-1" },
  { value: "ap-southeast-2", label: "Asia Pacific (Sydney) · ap-southeast-2" },
  { value: "ap-northeast-1", label: "Asia Pacific (Tokyo) · ap-northeast-1" },
  { value: "ap-northeast-2", label: "Asia Pacific (Seoul) · ap-northeast-2" },
  { value: "ap-northeast-3", label: "Asia Pacific (Osaka) · ap-northeast-3" },
];
export const DEFAULT_REGION = "eu-north-1";
export const DEFAULT_MAX_TOKENS = 16_000;
/** The most the API takes for maxOutputTokens (model_defs.MAX_OUTPUT). */
export const MAX_TOKENS = 500_000;
/** An AWS Region code, as the API checks it (model_defs.REGION). */
export const REGION_CODE = /^[a-z]{2}(-gov)?-[a-z]+-[0-9]{1,2}$/;
const ANOTHER_REGION = "another";

/** A Region code the owner typed, or what to fix, in plain words. */
export function regionProblem(code: string): string | null {
  return REGION_CODE.test(code.trim()) ? null : "Type the AWS Region code where the model runs, like eu-west-2 or ap-south-1.";
}

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
  /** how Lamo Stories calls it (§45.35 D1); they follow the maker until the owner changes one (`ownCalling`) */
  effortField: EffortField;
  tools: boolean;
  cache: boolean;
  ownCalling: boolean;
  modelId: string;
  /** a listed Region, or ANOTHER_REGION with the code in otherRegion */
  region: string;
  otherRegion: string;
  efforts: Effort[];
  defaultEffort: Effort | null;
  vision: boolean;
  maxTokens: string;
  priced: boolean;
  input: string;
  output: string;
  currency: string;
}

/**
 * How an added model is called: what it says itself, else what its maker's models take. A model with levels takes them;
 * one with none ticked has no effort setting, whatever it was saved with (an Anthropic model saved before round 4 reads
 * back as output_config with no levels: nothing is ever sent to it, so it shows, and saves again, as none).
 */
export function callingOf(m: Pick<ModelInfo, "provider" | "efforts" | "effortField" | "tools" | "cache">): ModelCalling {
  const usual = callingFor(m.provider);
  return {
    effortField: m.efforts.length ? (m.effortField ?? "output_config") : "none",
    tools: m.tools ?? usual.tools,
    cache: m.cache ?? usual.cache,
  };
}

/** The maker a draft names (a listed one, or the name typed under Someone else). */
const makerOf = (d: Pick<Draft, "maker" | "otherMaker">) => (d.maker === SOMEONE_ELSE ? d.otherMaker.trim() : d.maker);

/** The draft after the maker changed: the three ways of calling it follow the new maker unless the owner set them. */
export function withMaker(d: Draft, patch: Partial<Pick<Draft, "maker" | "otherMaker">>): Draft {
  const next = { ...d, ...patch };
  if (d.ownCalling) return next;
  const usual = callingFor(makerOf(next));
  return { ...next, ...usual, efforts: usual.effortField === "none" ? [] : next.efforts, defaultEffort: usual.effortField === "none" ? null : next.defaultEffort };
}

function draftOf(m: ModelInfo | null): Draft {
  const known = m && (MAKERS as readonly string[]).includes(m.provider);
  const price = m?.price ?? null;
  const calling = m ? callingOf(m) : callingFor("Anthropic");
  return {
    label: m?.label ?? "",
    maker: m ? (known ? m.provider : SOMEONE_ELSE) : "Anthropic",
    otherMaker: m && !known ? m.provider : "",
    ...calling,
    // An existing model keeps what it was saved with: a new maker name no longer moves them.
    ownCalling: !!m,
    modelId: m?.modelId ?? "",
    region: m?.region && !REGIONS.some((r) => r.value === m.region) ? ANOTHER_REGION : (m?.region ?? DEFAULT_REGION),
    otherRegion: m?.region && !REGIONS.some((r) => r.value === m.region) ? m.region : "",
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
  const region = d.region === ANOTHER_REGION ? d.otherRegion.trim() : d.region;
  const badRegion = regionProblem(region);
  if (badRegion) return { problem: badRegion };
  const efforts = d.effortField === "none" ? [] : EFFORTS.filter((e) => d.efforts.includes(e));
  if (d.effortField === "output_config" && !efforts.length) return { problem: "Tick the effort levels it accepts, or switch off It has effort levels." };
  if (efforts.length && (!d.defaultEffort || !efforts.includes(d.defaultEffort))) return { problem: "Pick its own level, the one it uses when nothing else is set." };
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
    region,
    efforts,
    defaultEffort: efforts.length ? d.defaultEffort : null,
    vision: d.vision,
    maxOutputTokens: tokens,
    price,
    effortField: d.effortField,
    tools: d.tools,
    cache: d.cache,
  };
}

/** "Effort levels · tools · prompt cache", or what it does without them, in a few words. */
export function callingWords(c: ModelCalling): string {
  return [c.effortField === "output_config" ? "Takes effort levels" : "No effort levels", c.tools ? "uses tools" : "no tools", c.cache ? "prompt cache on" : "no prompt cache"].join(" · ");
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
      // Ticking its levels is saying how it is called: a later maker change no longer moves the three switches.
      return { ...x, efforts, defaultEffort, ownCalling: true };
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
          onChange={(v) => setD((x) => withMaker(x, { maker: v }))}
          options={[...MAKERS.map((m) => ({ value: m, label: m })), { value: SOMEONE_ELSE, label: "Someone else" }]}
        />
      </span>
      {d.maker === SOMEONE_ELSE ? (
        <Field id={`${id}-other`} label="Its maker's name">
          <input id={`${id}-other`} className="st-stg-input" value={d.otherMaker} maxLength={40} placeholder="Cohere" onChange={(e) => setD((x) => withMaker(x, { otherMaker: e.target.value }))} />
        </Field>
      ) : null}
      <Field
        id={`${id}-mid`}
        label="Bedrock model ID or inference profile"
        hint="Copy it from the Amazon Bedrock console: a model ID, an inference profile like eu.amazon.nova-premier-v1:0, or its ARN."
      >
        <input id={`${id}-mid`} className="st-stg-input st-stg-input--code" value={d.modelId} spellCheck={false} autoComplete="off" maxLength={200} placeholder="eu.amazon.nova-premier-v1:0" onChange={(e) => set({ modelId: e.target.value })} />
      </Field>
      <span className="st-stg-region">
        <SetSelect label="AWS Region" value={d.region} options={[...REGIONS, { value: ANOTHER_REGION, label: "Another Region: type its code" }]} onChange={(v) => set({ region: v })} />
        {d.region === ANOTHER_REGION ? (
          <Field id={`${id}-region`} label="Its Region code" hint="The Bedrock console shows it at the top right, like eu-west-2.">
            <input
              id={`${id}-region`}
              className="st-stg-input st-stg-input--code"
              value={d.otherRegion}
              spellCheck={false}
              autoComplete="off"
              maxLength={20}
              placeholder="eu-west-2"
              onChange={(e) => set({ otherRegion: e.target.value })}
            />
          </Field>
        ) : null}
      </span>

      <span className="st-stg-field st-stg-calling">
        <span className="st-stg-label">How Lamo Stories talks to it</span>
        <span className="st-stg-small">
          {d.ownCalling
            ? "Change these only if Amazon Bedrock says the model does not take them."
            : `These start right for ${makerOf(d) || "its maker"}'s models. Change one only if Amazon Bedrock says the model does not take it.`}
        </span>
      </span>
      <SetSwitch
        label="It has effort levels"
        description={d.effortField === "output_config" ? "Lamo Stories sends the level you pick, the way Claude models take it." : "It runs at its own level. Lamo Stories never sends it one."}
        checked={d.effortField === "output_config"}
        onChange={(v) => setD((x) => ({ ...x, ownCalling: true, effortField: v ? "output_config" : "none", efforts: v ? x.efforts : [], defaultEffort: v ? x.defaultEffort : null }))}
      />
      {d.effortField === "output_config" ? (
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
          <span className="st-stg-small">{d.efforts.length ? "Only these levels are ever sent to it." : "Tick the levels it accepts. Only those are ever sent to it."}</span>
        </span>
      ) : null}
      {d.effortField === "output_config" && d.efforts.length ? (
        <span className="st-stg-field">
          <span className="st-stg-label">Its own level</span>
          <SetPick<Effort> label="Its own level" value={d.defaultEffort} onChange={(v) => set({ defaultEffort: v })} options={d.efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] }))} />
        </span>
      ) : null}
      <SetSwitch
        label="It can use tools"
        description={
          d.tools ? "In the chat it can do things for you, like starting a video. Answers come back in a tidy shape." : "It only talks: in the chat it cannot start things, and Lamo Stories asks it for tidy answers as text."
        }
        checked={d.tools}
        onChange={(v) => set({ tools: v, ownCalling: true })}
      />
      <SetSwitch
        label="It can reuse its instructions"
        description={d.cache ? "Amazon Bedrock keeps the long instructions for a few minutes (its prompt cache), so answers come faster and cost less." : "Every answer reads the whole instructions again. Fine for a model that has no prompt cache."}
        checked={d.cache}
        onChange={(v) => set({ cache: v, ownCalling: true })}
      />
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

function OwnRow({ ws, m, stale = false, onChanged, onEdit }: { ws: string; m: ModelInfo; /** its model ID or Region changed since its last check */ stale?: boolean; onChanged: () => Promise<void>; onEdit: () => void }) {
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
        {/* The API clears a moved model's last check (§45.35 D6): "Not checked yet"; an older one kept it: "Check it again". */}
        {stale && m.status !== "not_checked" ? <Chip tone="sun">Check it again</Chip> : <Chip tone={s.tone}>{s.label}</Chip>}
      </div>
      <p className="st-stg-small">
        Made by {m.provider} · on {m.host ?? "Amazon Bedrock"}
        {m.region ? ` in ${m.region}` : ""} · <code className="st-stg-code">{m.modelId}</code>
      </p>
      <p className="st-stg-small">
        {m.efforts.length ? `Levels: ${m.efforts.map((e) => EFFORT_LABEL[e]).join(", ")}. Its own: ${m.defaultEffort ? EFFORT_LABEL[m.defaultEffort] : "none"}.` : "No effort setting: it runs at its own level."}
        {m.vision ? " Looks at pictures." : " Words only."}
      </p>
      <p className="st-stg-small">{callingWords(callingOf(m))}.</p>
      <p className="st-stg-small">
        {stale ? "Changed since its last check. Check it again: tap Check models above to see if it answers now." : m.statusLine}
        {!stale && m.checkedAt ? ` (${whenText(m.checkedAt)})` : ""}
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

/** The model just saved: suggest checking it while it is new, or its model ID or Region changed since `checkedAt`. */
interface Saved {
  key: string;
  /** a new model, or an existing one whose model ID or Region changed */
  moved: boolean;
  /** an existing model that was changed (not a new one) */
  edited: boolean;
  checkedAt: string | null;
}

/**
 * A changed model ID or Region whose new check has not come yet (§45.35 D6): the API clears its status ("Not checked
 * yet") until Check models answers; an older API kept the old one, which is then just as stale until a new check.
 */
export function movedUnchecked(saved: Saved | null, m: Pick<ModelInfo, "status" | "checkedAt"> | undefined): boolean {
  if (!saved || !m || !saved.edited || !saved.moved) return false;
  return m.status === "not_checked" || (m.checkedAt ?? null) === saved.checkedAt;
}

/**
 * The "Add a model" card: the owner's own Bedrock models, the form, and after a save the suggestion to check it
 * (`check` is the section's Check models for just that model).
 */
export function OwnModels({ ws, models, onChanged, check }: { ws: string; models: ModelInfo[]; onChanged: () => Promise<void>; check: (key: string) => ReactNode }) {
  const [open, setOpen] = useState<"new" | string | null>(null);
  const [added, setAdded] = useState<Saved | null>(null);
  const own = models.filter((m) => m.custom);
  const full = own.length >= MAX_CUSTOM_MODELS;
  const just = added ? models.find((m) => m.key === added.key) : undefined;
  // A changed model ID or Region: its last check was of the old one, until a new check is stamped.
  const stale = movedUnchecked(added, just);
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
      {just && (just.status === "not_checked" || stale) ? (
        <div className="st-stg-suggest" role="status">
          <Note tone="sun" icon="retry">
            {stale
              ? `${just.label} is changed, so its last check no longer counts. Check it again: Amazon Bedrock says whether this account may use it.`
              : `${just.label} is listed, but it has not answered yet. Check it now: Amazon Bedrock says whether this account may use it.`}
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
            setAdded({ key: m.key, moved: true, edited: false, checkedAt: m.checkedAt ?? null });
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
                    // The check it had before this change (the API answers with the cleared one when it moved).
                    setAdded({ key: saved.key, moved: saved.modelId !== m.modelId || saved.region !== m.region, edited: true, checkedAt: m.checkedAt ?? null });
                    void onChanged();
                  }}
                />
              </li>
            ) : (
              <OwnRow key={m.key} ws={ws} m={m} stale={stale && m.key === just?.key} onChanged={onChanged} onEdit={() => setOpen(m.key)} />
            ),
          )}
        </ul>
      ) : open === null ? (
        <p className="st-stg-small">No models added yet. The ones above come with Lamo Stories; add any other Bedrock model here.</p>
      ) : null}
    </SetCard>
  );
}
