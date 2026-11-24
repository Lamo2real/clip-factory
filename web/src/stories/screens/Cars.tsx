// A car's own addresses (docs/CONTRACTS.md §45.41): a car is a character of kind "car", so it is in Characters (the
// rail's Characters, with its Car tag) and nowhere else. /stories/cars/new is Make a car (drop the car's photos, the
// model on the chip, the cartoon cars to pick from, then a name), /stories/cars/{id} is the car's page (its Looks,
// Face, Moves, Sounds and Name, its photos, Design with AI again, and Delete), and /stories/cars, an older link, is
// the Characters gallery.
import { CharacterPage, Gallery, NewCharacter } from "./Characters.tsx";
import type { StoriesScreenProps } from "./types.ts";

export function CarsScreen({ ws, page }: StoriesScreenProps) {
  if (page.name === "car_new") return <NewCharacter ws={ws} kind="car" place="cars" />;
  if (page.name === "car") return <CharacterPage key={page.characterId} ws={ws} characterId={page.characterId} place="cars" />;
  return <Gallery ws={ws} />;
}
