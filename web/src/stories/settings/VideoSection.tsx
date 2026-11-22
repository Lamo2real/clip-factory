// Lamo Stories › Settings › Video (docs/CONTRACTS.md §45.29 Video, §45.31, §45.34): the makers, picked apart from
// the AI models that write the stories (an LLM never "makes the video"): the video maker and its model, the picture
// maker and the sound maker, each with its real state (a maker that is not ready says what it needs; nothing switches
// to another one by itself); the default shape (9:16, 1:1 or 16:9; Shorts, Reels and TikTok want 9:16) and its size,
// the frame rate (30 fps), the usual length (15 to 90 s, 30 to 60 s best), the quality, the captions and music
// defaults, the use and costs (render minutes per day, each maker's units and cost), prices for the AI makers and
// provider keys.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import { storiesReduceMotion } from "../prefs.ts";
import { RESOLUTIONS, type ProviderStatus, type StoriesConfig, type VideoAspect, type VideoResolution } from "../api/types.ts";
import modelsFile from "../../../../stories/config/models.json";
import { Chip, Failed, Loading, Note, PROVIDER_STATE, SavedMark, SetCard, SetPick, SetSwitch, useOnThisPage, useSaved } from "./bits.tsx";
import { useAi, useWorkspaceConfig } from "./data.ts";
import { keepName, ProviderKeys } from "./ProviderKeys.tsx";
import { MakerPrices } from "./ProviderPrices.tsx";
import { ReelTry } from "./ReelTry.tsx";
import { StTech } from "../ui.tsx";
import { VideoUsage } from "./VideoUsage.tsx";

type VideoMaker = StoriesConfig["providers"]["video"];
type PictureMaker = StoriesConfig["providers"]["images"];

/** An Amazon Bedrock model's exact ID and Region, said only behind "Technical details" (§45.36 E14). */
const bedrockTech = (m: { label: string; host: string; modelId: string; region: string }) => `On ${m.host}: ${m.label} (${m.modelId}) in ${m.region}.`;

/**
 * Each maker's name and model, from Lamo Stories' own stories/config/models.json where it has one. `model` is its plain
 * name; `tech` its exact Bedrock ID, folded away (§45.36 E14).
 */
export const MAKERS: Record<string, { label: string; model: string; line: string; tech?: string }> = {
  "builtin-2d": { label: "Built-in animator", model: "Lamo Stories' own 2D animator", line: "Draws and moves every character the same way in every video." },
  "nova-reel": {
    label: modelsFile.videoModel.label,
    model: modelsFile.videoModel.label,
    line: "AI footage for cut-aways (scenes with no character), 6 seconds a shot. Posts that use it carry the platforms' AI label.",
    tech: bedrockTech(modelsFile.videoModel),
  },
  "builtin-rig": { label: "Built-in drawings", model: "Lamo Stories' own character drawings", line: "Every character looks the same in every video." },
  "nova-canvas": {
    label: `Also AI portraits (${modelsFile.imageModel.label})`,
    model: modelsFile.imageModel.label,
    line: "Makes a portrait of each character for the app. Videos still use the drawings.",
    tech: bedrockTech(modelsFile.imageModel),
  },
  "builtin-synth": { label: "Built-in sounds and music", model: "Lamo Stories' own sound maker", line: "Every sound effect, noise and tune, made fresh for each video." },
};

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

function makerOption<T extends string>(providers: ProviderStatus[] | null, id: T, here: (text: string) => string = (t) => t) {
  const p = stateOf(providers, id);
  const s = p ? PROVIDER_STATE[p.state] : null;
  return {
    value: id,
    label: MAKERS[id]?.label ?? p?.label ?? id,
    line: p?.line ? here(p.line) : MAKERS[id]?.line,
    chip: s ? <Chip tone={s.tone}>{s.label}</Chip> : undefined,
    off: p?.state === "unavailable" ? here(p.line) || "Not available yet." : undefined,
  };
}

/** What a maker that is not working yet still needs, saying "is not ready yet" once (the API's line often says it). */
export function notReadyLine(p: Pick<ProviderStatus, "label" | "line">): string {
  return /\bis not ready yet\b/.test(p.line) ? p.line : `${p.label} is not ready yet. ${p.line}`;
}

function ModelLine({ providers, id }: { providers: ProviderStatus[] | null; id: string }) {
  const p = stateOf(providers, id);
  const here = useOnThisPage();
  return (
    <>
      <p className="st-stg-active">
        <span className="st-stg-active__word">Model</span>
        <strong>{MAKERS[id]?.model ?? p?.label ?? id}</strong>
        {p ? <Chip tone={PROVIDER_STATE[p.state].tone}>{PROVIDER_STATE[p.state].label}</Chip> : null}
      </p>
      {/* Its exact Bedrock model ID, one tap away (§45.36 E14). */}
      {MAKERS[id]?.tech ? (
        <StTech className="st-stg-tech">
          <span>{MAKERS[id].tech}</span>
        </StTech>
      ) : null}
      {/* The picked maker is not working yet: what it needs, in the API's own words (§45.11.6: on only after a real call). */}
      {p && (p.state === "needs_setup" || p.state === "unavailable") ? (
        <Note tone="sun" role="status">
          {/* The API's line may already say it is not ready (§45.34's sentence, with the maker's short name): then it is said once. */}
          {here(notReadyLine(p))}
          {p.lastError && p.lastError !== p.line ? ` Last problem: ${here(p.lastError)}` : ""}
        </Note>
      ) : null}
    </>
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
        <button type="button" className="st-stg-round" aria-label="5 seconds shorter" aria-disabled={shown <= 15 || undefined} onClick={() => shown > 15 && pick(shown - 5)}>
          <span aria-hidden="true">−</span>
        </button>
        <div className="st-stg-range" style={{ "--st-stg-range": `${pct}%` } as CSSProperties}>
          <span className="st-stg-range__best" aria-hidden="true" />
          <input type="range" min={15} max={90} step={5} value={shown} aria-label="Usual video length in seconds" aria-valuetext={`${shown} seconds`} onChange={(e) => pick(Number(e.target.value))} />
        </div>
        <button type="button" className="st-stg-round" aria-label="5 seconds longer" aria-disabled={shown >= 90 || undefined} onClick={() => shown < 90 && pick(shown + 5)}>
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
  const here = useOnThisPage();
  const reloadProviders = providers.reload;
  // A saved change shows "Saved" and asks the makers again (a newly picked one may need a check).
  useEffect(() => {
    if (!savedCount) return;
    flash();
    void reloadProviders();
  }, [savedCount, flash, reloadProviders]);

  if (!workspace.data) return workspace.error ? <Failed message={workspace.error} onRetry={() => void workspace.reload()} /> : <Loading label="Opening the video settings…" />;
  const p = providers.data;

  return (
    <div className="st-stg-cards">
      <div className="st-stg-bar">
        <p className="st-stg-small">These make the pictures, video and sound. The AI models that write the stories are in Settings › AI.</p>
        <SavedMark saved={saved} busy={busy} />
      </div>
      <SetCard title="Video maker" icon="film" lede="What turns each story into moving pictures.">
        <SetPick<VideoMaker> label="Video maker" stack value={c.providers.video} options={[makerOption(p, "builtin-2d", here), makerOption(p, "nova-reel", here)]} onChange={(v) => save({ providers: { ...c.providers, video: v } })} />
        <ModelLine providers={p} id={c.providers.video} />
        {/* Nova Reel's own row: Try it, one 6-second test shot, so it can become ready before any video (§45.35 D2). */}
        {p?.some((x) => x.id === "nova-reel") ? <ReelTry ws={ws} p={stateOf(p, "nova-reel")} reload={providers.reload} /> : null}
      </SetCard>
      <SetCard title="Picture maker" icon="brush" id="picture-maker" lede="How the characters are drawn.">
        <SetPick<PictureMaker> label="Picture maker" stack value={c.providers.images} options={[makerOption(p, "builtin-rig", here), makerOption(p, "nova-canvas", here)]} onChange={(v) => save({ providers: { ...c.providers, images: v } })} />
        <ModelLine providers={p} id={c.providers.images} />
      </SetCard>
      <SetCard title="Sound maker" icon="sound" lede="Sound effects, character noises and music. No voice-over.">
        <SetPick label="Sound maker" stack value={c.providers.audio} options={[makerOption(p, "builtin-synth", here)]} onChange={() => undefined} />
        <ModelLine providers={p} id={c.providers.audio} />
      </SetCard>
      {providers.error && !p ? <Note tone="sun">{providers.error}</Note> : null}

      <SetCard title="Shape and size" icon="ruler" id="shape" lede="New videos start with this shape. Shorts, Reels and TikTok want 9:16. You can change it for one video in Production › New.">
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

      <SetCard title="Usual length" icon="clock" lede="New videos start at this length. You can change it for each video.">
        <LengthPicker value={c.defaultDurationSec} onChange={(v) => save({ defaultDurationSec: v })} />
      </SetCard>

      <SetCard title="Quality" icon="film" lede="Better quality makes bigger files that take a little longer to upload.">
        <SetPick label="Video quality" value={c.video.quality} options={QUALITY} onChange={(v) => save({ video: { ...c.video, quality: v } })} />
        <StTech className="st-stg-tech">
          <span>The H.264 quality number (CRF): Good 23, Better 20, Best 17. Lower is sharper.</span>
        </StTech>
      </SetCard>

      <SetCard title="Words and music" icon="sound" lede="What new videos start with. You can still change it for one video.">
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

      <SetCard title="Prices and keys" icon="coin" lede="What the AI makers cost, and keys for makers that need one.">
        <h4 className="st-stg-subhead">Prices</h4>
        <MakerPrices
          ai={ai}
          open={priceOpen}
          setOpen={(id) => {
            setPriceOpen(id);
            if (id === null) void usage.reload();
          }}
        />
        <h4 className="st-stg-subhead">Keys</h4>
        {p ? <ProviderKeys ws={ws} providers={p} kinds={["images", "animation", "audio"]} onChange={(x) => providers.setData((l) => (l ? l.map((y) => (y.id === x.id ? keepName(y, x) : y)) : l))} /> : null}
      </SetCard>
    </div>
  );
}
