// Lamo Stories › Settings › Video › Add a picture, video or sound model (docs/CONTRACTS.md §45.37 G2; request 2 §3
// "support adding new models and providers without rebuilding the application", §5 "Image-generation models.
// Video-generation models. Audio-generation models … allow me to select these providers and models independently").
// Like Settings › AI's own models (OwnModels): the owner's maker models are listed with an "Added by you" mark, can
// be changed (Edit) or removed (Remove: a model Settings › Video still picks is refused with the API's own sentence,
// shown here), and are checked by Check models, which for these is an access check that costs nothing (Works, No
// access, Not found, in the provider's own words). Where each kind runs: pictures on Amazon Bedrock or an
// OpenAI-compatible service, video on Amazon Bedrock, sound on ElevenLabs or Amazon Bedrock; a keyed service uses the
// owner's key from Provider keys, never shown again. A sound model makes sound effects and music only, never a voice.
import { useId, useState, type ReactNode } from "react";
import { ApiError, friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { storiesApi } from "../api/client.ts";
import { CUSTOM_MODEL_KEY, HOST_LABEL, MAKER_HOSTS, MAX_CUSTOM_MAKER_MODELS, type MakerHost, type MakerKind, type MakerModelDef, type MakerModelInfo } from "../api/types.ts";
import { CheckModels } from "./AiSection.tsx";
import { Btn, cheer, Chip, makerWho, MODEL_STATUS, money, Note, SetCard, SetPick, SetSelect, SetSwitch, SIcon, whenText } from "./bits.tsx";
import { regionWords } from "./makerFile.ts";
import { DEFAULT_REGION, keyFor, modelIdProblem, regionProblem, REGIONS } from "./OwnModels.tsx";

const KINDS: { value: MakerKind; label: string; line: string }[] = [
  { value: "image", label: "Pictures", line: "AI portraits of your characters" },
  { value: "video", label: "Video", line: "AI shots for scenes with no character" },
  { value: "audio", label: "Sound", line: "Sound effects and music, never a voice" },
];

/** Each host in the form's words. */
export const MAKER_HOST_WORDS: Record<MakerHost, { label: string; line: string }> = {
  bedrock: { label: "Amazon Bedrock", line: "Lamo Stories' own AWS access. No key." },
  openai_compatible: { label: "An OpenAI-compatible service", line: "Any https address that makes pictures the OpenAI way, with your key." },
  elevenlabs: { label: "ElevenLabs", line: "Sound effects and music with your ElevenLabs key." },
};

/** What a price is counted in, for each kind. */
export const UNIT_OF: Record<MakerKind, { unit: string; per: string }> = {
  image: { unit: "image", per: "one picture" },
  video: { unit: "second", per: "one second of video" },
  audio: { unit: "second", per: "one second of sound" },
};

/** The usual maker of each host and kind, so the form starts right. */
function usualMaker(kind: MakerKind, host: MakerHost): string {
  if (host === "elevenlabs") return "ElevenLabs";
  if (kind === "image") return host === "bedrock" ? "Stability AI" : "";
  if (kind === "video") return "Luma AI";
  return "";
}

/** The model id's hint and example for each host and kind. */
export function modelIdHint(kind: MakerKind, host: MakerHost): { hint: string; example: string } {
  if (host === "elevenlabs") return { hint: "The model's name in ElevenLabs, like eleven_text_to_sound_v2 or music_v1.", example: "eleven_text_to_sound_v2" };
  if (host === "openai_compatible") return { hint: "The model's name as that service lists it.", example: "my-picture-model" };
  if (kind === "image") return { hint: "Copy it from the Amazon Bedrock console: a Stability AI or Amazon picture model ID.", example: "stability.stable-image-core-v1:1" };
  if (kind === "video") return { hint: "Copy it from the Amazon Bedrock console: a video model ID.", example: "luma.ray-v2:0" };
  return { hint: "Copy it from the Amazon Bedrock console: a sound or music model ID.", example: "maker.sound-model-v1:0" };
}

/** A keyed model name: no spaces, at most 200 characters (the API's hosts.KEYED_MODEL_ID). */
const KEYED_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/** An https base URL, as the API wants it (it checks the rest: never a private or local address). */
export function baseUrlProblem(v: string): string | null {
  const t = v.trim();
  if (!t) return "Paste the service's address, like https://api.example.com/v1.";
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return "That is not a web address. Paste one like https://api.example.com/v1.";
  }
  if (u.protocol !== "https:") return "The address must start with https:// so the key travels safely.";
  if (u.username || u.password) return "Leave the name and password out of the address. Save the key in Provider keys.";
  if (u.search || u.hash || t.includes("?") || t.includes("#")) return "Leave out anything after ? or # in the address.";
  if (!u.hostname.includes(".")) return "That address is not on the public internet. Lamo Stories can only call a public https address.";
  return null;
}

interface Draft {
  kind: MakerKind;
  host: MakerHost;
  /** the owner picked where it runs himself: a new kind keeps it when it can */
  hostPicked?: boolean;
  label: string;
  provider: string;
  modelId: string;
  region: string;
  otherRegion: string;
  baseUrl: string;
  priced: boolean;
  price: string;
  currency: string;
  note: string;
}

const ANOTHER = "another";

function draftOf(m: MakerModelInfo | null, kind: MakerKind): Draft {
  const host = (m?.hostId as MakerHost | undefined) ?? (kind === "audio" ? "elevenlabs" : "bedrock");
  const listed = m?.region && REGIONS.some((r) => r.value === m.region);
  return {
    kind: m?.kind ?? kind,
    host,
    hostPicked: !!m,
    label: m?.label ?? "",
    provider: m?.provider ?? usualMaker(kind, host),
    modelId: m?.modelId ?? "",
    region: m?.region ? (listed ? m.region : ANOTHER) : kind === "audio" ? DEFAULT_REGION : "us-west-2",
    otherRegion: m?.region && !listed ? m.region : "",
    baseUrl: m?.baseUrl ?? "",
    priced: !!m?.price,
    price: m?.price ? String(m.price.perUnit) : "",
    currency: m?.price?.currency ?? "USD",
    note: m?.note ?? "",
  };
}

/** The MakerModelDef the form describes, or the first thing to fix, in plain words. */
export function makerDefOf(d: Draft): MakerModelDef | { problem: string } {
  const label = d.label.trim();
  if (!label) return { problem: "Give the model a name, like Stable Image Core." };
  if (label.length > 60) return { problem: "Keep the name to 60 letters or fewer." };
  const provider = d.provider.trim();
  if (!provider) return { problem: "Say who makes the model." };
  if (provider.length > 40) return { problem: "Keep who makes it to 40 letters or fewer." };
  if (!MAKER_HOSTS[d.kind].includes(d.host)) return { problem: `${MAKER_HOST_WORDS[d.host].label} cannot make ${d.kind === "image" ? "pictures" : d.kind === "video" ? "video" : "sound"}. Pick where it runs again.` };
  const id = d.modelId.trim();
  if (d.host === "bedrock") {
    const bad = modelIdProblem(id);
    if (bad) return { problem: bad };
  } else if (!KEYED_ID.test(id) || id.includes("..")) return { problem: "Type the model's name exactly as the service spells it, with no spaces." };
  const region = d.region === ANOTHER ? d.otherRegion.trim() : d.region;
  if (d.host === "bedrock") {
    const bad = regionProblem(region);
    if (bad) return { problem: bad };
  }
  if (d.host === "openai_compatible") {
    const bad = baseUrlProblem(d.baseUrl);
    if (bad) return { problem: bad };
  }
  let price: MakerModelDef["price"] = null;
  if (d.priced) {
    const n = Number(d.price.replace(",", ".").trim());
    if (!d.price.trim() || !Number.isFinite(n) || n < 0 || n > 100) return { problem: `Type the price for ${UNIT_OF[d.kind].per} as a number, like 0.04.` };
    price = { perUnit: n, unit: UNIT_OF[d.kind].unit, currency: d.currency };
  }
  if (d.note.trim().length > 200) return { problem: "Keep the note to 200 letters or fewer." };
  return {
    label,
    provider,
    kind: d.kind,
    host: d.host,
    modelId: id,
    ...(d.host === "bedrock" ? { region } : {}),
    ...(d.host === "openai_compatible" ? { baseUrl: d.baseUrl.trim().replace(/\/+$/, "") } : {}),
    price,
    note: d.note.trim(),
  };
}

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

function MakerForm({ ws, start, kind, taken, onSaved, onCancel }: { ws: string; start: MakerModelInfo | null; kind: MakerKind; taken: string[]; onSaved: (m: MakerModelInfo) => void; onCancel: () => void }) {
  const toast = useToast();
  const id = useId();
  const [d, setD] = useState<Draft>(() => draftOf(start, kind));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const editing = !!start;
  const hosts = MAKER_HOSTS[d.kind];
  const ids = modelIdHint(d.kind, d.host);
  const save = async (el: HTMLElement | null) => {
    if (busy) return;
    const def = makerDefOf(d);
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
      const saved = await storiesApi().putMakerModel(ws, key, def);
      cheer(el);
      toast.success(editing ? `${saved.label} is saved.` : `${saved.label} is added! Tap Check models to see if this account may use it.`);
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
      className="st-stg-form st-stg-modelform st-stg-makerform"
      aria-label={editing ? `Change ${start?.label ?? "the model"}` : "Add a picture, video or sound model"}
      onSubmit={(e) => {
        e.preventDefault();
        void save(e.currentTarget.querySelector("button[type=submit]"));
      }}
    >
      <span className="st-stg-field">
        <span className="st-stg-label">What it makes</span>
        <SetPick<MakerKind>
          label="What it makes"
          value={d.kind}
          options={KINDS}
          onChange={(v) =>
            setD((x) => {
              // Each kind starts where its models usually run (sound: ElevenLabs, Amazon Bedrock has no sound model yet).
              const host = x.hostPicked && MAKER_HOSTS[v].includes(x.host) ? x.host : MAKER_HOSTS[v][0]!;
              return { ...x, kind: v, host, provider: x.provider.trim() && x.provider !== usualMaker(x.kind, x.host) ? x.provider : usualMaker(v, host) };
            })
          }
        />
      </span>
      {d.kind === "audio" ? <Note tone="sky">Sound models make sound effects and music only. Lamo Stories never asks them for a voice.</Note> : null}
      <span className="st-stg-field">
        <span className="st-stg-label">Where it runs</span>
        <SetPick<MakerHost>
          label="Where it runs"
          stack
          value={d.host}
          options={hosts.map((h) => ({ value: h, label: MAKER_HOST_WORDS[h].label, line: MAKER_HOST_WORDS[h].line }))}
          onChange={(v) => setD((x) => ({ ...x, host: v, hostPicked: true, provider: x.provider.trim() && x.provider !== usualMaker(x.kind, x.host) ? x.provider : usualMaker(x.kind, v) }))}
        />
      </span>
      <Field id={`${id}-label`} label="Name">
        <input id={`${id}-label`} className="st-stg-input" value={d.label} maxLength={60} placeholder={d.kind === "image" ? "Stable Image Core" : d.kind === "video" ? "Luma Ray2" : "Rain and thunder sounds"} onChange={(e) => set({ label: e.target.value })} />
      </Field>
      <Field id={`${id}-maker`} label="Who makes it">
        <input id={`${id}-maker`} className="st-stg-input" value={d.provider} maxLength={40} placeholder="Stability AI" onChange={(e) => set({ provider: e.target.value })} />
      </Field>
      {d.host === "openai_compatible" ? (
        <Field id={`${id}-url`} label="The service's address" hint="Its https address, the part before /images/generations, like https://api.example.com/v1.">
          <input id={`${id}-url`} className="st-stg-input st-stg-input--code" inputMode="url" value={d.baseUrl} spellCheck={false} autoComplete="off" maxLength={300} placeholder="https://api.example.com/v1" onChange={(e) => set({ baseUrl: e.target.value })} />
        </Field>
      ) : null}
      <Field id={`${id}-mid`} label={d.host === "bedrock" ? "Bedrock model ID" : "Model name"} hint={ids.hint}>
        <input id={`${id}-mid`} className="st-stg-input st-stg-input--code" value={d.modelId} spellCheck={false} autoComplete="off" maxLength={200} placeholder={ids.example} onChange={(e) => set({ modelId: e.target.value })} />
      </Field>
      {d.host === "bedrock" ? (
        <span className="st-stg-region">
          <SetSelect label="AWS Region" value={d.region} options={[...REGIONS, { value: ANOTHER, label: "Another Region: type its code" }]} onChange={(v) => set({ region: v })} />
          {d.region === ANOTHER ? (
            <Field id={`${id}-region`} label="Its Region code" hint="The Bedrock console shows it at the top right, like us-west-2.">
              <input id={`${id}-region`} className="st-stg-input st-stg-input--code" value={d.otherRegion} spellCheck={false} autoComplete="off" maxLength={20} placeholder="us-west-2" onChange={(e) => set({ otherRegion: e.target.value })} />
            </Field>
          ) : null}
        </span>
      ) : (
        <p className="st-stg-small">It uses your {HOST_LABEL[d.host]} key, saved under Prices and keys below. The key is never shown again.</p>
      )}
      <SetSwitch label="I know its price" description="Without a price, its use is counted but no cost is worked out." checked={d.priced} onChange={(v) => set({ priced: v })} />
      {d.priced ? (
        <div className="st-stg-price__form">
          <Field id={`${id}-price`} label={`Price for ${UNIT_OF[d.kind].per}`}>
            <input id={`${id}-price`} className="st-stg-input" inputMode="decimal" value={d.price} placeholder="0.04" onChange={(e) => set({ price: e.target.value })} />
          </Field>
          <SetSelect label="Currency" value={d.currency} onChange={(v) => set({ currency: v })} options={["USD", "EUR", "GBP"].map((c) => ({ value: c, label: c }))} />
        </div>
      ) : null}
      <Field id={`${id}-note`} label="A short note (if you like)">
        <input id={`${id}-note`} className="st-stg-input" value={d.note} maxLength={200} placeholder="Good for soft, painted pictures" onChange={(e) => set({ note: e.target.value })} />
      </Field>
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

const KIND_WORD: Record<MakerKind, string> = { image: "Pictures", video: "Video", audio: "Sound" };

function MakerRow({ ws, m, onChanged, onEdit }: { ws: string; m: MakerModelInfo; onChanged: () => Promise<void>; onEdit: () => void }) {
  const toast = useToast();
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const s = MODEL_STATUS[m.status];
  const remove = async () => {
    setBusy(true);
    try {
      await storiesApi().deleteMakerModel(ws, m.key);
      toast.info(`${m.label} is removed from Lamo Stories.`);
      setSure(false);
      await onChanged();
    } catch (e) {
      // A model Settings › Video still picks stays: the API names where (409).
      const text = friendlyMessage(e);
      setRefused(e instanceof ApiError && e.code === "conflict" ? text : null);
      toast.error(text);
      setSure(false);
    } finally {
      setBusy(false);
    }
  };
  const keyed = !!m.hostId && m.hostId !== "bedrock";
  return (
    <li className="st-stg-own" data-maker-model={m.key}>
      <div className="st-stg-own__head">
        <span className="st-stg-own__name">{m.label}</span>
        <Chip tone="sky">{KIND_WORD[m.kind]}</Chip>
        <Chip tone="sky">Added by you</Chip>
        <Chip tone={s.tone}>{s.label}</Chip>
      </div>
      <p className="st-stg-small">
        Made by {makerWho(m)}
        {regionWords(m.region) ? ` · ${regionWords(m.region)}` : ""} · <code className="st-stg-code">{m.modelId}</code>
      </p>
      {m.price ? (
        <p className="st-stg-small">
          Price: {money(m.price.perUnit, m.price.currency)} for {UNIT_OF[m.kind].per}.
        </p>
      ) : null}
      {keyed && m.keySaved === false ? (
        <Note tone="sun" icon="key">
          Paste your {HOST_LABEL[m.hostId as MakerHost] ?? m.host} key under Prices and keys below, then tap Check models above.
        </Note>
      ) : null}
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
 * The "Add a picture, video or sound model" card: the owner's own maker models, the form, Check models for every maker
 * model that has not ended (a free access check), and after a save the suggestion to check the new one.
 */
export function MakerModels({ ws, models, onChanged }: { ws: string; models: MakerModelInfo[]; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState<"new" | string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const own = models.filter((m) => m.custom);
  const checkable = models.filter((m) => !m.ended).map((m) => m.key);
  const just = added ? models.find((m) => m.key === added) : undefined;
  const full = (k: MakerKind) => own.filter((m) => m.kind === k).length >= MAX_CUSTOM_MAKER_MODELS;
  const allFull = full("image") && full("video") && full("audio");
  return (
    <SetCard
      title="Add a picture, video or sound model"
      icon="plus"
      id="add-a-maker-model"
      lede="Use another picture, video or sound model, with no new version of the app: from Amazon Bedrock, an OpenAI-compatible service (pictures) or ElevenLabs (sound). Then check that this account may use it."
      actions={
        open === null ? (
          <>
            <Btn main off={allFull ? `You can add up to ${MAX_CUSTOM_MAKER_MODELS} models of each kind. Remove one first.` : undefined} onClick={() => setOpen("new")}>
              <SIcon name="plus" size={20} />
              Add a model
            </Btn>
            {checkable.length ? <CheckModels ws={ws} count={checkable.length} makers={checkable} onDone={onChanged} /> : null}
          </>
        ) : undefined
      }
    >
      {just && just.status === "not_checked" ? (
        <div className="st-stg-suggest" role="status">
          <Note tone="sun" icon="retry">
            {just.label} is listed, but it has not been checked yet. Check it now: it asks whether this account may use it, and costs nothing.
          </Note>
          <CheckModels ws={ws} count={1} makers={[just.key]} onDone={onChanged} />
        </div>
      ) : null}
      {open === "new" ? (
        <MakerForm
          ws={ws}
          start={null}
          kind="image"
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
        <ul className="st-stg-owns" aria-label="Picture, video and sound models you added">
          {own.map((m) =>
            open === m.key ? (
              <li key={m.key} className="st-stg-own">
                <MakerForm
                  ws={ws}
                  start={m}
                  kind={m.kind}
                  taken={models.map((x) => x.key)}
                  onCancel={() => setOpen(null)}
                  onSaved={(saved) => {
                    setOpen(null);
                    if (saved.modelId !== m.modelId || saved.region !== m.region || (saved.baseUrl ?? null) !== (m.baseUrl ?? null)) setAdded(saved.key);
                    void onChanged();
                  }}
                />
              </li>
            ) : (
              <MakerRow key={m.key} ws={ws} m={m} onChanged={onChanged} onEdit={() => setOpen(m.key)} />
            ),
          )}
        </ul>
      ) : open === null ? (
        <p className="st-stg-small">No models added yet. The makers above come with Lamo Stories; add any other picture, video or sound model here.</p>
      ) : null}
    </SetCard>
  );
}
