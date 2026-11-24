// A car character's parts in the editor (docs/CONTRACTS.md §45.42): Looks (shape, paint, windows, wheels, lights,
// extras), Face (none by default: a real-looking car; eyes on the windscreen or in the headlights for fun) and Moves
// (how it drives, and each move to try on the preview: "Honk" plays the honk itself). Sounds is SoundsPart.
import "../styles/sd-cars.css";
import { useEffect, useRef } from "react";
import type { CarInput } from "../api/types.ts";
import { CATALOG } from "../engine/catalog.ts";
import type { CarMove } from "../engine/engine.ts";
import type { CarLook, Expression, MovementStyle } from "../engine/types.ts";
import { CarPreview } from "../preview/CarPreview.tsx";
import { Chip, Pick, Slider, Swatches } from "./kit.tsx";
import {
  CAR_BODY,
  CAR_EXTRA,
  CAR_EYES,
  CAR_FACES_ON,
  CAR_FRONT_LIGHTS,
  CAR_MOUTH,
  CAR_MOVE_LINE,
  CAR_MOVES,
  CAR_PATTERN,
  CAR_REAR_LIGHTS,
  CAR_WHEELS,
  CAR_WINDOWS,
  CHAR_LIMITS,
  EYE_COLORS,
  OUTLINES,
  PAINT,
  RIMS,
  withColour,
} from "./looks.ts";
import { hearState, playSample, stopSample } from "./samples.ts";

const sizeWords = (n: number, small: string, big: string) => (n < 0.95 ? small : n > 1.05 ? big : "Just right");

export function CarLooksPart({ car, onChange }: { car: CarLook; onChange: (patch: Partial<CarLook>) => void }) {
  return (
    <div className="st-s-editor__part" aria-label="Looks" tabIndex={-1}>
      <fieldset className="st-s-group">
        <legend className="st-s-group__title">Shape</legend>
        <Pick label="Shape" value={car.body} options={CAR_BODY} onChange={(body) => onChange({ body })} />
        <Slider label="Length" min={0.85} max={1.15} step={0.05} value={car.length} words={sizeWords(car.length, "Shorter", "Longer")} onChange={(length) => onChange({ length })} />
        <Slider label="Height" min={0.85} max={1.15} step={0.05} value={car.height} words={sizeWords(car.height, "Lower", "Taller")} onChange={(height) => onChange({ height })} />
      </fieldset>
      <fieldset className="st-s-group">
        <legend className="st-s-group__title">Paint</legend>
        <Swatches label="Paint" value={car.paint} colors={withColour(PAINT, car.paint, "Your vehicle's colour")} onChange={(paint) => onChange({ paint })} />
        <Swatches label="Second colour" value={car.accent} colors={withColour(PAINT, car.accent, "Your vehicle's second colour")} onChange={(accent) => onChange({ accent })} />
        <Pick label="Pattern" value={car.pattern} options={CAR_PATTERN} onChange={(pattern) => onChange({ pattern })} />
      </fieldset>
      <fieldset className="st-s-group">
        <legend className="st-s-group__title">Windows</legend>
        <Pick label="Windows" value={car.windows} options={CAR_WINDOWS} onChange={(windows) => onChange({ windows })} />
      </fieldset>
      <fieldset className="st-s-group">
        <legend className="st-s-group__title">Wheels</legend>
        <Pick label="Wheels" value={car.wheels.style} options={CAR_WHEELS} onChange={(style) => onChange({ wheels: { ...car.wheels, style } })} />
        <Swatches label="Rims" value={car.wheels.rim} colors={withColour(RIMS, car.wheels.rim, "Your vehicle's rims")} onChange={(rim) => onChange({ wheels: { ...car.wheels, rim } })} />
        <Slider label="Wheel size" min={0.85} max={1.2} step={0.05} value={car.wheels.size} words={sizeWords(car.wheels.size, "Smaller", "Bigger")} onChange={(size) => onChange({ wheels: { ...car.wheels, size } })} />
      </fieldset>
      <fieldset className="st-s-group">
        <legend className="st-s-group__title">Lights</legend>
        <Pick label="Front lights" value={car.lights.front} options={CAR_FRONT_LIGHTS} onChange={(front) => onChange({ lights: { ...car.lights, front } })} />
        <Pick label="Back lights" value={car.lights.rear} options={CAR_REAR_LIGHTS} onChange={(rear) => onChange({ lights: { ...car.lights, rear } })} />
      </fieldset>
      <fieldset className="st-s-group">
        <legend className="st-s-group__title">Extras</legend>
        <Pick label="On top" value={car.extra} options={CAR_EXTRA} onChange={(extra) => onChange({ extra })} />
        <Swatches label="Outline" value={car.outline} colors={withColour(OUTLINES, car.outline, "Your vehicle's outline")} onChange={(outline) => onChange({ outline })} />
      </fieldset>
    </div>
  );
}

/**
 * A car's face: none to start (a real car). Eyes on gives neutral, happy and surprised when it had fewer than 3 faces;
 * eyes off keeps only neutral (§45.42). With eyes, the mouth, the eye colour and the faces, each tried on the car.
 */
export function CarFacePart({ c, name, face, onTry, onChange }: { c: CarInput; name: string; face: Expression; onTry: (e: Expression) => void; onChange: (next: CarInput) => void }) {
  const eyes = c.car.face.eyes;
  function setEyes(next: CarLook["face"]["eyes"]) {
    const expressions = next === "none" ? (["neutral"] as Expression[]) : c.expressions.length < CHAR_LIMITS.faces ? [...CAR_FACES_ON] : c.expressions;
    onChange({ ...c, car: { ...c.car, face: { ...c.car.face, eyes: next } }, expressions });
    onTry(next === "none" ? "neutral" : expressions.includes("happy") ? "happy" : (expressions.find((e) => e !== "neutral") ?? "neutral"));
  }
  function toggleFace(e: Expression) {
    if (e === "neutral") return;
    onChange({ ...c, expressions: c.expressions.includes(e) ? c.expressions.filter((x) => x !== e) : [...c.expressions, e] });
    onTry(e);
  }
  return (
    <div className="st-s-editor__part" aria-label="Face" tabIndex={-1}>
      <p className="st-s-editor__lede">Real vehicles have no face. Add one for fun.</p>
      <Pick label="Face" value={eyes} options={CAR_EYES} onChange={setEyes} />
      {eyes !== "none" ? (
        <>
          <Pick label="Mouth" value={c.car.face.mouth} options={CAR_MOUTH} onChange={(mouth) => onChange({ ...c, car: { ...c.car, face: { ...c.car.face, mouth } } })} />
          <Swatches label="Eye colour" value={c.car.face.color} colors={withColour(EYE_COLORS, c.car.face.color, "Your vehicle's eye colour")} onChange={(color) => onChange({ ...c, car: { ...c.car, face: { ...c.car.face, color } } })} />
          <ul className="st-s-faces">
            {CATALOG.expressions.map((e) => {
              const on = c.expressions.includes(e.id);
              return (
                <li key={e.id} className={`st-s-face${on ? " is-on" : ""}${face === e.id ? " is-trying" : ""}`}>
                  <CarPreview car={c.car} movementStyle={c.movementStyle} expression={e.id} size={72} playing={false} label={`${name} looking ${e.label.toLowerCase()}`} />
                  <span className="st-s-face__name">{e.label}</span>
                  <span className="st-s-face__btns">
                    <Chip on={on} onToggle={() => toggleFace(e.id)} locked={e.id === "neutral"} lockedWhy="Every character keeps the Neutral face.">
                      {on ? "Uses it" : "Use it"}
                    </Chip>
                    <button type="button" className="st-btn st-s-small" aria-pressed={face === e.id} onClick={() => onTry(e.id)}>
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
        </>
      ) : null}
    </div>
  );
}

/** How the car drives, and each move to try on the preview. "Honk" plays the honk itself (no tap sound over it). */
export function CarMovesPart({ name, style, move, onStyle, onMove }: { name: string; style: MovementStyle; move: CarMove; onStyle: (s: MovementStyle) => void; onMove: (m: CarMove) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  // The Honk choice plays its own sound: with sounds on, the app's tap click stays out of its way (data-sound="off").
  useEffect(() => {
    const input = bar.current?.querySelector<HTMLInputElement>('input[value="honk"]');
    const label = input?.closest("label");
    const own = hearState() === "ok";
    for (const el of [input, label]) {
      if (!el) continue;
      if (own) el.setAttribute("data-sound", "off");
      else el.removeAttribute("data-sound");
    }
  });
  // A honk still sounding stops when the part changes or the editor closes.
  useEffect(() => () => stopSample(), []);
  return (
    <div className="st-s-editor__part" aria-label="Moves" tabIndex={-1}>
      <Pick label={`How ${name} drives`} big value={style} options={CATALOG.movementStyles.map((m) => ({ value: m.id, label: m.label, line: CAR_MOVE_LINE[m.id] }))} onChange={onStyle} />
      <div
        ref={bar}
        className="st-s-carmoves"
        onClick={(e) => {
          // Every tap on Honk honks, the one already picked too (a radio's click comes with or without a change).
          if (e.target instanceof HTMLInputElement && e.target.value === "honk") playSample({ kind: "sfx", id: "honk" });
        }}
      >
        <Pick label="Try a move" value={move === "idle" ? "" : move} options={CAR_MOVES} onChange={onMove} className="st-s-moves" />
      </div>
    </div>
  );
}
