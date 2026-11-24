// One member of the cast, a person or a car (docs/CONTRACTS.md §45.41, §45.42): the gallery, the cast pickers, the
// series' covers and the chat's cards. `on` is a picked tile: a person waves with its own happy face, a car bounces;
// off is the plain, still pose; left out, the character's own face standing still (the gallery). Drawn in the nearest
// ArtProvider's drawing style (§45.45), or `art`.
import { isCar, type ArtStyle, type CharacterInput } from "../api/types.ts";
import { showFace } from "../studio/looks.ts";
import { CarPreview } from "./CarPreview.tsx";
import { CharacterPreview } from "./CharacterPreview.tsx";

export function CastPreview({ c, size, on, playing = true, label, art }: { c: CharacterInput; size: number; on?: boolean; playing?: boolean; label: string; art?: ArtStyle }) {
  if (isCar(c)) return <CarPreview car={c.car} movementStyle={c.movementStyle} expression={on === false ? "neutral" : showFace(c)} move={on ? "bounce" : "idle"} size={size} playing={playing} label={label} art={art} />;
  return <CharacterPreview look={c.look} movementStyle={c.movementStyle} expression={on === false ? "neutral" : showFace(c)} action={on ? "wave" : "idle"} size={size} playing={playing} label={label} art={art} />;
}
