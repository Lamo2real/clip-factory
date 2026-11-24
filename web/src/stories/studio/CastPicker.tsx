// Clips Funded › the cast of a video or a series (docs/CONTRACTS.md §45.43, §45.47). A series' cast is 1 to 3: the
// "People" row, then the "Vehicles" row (only when the workspace has a vehicle; up to 2, and someone to drive them).
// A video's cast (with `roles`) is "Who is in it": the people (up to 3, tapped on and off as always), then two pick-one
// bars over the people tapped, "Main character" (the first one tapped until another is picked) and "Villain" (another
// person, can be skipped), then "Vehicles" (up to 2): 4 in all. The order sent is always the main character, the other
// people in the order they were tapped, then the vehicles (castOrder / storyOrder): the API never reorders.
import "../styles/sd-cast.css";
import { A } from "../../components/ui.tsx";
import { isCar, VEHICLE_OF, type CastRoles, type Character, type CharacterKind } from "../api/types.ts";
import { CastPreview } from "../preview/CastPreview.tsx";
import { storiesHref } from "../routes.ts";
import { Pick } from "./kit.tsx";
import { VEHICLE_WORD } from "./words.ts";

/** The most characters a series' cast has (§45.44; ideas too). */
export const CAST_MAX = 3;
/** The most characters a video's cast has (§45.47): 3 people and 2 vehicles, 4 in all. */
export const STORY_CAST_MAX = 4;
export const PEOPLE_MAX = 3;
export const VEHICLES_MAX = 2;

export const NO_MAIN = "Pick a main character.";
export const SAME_VILLAIN = "The villain can't be the main character.";
export const TOO_MANY_VEHICLES = "Pick up to 2 vehicles.";
export const TOO_MANY_PEOPLE = "Pick up to 3 people.";
const FULL = "Pick up to 3 characters.";
/** A video's cast is full (3 people, or 4 in all). */
export const FULL_STORY = "Who is in it is full. Take someone out first.";
/** The Villain bar's first choice (no villain); never a character id. */
const NO_VILLAIN = "none";

/** What is wrong with a cast's kinds, in the API's own sentences (characters.cast_problem), or null. */
export function castProblem(chars: { kind?: CharacterKind }[]): string | null {
  const cars = chars.filter((c) => c.kind === "car").length;
  if (cars > VEHICLES_MAX) return TOO_MANY_VEHICLES;
  if (cars > 0 && cars === chars.length) return "Add someone to drive it.";
  return null;
}

const carIn = (characters: readonly Character[]) => (id: string) => {
  const c = characters.find((x) => x.characterId === id);
  return !!c && isCar(c);
};

/** The people in the order they were picked, then the vehicles. An id that is not in the list stays with the people. */
export function castOrder(ids: string[], characters: Character[]): string[] {
  const car = carIn(characters);
  return [...ids.filter((id) => !car(id)), ...ids.filter(car)];
}

/** The owner's role picks on Make a new video; a null main means "the first person in the cast". */
export interface RolePick {
  mainId: string | null;
  villainId: string | null;
}

export const NO_ROLES: RolePick = { mainId: null, villainId: null };

/** The main character now: the one picked (while in the cast and not the villain), else the first other person. */
export function mainOf(ids: string[], characters: Character[], pick: RolePick): string | null {
  const people = castOrder(ids, characters).filter((id) => !carIn(characters)(id) && id !== pick.villainId);
  return pick.mainId && people.includes(pick.mainId) ? pick.mainId : (people[0] ?? null);
}

/** The villain now: the one picked, while a person in the cast. */
export function villainOf(ids: string[], characters: Character[], pick: RolePick): string | null {
  return pick.villainId && ids.includes(pick.villainId) && !carIn(characters)(pick.villainId) ? pick.villainId : null;
}

/** A video's cast in the order the API wants (§45.43.1): the main character, the other people, then the vehicles. */
export function storyOrder(ids: string[], characters: Character[], pick: RolePick): string[] {
  const order = castOrder(ids, characters);
  const main = mainOf(ids, characters, pick);
  return main ? [main, ...order.filter((id) => id !== main)] : order;
}

/** The roles sent with the video (§45.47), or null when there is no main character. */
export function rolesOf(ids: string[], characters: Character[], pick: RolePick): CastRoles | null {
  const mainId = mainOf(ids, characters, pick);
  if (!mainId) return null;
  const villainId = villainOf(ids, characters, pick);
  return villainId && villainId !== mainId ? { mainId, villainId } : { mainId };
}

/** What is wrong with a video's cast (§45.47): its kinds, how many, and its roles; null when it is fine. */
export function storyCastProblem(ids: string[], characters: Character[], pick: RolePick): string | null {
  const chars = ids.map((id) => characters.find((c) => c.characterId === id)).filter((c): c is Character => !!c);
  if (pick.mainId && pick.mainId === pick.villainId) return SAME_VILLAIN;
  if (!mainOf(ids, characters, pick)) return chars.some(isCar) && !chars.some((c) => !isCar(c)) ? "Add someone to drive it." : NO_MAIN;
  if (chars.filter((c) => !isCar(c)).length > PEOPLE_MAX) return TOO_MANY_PEOPLE;
  return castProblem(chars);
}

interface Props {
  characters: Character[];
  value: string[];
  onChange: (ids: string[]) => void;
  /** 3 for a series (the default), STORY_CAST_MAX for a video */
  max?: number;
  /** A video's roles: with them the picker shows Main character, Villain, Also in it and Vehicles. */
  roles?: RolePick;
  onRoles?: (roles: RolePick) => void;
}

export function CastPicker({ characters, value, onChange, max = CAST_MAX, roles, onRoles }: Props) {
  const people = characters.filter((c) => !isCar(c));
  const cars = characters.filter(isCar);
  const car = carIn(characters);
  const peopleIn = value.filter((id) => !car(id)).length;
  const carsIn = value.filter(car).length;
  /** Room for one more of this kind (people up to 3, vehicles up to 2, and the cast's own most). */
  const room = (c: Character, freed = 0) => value.length - freed < max && (isCar(c) ? carsIn < VEHICLES_MAX : peopleIn - freed < PEOPLE_MAX);

  const noPeople = (
    <p className="st-s-field__hint">
      No people yet. <A href={storiesHref({ name: "character_new" })}>Make someone to drive it</A>.
    </p>
  );

  function toggle(c: Character) {
    const id = c.characterId;
    if (value.includes(id)) return onChange(value.filter((x) => x !== id));
    if (!room(c)) return;
    onChange([...value, id]);
  }

  const vehicleTile = (c: Character) => {
    const on = value.includes(c.characterId);
    return <CastTile key={c.characterId} c={c} on={on} off={!on && !room(c)} why={carsIn >= VEHICLES_MAX ? TOO_MANY_VEHICLES : roles ? FULL_STORY : FULL} onTap={() => toggle(c)} />;
  };

  if (!roles) {
    const tile = (c: Character) => {
      const on = value.includes(c.characterId);
      return <CastTile key={c.characterId} c={c} on={on} off={!on && !room(c)} why={FULL} onTap={() => toggle(c)} />;
    };
    // With no vehicle in the workspace the picker is the plain row it always was.
    if (!cars.length) return <ul className="st-s-castpick">{people.map(tile)}</ul>;
    return (
      <div className="st-cast">
        <h3 className="st-cast__row">People</h3>
        {people.length ? <ul className="st-s-castpick">{people.map(tile)}</ul> : noPeople}
        <h3 className="st-cast__row">Vehicles</h3>
        <ul className="st-s-castpick st-cast__cars">{cars.map(vehicleTile)}</ul>
      </div>
    );
  }

  const tile = (c: Character) => {
    const on = value.includes(c.characterId);
    return <CastTile key={c.characterId} c={c} on={on} off={!on && !room(c)} why={FULL_STORY} onTap={() => toggle(c)} />;
  };
  const main = mainOf(value, characters, roles);
  const villain = villainOf(value, characters, roles);
  const inCast = castOrder(value, characters)
    .filter((id) => !car(id))
    .flatMap((id) => people.filter((c) => c.characterId === id));
  const nameOf = (c: { characterId: string; name: string }) => ({ value: c.characterId, label: c.name });
  // Who plays whom: the people tapped above, as pick-one bars (the main character first; the villain can be skipped).
  const parts = (
    <>
      {inCast.length ? (
        <Pick label="Main character" value={main ?? ""} options={inCast.map(nameOf)} onChange={(id) => onRoles?.({ mainId: id, villainId: villain === id ? null : villain })} className="st-cast__role" />
      ) : null}
      {inCast.length > 1 ? (
        <Pick
          label="Villain (you can skip this)"
          value={villain ?? NO_VILLAIN}
          options={[{ value: NO_VILLAIN, label: "No villain" }, ...inCast.filter((c) => c.characterId !== main).map(nameOf)]}
          onChange={(id) => onRoles?.({ mainId: main, villainId: id === NO_VILLAIN ? null : id })}
          className="st-cast__role"
        />
      ) : null}
    </>
  );

  // With no vehicle in the workspace the people are the plain row they always were.
  if (!cars.length)
    return (
      <div className="st-cast st-cast--roles">
        <ul className="st-s-castpick">{people.map(tile)}</ul>
        {parts}
      </div>
    );
  return (
    <div className="st-cast st-cast--roles">
      <h3 className="st-cast__row">People</h3>
      {people.length ? <ul className="st-s-castpick">{people.map(tile)}</ul> : noPeople}
      {parts}
      <h3 className="st-cast__row">
        Vehicles<span className="st-cast__skip"> (you can skip this)</span>
      </h3>
      <ul className="st-s-castpick st-cast__cars">{cars.map(vehicleTile)}</ul>
    </div>
  );
}

function CastTile({ c, on, off, why, onTap }: { c: Character; on: boolean; off: boolean; why: string; onTap: () => void }) {
  const kind = isCar(c) ? VEHICLE_WORD[VEHICLE_OF[c.car.body] ?? "car"] : null;
  return (
    <li>
      <button
        type="button"
        className={`st-s-casttile${on ? " is-on" : ""}${isCar(c) ? " st-cast__car" : ""}`}
        aria-pressed={on}
        aria-disabled={off || undefined}
        title={off ? why : undefined}
        onClick={() => !off && onTap()}
      >
        <CastPreview c={c} size={88} on={on} playing={on} label={c.name} />
        <span className="st-s-casttile__name">{c.name}</span>
        {/* the kind is drawn by CSS (::after), so the tile's text stays its name */}
        {kind ? <span className="st-cast__kind" data-kind={kind} aria-hidden="true" /> : null}
        <span className="st-s-casttile__tick" aria-hidden="true">
          {on ? "✓" : "+"}
        </span>
      </button>
    </li>
  );
}
