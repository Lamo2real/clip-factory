// Lamo Stories engine: the sounds a place needs for a whole scene (the place's wind, rain or traffic, weather props,
// and an engine hum while someone drives). normalizeScript writes them into a new scene's effects list with ids
// "{sceneId}.amb{k}", so the owner sees each one in Review and can move or remove it (CONTRACTS §45.6 SceneEdit,
// §45.16.6); audioTrack plays only what the lists hold.

import { CARS } from "./props.ts";
import { drives } from "./scene.ts";
import { setInfo } from "./sets.ts";
import type { Scene, SfxId } from "./types.ts";

export interface Bed {
  sfx: SfxId;
  volume: number;
}

/** An ambience id: "{sceneId}.amb{k}". */
export const BED_ID = /\.amb\d+$/;

/** The looping sounds this scene's place, weather and driving need, one per kind of sound, quietest last. */
export function sceneBeds(scene: Scene): Bed[] {
  const out: Bed[] = [];
  const add = (sfx: SfxId, volume: number) => {
    if (!out.some((b) => b.sfx === sfx)) out.push({ sfx, volume });
  };
  const loop = setInfo(scene.set).loop;
  if (loop) add(loop.sfx, loop.volume);
  for (const p of scene.props) {
    if (p.kind === "rain") add("rain", 0.35);
    if (p.kind === "snow") add("wind", 0.22);
  }
  if (drives(scene)) add("engine", 0.3);
  return out;
}

/** The pan (-1..1) of an ambience: a driving car's engine hum comes from the scene's first car or truck; the place's
 * own sounds (the highway's traffic too) come from everywhere. */
export function bedPan(scene: Scene, sfx: SfxId): number {
  if (sfx !== "engine" || setInfo(scene.set).loop?.sfx === "engine") return 0;
  const car = scene.props.find((p) => CARS.has(p.kind));
  return car ? Math.round(Math.max(-1, Math.min(1, (car.x - 0.5) * 1.6)) * 100) / 100 : 0;
}
