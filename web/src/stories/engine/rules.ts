// Lamo Stories engine: what the script's free words and numbers mean, in plain sentences for the story writer and the
// fact checker (CONTRACTS §45.10, §45.11.2, §45.11.5). `cli.ts catalog` gives them next to the catalog and the limits,
// so a writer never has to guess which way a skid slides. engine/README.md says the same at more length.

import type { PropKind } from "./types.ts";

/** The words a prop's `state` understands, by kind (any other word is ignored). */
export const PROP_STATES: Partial<Record<PropKind, string[]>> = {
  car: ["parked", "driving", "lights", "brakes", "flat"],
  truck: ["parked", "driving", "lights", "brakes", "flat"],
  arrow: ["curve_left", "curve_right"],
  tree: ["pine", "snow"],
  phone: ["ring", "on"],
};

const states = Object.entries(PROP_STATES)
  .map(([kind, words]) => `${kind}: ${words!.join(", ")}`)
  .join("; ");

/** One sentence per rule, in the words the writer reads. */
export const RULES: { id: string; text: string }[] = [
  {
    id: "skid_dir",
    text:
      'A skid\'s dir is the side the car\'s REAR slides to. "Rear slides right" is {do: "skid", dir: "right"}, and ' +
      'steering into that skid is the driver\'s steer_right at the same time (the steering arrow then points right). ' +
      '"Rear slides left" is dir: "left" with steer_left. When the rear slides right, the nose points left of where ' +
      "the car travels. The rear swings out, is furthest out 40% of the way through and is straight again at the end; " +
      "a swing back the other way is a second skid with the other dir.",
  },
  {
    id: "spin_dir",
    text: 'A spin turns the car all the way round: dir "right" is clockwise seen from above, "left" anticlockwise.',
  },
  {
    id: "side_dir",
    text:
      "In a side view, dir on move, stop, bump or appear turns the prop to face that way (a car reversing is a move " +
      "with dir the way its nose points and to behind it). On skid, spin or tyre_burst, dir is only the side of the " +
      "slide: the car keeps going nose first.",
  },
  {
    id: "top_rot",
    text:
      'view "top" is a road seen from above, running up the frame between x 0.25 and 0.75. A car\'s rot is its ' +
      "heading in degrees clockwise from nose-up: 0 drives up the frame, 90 to the right, 180 down, -90 to the left. " +
      "Moving to a to point turns it smoothly to face where it goes.",
  },
  {
    id: "steering",
    text:
      "A character inCar a car is its driver (a car seats 2, a truck 1). The driver's steer_left or steer_right turns " +
      "the front wheels and draws a curved arrow ahead of the car pointing that way. A car with someone in it and no " +
      "move with to is driving: the road rolls past; brake slows it, a stop beat on the car halts it, drive speeds it up.",
  },
  {
    id: "coordinates",
    text:
      "x and y are 0 to 1 of the frame. For a character or a standing prop (car, truck, sign, tree, cone, deer) the " +
      "point is where it touches the ground; for a flat or floating prop it is the centre. In a side view the ground " +
      "runs from about y 0.62 to 0.85 (the road 0.64 to 0.80). Lower down looks nearer.",
  },
  { id: "arrow_rot", text: "An arrow points up at rot 0; turn it with rot (degrees clockwise)." },
  { id: "prop_state", text: `A prop's state may hold these words (others are ignored): ${states}.` },
  {
    id: "sounds",
    text:
      "Wind, rain, traffic and a driving car's engine hum are added to each new scene's effects list for you; add " +
      "other effects with sfx on a beat. Bubbles hold symbols only, never words.",
  },
];
