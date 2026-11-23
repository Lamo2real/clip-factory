// Clips Funded › Cars (docs/CONTRACTS.md §45.41): the car characters in their own place in the rail, right under
// Characters. The same characters as Characters (kind "car"), so a car made anywhere is here and nowhere else: the
// cars as cards (each driving its own drawing), a big "Make a car" (/stories/cars/new: drop the car's photos, the
// model on the chip, the cartoon cars to pick from, then a name) and each car's page (/stories/cars/{id}: its Looks,
// Face, Moves, Sounds and Name, its photos, Design with AI again, and Delete). Characters shows the people.
import "../styles/studio.css";
import "../styles/sd-cars.css";
import { A } from "../../components/ui.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import { isCar } from "../api/types.ts";
import { DEFAULT_CAR } from "../engine/car.ts";
import { Glass } from "../glass/index.ts";
import { CarPreview } from "../preview/CarPreview.tsx";
import { CastPreview } from "../preview/CastPreview.tsx";
import { storiesHref } from "../routes.ts";
import { Busy, Notice, Tag } from "../studio/kit.tsx";
import { CAR_MOVE_LINE } from "../studio/looks.ts";
import { count } from "../studio/words.ts";
import { StIcon } from "../ui.tsx";
import { CharacterPage, NewCharacter } from "./Characters.tsx";
import type { StoriesScreenProps } from "./types.ts";

export function CarsScreen({ ws, page }: StoriesScreenProps) {
  if (page.name === "car_new") return <NewCharacter ws={ws} kind="car" place="cars" />;
  if (page.name === "car") return <CharacterPage key={page.characterId} ws={ws} characterId={page.characterId} place="cars" />;
  return <CarGallery ws={ws} />;
}

/** The one big way to make a car: the same words wherever it shows. */
function MakeCar() {
  return (
    <A href={storiesHref({ name: "car_new" })} className="st-btn st-btn--main st-s-makecar">
      <StIcon name="car" size={24} />
      Make a car
    </A>
  );
}

function CarGallery({ ws }: { ws: string }) {
  // The same list (and the same remembered copy) as Characters: a car is a character of kind "car".
  const list = useLoad(() => storiesApi().listCharacters(ws), ws, "st-characters");
  const cars = list.data?.filter(isCar) ?? null;
  return (
    <section className="st-page st-studio st-s-make st-s-cars">
      <header className="st-s-head">
        <div className="st-plate st-s-head__text">
          <h1 className="st-s-head__title">Cars</h1>
          <p className="st-s-head__lede">Your cars. Each one looks the same in every video.</p>
        </div>
        {cars?.length ? (
          <div className="st-s-head__actions">
            <MakeCar />
          </div>
        ) : null}
      </header>
      {list.error && !list.data ? (
        <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void list.reload()}>Try again</button>}>
          {list.error}
        </Notice>
      ) : !cars ? (
        <Busy>Getting your cars…</Busy>
      ) : cars.length === 0 ? (
        <Glass lens className="st-s-empty st-s-make-empty">
          <CarPreview car={DEFAULT_CAR} movementStyle="bouncy" move="drive" size={140} label="A red cartoon car driving" />
          <h2 className="st-s-empty__title">No cars yet</h2>
          <p className="st-s-empty__text">Add photos of a real car. You get a cartoon car for your videos.</p>
          <MakeCar />
        </Glass>
      ) : (
        <ul className="st-s-cast">
          {cars.map((c) => (
            <li key={c.characterId}>
              <A href={storiesHref({ name: "car", characterId: c.characterId })} className="st-glass st-lens st-s-cast__card">
                <span className="st-s-cast__stage">
                  <CastPreview c={c} size={132} label={`${c.name}, moving`} />
                </span>
                <span className="st-s-cast__name">{c.name}</span>
                <span className="st-s-cast__line">{c.personality || c.description || CAR_MOVE_LINE[c.movementStyle]}</span>
                <span className="st-s-cast__tags">
                  <Tag tone="coral">Car</Tag>
                  <Tag>In {count(c.storyCount, "video")}</Tag>
                </span>
              </A>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
