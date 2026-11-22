// The picture, video and sound makers' models in Lamo Stories' own stories/config/models.json (docs/CONTRACTS.md
// §45.37 G1): the lists imageModels, videoModels and audioModels, each entry carrying the maker it belongs to
// (`maker`) and, for a model Amazon ended, the day (`ended`). A file from before the lists has one imageModel and one
// videoModel; each reads as a one-item list (keyed nova-canvas and nova-reel, their makers' ids), so nothing breaks
// whichever shape the file has. The server's list (the maker rows of GET …/providers, with each model's status and the
// owner's own models) is the one that counts; this file only names the bundled models while that list loads.
import modelsFile from "../../../../stories/config/models.json";
import { AMAZON_ENDED_ON, MAKER_KINDS, type MakerKind, type MakerPrice } from "../api/types.ts";

export interface FileMakerModel {
  key: string;
  label: string;
  provider: string;
  host: string;
  modelId: string;
  region: string;
  kind: MakerKind;
  price: MakerPrice | null;
  note: string;
  maker?: string;
  ended?: string | null;
}

/** The key (and maker) an older file's single model has. */
export const OLD_SHAPE_KEY: Partial<Record<MakerKind, string>> = { image: "nova-canvas", video: "nova-reel" };

const LIST_FIELD: Record<MakerKind, string> = { image: "imageModels", video: "videoModels", audio: "audioModels" };
const OLD_FIELD: Partial<Record<MakerKind, string>> = { image: "imageModel", video: "videoModel" };

type Raw = Record<string, unknown>;
const text = (v: unknown, or = "") => (typeof v === "string" ? v : or);

/** A price for one unit, or null for anything else (an older file's `pricing: null`). */
export function priceOf(v: unknown): MakerPrice | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Raw;
  if (typeof p.perUnit !== "number" || !Number.isFinite(p.perUnit) || typeof p.unit !== "string" || typeof p.currency !== "string") return null;
  return { perUnit: p.perUnit, unit: p.unit, currency: p.currency };
}

function entry(raw: Raw, kind: MakerKind, key: string, old = false): FileMakerModel {
  const ended = text(raw.ended) || text(raw.endedOn) || null;
  return {
    key,
    label: text(raw.label, key),
    provider: text(raw.provider, "Amazon"),
    host: text(raw.host, "Amazon Bedrock"),
    modelId: text(raw.modelId),
    region: text(raw.region),
    kind,
    price: priceOf(raw.price ?? raw.pricing),
    note: text(raw.note),
    ...(typeof raw.maker === "string" ? { maker: raw.maker } : old ? { maker: key } : {}),
    // The older file's two models are Amazon's Nova Canvas and Nova Reel, both ended on 30 Sep 2026.
    ...(ended ? { ended } : old ? { ended: AMAZON_ENDED_ON } : {}),
  };
}

/** True when the file has §45.37's lists (any of the three). */
export function hasMakerLists(file: unknown = modelsFile): boolean {
  const f = (file ?? {}) as Raw;
  return MAKER_KINDS.some((k) => Array.isArray(f[LIST_FIELD[k]]));
}

/** The bundled models of one kind (or all), in the file's order. `file` is for tests. */
export function fileMakerModels(kind?: MakerKind, file: unknown = modelsFile): FileMakerModel[] {
  const f = (file ?? {}) as Raw;
  const lists = hasMakerLists(f);
  return MAKER_KINDS.filter((k) => !kind || k === kind).flatMap((k) => {
    const list = f[LIST_FIELD[k]];
    if (Array.isArray(list)) return list.filter((x): x is Raw => !!x && typeof x === "object" && typeof (x as Raw).key === "string").map((x) => entry(x, k, x.key as string));
    // The old single entries count only in a file without the lists (the integrator keeps them as mirrors for a while).
    const old = !lists && OLD_FIELD[k] ? f[OLD_FIELD[k]!] : undefined;
    return old && typeof old === "object" ? [entry(old as Raw, k, OLD_SHAPE_KEY[k]!, true)] : [];
  });
}

/**
 * The bundled maker models as the lead's one set names them (§45.37 G7; stories/config/models.json's imageModels,
 * videoModels and audioModels, in that file's order): used while a file has only the old imageModel and videoModel.
 * Model ids from AWS's own model cards (docs.aws.amazon.com/bedrock/latest/userguide/model-card-*.html); Stability AI
 * and Luma AI run in us-west-2 only; Amazon ended Nova Canvas and Nova Reel on 30 Sep 2026. Prices null: none
 * documented.
 */
export const LEAD_MAKER_MODELS: FileMakerModel[] = [
  { key: "nova-canvas", label: "Amazon Nova Canvas", provider: "Amazon", host: "Amazon Bedrock", modelId: "amazon.nova-canvas-v1:0", region: "eu-west-1", kind: "image", price: null, note: "Ended by Amazon on 30 Sep 2026.", maker: "nova-canvas", ended: AMAZON_ENDED_ON },
  { key: "stable-image-core", label: "Stable Image Core", provider: "Stability AI", host: "Amazon Bedrock", modelId: "stability.stable-image-core-v1:1", region: "us-west-2", kind: "image", price: null, note: "Runs in the US (Oregon). Quick pictures for portraits.", maker: "stability" },
  { key: "stable-image-ultra", label: "Stable Image Ultra", provider: "Stability AI", host: "Amazon Bedrock", modelId: "stability.stable-image-ultra-v1:1", region: "us-west-2", kind: "image", price: null, note: "Runs in the US (Oregon). The most detailed pictures.", maker: "stability" },
  { key: "sd3-5-large", label: "Stable Diffusion 3.5 Large", provider: "Stability AI", host: "Amazon Bedrock", modelId: "stability.sd3-5-large-v1:0", region: "us-west-2", kind: "image", price: null, note: "Runs in the US (Oregon). Detailed pictures in many styles.", maker: "stability" },
  { key: "nova-reel", label: "Amazon Nova Reel 1.1", provider: "Amazon", host: "Amazon Bedrock", modelId: "amazon.nova-reel-v1:1", region: "us-east-1", kind: "video", price: null, note: "Ended by Amazon on 30 Sep 2026.", maker: "nova-reel", ended: AMAZON_ENDED_ON },
  { key: "luma-ray2", label: "Luma AI Ray2", provider: "Luma AI", host: "Amazon Bedrock", modelId: "luma.ray-v2:0", region: "us-west-2", kind: "video", price: null, note: "Runs in the US (Oregon). Makes 5-second AI shots for scenes with no characters (cut-aways).", maker: "luma-ray" },
  { key: "polly-neural", label: "Amazon Polly neural voices", provider: "Amazon", host: "Amazon Polly", modelId: "neural", region: "eu-west-1", kind: "audio", price: null, note: "Adds words spoken aloud. Your videos are made without a voice unless you pick this.", maker: "polly" },
  { key: "elevenlabs-effects", label: "ElevenLabs sound effects", provider: "ElevenLabs", host: "elevenlabs", modelId: "eleven_text_to_sound_v2", region: "", kind: "audio", price: null, note: "Sound effects from your ElevenLabs account. Never a voice.", maker: "elevenlabs" },
  { key: "elevenlabs-music", label: "ElevenLabs music (instrumental)", provider: "ElevenLabs", host: "elevenlabs", modelId: "music_v1", region: "", kind: "audio", price: null, note: "An instrumental music bed from your ElevenLabs account. Never a voice.", maker: "elevenlabs" },
];

/** The bundled maker models: the file's lists once it has them, else the lead's set above. */
export function bundledMakerModels(): FileMakerModel[] {
  return hasMakerLists() ? fileMakerModels() : LEAD_MAKER_MODELS;
}

/** The month words of "30 Sep 2026" (fixed: some browsers' short September is "Sept"). */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Ended by Amazon on 30 Sep 2026" for an ISO day, or null when it has not ended. */
export function endedWords(day: string | null | undefined): string | null {
  if (!day) return null;
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "Ended by Amazon";
  return `Ended by Amazon on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Where an Amazon Bedrock model runs, in words, when it is not Lamo Stories' own Europe: "Runs in the US (Oregon)". */
export const REGION_WORDS: Record<string, string> = {
  "us-west-2": "Runs in the US (Oregon)",
  "us-east-1": "Runs in the US (N. Virginia)",
  "eu-west-1": "Runs in Europe (Ireland)",
  "eu-north-1": "Runs in Europe (Stockholm)",
};
export function regionWords(region: string | null | undefined): string | null {
  if (!region) return null;
  return REGION_WORDS[region] ?? `Runs in ${region}`;
}
