// One member of the cast, a person or a car (docs/CONTRACTS.md §45.42, §45.43): the gallery, the cast pickers, the
// series' covers and the chat's cards. `on` is a picked tile: a person waves with its own happy face, a car bounces;
// off is the plain, still pose; left out, the character's own face standing still (the gallery).
import { isCar, type CharacterInput } from "../api/types.ts";
import { showFace } from "../studio/looks.ts";
import { CarPreview } from "./CarPreview.tsx";
import { CharacterPreview } from "./CharacterPreview.tsx";

export function CastPreview({ c, size, on, playing = true, label }: { c: CharacterInput; size: number; on?: boolean; playing?: boolean; label: string }) {
  if (isCar(c)) return <CarPreview car={c.car} movementStyle={c.movementStyle} expression={on === false ? "neutral" : showFace(c)} move={on ? "bounce" : "idle"} size={size} playing={playing} label={label} />;
  return <CharacterPreview look={c.look} movementStyle={c.movementStyle} expression={on === false ? "neutral" : showFace(c)} action={on ? "wave" : "idle"} size={size} playing={playing} label={label} />;
}
