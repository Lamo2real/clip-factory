// The picture, video and sound makers' models in Lamo Stories' own stories/config/models.json (docs/CONTRACTS.md
// §45.37 G1): the lists imageModels, videoModels and audioModels, each entry carrying the maker it belongs to
// (`maker`) and, for a model Amazon ended, the day (`ended`). A file from before the lists has one imageModel and one
// videoModel; each reads as a one-item list (keyed nova-canvas and nova-reel, their makers' ids), so nothing breaks
// whichever shape the file has. The server's list (GET …/makers/models, with each model's status and the owner's own
// models) is the one that counts; this file only names the bundled models while that list loads.
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
