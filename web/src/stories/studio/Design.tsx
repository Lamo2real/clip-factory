// "Design with AI" on the Characters page (docs/CONTRACTS.md §45.5, §45.8, §45.26): the owner says what a character is
// like, adds a picture (sent straight to storage with a presigned PUT, kept as a design picture the Library never
// lists, or one of the character's own pictures), or both; Lamo Stories' character agent suggests the whole rig, the
// faces, the moves and the sounds as a draft. Nothing is saved: the draft opens in the editor, the owner changes what he
// likes and taps Save. The task is read every second with a line that names the model and the effort, and the button
// has its own "Model and effort for this one" menu. On a saved character's page it redesigns that character
// (`characterId`, §45.34): the agent keeps its name and changes only what the owner asks, and the page shows which
// parts changed (RedesignCompare) before "Use this" puts the new version in the editor. A picture dropped on the open
// panel is the picture to start from, as if picked (docs/CONTRACTS.md §45.40).
//
// A vehicle (§45.42, §45.47, CarDesign): real photos in two strips (Photos.tsx: "Outside", up to 6, and "Inside", up to
// 4, 8 in all) and the owner's words go to the model on the chip in one call that makes 3 cartoon vehicles to pick
// from ("Pick one", CarOptions.tsx), with each photo's side (`referenceSides`) and the kind picked in "What is it?"
// (`vehicle`); "Make more" asks for 3 more that look different, and the picked one goes in the editor (or, for a saved
// vehicle, into RedesignCompare).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { putFile } from "../../api/upload.ts";
import { DropOverlay } from "../../components/DropOverlay.tsx";
import { useFileDrop } from "../../lib/useFileDrop.ts";
import { Icon } from "../chat/kit.tsx";
import { storiesApi } from "../api/client.ts";
import { isCar, type AiTask, type CarInput, type CharacterInput, type DesignBody, type ModelOverride, type PersonInput, type PhotoSide, type VehicleType } from "../api/types.ts";
import type { CarLook, Expression } from "../engine/types.ts";
import { merged, ModelMenu, sendPick, TaskLine, useAiTask, usualFor, type AiInfo } from "./ai.tsx";
import { CastPreview } from "../preview/CastPreview.tsx";
import { CarOptions, MAX_CAR_OPTIONS } from "./CarOptions.tsx";
import { celebrate, Notice, ProgressBar, Tag, TextField } from "./kit.tsx";
import { DEFAULT_LOOK, DEFAULT_VOICE, newCar, newCharacter } from "./looks.ts";
import { Photos, type Photo } from "./Photos.tsx";
import { fileProblem } from "./References.tsx";
import { say } from "./words.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
const text = (raw: Record<string, unknown>) => ({
  name: str(raw.name, "").slice(0, 30),
  description: str(raw.description, "").slice(0, 400),
  personality: str(raw.personality, "").slice(0, 400),
  traits: Array.isArray(raw.traits) ? raw.traits.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.slice(0, 30)).slice(0, 8) : [],
});

/** A suggested car, filled out to a whole CarInput (no voice, the faces rule of §45.42) so the editor can draw it. */
function carOf(raw: Record<string, unknown>): CarInput {
  const base = newCar();
  const car = isObj(raw.car) ? raw.car : {};
  const voice = isObj(raw.voice) ? raw.voice : {};
  const look: CarLook = {
    ...base.car,
    ...(car as Partial<CarLook>),
    wheels: { ...base.car.wheels, ...(isObj(car.wheels) ? car.wheels : {}) },
    lights: { ...base.car.lights, ...(isObj(car.lights) ? car.lights : {}) },
    face: { ...base.car.face, ...(isObj(car.face) ? car.face : {}) },
  } as CarLook;
  const faces = Array.isArray(raw.expressions) ? (raw.expressions.filter((e) => typeof e === "string") as Expression[]) : [];
  return {
    kind: "car",
    ...text(raw),
    movementStyle: (typeof raw.movementStyle === "string" ? raw.movementStyle : base.movementStyle) as CharacterInput["movementStyle"],
    expressions: look.face.eyes === "none" ? ["neutral"] : faces.includes("neutral") ? faces : ["neutral", ...faces],
    car: look,
    voice: { style: "none", pitch: 1, noises: [], sfx: Array.isArray(voice.sfx) ? (voice.sfx as CharacterInput["voice"]["sfx"]).slice(0, 8) : [...base.voice.sfx] },
  };
}

/** Every character a finished design task suggests (result.characters, else result.character), each filled out. */
export function designsOf(task: AiTask): CharacterInput[] {
  const result = task.result as { character?: unknown; characters?: unknown } | null;
  const list = Array.isArray(result?.characters) && result.characters.length ? result.characters : [result?.character];
  return list.map((raw) => fill(raw)).filter((c): c is CharacterInput => c !== null);
}

/**
 * The character a finished design task suggests (result.character), filled out to a whole CharacterInput so the
 * editor can always draw it; null when the answer has no character in it.
 */
export function designOf(task: AiTask): CharacterInput | null {
  return fill((task.result as { character?: unknown } | null)?.character);
}

function fill(raw: unknown): CharacterInput | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "car") return carOf(raw);
  const base = newCharacter();
  const look = isObj(raw.look) ? raw.look : {};
  const voice = isObj(raw.voice) ? raw.voice : {};
  const faces = Array.isArray(raw.expressions) ? (raw.expressions.filter((e) => typeof e === "string") as Expression[]) : base.expressions;
  return {
    ...text(raw),
    movementStyle: (typeof raw.movementStyle === "string" ? raw.movementStyle : base.movementStyle) as CharacterInput["movementStyle"],
    expressions: faces.includes("neutral") ? faces : ["neutral", ...faces],
    look: {
      ...DEFAULT_LOOK,
      ...(look as Partial<CharacterInput["look"]>),
      hair: { ...DEFAULT_LOOK.hair, ...(isObj(look.hair) ? look.hair : {}) },
      eyes: { ...DEFAULT_LOOK.eyes, ...(isObj(look.eyes) ? look.eyes : {}) },
      outfit: { ...DEFAULT_LOOK.outfit, ...(isObj(look.outfit) ? look.outfit : {}) },
    } as PersonInput["look"],
    voice: {
      ...DEFAULT_VOICE,
      ...(voice as Partial<CharacterInput["voice"]>),
      noises: Array.isArray(voice.noises) ? (voice.noises as CharacterInput["voice"]["noises"]).slice(0, 8) : [...DEFAULT_VOICE.noises],
      sfx: Array.isArray(voice.sfx) ? (voice.sfx as CharacterInput["voice"]["sfx"]).slice(0, 8) : [...DEFAULT_VOICE.sfx],
    },
  };
}

/** One part of a character the owner can see change, in plain words. */
export interface ChangedPart {
  part: "looks" | "faces" | "moves" | "sounds" | "name" | "description" | "personality" | "traits";
  label: string;
  /** what in it changed ("clothes, hair") */
  detail: string;
}

const PART_LABEL: Record<ChangedPart["part"], string> = {
  looks: "Looks",
  faces: "Faces",
  moves: "Moves",
  sounds: "Sounds",
  name: "Name",
  description: "Description",
  personality: "Personality",
  traits: "Traits",
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Which parts of a character a redesign changes, and which stay the same (§45.34: shown before "Use this"). */
export function changedParts(now: CharacterInput, next: CharacterInput): { changed: ChangedPart[]; kept: ChangedPart["part"][] } {
  const looks = lookChanges(now, next);
  const faces = [...next.expressions.filter((e) => !now.expressions.includes(e)).map((e) => `+ ${e}`), ...now.expressions.filter((e) => !next.expressions.includes(e)).map((e) => `− ${e}`)];
  const checks: [ChangedPart["part"], boolean, string][] = [
    ["looks", looks.length > 0, looks.join(", ")],
    ["faces", faces.length > 0, faces.join(", ")],
    ["moves", now.movementStyle !== next.movementStyle, `${now.movementStyle} → ${next.movementStyle}`],
    ["sounds", !same(now.voice, next.voice), [now.voice.style !== next.voice.style ? "voice" : "", !same(now.voice.noises, next.voice.noises) ? "noises" : "", !same(now.voice.sfx, next.voice.sfx) ? "effects" : "", now.voice.pitch !== next.voice.pitch ? "pitch" : ""].filter(Boolean).join(", ")],
    ["name", now.name !== next.name, `${now.name} → ${next.name}`],
    ["description", now.description !== next.description, ""],
    ["personality", now.personality !== next.personality, ""],
    ["traits", !same(now.traits, next.traits), next.traits.join(", ")],
  ];
  return {
    changed: checks.filter(([, c]) => c).map(([part, , detail]) => ({ part, label: PART_LABEL[part], detail })),
    kept: checks.filter(([, c]) => !c).map(([part]) => part),
  };
}

/** Which parts of the look change, in plain words. */
function lookChanges(now: CharacterInput, next: CharacterInput): string[] {
  const looks: string[] = [];
  if (isCar(now) || isCar(next)) {
    if (!isCar(now) || !isCar(next)) return ["all of it"];
    const a = now.car;
    const b = next.car;
    if (a.body !== b.body || a.length !== b.length || a.height !== b.height) looks.push("shape");
    if (a.paint !== b.paint || a.accent !== b.accent || a.pattern !== b.pattern) looks.push("paint");
    if (a.windows !== b.windows) looks.push("windows");
    if (!same(a.wheels, b.wheels)) looks.push("wheels");
    if (!same(a.lights, b.lights)) looks.push("lights");
    if (a.extra !== b.extra) looks.push("extra");
    if (!same(a.face, b.face)) looks.push("face");
    if (a.outline !== b.outline) looks.push("outline");
    return looks;
  }
  const a = now.look;
  const b = next.look;
  if (a.body !== b.body || a.height !== b.height || a.width !== b.width) looks.push("body");
  if (a.skin !== b.skin) looks.push("skin");
  if (!same(a.hair, b.hair)) looks.push("hair");
  if (!same(a.eyes, b.eyes) || a.brows !== b.brows || a.nose !== b.nose || a.mouth !== b.mouth) looks.push("face shape");
  if (!same(a.outfit, b.outfit)) looks.push("clothes");
  if (a.accessory !== b.accessory) looks.push("extra");
  if (a.outline !== b.outline) looks.push("outline");
  return looks;
}

/** A redesign side by side with the character as it is, the parts that change, and "Use this" (§45.34). */
export function RedesignCompare({ now, next, onUse, onDrop }: { now: CharacterInput; next: CharacterInput; onUse: () => void; onDrop: () => void }) {
  const { changed, kept } = changedParts(now, next);
  const pair = (title: string, c: CharacterInput, extra?: ReactNode) => (
    <figure className="st-s-redesign__fig">
      <CastPreview c={c} size={120} label={`${title}: ${c.name}`} />
      <figcaption className="st-s-redesign__cap">
        {title}
        {extra}
      </figcaption>
    </figure>
  );
  return (
    <section className="st-s-redesign st-glass st-glass--tinted" aria-labelledby="st-redesign-title">
      <h2 className="st-s-design__title" id="st-redesign-title">
        The new {now.name}
      </h2>
      <div className="st-s-redesign__pair">
        {pair("Now", now)}
        {pair("New", next)}
      </div>
      {changed.length ? (
        <>
          <p className="st-s-redesign__lede">What changes:</p>
          <ul className="st-s-redesign__list">
            {changed.map((c) => (
              <li key={c.part} className="st-s-redesign__item">
                <Tag tone="sun">{c.label}</Tag>
                {c.detail ? <span className="st-s-redesign__detail">{c.detail}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="st-s-redesign__lede">Nothing changes. Say more about what should be different, then tap Design it again.</p>
      )}
      {kept.length ? <p className="st-s-field__hint">Stays the same: {kept.map((k) => PART_LABEL[k]).join(", ")}.</p> : null}
      <div className="st-s-actionbar">
        <button type="button" className="st-btn" onClick={onDrop}>
          Keep {now.name} as now
        </button>
        <button type="button" className="st-btn st-btn--main" aria-disabled={!changed.length || undefined} onClick={() => changed.length && onUse()}>
          Use this
        </button>
      </div>
    </section>
  );
}

export function DesignPanel({
  ws,
  info,
  onDraft,
  startOpen = false,
  pictures = [],
  name,
  characterId,
}: {
  ws: string;
  info: AiInfo;
  onDraft: (c: CharacterInput) => void;
  startOpen?: boolean;
  /** the character's own pictures, to design from one of them */
  pictures?: { assetId: string; url: string }[];
  /** an existing character keeps its name */
  name?: string;
  /** a saved character to redesign (the agent starts from it, §45.34) */
  characterId?: string;
}) {
  const [open, setOpen] = useState(startOpen);
  const [words, setWords] = useState("");
  const [picture, setPicture] = useState<{ assetId: string; url: string; own: boolean } | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pick, setPick] = useState<ModelOverride | null>(null);
  const [made, setMade] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLElement>(null);
  const local = useRef<string[]>([]);
  const usual = usualFor(info, "character_design");
  const run = useAiTask(ws, (task) => {
    const draft = designOf(task);
    if (!draft) {
      setProblem("The character helper did not send a character back. Tap Design it again.");
      return;
    }
    onDraft(name ? { ...draft, name } : draft);
    setMade(true);
    celebrate(box.current, 90);
  }, () => design());
  const busy = run.phase === "working" || sending !== null;
  // One picture dropped on the open panel; while one is being sent, the next waits.
  const drop = useFileDrop({
    scope: "element",
    checkFile: fileProblem,
    onFiles: ([f]) => {
      if (f) void send(f);
    },
    enabled: open,
    busy: sending !== null ? "Sending the picture…" : null,
  });

  useEffect(() => {
    if (startOpen) box.current?.scrollIntoView?.({ block: "nearest" });
  }, [startOpen]);

  useEffect(
    () => () => {
      for (const url of local.current) URL.revokeObjectURL(url);
    },
    [],
  );

  async function send(file: File) {
    setProblem(null);
    const bad = fileProblem(file);
    if (bad) return setProblem(bad);
    setSending(0);
    try {
      const target = await storiesApi().designUpload(ws, { filename: file.name, contentType: file.type, size: file.size });
      await putFile({ key: target.assetId, uploadUrl: target.uploadUrl, headers: target.headers }, file, setSending);
      const url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
      if (url) local.current.push(url);
      setPicture({ assetId: target.assetId, url, own: false });
    } catch (e) {
      setProblem(say(e, "The picture did not arrive. Try again."));
    } finally {
      setSending(null);
    }
  }

  function design() {
    if (busy) return;
    const description = words.trim();
    if (!description && !picture) return setProblem("Say what your character is like, or add a picture.");
    if (description.length > 600) return setProblem("Keep it to 600 letters.");
    setProblem(null);
    setMade(false);
    const body: { description?: string; referenceAssetId?: string; characterId?: string; override?: ModelOverride } = {};
    if (description) body.description = description;
    if (picture) body.referenceAssetId = picture.assetId;
    if (characterId) body.characterId = characterId;
    const override = sendPick(info, usual, pick);
    if (override) body.override = override;
    void run.start(() => storiesApi().designCharacter(ws, body));
  }

  if (!open)
    return (
      <section className="st-s-design st-s-design--closed st-glass st-glass--hero" aria-labelledby="st-design-title" ref={box}>
        <div>
          <h2 className="st-s-design__title" id="st-design-title">
            Design with AI
          </h2>
          <p className="st-s-design__lede">{name ? `Describe a new look for ${name}, or use one of its pictures. You check it before saving.` : "Describe your character or add a picture. You get a first try to change and save."}</p>
        </div>
        <button type="button" className="st-btn" onClick={() => setOpen(true)}>
          Design with AI
        </button>
      </section>
    );

  return (
    <section className="st-s-design st-glass st-glass--hero st-drop-host" aria-labelledby="st-design-title" ref={box} {...drop.bind}>
      <DropOverlay drop={drop} scope="element" look="stories" words={{ file: "Drop your picture here", busy: "Sending the picture…" }} icon={<Icon name="picture" size={40} />} />
      <h2 className="st-s-design__title" id="st-design-title">
        Design with AI
      </h2>
      <p className="st-s-design__lede">Say what {name ?? "your character"} is like, add a picture, or both. The character helper picks the looks, faces, moves and sounds. Nothing is saved until you tap Save.</p>
      <TextField
        label={name ? `What should ${name} look like?` : "What is your character like?"}
        multiline
        rows={3}
        value={words}
        max={600}
        onChange={setWords}
        placeholder="For example: a tall, clumsy robot called Zed in a blue cap who loves to dance"
      />
      <div className="st-s-field">
        <span className="st-s-field__label">A picture to start from (you can skip this)</span>
        {picture ? (
          <span className="st-s-design__pic">
            {picture.url ? <img src={picture.url} alt="The picture to design from" width={72} height={72} /> : <span className="st-s-design__noimg" aria-hidden="true" />}
            <button type="button" className="st-btn st-s-small" onClick={() => setPicture(null)}>
              Use no picture
            </button>
          </span>
        ) : sending !== null ? (
          <span className="st-s-refs__sending">
            <span>Sending the picture…</span>
            <ProgressBar value={sending} label="Sending the picture" />
          </span>
        ) : (
          <span className="st-s-design__pics">
            {pictures.map((p, i) => (
              <button key={p.assetId} type="button" className="st-s-design__own" aria-label={`Use picture ${i + 1}`} onClick={() => setPicture({ ...p, own: true })}>
                <img src={p.url} alt="" width={56} height={56} />
              </button>
            ))}
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="st-s-sr"
              id="st-design-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void send(f);
              }}
            />
            <label htmlFor="st-design-file" className="st-btn">
              Add a picture
            </label>
          </span>
        )}
      </div>
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      <TaskLine info={info} kind="character_design" run={run} expected={merged(info, usual, pick)} />
      {made && run.phase === "done" ? (
        <Notice tone="good">{characterId ? `Here is the new ${name ?? "look"}. See what changes below, then tap Use this.` : "Here is a first try. Look at it, change anything you like, then tap Save."}</Notice>
      ) : null}
      <div className="st-s-actionbar">
        <button type="button" className="st-btn" onClick={() => setOpen(false)}>
          Close
        </button>
        <ModelMenu info={info} usual={usual} value={pick} onChange={setPick} />
        <button type="button" className="st-btn st-btn--main" aria-disabled={busy || undefined} onClick={design}>
          {run.phase === "working" ? "Designing…" : made ? "Design it again" : "Design it"}
        </button>
      </div>
    </section>
  );
}

/** How many cars one design makes (§45.42: one model call, the photos sent once). */
const CARS_PER_DESIGN = 3;
/** The most photos one design sends (§45.47: 6 outside and 4 inside, 8 in all). */
const MAX_PHOTOS = 8;
const MAX_OUTSIDE = 6;
const MAX_INSIDE = 4;
/** The most looks "Make more" sends to stay away from (the API's limit). */
const MAX_AVOID = 8;

/** A saved picture of the vehicle in its photo strip (already in storage: never sent again). */
function savedPhoto(p: { assetId: string; url: string; side?: PhotoSide }): Photo {
  return { key: `saved-${p.assetId}`, assetId: p.assetId, url: p.url, state: "ready", file: new File([], "photo"), ...(p.side === "inside" ? { side: "inside" as const } : {}) };
}

const inside = (p: Photo) => p.side === "inside";

/** The photos, outside first then inside (the order they are sent in), within each side's limit and 8 in all. */
function sorted(list: Photo[]): Photo[] {
  const out = list.filter((p) => !inside(p)).slice(0, MAX_OUTSIDE);
  const ins = list.filter(inside).slice(0, MAX_INSIDE);
  return [...out, ...ins].slice(0, MAX_PHOTOS);
}

/**
 * "Design with AI" for a car (§45.42): the photo strip, the words, the model chip and Design it, which sends
 * `{kind: "car", referenceAssetIds, count: 3}` and shows the 3 cars to pick from. The first opens in the editor at once
 * (`onDraft`); tapping another puts that one there. On a saved car's page its own pictures start the strip, and the
 * agent keeps its name (the page shows what changes before Use this).
 */
export function CarDesign({
  ws,
  info,
  onDraft,
  startOpen = true,
  pictures = [],
  name,
  characterId,
  onPhotos,
  vehicle = "car",
}: {
  ws: string;
  info: AiInfo;
  onDraft: (c: CarInput) => void;
  startOpen?: boolean;
  /** the vehicle's own pictures (each with its side): they start the photo strips */
  pictures?: { assetId: string; url: string; side?: PhotoSide }[];
  /** a saved car keeps its name */
  name?: string;
  /** a saved car to redesign (the agent starts from it, §45.34) */
  characterId?: string;
  /** told whenever the photos change (New character keeps them with the car once it is saved) */
  onPhotos?: (photos: Photo[]) => void;
  /** the kind picked in "What is it?" (§45.47): the design keeps to its bodies; "car" is left out of the request */
  vehicle?: VehicleType;
}) {
  const [open, setOpen] = useState(startOpen);
  const [words, setWords] = useState("");
  const [photos, setPhotos] = useState<Photo[]>(() => sorted(pictures.map(savedPhoto)));
  /** the strip a paste anywhere on the page goes to: the one the owner last used */
  const [pasteTo, setPasteTo] = useState<PhotoSide>("outside");
  const [problem, setProblem] = useState<string | null>(null);
  const [pick, setPick] = useState<ModelOverride | null>(null);
  const [options, setOptions] = useState<CarInput[]>([]);
  const [picked, setPicked] = useState(0);
  /** the photos the shown cars were made from: once they change, the button makes a new set */
  const [madeFrom, setMadeFrom] = useState<string | null>(null);
  const more = useRef(false);
  const box = useRef<HTMLElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const latest = useRef(photos);
  latest.current = photos;
  const usual = usualFor(info, "character_design");
  const ready = photos.filter((p) => p.state === "ready" && p.assetId);
  const sending = photos.some((p) => p.state === "sending");
  const photoKey = ready.map((p) => p.assetId).join(",");
  const run = useAiTask(
    ws,
    (task) => {
      const cars = designsOf(task)
        .filter(isCar)
        .map((c) => (name ? { ...c, name } : c));
      if (!cars.length) {
        setProblem("No cars came back. Tap Design it again.");
        return;
      }
      if (more.current) setOptions((now) => [...now, ...cars].slice(0, MAX_CAR_OPTIONS));
      else {
        setOptions(cars.slice(0, MAX_CAR_OPTIONS));
        setPicked(0);
        onDraft(cars[0]!);
      }
      celebrate(box.current, 90);
    },
    () => design(more.current),
  );
  const busy = run.phase === "working";

  useEffect(() => {
    onPhotos?.(photos);
  }, [photos, onPhotos]);

  useEffect(
    () => () => {
      for (const p of latest.current) if (p.url.startsWith("blob:")) URL.revokeObjectURL(p.url);
    },
    [],
  );

  function design(again = false) {
    if (busy || sending) return;
    const description = words.trim();
    if (!description && !ready.length) return setProblem("Add a photo of your car, or say what it is like.");
    if (description.length > 600) return setProblem("Keep it to 600 letters.");
    setProblem(null);
    const count = again ? Math.min(CARS_PER_DESIGN, MAX_CAR_OPTIONS - options.length) : CARS_PER_DESIGN;
    if (count <= 0) return;
    const body: DesignBody = { kind: "car" };
    if (ready.length) body.referenceAssetIds = ready.map((p) => p.assetId!);
    // Left out when every photo is an outside one, and for a car (the API's defaults), so older bodies stay the same.
    if (ready.some(inside)) body.referenceSides = ready.map((p) => (inside(p) ? "inside" : "outside"));
    if (vehicle !== "car") body.vehicle = vehicle;
    body.count = count;
    if (description) body.description = description;
    if (characterId) body.characterId = characterId;
    if (again) body.avoid = options.slice(-MAX_AVOID).map((o) => o.car);
    const override = sendPick(info, usual, pick);
    if (override) body.override = override;
    more.current = again;
    if (!again) setMadeFrom(photoKey);
    void run.start(() => storiesApi().designCharacter(ws, body));
  }

  function choose(i: number) {
    const c = options[i];
    if (!c) return;
    setPicked(i);
    onDraft(c);
  }

  if (!open)
    return (
      <section className="st-s-design st-s-design--closed st-glass st-glass--hero" aria-labelledby="st-design-title" ref={box}>
        <div>
          <h2 className="st-s-design__title" id="st-design-title">
            Design with AI
          </h2>
          <p className="st-s-design__lede">{name ? `Add photos of ${name}, or say what to change. You check it before saving.` : "Add photos of your vehicle. You get cartoon ones to pick from."}</p>
        </div>
        <button type="button" className="st-btn" onClick={() => setOpen(true)}>
          Design with AI
        </button>
      </section>
    );

  const changed = madeFrom !== null && madeFrom !== photoKey;
  const outs = photos.filter((p) => !inside(p));
  const ins = photos.filter(inside);
  // Each strip changes only its own photos; the list stays outside first, then inside.
  const setOutside = (next: Photo[]) => setPhotos((now) => [...next, ...now.filter(inside)]);
  const setInside = (next: Photo[]) => setPhotos((now) => [...now.filter((p) => !inside(p)), ...next]);
  const outMax = Math.min(MAX_OUTSIDE, MAX_PHOTOS - ins.length);
  const inMax = Math.min(MAX_INSIDE, MAX_PHOTOS - outs.length);
  const full = (max: number, side: number, words: string) => (max < side ? `Up to ${MAX_PHOTOS} photos. Remove one first.` : words);
  return (
    <section className="st-s-design st-s-design--car st-glass st-glass--hero" aria-labelledby="st-design-title" ref={box}>
      <h2 className="st-s-design__title" id="st-design-title">
        Design with AI
      </h2>
      <div ref={strip}>
        <div className="st-s-photosides">
          <p className="st-s-photosides__hint">Drop, paste or pick photos.</p>
          <div onPointerDown={() => setPasteTo("outside")} onFocus={() => setPasteTo("outside")}>
            <Photos
              ws={ws}
              max={outMax}
              photos={outs}
              onChange={setOutside}
              side="outside"
              label="Outside"
              hint="Front, side, back. Up to 6."
              tooMany={full(outMax, MAX_OUTSIDE, "Up to 6 photos. Remove one first.")}
              catchPaste={pasteTo === "outside"}
            />
          </div>
          <div onPointerDown={() => setPasteTo("inside")} onFocus={() => setPasteTo("inside")}>
            <Photos
              ws={ws}
              max={inMax}
              photos={ins}
              onChange={setInside}
              side="inside"
              noun="inside photo"
              label="Inside"
              hint="Seats and dashboard. Up to 4."
              tooMany={full(inMax, MAX_INSIDE, "Up to 4 inside photos. Remove one first.")}
              catchPaste={pasteTo === "inside"}
            />
          </div>
        </div>
      </div>
      <TextField
        label="What is it like? (you can skip this)"
        multiline
        rows={2}
        value={words}
        max={600}
        onChange={setWords}
        placeholder="For example: my red hatchback, a bit old"
      />
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      <TaskLine info={info} kind="character_design" run={run} expected={merged(info, usual, pick)} />
      <div className="st-s-actionbar">
        <button type="button" className="st-btn" onClick={() => setOpen(false)}>
          Close
        </button>
        <ModelMenu info={info} usual={usual} value={pick} onChange={setPick} />
        <button type="button" className="st-btn st-btn--main" aria-disabled={busy || sending || undefined} onClick={() => design(false)}>
          {busy ? `Designing ${CARS_PER_DESIGN}…` : options.length && !changed ? "Design it again" : "Design it"}
        </button>
      </div>
      {options.length ? (
        <CarOptions
          options={options}
          picked={picked}
          onPick={choose}
          busy={busy}
          onMore={() => design(true)}
          onPhotos={() => strip.current?.scrollIntoView?.({ block: "center" })}
        />
      ) : null}
    </section>
  );
}
