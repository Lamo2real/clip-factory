// Lamo Stories › Settings › Video (docs/CONTRACTS.md §45.29 Video, §45.31, §45.34, §45.37): the makers, picked apart
// from the AI models that write the stories (an LLM never "makes the video"): the video maker, the picture maker and
// the sound maker, each with its own model picked from its list (G1, with who makes it, where it runs, its price and
// its last check) and its real state (a maker that is not ready says what it needs; nothing switches to another one
// by itself). Amazon ended Nova Canvas and Nova Reel on 30 Sep 2026: they are listed as ended, never picked again,
// and an older pick of one says so with a one-tap replacement. The sound maker saves (G3): built-in sounds, ElevenLabs
// effects and music, the owner's own sound model, or, only when he picks it, a spoken voice (Amazon Polly). The
// owner's own picture, video and sound models (G2) are added below the makers. Then the default shape (9:16, 1:1 or
// 16:9) and its size, the frame rate, the usual length, the quality, the captions and music defaults, the use and
// costs, prices for the AI makers and provider keys.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import { storiesReduceMotion } from "../prefs.ts";
import {
  IMAGE_MAKERS,
  MAKER_FIELD_OF,
  makerModelsIn,
  OWN_MAKER,
  RESOLUTIONS,
  SOUND_MAKERS,
  VIDEO_MAKERS,
  type MakerKind,
  type MakerModelInfo,
  type MakerPrice,
  type ProviderStatus,
  type StoriesConfig,
  type StoriesConfigPatch,
  type VideoAspect,
  type VideoResolution,
} from "../api/types.ts";
import { Btn, Chip, Failed, hostName, Loading, makerWho, MODEL_STATUS, money, Note, PROVIDER_STATE, SavedMark, SectionBar, SetCard, SetPick, SetSwitch, useOnThisPage, useSaved, whenText, type SIconName } from "./bits.tsx";
import { useAi, useWorkspaceConfig } from "./data.ts";
import { bundledMakerModels, endedWords, regionWords } from "./makerFile.ts";
import { MakerModels } from "./MakerModels.tsx";
import { keepName, ProviderKeys } from "./ProviderKeys.tsx";
import { MakerPrices } from "./ProviderPrices.tsx";
import { ReelTry } from "./ReelTry.tsx";
import { StTech } from "../ui.tsx";
import { VideoUsage } from "./VideoUsage.tsx";

/** A model's exact ID (and its Region on Amazon Bedrock), said only behind "Technical details" (§45.36 E14). */
export const modelTech = (m: { label: string; host: string; modelId: string; region?: string | null }) => `On ${m.host}: ${m.label} (${m.modelId})${m.region ? ` in ${m.region}` : ""}.`;

/**
 * Each maker's name, what it uses and one line (§45.37's ids; an id the API adds later is named by its own label).
 * `model` is its plain name; `tech` its exact Bedrock ID, folded away (§45.36 E14).
 */
export const MAKERS: Record<string, { label: string; model: string; line: string; short?: string; tech?: string }> = {
  "builtin-2d": { label: "Built-in animator", model: "Clips Funded's own 2D animator", line: "Moves every character the same way, every time." },
  "luma-ray": {
    label: "Luma AI Ray2",
    short: "Luma AI Ray2",
    model: "Luma AI Ray2",
    tech: modelTech({ label: "Luma AI Ray2", host: "Amazon Bedrock", modelId: "luma.ray-v2:0", region: "us-west-2" }),
    line: "AI shots for scenes with no character. Runs in the US (Oregon). Posts get an AI label.",
  },
  "own-video": { label: "Your own video model", model: "A video model you added", line: "AI shots from a video model you add below." },
  "nova-reel": { label: "Amazon Nova Reel", model: "Amazon Nova Reel 1.1", line: "Ended by Amazon on 30 Sep 2026. It made AI footage for cut-aways (scenes with no character)." },
  "builtin-rig": { label: "Built-in drawings", model: "Clips Funded's own character drawings", line: "Every character looks the same in every video." },
  stability: {
    label: "Also AI portraits (Stability AI)",
    short: "Stability AI pictures",
    model: "Stability AI on Amazon Bedrock",
    line: "A portrait of each character. Videos still use the drawings. Runs in the US (Oregon).",
  },
  "own-images": { label: "Also AI portraits (your own picture model)", model: "A picture model you added", line: "Portraits from a picture model you add below. Videos still use the drawings." },
  "nova-canvas": { label: "Amazon Nova Canvas", model: "Amazon Nova Canvas", line: "Ended by Amazon on 30 Sep 2026. It made AI portraits." },
  "builtin-synth": { label: "Built-in sounds and music", short: "Built-in sounds and music", model: "Clips Funded's own sound maker", line: "Every sound effect, noise and tune, made fresh for each video." },
  elevenlabs: {
    label: "ElevenLabs sound effects and music",
    model: "ElevenLabs",
    line: "Sound effects and music, with your ElevenLabs key. Never a voice.",
  },
  "own-sound": { label: "Your own sound model", model: "A sound model you added", line: "Sound effects and music from a sound model you add below. Never a voice." },
  polly: { label: "A spoken voice (Amazon Polly)", model: "Amazon Polly neural voices", line: "Adds words spoken aloud. Your videos are made without a voice unless you pick this." },
};

/** Each maker card (§45.37): its title, the makers it lists and its words. */
export const MAKER_CARDS: Record<MakerKind, { title: string; icon: SIconName; id: string; lede: string; list: string[]; noun: string }> = {
  video: { title: "Video maker", icon: "film", id: "video-maker", lede: "What turns each story into moving pictures.", list: VIDEO_MAKERS, noun: "video" },
  image: { title: "Picture maker", icon: "brush", id: "picture-maker", lede: "How the characters are drawn.", list: IMAGE_MAKERS, noun: "picture" },
  audio: { title: "Sound maker", icon: "sound", id: "sound-maker", lede: "Effects and music. No voice-over unless you pick a spoken voice.", list: SOUND_MAKERS, noun: "sound" },
};

/** Which maker a model belongs to: the API says (`maker`); an added model is its kind's own maker. */
export function makerOfModel(m: Pick<MakerModelInfo, "maker" | "custom" | "kind" | "key">): string {
  return m.maker ?? (m.custom ? OWN_MAKER[m.kind] : m.key);
}

/** A maker's models, in the API's order. */
export function modelsOfMaker(models: readonly MakerModelInfo[], kind: MakerKind, maker: string): MakerModelInfo[] {
  return models.filter((m) => m.kind === kind && makerOfModel(m) === maker);
}

/** The model a maker uses: the one picked, else its first model that has not ended (§45.37 G1). */
export function usedModel(models: readonly MakerModelInfo[], kind: MakerKind, maker: string, picked: string | null | undefined): MakerModelInfo | undefined {
  const mine = modelsOfMaker(models, kind, maker);
  return mine.find((m) => m.key === picked) ?? mine.find((m) => !m.ended);
}

/** "US$0.04 a picture", "US$0.75 a second", or null with no price known. */
export function priceWords(p: MakerPrice | null | undefined): string | null {
  if (!p) return null;
  const per = p.unit === "image" ? "a picture" : p.unit === "second" ? "a second" : p.unit === "character" ? "a character spoken" : `per ${p.unit}`;
  return `${money(p.perUnit, p.currency)} ${per}`;
}

/** The maker models from the file while GET …/providers loads (or when it fails): every one "Not checked yet". */
export function fallbackMakerModels(): MakerModelInfo[] {
  return bundledMakerModels().map((m) =>
    m.ended
      ? { ...m, custom: false, status: "not_found", statusLine: "Ended by Amazon on 30 Sep 2026.", checkedAt: null }
      : { ...m, custom: false, status: "not_checked", statusLine: "Not checked yet. Tap Check models to see if it works.", checkedAt: null },
  );
}

/** The maker models to show: from the maker rows of GET …/providers (§45.37: no route of their own), else the file's. */
export function shownMakerModels(providers: readonly ProviderStatus[] | null | undefined): MakerModelInfo[] {
  const listed = makerModelsIn(providers);
  return providers && providers.some((p) => p.models) ? listed : fallbackMakerModels();
}

const QUALITY: { value: StoriesConfig["video"]["quality"]; label: string; line: string }[] = [
  { value: "standard", label: "Good", line: "Smaller files" },
  { value: "high", label: "Better", line: "The usual" },
  { value: "best", label: "Best", line: "Sharpest, bigger files" },
];

/** The three shapes, the one Shorts, Reels and TikTok want first (§45.34). */
export const SHAPES: { value: VideoAspect; label: string; line: string }[] = [
  { value: "9:16", label: "9:16 tall", line: "For Shorts, Reels and TikTok" },
  { value: "1:1", label: "1:1 square", line: "For feeds and posts" },
  { value: "16:9", label: "16:9 wide", line: "For YouTube videos and big screens" },
];

/** "1080 × 1920" from "1080x1920". */
export function sizeWords(r: VideoResolution): string {
  return r.replace("x", " × ");
}

/** A new shape keeps the same sharpness: the big size stays big, the small one small. */
export function sizeFor(aspect: VideoAspect, from: VideoResolution): VideoResolution {
  const small = Object.values(RESOLUTIONS).some((sizes) => sizes[1] === from);
  return RESOLUTIONS[aspect][small ? 1 : 0]!;
}

function stateOf(providers: ProviderStatus[] | null, id: string): ProviderStatus | undefined {
  return providers?.find((p) => p.id === id);
}

/**
 * A maker an option can show: ended, or the owner's own maker with no model of its kind yet, cannot be picked. `here`
 * says the API's line on the page it names (§45.36 E17).
 */
function makerOption(providers: ProviderStatus[] | null, id: string, ownModels: number, noun: string, here: (text: string) => string = (t) => t) {
  const p = stateOf(providers, id);
  const s = p ? PROVIDER_STATE[p.state] : null;
  const isEnded = p?.state === "ended" || id === "nova-canvas" || id === "nova-reel";
  const isOwn = id.startsWith("own-");
  return {
    value: id,
    label: MAKERS[id]?.label ?? p?.label ?? "Another maker",
    line: isEnded ? undefined : (MAKERS[id]?.line ?? (p?.line ? here(p.line) : undefined)),
    chip: isEnded ? <Chip tone="coral">Ended</Chip> : s ? <Chip tone={s.tone}>{s.label}</Chip> : undefined,
    off: isEnded
      ? `${endedWords("2026-09-30")}.`
      : isOwn && !ownModels
        ? `Add your own ${noun} model below first.`
        : p?.state === "unavailable"
          ? here(p.line) || "Not available yet."
          : undefined,
  };
}

/** What a maker that is not working yet still needs, saying "is not ready yet" once (the API's line often says it). */
export function notReadyLine(p: Pick<ProviderStatus, "label" | "line">): string {
  return /\bis not ready yet\b/.test(p.line) ? p.line : `${p.label} is not ready yet. ${p.line}`;
}

/** The maker's state under its pick: what it needs while it is not ready, in the API's own words, said on this page. */
function MakerState({ p }: { p: ProviderStatus | undefined }) {
  const here = useOnThisPage();
  if (!p || (p.state !== "needs_setup" && p.state !== "unavailable")) return null;
  return (
    <Note tone="sun" role="status">
      {/* The API's line may already say it is not ready (§45.34's sentence, with the maker's short name): then it is said once. */}
      {here(notReadyLine(p))}
      {p.lastError && p.lastError !== p.line ? ` Last problem: ${here(p.lastError)}` : ""}
    </Note>
  );
}

/** One maker model as a pick option: who makes it and where it runs, its price, and its last check. */
function modelOption(m: MakerModelInfo) {
  const ended = endedWords(m.ended);
  const s = MODEL_STATUS[m.status];
  const bits = [makerWho(m), regionWords(m.region), priceWords(m.price) ?? "No price known"].filter(Boolean);
  return {
    value: m.key,
    label: m.label,
    line: bits.join(" · "),
    chip: ended ? <Chip tone="coral">Ended</Chip> : <Chip tone={s.tone}>{s.label}</Chip>,
    off: ended ? `${ended}.` : undefined,
  };
}

/**
 * The picked model's details: its plain name first, its exact ID one tap away (§45.36 E14), its line, price, last check
 * and, when it was refused, the provider's own sentence, said on this page (§45.36 E17).
 */
function ModelDetails({ m, brief = false }: { m: MakerModelInfo; /** under its own pick, whose option already says who makes it, where it runs and its price */ brief?: boolean }) {
  const here = useOnThisPage();
  const refused = m.status === "denied" || m.status === "not_found" || m.status === "error";
  // Where it runs, said once: a note that already says it ("Runs in the US (Oregon). …") is enough.
  const region = regionWords(m.region);
  const where = region && !m.note?.includes(region) ? region : null;
  return (
    <div className="st-stg-makermodel" data-maker-model={m.key}>
      <p className="st-stg-active">
        <span className="st-stg-active__word">Model</span>
        <strong>{m.label}</strong>
        <Chip tone={MODEL_STATUS[m.status].tone}>{MODEL_STATUS[m.status].label}</Chip>
      </p>
      {brief ? (
        m.note ? <p className="st-stg-small">{m.note}</p> : null
      ) : (
        <>
          <p className="st-stg-small">
            {makerWho(m)}
            {where ? ` · ${where}` : ""}
            {m.note ? ` · ${m.note}` : ""}
          </p>
          <p className="st-stg-small">{priceWords(m.price) ? `Price: ${priceWords(m.price)}.` : "No price known. Add yours in Prices and keys."}</p>
        </>
      )}
      {refused ? (
        <Note tone="coral" role="status">
          {here(m.statusLine)}
        </Note>
      ) : (
        <p className="st-stg-small">
          {here(m.statusLine)}
          {m.checkedAt ? ` (${whenText(m.checkedAt)})` : ""}
        </p>
      )}
      {m.modelId ? (
        <StTech className="st-stg-tech">
          <span>{modelTech({ label: m.label, host: hostName(m.host, m.baseUrl, m.hostId), modelId: m.modelId, region: m.region })}</span>
        </StTech>
      ) : null}
    </div>
  );
}

/**
 * One maker card (§45.37 G1, G3): the makers of its kind, the picked maker's model from its list, its state, and an
 * ended maker's one-tap replacement. Changing the maker starts from its first model that has not ended.
 */
function MakerCard({
  kind,
  c,
  providers,
  models,
  save,
  children,
}: {
  kind: MakerKind;
  c: StoriesConfig;
  providers: ProviderStatus[] | null;
  models: MakerModelInfo[];
  save: (patch: StoriesConfigPatch) => void;
  children?: ReactNode;
}) {
  const card = MAKER_CARDS[kind];
  // The makers' lines are said in this card (§45.36 E17); the options are made here, outside the card's own words.
  const here = useOnThisPage(card.title);
  const { maker: makerKey, model: modelKey } = MAKER_FIELD_OF[kind];
  const maker = c.providers[makerKey];
  const picked = c.providers[modelKey] ?? null;
  const own = models.filter((m) => m.custom && m.kind === kind).length;
  const p = stateOf(providers, maker);
  const ended = p?.state === "ended" || maker === "nova-canvas" || maker === "nova-reel";
  const replacement = p?.replacement ?? (maker === "nova-canvas" ? "stability" : maker === "nova-reel" ? "luma-ray" : null);
  const mine = modelsOfMaker(models, kind, maker);
  // The pick on screen first (it shows at once), else the model the API says the maker uses (`model`), else the same
  // rule here while it loads.
  const used = mine.find((m) => m.key === picked) ?? (p?.model ? mine.find((m) => m.key === p.model) : undefined) ?? usedModel(models, kind, maker, picked);
  // Only this card's two fields are sent: the API checks only what the body names (§45.37 G1).
  const pickMaker = (v: string) => save({ providers: { [makerKey]: v, [modelKey]: null } });
  // ElevenLabs makes the effects and the music bed, each with its own model: both are used, so there is no pick.
  const usesAll = kind === "audio" && maker === "elevenlabs" && mine.length > 1;
  return (
    <SetCard title={card.title} icon={card.icon} id={card.id} lede={card.lede}>
      <SetPick<string> label={card.title} stack value={maker} options={card.list.map((id) => makerOption(providers, id, own, card.noun, here))} onChange={pickMaker} />
      {ended ? (
        <div className="st-stg-ended" role="status">
          <Note tone="coral" icon="alert">
            {endedWords("2026-09-30")}. {kind === "image" ? "AI portraits stop" : "New videos stop"} until you pick another {card.noun} maker.
          </Note>
          <div className="st-stg-actions">
            {replacement ? (
              <Btn main onClick={() => pickMaker(replacement)} label={`Use ${MAKERS[replacement]?.short ?? MAKERS[replacement]?.label ?? replacement} instead`}>
                Use {MAKERS[replacement]?.short ?? MAKERS[replacement]?.label ?? replacement}
              </Btn>
            ) : null}
            <Btn quiet onClick={() => pickMaker(kind === "image" ? "builtin-rig" : "builtin-2d")}>
              Use {kind === "image" ? "Built-in drawings" : "Built-in animation"}
            </Btn>
          </div>
        </div>
      ) : usesAll ? (
        <ul className="st-stg-makermodels" aria-label={`${MAKERS[maker]?.model ?? "Its"} models`}>
          {mine.map((m) => (
            <li key={m.key}>
              <ModelDetails m={m} />
            </li>
          ))}
        </ul>
      ) : mine.length > 1 ? (
        <>
          <p className="st-stg-label">{card.title.replace(" maker", "")} model</p>
          <SetPick<string>
            label={`${card.title}'s model`}
            stack
            value={used?.key ?? null}
            options={mine.map(modelOption)}
            onChange={(v) => save({ providers: { [modelKey]: v } })}
          />
          {used ? <ModelDetails m={used} brief /> : null}
        </>
      ) : used ? (
        <ModelDetails m={used} />
      ) : (
        <>
          <p className="st-stg-active">
            <span className="st-stg-active__word">Model</span>
            <strong>{MAKERS[maker]?.model ?? p?.label ?? "Its own"}</strong>
            {p ? <Chip tone={PROVIDER_STATE[p.state].tone}>{PROVIDER_STATE[p.state].label}</Chip> : null}
          </p>
          {/* Its exact Bedrock model ID, one tap away (§45.36 E14). */}
          {MAKERS[maker]?.tech ? (
            <StTech className="st-stg-tech">
              <span>{MAKERS[maker].tech}</span>
            </StTech>
          ) : null}
        </>
      )}
      {ended ? null : <MakerState p={p} />}
      {kind === "audio" && maker === "polly" ? (
        <Note tone="sun" icon="sound" role="status">
          Your videos now have a spoken voice. To make them without one, pick Built-in sounds and music.
        </Note>
      ) : null}
      {children}
    </SetCard>
  );
}

/** The usual length: 15 to 90 seconds in steps of 5, with 30 to 60 marked as the best. Saved a moment after the last change. */
export function LengthPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [shown, setShown] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const waiting = useRef<number | null>(null);
  const send = useRef(onChange);
  send.current = onChange;
  useEffect(() => setShown(value), [value]);
  // Leaving the page within the moment still saves the last length picked.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (waiting.current !== null) send.current(waiting.current);
    },
    [],
  );
  const pick = (v: number) => {
    const n = Math.max(15, Math.min(90, Math.round(v / 5) * 5));
    setShown(n);
    waiting.current = n;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      waiting.current = null;
      send.current(n);
    }, 450);
  };
  const pct = ((shown - 15) / 75) * 100;
  return (
    <div className="st-stg-length">
      <p className="st-stg-length__value" aria-live="polite">
        <strong>{shown}</strong> seconds
        {shown >= 30 && shown <= 60 ? <Chip tone="mint">Best length</Chip> : <Chip tone="sun">Longer or shorter than most</Chip>}
      </p>
      <div className="st-stg-length__row">
        <button type="button" className="st-stg-round st-stepper__btn" aria-label="5 seconds shorter" aria-disabled={shown <= 15 || undefined} onClick={() => shown > 15 && pick(shown - 5)}>
          <span aria-hidden="true">−</span>
        </button>
        <div className="st-stg-range" style={{ "--st-stg-range": `${pct}%` } as CSSProperties}>
          <span className="st-stg-range__best" aria-hidden="true" />
          <input type="range" min={15} max={90} step={5} value={shown} aria-label="Usual video length in seconds" aria-valuetext={`${shown} seconds`} onChange={(e) => pick(Number(e.target.value))} />
        </div>
        <button type="button" className="st-stg-round st-stepper__btn" aria-label="5 seconds longer" aria-disabled={shown >= 90 || undefined} onClick={() => shown < 90 && pick(shown + 5)}>
          <span aria-hidden="true">+</span>
        </button>
      </div>
      <p className="st-stg-length__scale" aria-hidden="true">
        <span>15 s</span>
        <span>30 to 60 s is best</span>
        <span>90 s</span>
      </p>
    </div>
  );
}

export function VideoSection({ ws }: { ws: string }) {
  const { workspace, config: c, save, saved: savedCount, busy } = useWorkspaceConfig(ws);
  const providers = useLoad(() => storiesApi().providers(ws), ws, "st-settings-providers");
  const usage = useLoad(() => storiesApi().usage(ws, 30), ws, "st-settings-usage");
  const ai = useAi(ws);
  const { saved, flash } = useSaved();
  const [priceOpen, setPriceOpen] = useState<string | null>(null);
  const reloadProviders = providers.reload;
  // A saved change shows "Saved" and asks the makers again (a newly picked one may need a check).
  useEffect(() => {
    if (!savedCount) return;
    flash();
    void reloadProviders();
  }, [savedCount, flash, reloadProviders]);

  if (!workspace.data) return workspace.error ? <Failed message={workspace.error} onRetry={() => void workspace.reload()} /> : <Loading label="Opening the video settings…" />;
  const p = providers.data;
  // The maker models are on the maker rows (§45.37 G1, G2), so one load brings the makers, their models and the keys.
  const models = shownMakerModels(p);
  const reloadAll = async () => {
    await reloadProviders();
  };

  return (
    <div className="st-stg-cards">
      <SectionBar>
        <p className="st-stg-small">The makers of pictures, video and sound. Story writers are in Settings › AI.</p>
        <SavedMark saved={saved} busy={busy} />
      </SectionBar>
      <MakerCard kind="video" c={c} providers={p} models={models} save={save}>
        {/* Luma AI Ray2's own row: Try it, one 5-second test shot, so it can become ready before any video (§45.37). */}
        {p?.some((x) => x.id === "luma-ray") ? <ReelTry ws={ws} p={stateOf(p, "luma-ray")} reload={providers.reload} /> : null}
        {/* The owner's own video model is tried the same way (its shots go to the same storage); only once one is added. */}
        {models.some((m) => m.kind === "video" && m.custom) && p?.some((x) => x.id === "own-video") ? (
          <ReelTry ws={ws} p={stateOf(p, "own-video")} reload={providers.reload} maker="own-video" />
        ) : null}
      </MakerCard>
      <MakerCard kind="image" c={c} providers={p} models={models} save={save} />
      <MakerCard kind="audio" c={c} providers={p} models={models} save={save} />
      {providers.error && !p ? <Note tone="sun">{providers.error}</Note> : null}

      <MakerModels ws={ws} models={models} providers={p} aiKeys={ai.data?.models.map((m) => m.key) ?? []} onChanged={reloadAll} />

      <SetCard title="Shape and size" icon="ruler" id="shape" lede="New videos start with this shape. Change it per video in Production › New.">
        <p className="st-stg-label">Shape</p>
        <SetPick<VideoAspect>
          label="Shape of the video"
          value={c.video.aspect}
          onChange={(v) => save({ video: { ...c.video, aspect: v, resolution: sizeFor(v, c.video.resolution) } })}
          options={SHAPES}
        />
        {c.video.aspect !== "9:16" ? (
          <Note tone="sun" role="status">
            Shorts, Reels and TikTok want 9:16. A {c.video.aspect === "1:1" ? "square" : "wide"} video shows smaller there, with bars around it.
          </Note>
        ) : null}
        <p className="st-stg-label">Size</p>
        <SetPick<VideoResolution>
          label="Size of the video"
          value={c.video.resolution}
          onChange={(v) => save({ video: { ...c.video, resolution: v } })}
          options={RESOLUTIONS[c.video.aspect].map((r, i) => ({ value: r, label: sizeWords(r), line: i === 0 ? "Sharp (Full HD)" : "Smaller files, quicker to make" }))}
        />
        <dl className="st-stg-facts">
          <div>
            <dt>Frame rate</dt>
            <dd>30 frames a second (30 fps)</dd>
          </div>
        </dl>
      </SetCard>

      <SetCard title="Usual length" icon="clock" lede="New videos start at this length. Change it per video.">
        <LengthPicker value={c.defaultDurationSec} onChange={(v) => save({ defaultDurationSec: v })} />
      </SetCard>

      <SetCard title="Quality" icon="film" lede="How sharp new videos are. Sharper files are bigger.">
        <SetPick label="Video quality" value={c.video.quality} options={QUALITY} onChange={(v) => save({ video: { ...c.video, quality: v } })} />
        <StTech className="st-stg-tech">
          <span>The H.264 quality number (CRF): Good 23, Better 20, Best 17. Lower is sharper.</span>
        </StTech>
      </SetCard>

      <SetCard title="Words and music" icon="sound" lede="New videos start with these. Change them per video.">
        <SetSwitch label="Captions" description="Short words on screen, like a comic." checked={c.captionsOn} onChange={(v) => save({ captionsOn: v })} />
        <SetSwitch label="Music" description="A tune under the sound effects." checked={c.musicOn} onChange={(v) => save({ musicOn: v })} />
      </SetCard>

      <VideoUsage
        usage={usage.data}
        error={usage.error}
        providers={p}
        onAddPrice={(id) => {
          setPriceOpen(id);
          requestAnimationFrame(() => document.getElementById(`price-${id}`)?.scrollIntoView?.({ block: "center", behavior: storiesReduceMotion() ? "auto" : "smooth" }));
        }}
      />

      <SetCard title="Prices and keys" icon="coin" lede="What the AI makers cost, and their keys.">
        <h4 className="st-stg-subhead">Prices</h4>
        <MakerPrices
          ai={ai}
          open={priceOpen}
          setOpen={(id, from) => {
            if (id !== null) return setPriceOpen(id);
            // Only that maker's own form closes: its save may end after the owner opened another one, which stays open.
            setPriceOpen((now) => (now === from ? null : now));
            void usage.reload();
          }}
        />
        <h4 className="st-stg-subhead">Keys</h4>
        {p ? (
          <ProviderKeys
            ws={ws}
            providers={p}
            kinds={["images", "animation", "audio"]}
            also={["openai_compatible"]}
            onChange={(x) => {
              // The key's row (and so every model on that host) shows the new key state; nothing else changes.
              providers.setData((l) => (l ? l.map((y) => (y.id === x.id ? keepName(y, x) : y)) : l));
            }}
          />
        ) : null}
      </SetCard>
    </div>
  );
}
