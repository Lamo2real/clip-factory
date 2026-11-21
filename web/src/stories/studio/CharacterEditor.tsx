// Making and changing a character (docs/CONTRACTS.md §45.8, §45.16.5): a stepper of five parts (Looks, Face, Moves,
// Sounds, Name and personality) beside a live preview drawn by the same engine as the videos. Every look choice the
// rig has is here; each face and each move can be tried on the preview. Save stays at the bottom right.
import { useState, type ReactNode } from "react";
import type { CharacterInput } from "../api/types.ts";
import { CATALOG } from "../engine/catalog.ts";
import type { ActionId, CharacterLook, Expression, NoiseId, SfxId } from "../engine/types.ts";
import { CharacterPreview } from "../preview/CharacterPreview.tsx";
import { useWidth } from "./hooks.ts";
import { Chip, Notice, Pick, Slider, Swatches, TextField } from "./kit.tsx";
import {
  ACCESSORY,
  BODY,
  BROWS,
  CHAR_LIMITS,
  characterProblem,
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
  SKIN,
  VOICE_STYLE,
} from "./looks.ts";

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

export function CharacterEditor({
  initial,
  mode,
  saving,
  onSave,
  serverProblem,
  aside,
  startPart,
}: {
  initial: CharacterInput;
  /** the part to open first (after Design with AI: the name and personality, to check them) */
  startPart?: EditorPart;
  mode: "new" | "edit";
  saving: boolean;
  onSave: (c: CharacterInput) => void;
  /** What the server said about the last Save. */
  serverProblem?: ReactNode;
  /** More under the preview (the reference pictures, the AI picture). */
  aside?: ReactNode;
}) {
  const [c, setC] = useState<CharacterInput>(initial);
  const [part, setPart] = useState<EditorPart>(startPart ?? "looks");
  const [face, setFace] = useState<Expression>("happy");
  const [move, setMove] = useState<ActionId>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [trait, setTrait] = useState("");
  const [box, width] = useWidth<HTMLDivElement>(220);
  const size = Math.max(140, Math.min(260, width - 24));

  const set = (patch: Partial<CharacterInput>) => {
    setProblem(null);
    setC((prev) => ({ ...prev, ...patch }));
  };
  const setLook = (patch: Partial<CharacterLook>) => set({ look: { ...c.look, ...patch } });
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

  function toggle<T extends string>(list: T[], v: T, max: number): T[] {
    if (list.includes(v)) return list.filter((x) => x !== v);
    return list.length >= max ? list : [...list, v];
  }

  function addTrait() {
    const t = trait.trim();
    if (!t) return;
    if (t.length > CHAR_LIMITS.trait) return setProblem(`Keep each trait to ${CHAR_LIMITS.trait} letters.`);
    if (c.traits.length >= CHAR_LIMITS.traits) return setProblem(`Keep it to ${CHAR_LIMITS.traits} traits.`);
    if (!c.traits.some((x) => x.toLowerCase() === t.toLowerCase())) set({ traits: [...c.traits, t] });
    setTrait("");
  }

  const name = c.name.trim() || "Your character";
  const faceLabel = CATALOG.expressions.find((e) => e.id === face)?.label ?? face;
  const moveLabel = CATALOG.actions.find((a) => a.id === move)?.label ?? move;

  return (
    <div className="st-s-editor">
      <div className="st-s-editor__stage" ref={box}>
        <div className="st-s-editor__preview">
          <CharacterPreview look={c.look} movementStyle={c.movementStyle} expression={face} action={move} size={size} label={`${name}, ${faceLabel} face, ${moveLabel}`} />
          <p className="st-s-editor__now">
            <strong>{name}</strong>
            <span>
              {faceLabel} · {moveLabel}
            </span>
          </p>
        </div>
        {aside}
      </div>

      <div className="st-s-editor__panel">
        <Pick label="Make your character" hideLabel value={part} options={PARTS} onChange={setPart} className="st-s-editor__parts" />

        {part === "looks" ? (
          <div className="st-s-editor__part" aria-label="Looks">
            <fieldset className="st-s-group">
              <legend className="st-s-group__title">Body</legend>
              <Pick label="Shape" value={c.look.body} options={BODY} onChange={(body) => setLook({ body })} />
              <Slider label="Height" min={0.85} max={1.15} step={0.05} value={c.look.height} words={sizeWords(c.look.height, "Shorter", "Taller")} onChange={(height) => setLook({ height })} />
              <Slider label="Width" min={0.85} max={1.15} step={0.05} value={c.look.width} words={sizeWords(c.look.width, "Thinner", "Wider")} onChange={(w) => setLook({ width: w })} />
              <Swatches label="Skin" value={c.look.skin} colors={SKIN} onChange={(skin) => setLook({ skin })} />
            </fieldset>
            <fieldset className="st-s-group">
              <legend className="st-s-group__title">Hair</legend>
              <Pick label="Hair style" value={c.look.hair.style} options={HAIR} onChange={(style) => setLook({ hair: { ...c.look.hair, style } })} />
              <Swatches label="Hair colour" value={c.look.hair.color} colors={HAIR_COLORS} onChange={(color) => setLook({ hair: { ...c.look.hair, color } })} />
            </fieldset>
            <fieldset className="st-s-group">
              <legend className="st-s-group__title">Face</legend>
              <Pick label="Eyes" value={c.look.eyes.shape} options={EYES} onChange={(shape) => setLook({ eyes: { ...c.look.eyes, shape } })} />
              <Swatches label="Eye colour" value={c.look.eyes.color} colors={EYE_COLORS} onChange={(color) => setLook({ eyes: { ...c.look.eyes, color } })} />
              <Pick label="Eyebrows" value={c.look.brows} options={BROWS} onChange={(brows) => setLook({ brows })} />
              <Pick label="Nose" value={c.look.nose} options={NOSE} onChange={(nose) => setLook({ nose })} />
              <Pick label="Mouth" value={c.look.mouth} options={MOUTH} onChange={(mouth) => setLook({ mouth })} />
            </fieldset>
            <fieldset className="st-s-group">
              <legend className="st-s-group__title">Clothes</legend>
              <Swatches label="Top" value={c.look.outfit.top} colors={CLOTHES} onChange={(top) => setLook({ outfit: { ...c.look.outfit, top } })} />
              <Swatches label="Bottom" value={c.look.outfit.bottom} colors={CLOTHES} onChange={(bottom) => setLook({ outfit: { ...c.look.outfit, bottom } })} />
              <Swatches label="Little bits" value={c.look.outfit.accent} colors={CLOTHES} onChange={(accent) => setLook({ outfit: { ...c.look.outfit, accent } })} />
              <Pick label="Pattern" value={c.look.outfit.pattern} options={PATTERN} onChange={(pattern) => setLook({ outfit: { ...c.look.outfit, pattern } })} />
            </fieldset>
            <fieldset className="st-s-group">
              <legend className="st-s-group__title">Extras</legend>
              <Pick label="Wears" value={c.look.accessory} options={ACCESSORY} onChange={(accessory) => setLook({ accessory })} />
              <Swatches label="Outline" value={c.look.outline} colors={OUTLINES} onChange={(outline) => setLook({ outline })} />
            </fieldset>
          </div>
        ) : null}

        {part === "face" ? (
          <div className="st-s-editor__part" aria-label="Face">
            <p className="st-s-editor__lede">Pick the faces {name} can make. Tap Try to see one. Neutral is always there.</p>
            <ul className="st-s-faces">
              {CATALOG.expressions.map((e) => {
                const on = c.expressions.includes(e.id);
                return (
                  <li key={e.id} className={`st-s-face${on ? " is-on" : ""}${face === e.id ? " is-trying" : ""}`}>
                    <CharacterPreview look={c.look} movementStyle={c.movementStyle} expression={e.id} action="idle" size={72} playing={false} label={`${name} looking ${e.label.toLowerCase()}`} />
                    <span className="st-s-face__name">{e.label}</span>
                    <span className="st-s-face__btns">
                      <Chip on={on} onToggle={() => toggleFace(e.id)} locked={e.id === "neutral"} lockedWhy="Every character keeps the Neutral face.">
                        {on ? "Uses it" : "Use it"}
                      </Chip>
                      <button type="button" className="st-btn st-s-small" aria-pressed={face === e.id} onClick={() => setFace(e.id)}>
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

        {part === "moves" ? (
          <div className="st-s-editor__part" aria-label="Moves">
            <Pick
              label={`How ${name} moves`}
              big
              value={c.movementStyle}
              options={CATALOG.movementStyles.map((m) => ({ value: m.id, label: m.label, line: MOVE_LINE[m.id] }))}
              onChange={(movementStyle) => set({ movementStyle })}
            />
            <Pick label="Try a move" value={move} options={CATALOG.actions.map((a) => ({ value: a.id, label: a.label }))} onChange={setMove} className="st-s-moves" />
          </div>
        ) : null}

        {part === "sounds" ? (
          <div className="st-s-editor__part" aria-label="Sounds">
            <p className="st-s-editor__lede">Lamo Stories videos have no talking. {name} makes little noises instead. You will hear them in the video.</p>
            <Pick label="Voice" value={c.voice.style} options={VOICE_STYLE} onChange={(style) => set({ voice: { ...c.voice, style } })} />
            <Slider
              label="Voice pitch"
              min={0.5}
              max={2}
              step={0.05}
              value={c.voice.pitch}
              words={c.voice.pitch < 0.85 ? "Low" : c.voice.pitch > 1.3 ? "High" : "Middle"}
              onChange={(pitch) => set({ voice: { ...c.voice, pitch } })}
            />
            <div className="st-s-field">
              <span className="st-s-field__label">
                Noises ({c.voice.noises.length} of {CHAR_LIMITS.noises})
              </span>
              <div className="st-s-chips">
                {CATALOG.noises.map((n) => (
                  <Chip key={n.id} on={c.voice.noises.includes(n.id)} onToggle={() => set({ voice: { ...c.voice, noises: toggle<NoiseId>(c.voice.noises, n.id, CHAR_LIMITS.noises) } })}>
                    {n.label}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="st-s-field">
              <span className="st-s-field__label">
                Favourite sound effects ({c.voice.sfx.length} of {CHAR_LIMITS.sfx})
              </span>
              <div className="st-s-chips">
                {CATALOG.sfx.map((s) => (
                  <Chip key={s.id} on={c.voice.sfx.includes(s.id)} onToggle={() => set({ voice: { ...c.voice, sfx: toggle<SfxId>(c.voice.sfx, s.id, CHAR_LIMITS.sfx) } })}>
                    {s.label}
                  </Chip>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {part === "name" ? (
          <div className="st-s-editor__part" aria-label="Name and personality">
            <TextField label="Name" value={c.name} max={CHAR_LIMITS.name} placeholder="For example: Pip" onChange={(name) => set({ name })} />
            <TextField
              label="What they look like"
              multiline
              value={c.description}
              max={CHAR_LIMITS.description}
              placeholder="For example: a small driver in a yellow jumper"
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
            <button type="button" className="st-btn" onClick={() => setPart(PARTS[at - 1]!.value)}>
              Back
            </button>
          ) : null}
          {!last ? (
            <button type="button" className={`st-btn${mode === "new" ? " st-btn--main" : ""}`} onClick={() => setPart(PARTS[at + 1]!.value)}>
              Next: {PARTS[at + 1]!.label}
            </button>
          ) : null}
          {mode === "edit" || last ? (
            <button type="button" className="st-btn st-btn--main" aria-disabled={saving || undefined} onClick={() => !saving && save()}>
              {saving ? "Saving…" : mode === "new" ? "Save character" : "Save changes"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
