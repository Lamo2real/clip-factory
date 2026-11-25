// Clips Funded › Vehicles (docs/CONTRACTS.md §45.42.10, shown as Vehicles since §45.47): the vehicle characters in
// their own place in the rail, right under Characters (the owner: "where are cars? i need cars as well", then "change
// to vehicle instead of cars", "or rather vehicles (in plural)"). The same characters as Characters (kind "car"), so a
// vehicle made anywhere is here: the vehicles as cards (each moving its own drawing), a big "Make a vehicle"
// (/stories/vehicles/new: "What is it?", its outside and inside photos, the model on the chip, the cartoon ones to pick
// from, then a name) and each vehicle's page (/stories/vehicles/{id}: its Looks, Face, Moves, Sounds and Name, its
// photos, Design with AI again, and Delete). /stories/cars… still opens the same pages. Characters shows the whole cast,
// each vehicle with its Vehicle tag. The route names (cars, car_new, car) and the kind ("car") never change.
import "../styles/studio.css";
import "../styles/sd-cars.css";
import { A } from "../../components/ui.tsx";
import { useState } from "react";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import { isCar } from "../api/types.ts";
import { DEFAULT_CAR } from "../engine/car.ts";
import { Glass } from "../glass/index.ts";
import { CarPreview } from "../preview/CarPreview.tsx";
import { CastPreview } from "../preview/CastPreview.tsx";
import { storiesHref } from "../routes.ts";
import { useAiInfo } from "../studio/ai.tsx";
import { Busy, Notice, Tag } from "../studio/kit.tsx";
import { CAR_MOVE_LINE } from "../studio/looks.ts";
import { count } from "../studio/words.ts";
import { ConfirmDelete, VehicleDraftCard, useVehicleDrafts } from "../studio/VehicleDrafts.tsx";
import type { VehicleDraft } from "../api/types.ts";
import { StIcon } from "../ui.tsx";
import { CharacterPage, NewCharacter } from "./Characters.tsx";
import { VehicleDraftPage } from "./VehicleDraft.tsx";
import type { StoriesScreenProps } from "./types.ts";

export function CarsScreen({ ws, page }: StoriesScreenProps) {
  if (page.name === "car_new") return <NewCharacter ws={ws} kind="car" place="cars" />;
  if (page.name === "car_draft") return <VehicleDraftPage key={page.draftId} ws={ws} draftId={page.draftId} />;
  if (page.name === "car") return <CharacterPage key={page.characterId} ws={ws} characterId={page.characterId} place="cars" />;
  return <CarGallery ws={ws} />;
}

/** The one big way to make a vehicle: the same words wherever it shows. */
function MakeCar() {
  return (
    <A href={storiesHref({ name: "car_new" })} className="st-btn st-btn--main st-s-makecar st-s-makecar--big">
      <StIcon name="car" size={24} />
      Make a vehicle
    </A>
  );
}

function CarGallery({ ws }: { ws: string }) {
  // The same list (and the same remembered copy) as Characters: a vehicle is a character of kind "car".
  const list = useLoad(() => storiesApi().listCharacters(ws), ws, "st-characters");
  const cars = list.data?.filter(isCar) ?? null;
  // The vehicle drafts (a design that runs on the server) come first, and keep going when the owner is elsewhere.
  const drafts = useVehicleDrafts(ws);
  const info = useAiInfo(ws);
  const [asking, setAsking] = useState<VehicleDraft | null>(null);
  const none = !!cars && cars.length === 0 && drafts.loaded && drafts.items.length === 0;
  const some = !!cars?.length || drafts.items.length > 0;
  return (
    <section className="st-page st-studio st-s-make st-s-cars">
      <header className="st-s-head">
        <div className="st-plate st-s-head__text">
          <h1 className="st-s-head__title">Vehicles</h1>
          <p className="st-s-head__lede">Your vehicles. Each looks the same in every video.</p>
        </div>
        {some ? (
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
        <Busy>Getting your vehicles…</Busy>
      ) : !drafts.loaded && cars.length === 0 ? (
        <Busy>Getting your vehicles…</Busy>
      ) : none ? (
        <Glass lens className="st-s-empty st-s-make-empty">
          <CarPreview car={DEFAULT_CAR} movementStyle="bouncy" move="drive" size={140} label="A red cartoon car driving" />
          <h2 className="st-s-empty__title">No vehicles yet</h2>
          <p className="st-s-empty__text">Add photos. Tap Make a vehicle.</p>
          <MakeCar />
        </Glass>
      ) : null}
      <span className="st-s-sr" role="status" aria-live="polite">
        {drafts.announce}
      </span>
      {drafts.items.length ? (
        <ul className="st-vdc-list" aria-label="Vehicle drafts">
          {drafts.items.map((d) => (
            <VehicleDraftCard
              key={d.draftId}
              draft={d}
              info={info}
              celebrateNow={drafts.fresh.has(d.draftId)}
              onTryAgain={() => void drafts.again(d)}
              onDelete={() => (d.status === "ready" && d.options.length ? setAsking(d) : void drafts.remove(d))}
            />
          ))}
        </ul>
      ) : null}
      {asking ? (
        <ConfirmDelete
          draft={asking}
          onKeep={() => setAsking(null)}
          onDelete={() => {
            const d = asking;
            setAsking(null);
            void drafts.remove(d);
          }}
        />
      ) : null}
      {cars && cars.length ? (
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
                  <Tag tone="coral">Vehicle</Tag>
                  <Tag>In {count(c.storyCount, "video")}</Tag>
                </span>
              </A>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
