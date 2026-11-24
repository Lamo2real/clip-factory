// Lamo Stories engine: what the script's free words and numbers mean, in plain sentences for the story writer and the
// fact checker (CONTRACTS §45.10, §45.11.2, §45.11.5, §45.34, §45.43, §45.45). `cli.ts catalog` gives them next to the
// catalog, the limits and the formats, so a writer never has to guess which way a skid slides, which faces a character
// has or what shape the frame is. engine/README.md says the same at more length.

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
  {
    id: "own_faces",
    text:
      "Each character keeps its own faces and noises: a cast member with an expressions list makes only those faces, " +
      "and only the noises in its voice.noises. A beat's face and noise for that character must come from its own " +
      "lists; any other is refused. Leave face out to keep the face it has, and leave noise out for silence.",
  },
  {
    id: "car_cast",
    text:
      "A car of the cast is never an actor: it is a car prop with its castId. People ride in it with inCar set to " +
      "that prop's propId.",
  },
  {
    id: "get_in_out",
    text:
      "get_in and get_out need inCar, last 0.8 to 3 seconds, and happen while the car is parked. The car moves only " +
      "after get_in ends.",
  },
  { id: "honk", text: "honk adds the honk sound by itself." },
  { id: "driver_wave", text: "The driver waves only while the car is stopped; a passenger may wave any time." },
  {
    id: "frame_shape",
    text:
      "The request's format (aspect, width and height) says which shape this video is; with no format it is tall " +
      "9:16 1080 × 1920. The shapes are tall 9:16 (1080 × 1920 or 720 × 1280), square 1:1 (1080 × 1080 or " +
      "720 × 720) or wide 16:9 (1920 × 1080 or 1280 × 720). x and y are 0 to 1 of that frame in every shape, so the " +
      "ground (y 0.62 to 0.85) and a top view's road (x 0.25 to 0.75) keep their numbers. Characters and things keep " +
      "their size against the frame's short side: a standing character is about a quarter of a tall frame's height " +
      "but about two fifths of a square or wide one's, so keep standing characters on the ground there. A wide frame " +
      "has room for up to 4 characters side by side (x 0.15 to 0.85); a tall one fits 2 or 3. Captions, teaching " +
      "text, bubbles and the end card are placed inside each shape's safe area for you.",
  },
  {
    id: "shots",
    text:
      "A scene can cut between shots while its action and sound go on: cuts is a list of {at, shot, who?}, seconds " +
      "from the scene's start, at least 0.6 s apart, at most 8; before the first cut the scene shows the whole scene. " +
      "Driver's eyes, Side window, Mirror, Speed dial, Feet on the pedals and Behind the car need someone sitting in a " +
      "car on a road; Down the road needs a road; Face up close needs a person. Bubbles show beside the face in Face " +
      "up close and Side window, and at the top in the other shots.",
  },
  {
    id: "shot_world",
    text:
      "In shots, the side view's places still count: a car further along the way the driver's car faces is ahead, one " +
      "the other way is behind; a car whose y is under 0.72 is in the other lane; a car facing the other way comes " +
      "towards it. move, speed_up, stop, stall, blink and honk show in every shot; steer_left and steer_right turn the " +
      "wheel; brake lights the brake lights and drops the speed needle.",
  },
];
