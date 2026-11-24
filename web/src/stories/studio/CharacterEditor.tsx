// Making and changing a character (docs/CONTRACTS.md §45.8, §45.16.5): a stepper of five parts (Looks, Face, Moves,
// Sounds, Name and personality) beside a live preview drawn by the same engine as the videos. Every look choice the
// rig has is here; each face and each move can be tried on the preview. Save stays at the bottom right. A car (§45.42)
// has the same five parts and stepper with its own Looks, Face and Moves (CarParts.tsx) and a car preview; Sounds is
// SoundsPart for both, where every sound can be heard first (§45.41). Next and Back open the next part at its top; Try
// brings the preview into view on a phone; unsaved changes ask "Leave without saving?" before the page changes.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isCar, type CarInput, type CharacterInput, type PersonInput } from "../api/types.ts";
import { CATALOG } from "../engine/catalog.ts";
import type { CarMove } from "../engine/engine.ts";
import type { ActionId, CarLook, CharacterLook, Expression } from "../engine/types.ts";
import { CarPreview } from "../preview/CarPreview.tsx";
import { CharacterPreview } from "../preview/CharacterPreview.tsx";
import { CarFacePart, CarLooksPart, CarMovesPart } from "./CarParts.tsx";
import { storiesReduceMotion } from "../prefs.ts";
import { useWidth } from "./hooks.ts";
import { Chip, Notice, Pick, Slider, Swatches, TextField } from "./kit.tsx";
import { useLeaveGuard } from "./leaveGuard.tsx";
import {
  ACCESSORY,
  BODY,
  BROWS,
  CHAR_LIMITS,
  characterProblem,
  carMoveLabel,
  CLOTHES,
  EYE_COLORS,
  EYES,
  HAIR,
  HAIR_COLORS,
  MOUTH,
  MOVE_LINE,
  NOSE,
  OUTLINES,
  PATTERN,
  showFace,
  SKIN,
} from "./looks.ts";
import { SoundsPart } from "./SoundsPart.tsx";

export type EditorPart = "looks" | "face" | "moves" | "sounds" | "name";

export const PARTS: { value: EditorPart; label: string }[] = [
  { value: "looks", label: "Looks" },
  { value: "face", label: "Face" },
  { value: "moves", label: "Moves" },
  { value: "sounds", label: "Sounds" },
  { value: "name", label: "Name and personality" },
];

/** Which part to open to fix a problem. */
function partFor(problem: string): EditorPart {
  if (/name|description|personality|trait/i.test(problem)) return "name";
  if (/face|neutral/i.test(problem)) return "face";
  if (/noise|sound/i.test(problem)) return "sounds";
  return "looks";
}

const sizeWords = (n: number, small: string, big: string) => (n < 0.95 ? small : n > 1.05 ? big : "Just right");

/** What a person and a car both have (the parts the editor changes the same way for both). */
type Common = Omit<PersonInput, "kind" | "look" | "car">;

/** A person's moves to try: getting in and out need a car, so they are tried in a video. */
const PERSON_MOVES = CATALOG.actions.filter((a) => a.id !== "get_in" && a.id !== "get_out").map((a) => ({ value: a.id, label: a.label }));

/** The same words in a stable order, so two inputs compare by what they say (the order of their keys aside). */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}

/** What Save would send: the name and traits trimmed, as save() sends them. */
const cleaned = (c: CharacterInput): CharacterInput => ({ ...c, name: c.name.trim(), traits: c.traits.map((t) => t.trim()).filter(Boolean) });

/** True when the two characters would save the same. */
export function sameCharacter(a: CharacterInput, b: CharacterInput): boolean {
  return JSON.stringify(stable(cleaned(a))) === JSON.stringify(stable(cleaned(b)));
}

export function CharacterEditor({
  initial,
  mode,
  saving,
  onSave,
  serverProblem,
  aside,
  startPart,
  otherMaker,
  onEdit,
  saved,
  onChange,
  hold = true,
}: {
  initial: CharacterInput;
  /** what is saved now (a new character: nothing yet), so unsaved changes ask before the page changes; else `initial` */
  saved?: CharacterInput;
  /** the character as the editor has it now, after every change */
  onChange?: (c: CharacterInput) => void;
  /** false while the page leaves on purpose (the character is being deleted): unsaved changes do not ask then */
  hold?: boolean;
  /** the part to open first (after Design with AI: the name and personality, to check them) */
  startPart?: EditorPart;
  mode: "new" | "edit";
  saving: boolean;
  onSave: (c: CharacterInput) => void;
  /** What the server said about the last Save. */
  serverProblem?: ReactNode;
  /** More under the preview (the reference pictures, the AI picture). */
  aside?: ReactNode;
  /** the workspace's effects maker is not the built-in one (the Sounds part says the videos can sound different) */
  otherMaker?: boolean;
  /** told on each change the owner makes */
  onEdit?: () => void;
}) {
  const [c, setC] = useState<CharacterInput>(initial);
  const [part, setPart] = useState<EditorPart>(startPart ?? "looks");
  // The preview opens on the character's own face (happy if it has it, else its first face that is not neutral).
  const [face, setFace] = useState<Expression>(() => showFace(initial));
  const [move, setMove] = useState<ActionId>("idle");
  const [carMove, setCarMove] = useState<CarMove>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [trait, setTrait] = useState("");
  const [box, width] = useWidth<HTMLDivElement>(220);
  const size = Math.max(140, Math.min(260, width - 24));
  const preview = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  /** Set by Next and Back: the part they open comes into view at its top, with the focus. */
  const jumped = useRef(false);
  const leave = useLeaveGuard(hold && !saving && !sameCharacter(c, saved ?? initial));
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    changed.current?.(c);
  }, [c]);

  useEffect(() => {
    if (!jumped.current) return;
    jumped.current = false;
    const top = panel.current?.querySelector<HTMLElement>(".st-s-editor__parts");
    top?.scrollIntoView?.({ block: "start", behavior: storiesReduceMotion() ? "auto" : "smooth" });
    panel.current?.querySelector<HTMLElement>(".st-s-editor__part")?.focus({ preventScroll: true });
  }, [part]);

  /** Next or Back: the other part, from its top. */
  const goTo = (next: EditorPart) => {
    jumped.current = true;
    setPart(next);
  };

  /** Try a face or a move: on a phone the preview is far above, so it comes into view to show it. */
  const showPreview = () => {
    const el = preview.current;
    if (!el || typeof window === "undefined") return;
    const r = el.getBoundingClientRect();
    if (r.top >= 0 && r.bottom <= window.innerHeight) return;
    el.scrollIntoView?.({ block: "nearest", behavior: storiesReduceMotion() ? "auto" : "smooth" });
  };

  const update = (next: (prev: CharacterInput) => CharacterInput) => {
    setProblem(null);
    onEdit?.();
    setC(next);
  };
  const set = (patch: Partial<Common>) => update((prev) => ({ ...prev, ...patch }) as CharacterInput);
  const setLook = (patch: Partial<CharacterLook>) => update((prev) => (isCar(prev) ? prev : { ...prev, look: { ...prev.look, ...patch } }));
  const setCar = (patch: Partial<CarLook>) => update((prev) => (isCar(prev) ? { ...prev, car: { ...prev.car, ...patch } } : prev));
  const car: CarInput | null = isCar(c) ? c : null;
  const person: PersonInput | null = isCar(c) ? null : c;
  const at = PARTS.findIndex((p) => p.value === part);
  const last = at === PARTS.length - 1;

  function save() {
    const why = characterProblem(c);
    if (why) {
      setProblem(why);
      setPart(partFor(why));
      return;
    }
    onSave({ ...c, name: c.name.trim(), traits: c.traits.map((t) => t.trim()).filter(Boolean) });
  }

  function toggleFace(e: Expression) {
    if (e === "neutral") return;
    set({ expressions: c.expressions.includes(e) ? c.expressions.filter((x) => x !== e) : [...c.expressions, e] });
    setFace(e);
  }

  function addTrait() {
    const t = trait.trim();
    if (!t) return;
    if (t.length > CHAR_LIMITS.trait) return setProblem(`Keep each trait to ${CHAR_LIMITS.trait} letters.`);
    if (c.traits.length >= CHAR_LIMITS.traits) return setProblem(`Keep it to ${CHAR_LIMITS.traits} traits.`);
    if (!c.traits.some((x) => x.toLowerCase() === t.toLowerCase())) set({ traits: [...c.traits, t] });
    setTrait("");
  }

  const name = c.name.trim() || (car ? "Your vehicle" : "Your character");
  const faceLabel = CATALOG.expressions.find((e) => e.id === face)?.label ?? face;
  const moveLabel = car ? carMoveLabel(carMove) : (CATALOG.actions.find((a) => a.id === move)?.label ?? move);

  return (
    <div className="st-s-editor">
      <div className="st-s-editor__stage" ref={box}>
        {/* The editor's hero: its rim may bend (glass/lens.ts decides). */}
        <div className="st-s-editor__preview st-lens" ref={preview}>
          {car ? (
            <CarPreview car={car.car} movementStyle={car.movementStyle} expression={face} move={carMove} size={size} label={car.car.face.eyes === "none" ? `${name}, ${moveLabel}` : `${name}, ${faceLabel} face, ${moveLabel}`} />
          ) : person ? (
            <CharacterPreview look={person.look} movementStyle={person.movementStyle} expression={face} action={move} size={size} label={`${name}, ${faceLabel} face, ${moveLabel}`} />
          ) : null}
          <p className="st-s-editor__now">
            <strong>{name}</strong>
            <span>{car && car.car.face.eyes === "none" ? moveLabel : `${faceLabel} · ${moveLabel}`}</span>
          </p>
        </div>
        {aside}
      </div>

      <div className="st-s-editor__panel" ref={panel}>
        <Pick label={car ? "Make your vehicle" : "Make your character"} hideLabel value={part} options={PARTS} onChange={setPart} className="st-s-editor__parts" />

        {car && part === "looks" ? <CarLooksPart car={car.car} onChange={setCar} /> : null}
        {car && part === "face" ? (
          <CarFacePart
            c={car}
            name={name}
            face={face}
            onTry={(f) => {
              setFace(f);
              showPreview();
            }}
            onChange={(next) => update(() => next)}
          />
        ) : null}
        {car && part === "moves" ? (
          <CarMovesPart
            name={name}
            style={car.movementStyle}
            move={carMove}
            onStyle={(movementStyle) => set({ movementStyle })}
            onMove={(m) => {
              setCarMove(m);
              showPreview();
            }}
          />
        ) : null}

        {person && part === "looks" ? (
          <div className="st-s-editor__part" aria-label="Looks" tabIndex={-1}>
            <fieldset className="st-s-group">
              <legend className="st-s-group__title">Body</legend>
              <Pick label="Shape" value={person.look.body} options={BODY} onChange={(body) => setLook({ body })} />
              <Slider label="Height" min={0.85} max={1.15} step={0.05} value={person.look.height} words={sizeWords(person.look.height, "Shorter", "Taller")} onChange={(height) => setLook({ height })} />
              <Slider label="Width" min={0.85} max={1.15} step={0.05} value={person.look.width} words={sizeWords(person.look.width, "Thinner", "Wider")} onChange={(w) => setLook({ width: w })} />
              <Swatches label="Skin" value={person.look.skin} colors={SKIN} onChange={(skin) => setLook({ skin })} />
            </fieldset>
            <fieldset className="st-s-group">
              <legend className="st-s-group__title">Hair</legend>
              <Pick label="Hair style" value={person.look.hair.style} options={HAIR} onChange={(style) => setLook({ hair: { ...person.look.hair, style } })} />
              <Swatches label="Hair colour" value={person.look.hair.color} colors={HAIR_COLORS} onChange={(color) => setLook({ hair: { ...person.look.hair, color } })} />
            </fieldset>
            <fieldset className="st-s-group">
              <legend className="st-s-group__title">Face</legend>
              <Pick label="Eyes" value={person.look.eyes.shape} options={EYES} onChange={(shape) => setLook({ eyes: { ...person.look.eyes, shape } })} />
              <Swatches label="Eye colour" value={person.look.eyes.color} colors={EYE_COLORS} onChange={(color) => setLook({ eyes: { ...person.look.eyes, color } })} />
              <Pick label="Eyebrows" value={person.look.brows} options={BROWS} onChange={(brows) => setLook({ brows })} />
              <Pick label="Nose" value={person.look.nose} options={NOSE} onChange={(nose) => setLook({ nose })} />
              <Pick label="Mouth" value={person.look.mouth} options={MOUTH} onChange={(mouth) => setLook({ mouth })} />
            </fieldset>
            <fieldset className="st-s-group">
              <legend className="st-s-group__title">Clothes</legend>
              <Swatches label="Top" value={person.look.outfit.top} colors={CLOTHES} onChange={(top) => setLook({ outfit: { ...person.look.outfit, top } })} />
              <Swatches label="Bottom" value={person.look.outfit.bottom} colors={CLOTHES} onChange={(bottom) => setLook({ outfit: { ...person.look.outfit, bottom } })} />
              <Swatches label="Little bits" value={person.look.outfit.accent} colors={CLOTHES} onChange={(accent) => setLook({ outfit: { ...person.look.outfit, accent } })} />
              <Pick label="Pattern" value={person.look.outfit.pattern} options={PATTERN} onChange={(pattern) => setLook({ outfit: { ...person.look.outfit, pattern } })} />
            </fieldset>
            <fieldset className="st-s-group">
              <legend className="st-s-group__title">Extras</legend>
              <Pick label="Wears" value={person.look.accessory} options={ACCESSORY} onChange={(accessory) => setLook({ accessory })} />
              <Swatches label="Outline" value={person.look.outline} colors={OUTLINES} onChange={(outline) => setLook({ outline })} />
            </fieldset>
          </div>
        ) : null}

        {person && part === "face" ? (
          <div className="st-s-editor__part" aria-label="Face" tabIndex={-1}>
            <p className="st-s-editor__lede">Pick the faces {name} can make. Tap Try to see one. Neutral is always there.</p>
            <ul className="st-s-faces">
              {CATALOG.expressions.map((e) => {
                const on = c.expressions.includes(e.id);
                return (
                  <li key={e.id} className={`st-s-face${on ? " is-on" : ""}${face === e.id ? " is-trying" : ""}`}>
                    <CharacterPreview look={person.look} movementStyle={c.movementStyle} expression={e.id} action="idle" size={72} playing={false} label={`${name} looking ${e.label.toLowerCase()}`} />
                    <span className="st-s-face__name">{e.label}</span>
                    <span className="st-s-face__btns">
                      <Chip on={on} onToggle={() => toggleFace(e.id)} locked={e.id === "neutral"} lockedWhy="Every character keeps the Neutral face.">
                        {on ? "Uses it" : "Use it"}
                      </Chip>
                      <button
                        type="button"
                        className="st-btn st-s-small"
                        aria-pressed={face === e.id}
                        onClick={() => {
                          setFace(e.id);
                          showPreview();
                        }}
                      >
                        Try<span className="st-s-sr"> {e.label}</span>
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="st-s-field__hint">
              {c.expressions.length} faces picked{c.expressions.length < CHAR_LIMITS.faces ? `: pick at least ${CHAR_LIMITS.faces}.` : "."}
            </p>
          </div>
        ) : null}

        {person && part === "moves" ? (
          <div className="st-s-editor__part" aria-label="Moves" tabIndex={-1}>
            <Pick
              label={`How ${name} moves`}
              big
              value={c.movementStyle}
              options={CATALOG.movementStyles.map((m) => ({ value: m.id, label: m.label, line: MOVE_LINE[m.id] }))}
              onChange={(movementStyle) => set({ movementStyle })}
            />
            <Pick
              label="Try a move"
              value={move}
              options={PERSON_MOVES}
              onChange={(m) => {
                setMove(m);
                showPreview();
              }}
              className="st-s-moves"
            />
          </div>
        ) : null}

        {part === "sounds" ? <SoundsPart kind={car ? "car" : "person"} name={name} voice={c.voice} onChange={(voice) => set({ voice })} otherMaker={otherMaker} /> : null}

        {part === "name" ? (
          <div className="st-s-editor__part" aria-label="Name and personality" tabIndex={-1}>
            <TextField label="Name" value={c.name} max={CHAR_LIMITS.name} placeholder={car ? "For example: Rosso" : "For example: Pip"} onChange={(name) => set({ name })} />
            <TextField
              label="What they look like"
              multiline
              value={c.description}
              max={CHAR_LIMITS.description}
              placeholder={car ? "For example: a small red hatchback" : "For example: a small driver in a yellow jumper"}
              onChange={(description) => set({ description })}
            />
            <TextField
              label="Personality"
              multiline
              value={c.personality}
              max={CHAR_LIMITS.personality}
              placeholder="For example: cheerful, gets a fright, then stays calm"
              onChange={(personality) => set({ personality })}
            />
            <div className="st-s-field">
              <label className="st-s-field__label" htmlFor="st-trait">
                Traits ({c.traits.length} of {CHAR_LIMITS.traits})
              </label>
              <span className="st-s-trait-add">
                <input
                  id="st-trait"
                  className="st-s-input"
                  value={trait}
                  placeholder="For example: brave"
                  maxLength={CHAR_LIMITS.trait}
                  onChange={(e) => setTrait(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTrait();
                    }
                  }}
                />
                <button type="button" className="st-btn" aria-disabled={!trait.trim() || undefined} onClick={addTrait}>
                  Add
                </button>
              </span>
              {c.traits.length ? (
                <ul className="st-s-chips">
                  {c.traits.map((t) => (
                    <li key={t}>
                      <button type="button" className="st-s-chipbtn is-on" aria-label={`Remove ${t}`} onClick={() => set({ traits: c.traits.filter((x) => x !== t) })}>
                        {t} <span aria-hidden="true">×</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ) : null}

        {problem ? <Notice tone="bad">{problem}</Notice> : null}
        {serverProblem}

        <div className="st-s-actionbar">
          {at > 0 ? (
            <button type="button" className="st-btn" onClick={() => goTo(PARTS[at - 1]!.value)}>
              Back
            </button>
          ) : null}
          {!last ? (
            <button type="button" className={`st-btn${mode === "new" ? " st-btn--main" : ""}`} onClick={() => goTo(PARTS[at + 1]!.value)}>
              Next: {PARTS[at + 1]!.label}
            </button>
          ) : null}
          {mode === "edit" || last ? (
            <button type="button" className="st-btn st-btn--main" aria-disabled={saving || undefined} onClick={() => !saving && save()}>
              {saving ? "Saving…" : mode === "new" ? (car ? "Save vehicle" : "Save character") : "Save changes"}
            </button>
          ) : null}
        </div>
      </div>
      {leave}
    </div>
  );
}
