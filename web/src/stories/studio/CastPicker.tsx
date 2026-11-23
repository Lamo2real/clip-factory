// Clips Funded › the cast of a video or a series (docs/CONTRACTS.md §45.42): 1 to 3 characters, at most one car, and
// someone to drive it. People first, then the "Your cars" row (only when the workspace has a car); a car tile works
// like a radio (tapping another car swaps it). The first person picked is the main character, and the order sent is always
// the people in the order they were tapped, then the car (castOrder): the API never reorders.
import "../styles/sd-cast.css";
import { A } from "../../components/ui.tsx";
import { isCar, type Character, type CharacterKind } from "../api/types.ts";
import { CastPreview } from "../preview/CastPreview.tsx";
import { storiesHref } from "../routes.ts";

/** The most characters a video's cast has (§45.9). */
export const CAST_MAX = 3;

const FULL = "Pick up to 3 characters.";

/** What is wrong with a cast's kinds, in the API's own sentences (characters.cast_problem), or null. */
export function castProblem(chars: { kind?: CharacterKind }[]): string | null {
  const cars = chars.filter((c) => c.kind === "car").length;
  if (cars > 1) return "Pick one car.";
  if (cars === 1 && cars === chars.length) return "Add someone to drive it.";
  return null;
}

/** The people in the order they were picked, then the car. An id that is not in the list stays with the people. */
export function castOrder(ids: string[], characters: Character[]): string[] {
  const car = (id: string) => {
    const c = characters.find((x) => x.characterId === id);
    return !!c && isCar(c);
  };
  return [...ids.filter((id) => !car(id)), ...ids.filter(car)];
}

export function CastPicker({ characters, value, onChange, max = CAST_MAX }: { characters: Character[]; value: string[]; onChange: (ids: string[]) => void; max?: number }) {
  const people = characters.filter((c) => !isCar(c));
  const cars = characters.filter(isCar);
  const full = value.length >= max;
  const pickedCar = value.find((id) => cars.some((c) => c.characterId === id)) ?? null;

  function tap(c: Character) {
    const id = c.characterId;
    if (value.includes(id)) return onChange(value.filter((x) => x !== id));
    if (isCar(c) && pickedCar) return onChange([...value.filter((x) => x !== pickedCar), id]);
    if (full) return;
    onChange([...value, id]);
  }

  const tile = (c: Character) => {
    const on = value.includes(c.characterId);
    // A car swaps for the car already picked, so it is never "full" while one is picked.
    const off = !on && full && !(isCar(c) && pickedCar);
    return <CastTile key={c.characterId} c={c} on={on} off={off} onTap={() => tap(c)} />;
  };

  // With no car in the workspace the picker is the plain row it always was.
  if (!cars.length) return <ul className="st-s-castpick">{people.map(tile)}</ul>;
  return (
    <div className="st-cast">
      <h3 className="st-cast__row">People</h3>
      {people.length ? (
        <ul className="st-s-castpick">{people.map(tile)}</ul>
      ) : (
        <p className="st-s-field__hint">
          No people yet. <A href={storiesHref({ name: "character_new" })}>Make someone to drive it</A>.
        </p>
      )}
      <h3 className="st-cast__row">Your cars</h3>
      <ul className="st-s-castpick st-cast__cars">{cars.map(tile)}</ul>
    </div>
  );
}

function CastTile({ c, on, off, onTap }: { c: Character; on: boolean; off: boolean; onTap: () => void }) {
  return (
    <li>
      <button
        type="button"
        className={`st-s-casttile${on ? " is-on" : ""}${isCar(c) ? " st-cast__car" : ""}`}
        aria-pressed={on}
        aria-disabled={off || undefined}
        title={off ? FULL : undefined}
        onClick={() => !off && onTap()}
      >
        <CastPreview c={c} size={88} on={on} playing={on} label={c.name} />
        <span className="st-s-casttile__name">{c.name}</span>
        <span className="st-s-casttile__tick" aria-hidden="true">
          {on ? "✓" : "+"}
        </span>
      </button>
    </li>
  );
}
