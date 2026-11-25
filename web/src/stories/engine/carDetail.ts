// Clips Funded engine: "Realistic vehicles" (CONTRACTS §45.48). A vehicle look may carry one optional `detail` object:
// a measured outline (the photo's own proportions) plus named parts (roof, wheels, brakes, lamps, nose, sides, tail,
// stripes, finish, extras and the cabin). Left out, the vehicle draws exactly as it always did.
//
// This file is the schema's single source (design-final.md section 1): the types, the rules table (`CAR_DETAIL`), the
// check (`checkCarDetail`), the frozen presets and `resolveDetail`, the only place a default lives. The API's
// workspaces/car_detail.json is generated from the rules table by web/test/storiesCarDetailRules.test.ts.

import type { CarBody, CarLook, Hex, VehicleType } from "./types.ts";
import { VEHICLE_OF } from "./types.ts";

export type CarRoof = "closed" | "open" | "targa" | "soft_top" | "sunroof" | "glass";
export type CarWheelShape = "steel" | "cap" | "straight" | "split" | "y" | "star" | "mesh" | "turbine" | "dish" | "wire" | "block";
export type CarFrontLight = "round" | "twin_round" | "oval" | "square" | "rect" | "slim" | "swept" | "angled" | "stacked" | "pop_up" | "strip";
export type CarDrl = "none" | "line" | "hook" | "ring" | "dots" | "brow";
export type CarRearLight = "round" | "twin_round" | "square" | "rect" | "tall" | "slim" | "bar" | "split_bar" | "wedge" | "c_shape";
export type CarGrille = "none" | "slot" | "bars" | "slats" | "mesh" | "oval" | "tall" | "twin"; // "twin" = two openings side by side, nothing more
export type CarIntake = "none" | "wide" | "split3" | "twin" | "smile";
export type CarExhaust = "none" | "single" | "twin" | "quad" | "centre" | "high" | "side" | "stack";
export type CarSpoiler = "none" | "lip" | "ducktail" | "wing" | "big_wing" | "roof";
export type CarStripe = "none" | "centre" | "twin" | "offset" | "side" | "sill" | "pin";
export type CarExtra = "bull_bar" | "spare_wheel" | "roof_rails" | "antenna" | "shark_fin" | "snorkel" | "light_bar" | "mudflaps" | "roof_scoop" | "tow_hook" | "ladder" | "wing_lamps";

/** The outline's landmarks. X: percent of the length from the nose tip (0) to the tail tip (100).
 * H: percent of the height from the ground (0) to the highest point (100; an open car's is its windscreen top). */
export interface CarProfile {
  body: CarBody; // the body these numbers were measured as; used only while car.body is this body
  lh: number; // 150..520  length / height x 100
  wh: number; //  60..220  width / height x 100
  tipH: number; //  10..85   the nose's foremost point
  noseX: number; //   0..14   where the bonnet's top surface begins
  noseH: number; //  15..92
  noseR: number; //   0..100  0 a sharp wedge, 100 a ball
  chinH: number; //   3..40   the lowest front bodywork
  cowlX: number; //   1..55   the windscreen's foot
  cowlH: number; //  30..90
  bonnet: number; //   0..100  0 a straight bonnet line, 100 domed
  headX: number; //   4..72   the windscreen's top
  headH: number; //  40..100
  peakX: number; //   4..100  the roof's highest point (unused on an open car)
  roofX: number; //  12..100  the roof's rear end (open: the back of the cockpit, the hoops)
  roofH: number; //  40..100
  deckX: number; //  20..100  where the rear glass ends, the boot lid or the bed begins
  deckH: number; //  20..98
  tailX: number; //  86..100  the tail's top rear edge
  tailH: number; //  15..98
  rumpH: number; //   3..45   the lowest rear bodywork
  sillH: number; //   4..40   the body's bottom between the wheels
  axF: number; //   8..40   front wheel centre
  axR: number; //  55..94   rear wheel centre
  wheelD: number; //  20..72   tyre diameter, percent of the height
  archGap: number; //   0..45   air between tyre and arch, percent of the wheel's radius
  beltH: number; //  30..88   side glass bottom edge at the front door
  beltRise: number; // -10..20   how much higher the belt is at its rear end
  soft: number; //   0..100  0 boxy corners, 100 round ones
  pillarX: number; //  10..96   the pillar behind the front door
  glassX: number; //  20..99   where the side glass ends
  panes: number; //   1..5    side windows
  roofW: number; //  40..100  roof width, percent of the body's
  taperF: number; //   0..40   how much narrower the nose is, from above
  taperR: number; //   0..40   the same for the tail
}

export interface CarDetail {
  v: 1;
  toon?: number; // 0..100, default 30: 0 real proportions .. 100 as chunky as the classic drawing
  profile?: CarProfile; // all 35 keys together, or none
  roof?: { type?: CarRoof; color?: Hex; hoops?: "none" | "twin" | "bar"; rails?: boolean };
  wheels?: { shape?: CarWheelShape; spokes?: number /*3..24*/; tyre?: number /*12..60*/; lip?: number /*0..100*/; dish?: number /*0..100*/; wall?: "black" | "white"; hub?: Hex /*a flat disc, never a mark*/; rearD?: number /*20..72*/ };
  brakes?: { disc?: "none" | "plain" | "drilled" | "ceramic"; caliper?: Hex };
  lights?: {
    front?: { shape?: CarFrontLight; drl?: CarDrl; h?: number /*10..92*/; lens?: "clear" | "yellow" | "smoked" };
    rear?: { shape?: CarRearLight; h?: number /*10..92*/; lens?: "red" | "clear" | "smoked" };
  };
  front?: { grille?: CarGrille; intake?: CarIntake; splitter?: "none" | "lip" | "blade"; bumper?: "body" | "black" | "chrome"; fog?: boolean };
  bonnet?: { vent?: "none" | "scoop" | "bulge" | "vents" | "duct" };
  side?: {
    intake?: "none" | "scoop" | "gill" | "slats" | "duct";
    intakeX?: number /*20..95*/;
    skirts?: "none" | "lip" | "deep" | "boards";
    doors?: number /*0..3*/;
    handles?: "none" | "bar" | "flush" | "chrome";
    crease?: "none" | "level" | "wedge" | "double";
    mirror?: "none" | "ear" | "stalk" | "square";
    rubStrip?: boolean;
    fuelCap?: boolean;
  };
  rear?: { diffuser?: "none" | "fins" | "deep"; exhaust?: CarExhaust; spoiler?: CarSpoiler; bumper?: "body" | "black" | "chrome" };
  arches?: "round" | "square" | "flare" | "clad";
  stripe?: { layout?: CarStripe; color?: Hex; width?: number /*0..100*/ };
  twoTone?: "roof" | "split" | "lower" | "bonnet";
  trim?: Hex; // dark trim colour; left out #23252b
  mirrorColor?: Hex; // left out: car.accent, as today
  finish?: "gloss" | "satin" | "matte" | "metallic";
  extras?: CarExtra[]; // at most 6, no repeats
  cabin?: { rows?: number /*1..3*/; seat?: Hex; dial?: Hex; wheel?: "round" | "flat" };
}

export const CAR_DETAIL_V = 1;
export const CAR_DETAIL_MAX_CHARS = 2400;

/** One rule per dotted path: ids, a whole-number range, a colour, a boolean or a list of ids (design-final 1.2).
 * `label` is what the editor shows; `draws` is one plain line saying what the id paints (for the AI and the tests). */
export type Rule =
  | { e: string[]; label?: Record<string, string>; draws?: Record<string, string> }
  | { n: [number, number] }
  | { c: true }
  | { b: true }
  | { l: string[]; max: number; label?: Record<string, string>; draws?: Record<string, string> };

export const BODY_IDS: CarBody[] = ["hatchback", "sedan", "estate", "suv", "sports", "compact", "pickup", "van", "bus", "motorbike", "plane", "boat"];

/** The choices of an enum rule: id -> [what the editor shows, what it paints]. */
const ids = (pairs: Record<string, [string, string]>): Rule => {
  const label: Record<string, string> = {};
  const draws: Record<string, string> = {};
  for (const [id, [l, d]] of Object.entries(pairs)) {
    label[id] = l;
    draws[id] = d;
  }
  return { e: Object.keys(pairs), label, draws };
};
const num = (min: number, max: number): Rule => ({ n: [min, max] });
const COLOUR: Rule = { c: true };
const FLAG: Rule = { b: true };

/** The outline's 34 numbers and their ranges (the 35th key is `body`). */
export const PROFILE_RANGES: Record<Exclude<keyof CarProfile, "body">, [number, number]> = {
  lh: [150, 520],
  wh: [60, 220],
  tipH: [10, 85],
  noseX: [0, 14],
  noseH: [15, 92],
  noseR: [0, 100],
  chinH: [3, 40],
  cowlX: [1, 55],
  cowlH: [30, 90],
  bonnet: [0, 100],
  headX: [4, 72],
  headH: [40, 100],
  peakX: [4, 100],
  roofX: [12, 100],
  roofH: [40, 100],
  deckX: [20, 100],
  deckH: [20, 98],
  tailX: [86, 100],
  tailH: [15, 98],
  rumpH: [3, 45],
  sillH: [4, 40],
  axF: [8, 40],
  axR: [55, 94],
  wheelD: [20, 72],
  archGap: [0, 45],
  beltH: [30, 88],
  beltRise: [-10, 20],
  soft: [0, 100],
  pillarX: [10, 96],
  glassX: [20, 99],
  panes: [1, 5],
  roofW: [40, 100],
  taperF: [0, 40],
  taperR: [0, 40],
};
export const PROFILE_KEYS = Object.keys(PROFILE_RANGES) as (keyof typeof PROFILE_RANGES)[];

const bumper = (what: string): Rule =>
  ids({
    body: ["Body", `nothing extra: the ${what} bumper is part of the body`],
    black: ["Black", `a dark bar across the ${what}`],
    chrome: ["Chrome", `a bright metal bar across the ${what}`],
  });
const profileRules = Object.fromEntries(PROFILE_KEYS.map((k) => [`profile.${k}`, num(...PROFILE_RANGES[k])]));

/** The rules table, one entry per key of CarDetail (`v` itself is checked on its own: it must be 1). */
export const CAR_DETAIL: Record<string, Rule> = {
  toon: num(0, 100),
  "profile.body": { e: [...BODY_IDS] },
  ...profileRules,
  "roof.type": ids({
    closed: ["Closed", "a solid roof over the cabin"],
    open: ["Open top", "no roof: a windscreen in its frame, the riders in the open air"],
    targa: ["Targa", "no roof panel, a bar behind the seats, open sky above them"],
    soft_top: ["Soft top", "a fabric roof in its own colour, one window, two seams"],
    sunroof: ["Sunroof", "a closed roof with a small dark glass panel"],
    glass: ["Glass roof", "a closed roof that is mostly dark glass"],
  }),
  "roof.color": COLOUR,
  "roof.hoops": ids({
    none: ["None", "no bars behind the seats"],
    twin: ["Two hoops", "two round hoops standing up behind the seats"],
    bar: ["One bar", "one flat bar across behind the seats"],
  }),
  "roof.rails": FLAG,
  "wheels.shape": ids({
    steel: ["Steel", "a plain disc with eight round holes"],
    cap: ["Hubcap", "a dished hubcap with a shine arc"],
    straight: ["Straight", "tapered spokes that run straight out from the hub"],
    split: ["Split", "pairs of thin spokes, each pair a slim V"],
    y: ["Y spokes", "spokes that fork in two near the rim"],
    star: ["Star", "wide blades that end in a point"],
    mesh: ["Mesh", "twice as many thin crossing spokes as the count"],
    turbine: ["Turbine", "swept blades that look like a fan"],
    dish: ["Dish", "a deep plain dish with a wide polished lip and small slots"],
    wire: ["Wire", "hair-thin spokes and a small bright hub"],
    block: ["Chunky", "a small rim and chunky blocks of tread on the tyre"],
  }),
  "wheels.spokes": num(3, 24),
  "wheels.tyre": num(12, 60),
  "wheels.lip": num(0, 100),
  "wheels.dish": num(0, 100),
  "wheels.wall": ids({ black: ["Black", "an all black tyre"], white: ["White", "a white ring on the side of the tyre"] }),
  "wheels.hub": COLOUR,
  "wheels.rearD": num(20, 72),
  "brakes.disc": ids({
    none: ["None", "no disc: the dark barrel of the wheel shows"],
    plain: ["Plain", "a plain grey disc behind the spokes"],
    drilled: ["Drilled", "a grey disc with a ring of small holes"],
    ceramic: ["Dark", "a dark charcoal disc"],
  }),
  "brakes.caliper": COLOUR,
  "lights.front.shape": ids({
    round: ["Round", "one round lamp in a bezel"],
    twin_round: ["Two round", "two round lamps side by side"],
    oval: ["Oval", "one oval lamp"],
    square: ["Square", "a square block at the corner of the nose"],
    rect: ["Wide", "a wide low block at the corner of the nose"],
    slim: ["Slim", "a thin bar under the bonnet's edge"],
    swept: ["Swept", "a teardrop that runs back along the wing"],
    angled: ["Angled", "a wedge that slants down towards the grille"],
    stacked: ["Stacked", "two small blocks, one over the other"],
    pop_up: ["Pop-up", "a closed flap line by day, a raised block when the lights are on"],
    strip: ["Strip", "one thin bar across the whole nose"],
  }),
  "lights.front.drl": ids({
    none: ["None", "no daytime light"],
    line: ["Line", "a thin line along the lamp's lower edge"],
    hook: ["Hook", "an L shaped line round the lamp's corner"],
    ring: ["Ring", "a ring round a round lamp"],
    dots: ["Dots", "three small dots by the lamp"],
    brow: ["Brow", "a line along the lamp's top edge"],
  }),
  "lights.front.h": num(10, 92),
  "lights.front.lens": ids({
    clear: ["Clear", "a clear glass lens"],
    yellow: ["Yellow", "a yellow tinted lens"],
    smoked: ["Smoked", "a dark smoked lens"],
  }),
  "lights.rear.shape": ids({
    round: ["Round", "one round lamp"],
    twin_round: ["Two round", "two round lamps, one over the other"],
    square: ["Square", "a square lamp"],
    rect: ["Wide", "a wide low lamp"],
    tall: ["Tall", "a narrow upright lamp"],
    slim: ["Slim", "a thin lamp"],
    bar: ["Bar", "one bar across the full width of the tail"],
    split_bar: ["Split bar", "a bar across the tail with a gap for the plate"],
    wedge: ["Wedge", "a lamp that wraps round the corner of the tail"],
    c_shape: ["C shape", "a bracket shaped lamp"],
  }),
  "lights.rear.h": num(10, 92),
  "lights.rear.lens": ids({
    red: ["Red", "a red lens"],
    clear: ["Clear", "a clear lens with a red bulb"],
    smoked: ["Smoked", "a dark smoked lens"],
  }),
  "front.grille": ids({
    none: ["None", "a smooth nose with no grille"],
    slot: ["Slot", "a thin dark slit"],
    bars: ["Bars", "a dark box with one bright bar"],
    slats: ["Slats", "upright slats in a box"],
    mesh: ["Mesh", "a dark mesh box"],
    oval: ["Oval", "an oval mouth"],
    tall: ["Tall", "an upright box up to the bonnet"],
    twin: ["Two", "two openings side by side"],
  }),
  "front.intake": ids({
    none: ["None", "no low mouth"],
    wide: ["Wide", "one wide low mouth"],
    split3: ["Three", "a low mouth in three parts"],
    twin: ["Corners", "two mouths, one at each corner"],
    smile: ["Smile", "a curved low mouth"],
  }),
  "front.splitter": ids({
    none: ["None", "no splitter"],
    lip: ["Lip", "a thin dark edge along the bottom of the nose"],
    blade: ["Blade", "a dark blade standing out in front of the nose"],
  }),
  "front.bumper": bumper("front"),
  "front.fog": FLAG,
  "bonnet.vent": ids({
    none: ["None", "a smooth bonnet"],
    scoop: ["Scoop", "a raised scoop on the bonnet"],
    bulge: ["Bulge", "a long hump line down the bonnet"],
    vents: ["Vents", "two slats in the bonnet"],
    duct: ["Duct", "a wide dark outlet ahead of the windscreen"],
  }),
  "side.intake": ids({
    none: ["None", "a plain side"],
    scoop: ["Scoop", "a slash shaped dark scoop ahead of the rear wheel with a lit edge"],
    gill: ["Gills", "three slanted gills behind the front wheel"],
    slats: ["Slats", "four slats on the rear quarter"],
    duct: ["Duct", "a low dark slot in the sill"],
  }),
  "side.intakeX": num(20, 95),
  "side.skirts": ids({
    none: ["None", "no skirts"],
    lip: ["Lip", "a thin dark skirt between the wheels"],
    deep: ["Deep", "a deep dark skirt between the wheels"],
    boards: ["Boards", "a bright running board between the wheels"],
  }),
  "side.doors": num(0, 3),
  "side.handles": ids({
    none: ["None", "no handles"],
    bar: ["Bar", "a small bar handle on each door"],
    flush: ["Flush", "a tiny flat handle on each door"],
    chrome: ["Chrome", "a bright handle on each door"],
  }),
  "side.crease": ids({
    none: ["None", "a smooth side"],
    level: ["Level", "a lit line level along the side"],
    wedge: ["Wedge", "a lit line that rises towards the tail"],
    double: ["Double", "two lit lines along the side"],
  }),
  "side.mirror": ids({
    none: ["None", "no mirror"],
    ear: ["Ear", "a small cap at the foot of the windscreen"],
    stalk: ["Stalk", "a mirror on a short arm"],
    square: ["Square", "a tall square truck mirror"],
  }),
  "side.rubStrip": FLAG,
  "side.fuelCap": FLAG,
  "rear.diffuser": ids({
    none: ["None", "a plain underside at the tail"],
    fins: ["Fins", "a dark raked underside with fins"],
    deep: ["Deep", "a deep dark raked underside"],
  }),
  "rear.exhaust": ids({
    none: ["None", "no exhaust pipe"],
    single: ["One", "one pipe low at one side"],
    twin: ["Two", "two pipes low, side by side"],
    quad: ["Four", "four pipes in a row"],
    centre: ["Centre", "one pipe in the middle"],
    high: ["High", "two pipes at mid height, either side of the plate"],
    side: ["Side", "a pipe under the door"],
    stack: ["Stack", "an upright pipe behind the cab"],
  }),
  "rear.spoiler": ids({
    none: ["None", "no spoiler"],
    lip: ["Lip", "a thin lip on the tail's edge"],
    ducktail: ["Ducktail", "a short raised kick on the tail's edge"],
    wing: ["Wing", "a wing on two short stalks"],
    big_wing: ["Big wing", "a tall wing on two tall stalks"],
    roof: ["Roof", "a small wing at the roof's rear end"],
  }),
  "rear.bumper": bumper("rear"),
  arches: ids({
    round: ["Round", "round wheel openings"],
    square: ["Square", "square wheel openings"],
    flare: ["Flared", "a ring of darker paint round each wheel opening"],
    clad: ["Clad", "a ring of dark trim round each wheel opening"],
  }),
  "stripe.layout": ids({
    none: ["None", "no stripe"],
    centre: ["Centre", "one wide stripe over the bonnet, roof and tail"],
    twin: ["Twin", "two thin stripes over the bonnet, roof and tail"],
    offset: ["Offset", "one wide stripe a little off the middle"],
    side: ["Side", "a band along the doors"],
    sill: ["Sill", "a band low along the sill"],
    pin: ["Pin", "a hairline under the windows"],
  }),
  "stripe.color": COLOUR,
  "stripe.width": num(0, 100),
  twoTone: ids({
    roof: ["Roof", "the roof in the second colour"],
    split: ["Split", "everything above the windows' bottom edge in the second colour"],
    lower: ["Lower", "the lower body in the second colour"],
    bonnet: ["Bonnet", "the bonnet in the second colour"],
  }),
  trim: COLOUR,
  mirrorColor: COLOUR,
  finish: ids({
    gloss: ["Gloss", "bright paint with a clear shine"],
    satin: ["Satin", "paint with a soft low shine"],
    matte: ["Matte", "flat paint with almost no shine"],
    metallic: ["Metallic", "bright paint with a second thin shine line"],
  }),
  extras: {
    l: ["bull_bar", "spare_wheel", "roof_rails", "antenna", "shark_fin", "snorkel", "light_bar", "mudflaps", "roof_scoop", "tow_hook", "ladder", "wing_lamps"],
    max: 6,
    label: { bull_bar: "Bull bar", spare_wheel: "Spare wheel", roof_rails: "Roof rails", antenna: "Antenna", shark_fin: "Fin", snorkel: "Snorkel", light_bar: "Light bar", mudflaps: "Mudflaps", roof_scoop: "Roof scoop", tow_hook: "Tow hook", ladder: "Ladder", wing_lamps: "Wing lamps" },
    draws: {
      bull_bar: "a dark bar guard across the front of the nose",
      spare_wheel: "a spare wheel on the back",
      roof_rails: "two rails along the roof",
      antenna: "a thin mast on the roof's rear",
      shark_fin: "a small fin on the roof's rear",
      snorkel: "an upright pipe up the side of the windscreen",
      light_bar: "a bar of lamps across the roof's front",
      mudflaps: "a flap behind each wheel",
      roof_scoop: "a small scoop on the roof",
      tow_hook: "a small hook under the nose",
      ladder: "a ladder up the back",
      wing_lamps: "small lamps on top of the front wings",
    },
  },
  "cabin.rows": num(1, 3),
  "cabin.seat": COLOUR,
  "cabin.dial": COLOUR,
  "cabin.wheel": ids({ round: ["Round", "a round steering wheel"], flat: ["Flat", "a steering wheel with a flat bottom"] }),
};
/** Paths whose value is checked as a whole (the profile's 35 numbers go together). */
export const CAR_DETAIL_WHOLE: string[] = ["profile"];

// ---- the presets (frozen under v 1: a saved `{v:1}` look depends on them) -------------------------------------------

const P = (body: CarBody, a: number[]): CarProfile => {
  const o = { body } as Record<string, unknown>;
  PROFILE_KEYS.forEach((k, i) => (o[k] = a[i]));
  return o as unknown as CarProfile;
};
const COMPACT = [235, 108, 40, 2, 55, 55, 16, 26, 62, 28, 36, 96, 55, 84, 95, 93, 63, 98, 60, 17, 15, 17, 82, 38, 14, 62, 0, 60, 60, 82, 2, 80, 6, 6];

/** The measured outline of each body (the starting numbers; the motorbike, plane and boat rows are copies of
 * `compact`, kept for type completeness and never drawn). */
export const PRESET: Record<CarBody, CarProfile> = {
  hatchback: P("hatchback", [290, 124, 36, 2, 52, 40, 14, 26, 60, 20, 37, 96, 52, 80, 94, 92, 62, 98, 58, 16, 14, 19, 80, 42, 12, 60, 2, 55, 54, 84, 2, 78, 8, 6]),
  sedan: P("sedan", [330, 126, 34, 2, 50, 40, 13, 25, 60, 20, 37, 96, 48, 68, 94, 82, 62, 98, 60, 15, 13, 18, 78, 42, 12, 60, 2, 55, 52, 74, 2, 76, 8, 6]),
  estate: P("estate", [320, 124, 36, 2, 52, 40, 14, 25, 60, 20, 36, 96, 55, 92, 95, 97, 62, 99, 58, 16, 14, 18, 78, 42, 12, 60, 1, 50, 50, 92, 3, 82, 8, 4]),
  suv: P("suv", [265, 110, 40, 2, 58, 35, 20, 26, 62, 15, 36, 97, 55, 90, 96, 97, 62, 99, 60, 22, 20, 18, 78, 44, 18, 62, 1, 45, 52, 90, 3, 86, 6, 4]),
  pickup: P("pickup", [290, 105, 40, 2, 58, 30, 20, 24, 62, 12, 33, 98, 42, 54, 97, 56, 62, 99, 61, 22, 20, 17, 78, 44, 18, 62, 0, 35, 46, 52, 1, 88, 5, 2]),
  van: P("van", [240, 95, 42, 1, 55, 45, 16, 10, 58, 8, 20, 97, 50, 95, 97, 98, 58, 99, 52, 17, 15, 20, 80, 36, 14, 58, 0, 50, 38, 90, 3, 90, 6, 3]),
  sports: P("sports", [360, 150, 30, 3, 44, 25, 10, 30, 62, 40, 42, 97, 50, 64, 94, 84, 72, 97, 68, 14, 11, 22, 80, 54, 10, 62, 3, 55, 60, 70, 1, 66, 18, 8]),
  compact: P("compact", COMPACT),
  bus: P("bus", [375, 80, 45, 0, 50, 30, 12, 3, 46, 0, 6, 99, 50, 97, 99, 98, 46, 99, 44, 12, 11, 16, 74, 30, 12, 46, 0, 30, 20, 94, 5, 96, 3, 2]),
  motorbike: P("motorbike", COMPACT),
  plane: P("plane", COMPACT),
  boat: P("boat", COMPACT),
};

/** Each body's typical parts. Wheel and lamp shapes are left out on purpose: the classic fields always decide them. */
export const PRESET_PARTS: Record<CarBody, Partial<CarDetail>> = {
  hatchback: { front: { grille: "slot" }, side: { doors: 1, handles: "bar", crease: "level", mirror: "ear" }, rear: { exhaust: "single" }, wheels: { tyre: 34 } },
  sedan: { front: { grille: "slot" }, side: { doors: 2, handles: "bar", crease: "level", mirror: "ear" }, rear: { exhaust: "single" }, wheels: { tyre: 32 } },
  estate: { roof: { rails: true }, front: { grille: "slot" }, side: { doors: 2, handles: "bar", crease: "level", mirror: "ear" }, rear: { exhaust: "single" }, wheels: { tyre: 34 } },
  suv: {
    roof: { rails: true },
    front: { grille: "bars", bumper: "black" },
    side: { doors: 2, handles: "bar", skirts: "boards", mirror: "ear", rubStrip: true },
    rear: { exhaust: "single", bumper: "black" },
    arches: "square",
    wheels: { tyre: 40 },
  },
  pickup: {
    front: { grille: "bars", bumper: "black" },
    side: { doors: 1, handles: "bar", mirror: "square" },
    rear: { exhaust: "side", bumper: "black" },
    arches: "square",
    wheels: { tyre: 42 },
  },
  van: { front: { grille: "slot", bumper: "black" }, side: { doors: 2, handles: "bar", mirror: "square" }, rear: { exhaust: "single", bumper: "black" }, wheels: { tyre: 36 } },
  sports: {
    front: { intake: "wide", splitter: "lip" },
    side: { doors: 1, handles: "flush", skirts: "lip", crease: "wedge", mirror: "stalk" },
    rear: { diffuser: "fins", exhaust: "twin", spoiler: "lip" },
    brakes: { disc: "drilled", caliper: "#c8102e" },
    wheels: { tyre: 24, lip: 30 },
    finish: "metallic",
  },
  compact: { front: { grille: "oval" }, side: { doors: 1, handles: "bar", mirror: "ear" }, rear: { exhaust: "single" }, wheels: { tyre: 36 } },
  bus: { front: { grille: "slot", bumper: "black" }, side: { doors: 2 }, rear: { exhaust: "stack", bumper: "black" }, wheels: { tyre: 34 } },
  motorbike: { rear: { exhaust: "single" }, wheels: { tyre: 30 } },
  plane: {},
  boat: {},
};

// ---- what fits which family (design-final 1.4) --------------------------------------------------------------------

/** What each family of vehicle can carry. `resolveDetail` drops the rest silently; the check never refuses it (the
 * owner may change Shape later). `front`, `side`, `rear` list the keys that group may use. */
export interface FamilyFit {
  profile: boolean;
  roofs: CarRoof[];
  wheels: boolean;
  brakes: boolean;
  frontLight: boolean;
  rearLight: boolean;
  front: string[];
  bonnet: string[];
  side: string[];
  rear: string[];
  arches: boolean;
  cabin: boolean;
  extras: CarExtra[];
}
const ALL_ROOFS: CarRoof[] = ["closed", "open", "targa", "soft_top", "sunroof", "glass"];
const ALL_EXTRAS = CAR_DETAIL["extras"] && "l" in CAR_DETAIL["extras"] ? (CAR_DETAIL["extras"].l as CarExtra[]) : [];
const CAR_FIT: FamilyFit = {
  profile: true,
  roofs: ALL_ROOFS,
  wheels: true,
  brakes: true,
  frontLight: true,
  rearLight: true,
  front: ["grille", "intake", "splitter", "bumper", "fog"],
  bonnet: ["vent"],
  side: ["intake", "intakeX", "skirts", "doors", "handles", "crease", "mirror", "rubStrip", "fuelCap"],
  rear: ["diffuser", "exhaust", "spoiler", "bumper"],
  arches: true,
  cabin: true,
  extras: ALL_EXTRAS,
};
const NONE_FIT: FamilyFit = { ...CAR_FIT, profile: false, roofs: ["closed"], wheels: false, brakes: false, frontLight: true, rearLight: false, front: [], bonnet: [], side: [], rear: [], arches: false, cabin: false, extras: ["antenna"] };
export const FAMILY_FIT: Record<VehicleType, FamilyFit> = {
  car: CAR_FIT,
  truck: CAR_FIT,
  bus: { ...CAR_FIT, roofs: ["closed", "sunroof", "glass"], front: ["grille", "bumper"], bonnet: [], side: ["doors"], rear: ["exhaust", "bumper"], arches: false, extras: ["antenna", "light_bar", "roof_rails", "ladder", "mudflaps"] },
  motorbike: { ...NONE_FIT, wheels: true, brakes: true, rear: ["exhaust"], extras: ["antenna", "mudflaps"] },
  plane: { ...NONE_FIT, wheels: true, cabin: true },
  boat: { ...NONE_FIT, roofs: ["closed", "open"], cabin: true, extras: ["antenna", "ladder"] },
};
/** A van has no open roof (the rest of the truck family does). */
const VAN_ROOFS: CarRoof[] = ["closed", "sunroof", "glass"];

// ---- the check -------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
// lower case only, here and in the API (400); the agent lower-cases every colour it repairs, so a design never fails this check on case
const HEX = /^#[0-9a-f]{6}$/;
const show = (v: unknown): string => {
  let s: string | undefined;
  try {
    s = v === undefined ? "nothing" : JSON.stringify(v);
  } catch {
    s = "something odd";
  }
  s = s ?? "nothing";
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
};
/** Every prefix of every rule path: the groups an object may sit at. */
const GROUPS = new Set<string>(Object.keys(CAR_DETAIL).flatMap((p) => p.split(".").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("."))));

/** What a rule allows, in words (the end of "...; use {this}."). */
export function ruleWords(rule: Rule): string {
  if ("e" in rule) return `one of ${rule.e.join(", ")}`;
  if ("n" in rule) return `a whole number from ${rule.n[0]} to ${rule.n[1]}`;
  if ("c" in rule) return 'a colour like "#d8352a"';
  if ("b" in rule) return "true or false";
  return `a list of at most ${rule.max} different ones of ${rule.l.join(", ")}`;
}

/** True when `value` satisfies `rule`. */
export function ruleAllows(rule: Rule, value: unknown): boolean {
  if ("e" in rule) return typeof value === "string" && rule.e.includes(value);
  if ("n" in rule) return typeof value === "number" && Number.isInteger(value) && value >= rule.n[0] && value <= rule.n[1];
  if ("c" in rule) return typeof value === "string" && HEX.test(value);
  if ("b" in rule) return typeof value === "boolean";
  return Array.isArray(value) && value.length <= rule.max && new Set(value).size === value.length && value.every((x) => typeof x === "string" && rule.l.includes(x));
}

/** Visits every leaf: a path with a rule, or a path that has none (unknown). Objects are walked, lists are leaves. */
function walk(o: Obj, prefix: string, visit: (path: string, value: unknown) => void): void {
  for (const [k, value] of Object.entries(o)) {
    if (prefix === "" && k === "v") continue;
    const path = prefix === "" ? k : `${prefix}.${k}`;
    if (!hasOwn(CAR_DETAIL, path) && isObj(value) && (Object.keys(value).length > 0 || GROUPS.has(path))) walk(value, path, visit);
    else visit(path, value);
  }
}

/** Checks a `detail` value, one sentence per problem. Strict while `v` is 1 (or not a number); lenient when `v` is a
 * newer whole number (unknown keys and choices are skipped and drawn as the default), so a newer API never stops an
 * older agent image from making a video. */
export function checkCarDetail(value: unknown, where: string, err: (m: string) => void): void {
  if (!isObj(value)) {
    err(`${where}: car.detail must be an object.`);
    return;
  }
  const v = value["v"];
  const lenient = typeof v === "number" && Number.isInteger(v) && v > CAR_DETAIL_V;
  if (!lenient && v !== CAR_DETAIL_V) err(`${where}: car.detail.v must be ${CAR_DETAIL_V}.`);
  if (lenient) return;
  walk(value, "", (path, val) => {
    const rule = CAR_DETAIL[path];
    if (rule !== undefined && hasOwn(CAR_DETAIL, path)) {
      if (!ruleAllows(rule, val)) err(`${where}: car.detail.${path} is ${show(val)}; use ${ruleWords(rule)}.`);
    } else if (CAR_DETAIL_WHOLE.includes(path)) {
      // a profile that is not an object is reported below with the half profiles
    } else if (GROUPS.has(path)) err(`${where}: car.detail.${path} is ${show(val)}; use an object.`);
    else err(`${where}: car.detail.${path} is not a known detail.`);
  });
  for (const whole of CAR_DETAIL_WHOLE) {
    if (!hasOwn(value, whole)) continue;
    const part = value[whole];
    const need = Object.keys(CAR_DETAIL).filter((p) => p.startsWith(`${whole}.`));
    if (!isObj(part) || need.some((p) => !hasOwn(part, p.slice(whole.length + 1)))) err(`${where}: car.detail.${whole} needs all of its numbers.`);
  }
  let long: boolean;
  try {
    long = JSON.stringify(value).length > CAR_DETAIL_MAX_CHARS;
  } catch {
    long = true;
  }
  if (long) err(`${where}: car.detail is too long.`);
}

// ---- resolving a look ------------------------------------------------------------------------------------------------

type Bumper = "body" | "black" | "chrome";
export interface Resolved {
  /** the look and its detail as given (the drawers also read the classic fields from it) */
  car: CarLook;
  detail: CarDetail;
  family: VehicleType;
  /** open or targa (the outline has no roof); a soft top counts as closed */
  open: boolean;
  /** true when the outline is the photo's own (`detail.profile` for this body), false when it is the body's preset */
  fromPhotos: boolean;
  /** what fits this family: a part that does not fit is already neutral below, and the drawer skips it */
  fits: { profile: boolean; wheels: boolean; brakes: boolean; frontLight: boolean; rearLight: boolean; front: boolean; bonnet: boolean; side: boolean; rear: boolean; arches: boolean; cabin: boolean };
  profile: CarProfile;
  toon: number;
  roof: { type: CarRoof; color: Hex | null; hoops: "none" | "twin" | "bar"; rails: boolean };
  wheels: { shape: CarWheelShape; spokes: number; tyre: number; lip: number; dish: number; wall: "black" | "white"; hub: Hex | null; rearD: number };
  brakes: { disc: "none" | "plain" | "drilled" | "ceramic"; caliper: Hex };
  lights: {
    /** `h` null: the drawer's own height (62% between the nose tip and its top) */
    front: { shape: CarFrontLight; drl: CarDrl; h: number | null; lens: "clear" | "yellow" | "smoked" };
    rear: { shape: CarRearLight; h: number | null; lens: "red" | "clear" | "smoked" };
  };
  front: { grille: CarGrille; intake: CarIntake; splitter: "none" | "lip" | "blade"; bumper: Bumper; fog: boolean };
  bonnet: { vent: "none" | "scoop" | "bulge" | "vents" | "duct" };
  side: {
    intake: "none" | "scoop" | "gill" | "slats" | "duct";
    intakeX: number;
    skirts: "none" | "lip" | "deep" | "boards";
    doors: number;
    handles: "none" | "bar" | "flush" | "chrome";
    crease: "none" | "level" | "wedge" | "double";
    mirror: "none" | "ear" | "stalk" | "square";
    rubStrip: boolean;
    fuelCap: boolean;
  };
  rear: { diffuser: "none" | "fins" | "deep"; exhaust: CarExhaust; spoiler: CarSpoiler; bumper: Bumper };
  arches: "round" | "square" | "flare" | "clad";
  stripe: { layout: CarStripe; color: Hex; width: number };
  twoTone: "roof" | "split" | "lower" | "bonnet" | null;
  trim: Hex;
  mirrorColor: Hex;
  finish: "gloss" | "satin" | "matte" | "metallic";
  extras: CarExtra[];
  cabin: { rows: number; seat: Hex | null; dial: Hex | null; wheel: "round" | "flat" };
}

const CLASSIC_WHEEL: Record<CarLook["wheels"]["style"], { shape: CarWheelShape; spokes: number; tyre?: number }> = {
  steel: { shape: "steel", spokes: 8 },
  hubcap: { shape: "cap", spokes: 8 },
  alloy: { shape: "straight", spokes: 5 },
  sport: { shape: "split", spokes: 5 },
  offroad: { shape: "block", spokes: 6, tyre: 44 },
};
/** The spokes a shape starts with when the detail names the shape but not the count. */
export const DEFAULT_SPOKES: Record<CarWheelShape, number> = { steel: 8, cap: 8, straight: 5, split: 5, y: 5, star: 5, mesh: 10, turbine: 9, dish: 6, wire: 16, block: 6 };
const CLASSIC_STRIPE: Record<CarLook["pattern"], CarStripe | undefined> = { plain: undefined, two_tone: undefined, stripe: "side", racing_stripes: "twin" };
const NEUTRAL = {
  front: { grille: "none", intake: "none", splitter: "none", bumper: "body", fog: false },
  bonnet: { vent: "none" },
  side: { intake: "none", intakeX: 66, skirts: "none", doors: 0, handles: "none", crease: "none", mirror: "none", rubStrip: false, fuelCap: false },
  rear: { diffuser: "none", exhaust: "none", spoiler: "none", bumper: "body" },
};

/** The valid leaves of a detail, flat by dotted path: whatever breaks its rule is dropped (so the drawers can never
 * be handed a bad value), and a profile that is not complete is dropped whole. */
function flatten(detail: unknown): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  if (!isObj(detail)) return flat;
  walk(detail, "", (path, val) => {
    const rule = CAR_DETAIL[path];
    if (rule !== undefined && hasOwn(CAR_DETAIL, path) && path !== "extras" && ruleAllows(rule, val)) flat[path] = val;
  });
  if (PROFILE_KEYS.some((k) => flat[`profile.${k}`] === undefined) || flat["profile.body"] === undefined) {
    for (const p of Object.keys(flat)) if (p.startsWith("profile.")) delete flat[p];
  }
  return flat;
}

/** Decides every part of a detailed vehicle (only called when `car.detail !== undefined`). Per part: the `detail` key,
 * else the mapping from the classic field, else the body's preset parts, else a plain default. A part that does not fit
 * the vehicle's family is replaced by its neutral value. Never throws, whatever the editor state. */
export function resolveDetail(car: CarLook): Resolved {
  const body: CarBody = hasOwn(VEHICLE_OF, car.body) ? car.body : "sedan";
  const family = VEHICLE_OF[body];
  const fit = FAMILY_FIT[family];
  const detail: CarDetail = car.detail ?? { v: CAR_DETAIL_V };
  const flat = flatten(detail);
  const pp = PRESET_PARTS[body];
  const pick = <T,>(path: string, ...fallbacks: (T | undefined)[]): T => {
    const own = flat[path] as T | undefined;
    if (own !== undefined) return own;
    for (const f of fallbacks) if (f !== undefined) return f;
    return fallbacks[fallbacks.length - 1] as T;
  };

  // outline
  const fromPhotos = fit.profile && flat["profile.body"] === body;
  const profile: CarProfile = fromPhotos ? (Object.fromEntries([["body", body], ...PROFILE_KEYS.map((k) => [k, flat[`profile.${k}`]])]) as unknown as CarProfile) : { ...PRESET[body] };
  const toon = fit.profile ? pick<number>("toon", 30) : 30;

  // roof
  const roofsOk = family === "truck" && body === "van" ? VAN_ROOFS : fit.roofs;
  const asked = pick<CarRoof>("roof.type", "closed");
  const roofType: CarRoof = roofsOk.includes(asked) ? asked : "closed";
  const open = roofType === "open" || roofType === "targa";
  const roof = {
    type: roofType,
    color: (flat["roof.color"] as Hex | undefined) ?? null,
    hoops: open ? pick<"none" | "twin" | "bar">("roof.hoops", pp.roof?.hoops, "none") : ("none" as const),
    rails: fit.profile && !open ? pick<boolean>("roof.rails", pp.roof?.rails, false) : false,
  };

  // wheels and brakes
  const cw = CLASSIC_WHEEL[car.wheels?.style] ?? CLASSIC_WHEEL.alloy;
  const shape = pick<CarWheelShape>("wheels.shape", cw.shape);
  const wheels = {
    shape,
    spokes: pick<number>("wheels.spokes", flat["wheels.shape"] !== undefined ? DEFAULT_SPOKES[shape] : cw.spokes),
    tyre: pick<number>("wheels.tyre", cw.tyre, pp.wheels?.tyre, 32),
    lip: pick<number>("wheels.lip", pp.wheels?.lip, 30),
    dish: pick<number>("wheels.dish", pp.wheels?.dish, 30),
    wall: pick<"black" | "white">("wheels.wall", "black"),
    hub: (flat["wheels.hub"] as Hex | undefined) ?? null,
    rearD: pick<number>("wheels.rearD", profile.wheelD),
  };
  const brakes = {
    disc: fit.brakes ? pick<Resolved["brakes"]["disc"]>("brakes.disc", pp.brakes?.disc, "plain") : ("none" as const),
    caliper: pick<Hex>("brakes.caliper", pp.brakes?.caliper, "#5a5f68"),
  };

  // lamps
  const lights = {
    front: {
      shape: pick<CarFrontLight>("lights.front.shape", car.lights?.front),
      drl: pick<CarDrl>("lights.front.drl", pp.lights?.front?.drl, "none"),
      h: (flat["lights.front.h"] as number | undefined) ?? null,
      lens: pick<"clear" | "yellow" | "smoked">("lights.front.lens", pp.lights?.front?.lens, "clear"),
    },
    rear: {
      shape: pick<CarRearLight>("lights.rear.shape", car.lights?.rear),
      h: (flat["lights.rear.h"] as number | undefined) ?? null,
      lens: pick<"red" | "clear" | "smoked">("lights.rear.lens", pp.lights?.rear?.lens, "red"),
    },
  };

  // nose, bonnet, sides, tail: a group keeps only the keys its family can use
  const keep = <T extends Record<string, unknown>>(group: T, allowed: string[], neutral: Record<string, unknown>): T => {
    const out: Record<string, unknown> = { ...group };
    for (const k of Object.keys(out)) if (!allowed.includes(k)) out[k] = neutral[k];
    return out as T;
  };
  const front = keep(
    {
      grille: pick<CarGrille>("front.grille", pp.front?.grille, "none"),
      intake: pick<CarIntake>("front.intake", pp.front?.intake, "none"),
      splitter: pick<"none" | "lip" | "blade">("front.splitter", pp.front?.splitter, "none"),
      bumper: pick<Bumper>("front.bumper", pp.front?.bumper, "body"),
      fog: pick<boolean>("front.fog", pp.front?.fog, false),
    },
    fit.front,
    NEUTRAL.front,
  );
  const bonnet = keep({ vent: pick<Resolved["bonnet"]["vent"]>("bonnet.vent", pp.bonnet?.vent, "none") }, fit.bonnet, NEUTRAL.bonnet);
  const side = keep(
    {
      intake: pick<Resolved["side"]["intake"]>("side.intake", pp.side?.intake, "none"),
      intakeX: pick<number>("side.intakeX", pp.side?.intakeX, 66),
      skirts: pick<Resolved["side"]["skirts"]>("side.skirts", pp.side?.skirts, "none"),
      doors: pick<number>("side.doors", pp.side?.doors, 1),
      handles: pick<Resolved["side"]["handles"]>("side.handles", pp.side?.handles, "none"),
      crease: pick<Resolved["side"]["crease"]>("side.crease", pp.side?.crease, "none"),
      mirror: pick<Resolved["side"]["mirror"]>("side.mirror", pp.side?.mirror, "ear"),
      rubStrip: pick<boolean>("side.rubStrip", pp.side?.rubStrip, false),
      fuelCap: pick<boolean>("side.fuelCap", pp.side?.fuelCap, false),
    },
    fit.side,
    NEUTRAL.side,
  );
  const rear = keep(
    {
      diffuser: pick<Resolved["rear"]["diffuser"]>("rear.diffuser", pp.rear?.diffuser, "none"),
      exhaust: pick<CarExhaust>("rear.exhaust", pp.rear?.exhaust, "single"),
      spoiler: pick<CarSpoiler>("rear.spoiler", car.extra === "spoiler" ? "wing" : undefined, pp.rear?.spoiler, "none"),
      bumper: pick<Bumper>("rear.bumper", pp.rear?.bumper, "body"),
    },
    fit.rear,
    NEUTRAL.rear,
  );
  if (family === "bus" && rear.exhaust !== "stack") rear.exhaust = "none";

  // paint
  const stripe = {
    layout: pick<CarStripe>("stripe.layout", CLASSIC_STRIPE[car.pattern], pp.stripe?.layout, "none"),
    color: pick<Hex>("stripe.color", pp.stripe?.color, car.accent),
    width: pick<number>("stripe.width", pp.stripe?.width, 50),
  };
  const twoTone = (flat["twoTone"] as Resolved["twoTone"] | undefined) ?? (car.pattern === "two_tone" ? "roof" : (pp.twoTone ?? null));

  // extras: tolerant (unknown ids, repeats and the seventh onwards are dropped), then what the family can carry
  const rawExtras = Array.isArray(detail.extras) ? (detail.extras as unknown[]) : (pp.extras ?? []);
  const extras = [...new Set(rawExtras)].filter((x): x is CarExtra => typeof x === "string" && ALL_EXTRAS.includes(x as CarExtra)).slice(0, 6).filter((x) => fit.extras.includes(x));

  // cabin: the inside photos' seat colour (`interior`) wins over a `detail` seat colour
  const classicRows = body === "sports" || body === "pickup" || body === "motorbike" ? 1 : body === "bus" ? 3 : 2;
  const cabin = fit.cabin
    ? { rows: pick<number>("cabin.rows", pp.cabin?.rows, classicRows), seat: car.interior?.seat ?? (flat["cabin.seat"] as Hex | undefined) ?? null, dial: (flat["cabin.dial"] as Hex | undefined) ?? null, wheel: pick<"round" | "flat">("cabin.wheel", "round") }
    : { rows: 1, seat: null, dial: null, wheel: "round" as const };

  return {
    car,
    detail,
    family,
    open,
    fromPhotos,
    fits: {
      profile: fit.profile,
      wheels: fit.wheels,
      brakes: fit.brakes,
      frontLight: fit.frontLight,
      rearLight: fit.rearLight,
      front: fit.front.length > 0,
      bonnet: fit.bonnet.length > 0,
      side: fit.side.length > 0,
      rear: fit.rear.length > 0,
      arches: fit.arches,
      cabin: fit.cabin,
    },
    profile,
    toon,
    roof,
    wheels,
    brakes,
    lights,
    front,
    bonnet,
    side,
    rear,
    arches: fit.arches ? pick<Resolved["arches"]>("arches", pp.arches, "round") : "round",
    stripe,
    twoTone,
    trim: pick<Hex>("trim", pp.trim, "#23252b"),
    mirrorColor: pick<Hex>("mirrorColor", pp.mirrorColor, car.accent),
    finish: pick<Resolved["finish"]>("finish", pp.finish, "gloss"),
    extras,
    cabin,
  };
}
