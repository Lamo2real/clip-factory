// Lamo Stories animation engine: the shared types (docs/CONTRACTS.md §45.10).
// Imported by the browser (live previews) and run by the agent with Deno (final frames), so this folder must stay
// free of DOM, npm and network imports: relative ".ts" imports only.

export type Hex = string; // "#rrggbb"

export type Expression =
  | "neutral"
  | "happy"
  | "laughing"
  | "surprised"
  | "shocked"
  | "scared"
  | "worried"
  | "angry"
  | "determined"
  | "thinking"
  | "sad"
  | "proud"
  | "dizzy"
  | "relieved";

export type MovementStyle = "bouncy" | "calm" | "clumsy" | "zippy" | "heavy";

export interface CharacterLook {
  body: "bean" | "round" | "tall" | "square";
  skin: Hex;
  /** 0.85..1.15 */
  height: number;
  /** 0.85..1.15 */
  width: number;
  hair: { style: "none" | "short" | "spiky" | "curly" | "long" | "bun" | "cap"; color: Hex };
  eyes: { shape: "round" | "oval" | "sleepy"; color: Hex };
  brows: "thin" | "thick";
  nose: "dot" | "button" | "long" | "none";
  mouth: "small" | "wide";
  outfit: { top: Hex; bottom: Hex; accent: Hex; pattern: "plain" | "stripes" | "dots" };
  accessory: "none" | "glasses" | "scarf" | "bowtie" | "helmet" | "headphones";
  outline: Hex;
}

export type CharacterKind = "person" | "car";

export type CarBody = "hatchback" | "sedan" | "estate" | "suv" | "pickup" | "van" | "sports" | "compact";

/** A car character's look (CONTRACTS §45.41): drawn by engine/car.ts in the side and the top view. */
export interface CarLook {
  body: CarBody;
  /** 0.85..1.15 */
  length: number;
  /** 0.85..1.15 */
  height: number;
  paint: Hex;
  /** the second colour: roof and pillars (two_tone), the stripes, the mirror caps */
  accent: Hex;
  pattern: "plain" | "two_tone" | "stripe" | "racing_stripes";
  windows: "clear" | "tinted" | "dark";
  wheels: { style: "steel" | "hubcap" | "alloy" | "sport" | "offroad"; rim: Hex; /** 0.85..1.2 */ size: number };
  lights: { front: "round" | "square" | "slim"; rear: "round" | "bar" | "square" };
  extra: "none" | "roof_rack" | "spoiler" | "roof_box";
  /** a cartoon face; eyes "none" is a real-looking car (the default) */
  face: { eyes: "none" | "windscreen" | "headlights"; color: Hex; mouth: "none" | "grille" };
  outline: Hex;
}

export type ActionId =
  | "idle"
  | "walk"
  | "run"
  | "jump"
  | "wave"
  | "point"
  | "shrug"
  | "facepalm"
  | "celebrate"
  | "cower"
  | "sit"
  | "drive"
  | "steer_left"
  | "steer_right"
  | "brake"
  | "brace"
  | "look_left"
  | "look_right"
  | "nod"
  | "shake_head"
  | "thumbs_up"
  | "slip"
  | "fall"
  | "get_up"
  | "dance"
  | "think"
  | "gesture"
  | "gasp"
  | "get_in"
  | "get_out";

export type PropAction =
  | "move"
  | "skid"
  | "spin"
  | "stop"
  | "bump"
  | "tyre_burst"
  | "appear"
  | "vanish"
  | "wobble"
  | "flash"
  | "speed_up"
  | "bounce"
  | "honk"
  | "blink"
  | "stall";

export type SetId =
  | "studio"
  | "road_day"
  | "road_night"
  | "icy_road"
  | "snowy_road"
  | "rainy_road"
  | "foggy_road"
  | "highway"
  | "country_road"
  | "city_street"
  | "parking_lot"
  | "kitchen"
  | "living_room"
  | "office"
  | "park"
  | "highway_night";

export type PropKind =
  | "car"
  | "truck"
  | "tyre"
  | "ice_patch"
  | "puddle"
  | "warning_triangle"
  | "phone"
  | "steering_wheel"
  | "stop_sign"
  | "ice_sign"
  | "tree"
  | "cone"
  | "deer"
  | "arrow"
  | "check"
  | "cross"
  | "exclamation"
  | "question"
  | "heart"
  | "sparkles"
  | "snow"
  | "rain"
  | "fog"
  | "dust";

export type CameraId = "wide" | "medium" | "close" | "pan_left" | "pan_right" | "shake" | "push_in";

/** The drawing style of a whole video (CONTRACTS §45.45): "classic" (Bright, the first videos' look) or "night_drive"
 * (soft lines, cel shading, a muted night palette). A script without `art` draws as classic. */
export type ArtStyle = "classic" | "night_drive";

/** A shot inside a scene (§45.45): "scene" is the whole side or top view; the others look from inside or behind the
 * driver's car, or down the road. */
export type ShotId = "scene" | "driver_view" | "face" | "side_window" | "mirror" | "speed_dial" | "pedals" | "road_behind" | "road_wide";

/** A cut to another shot at `at` seconds from the scene's start; the action and sound go on. */
export interface ShotCue {
  at: number;
  shot: ShotId;
  /** whose face or whose car; default the scene's driver */
  who?: CastId;
}

/** Speech bubbles hold symbols only, never words: Lamo Stories has no voice-over and no spoken lines. */
export type BubbleId = "question" | "exclaim" | "idea" | "music" | "dots" | "heart" | "angry" | "sweat" | "zzz";

/** Non-verbal character noises (synthesized in the character's pitch). */
export type NoiseId = "gasp" | "whoa" | "hmm" | "yay" | "oops" | "laugh" | "giggle" | "sigh" | "yelp" | "phew" | "babble";

export type SfxId =
  | "whoosh"
  | "skid"
  | "screech"
  | "tyre_burst"
  | "thud"
  | "bump"
  | "honk"
  | "engine"
  | "brake_squeal"
  | "pop"
  | "boing"
  | "ding"
  | "tada"
  | "sad_trombone"
  | "footsteps"
  | "wind"
  | "rain"
  | "snow_crunch"
  | "click"
  | "beep"
  | "swoosh_up"
  | "heartbeat"
  | "tick";

export type MusicMood = "none" | "calm" | "playful" | "tense" | "triumphant" | "wonder" | "comedic";

export interface CharacterVoice {
  style: "babble" | "hum" | "none";
  /** 0.5..2 */
  pitch: number;
  /** ≤ 8 */
  noises: NoiseId[];
  /** ≤ 8 */
  sfx: SfxId[];
}

export type CastId = string;

export interface CastMember {
  characterId: string;
  name: string;
  look: CharacterLook;
  movementStyle: MovementStyle;
  voice: CharacterVoice;
  /** The character's own faces, copied from it (CONTRACTS §45.34). When it is there, its beats may use only these
   * faces and only the noises of `voice.noises`; a cast copied before it existed (old scripts) has none. */
  expressions?: Expression[];
}

/** A car of the cast (§45.42): never an actor; a car prop whose castId names it is drawn as it. */
export interface CarMember {
  characterId: string;
  name: string;
  car: CarLook;
  movementStyle: MovementStyle;
  /** always style "none" and noises [] */
  voice: CharacterVoice;
  /** ["neutral"] without a face; at least 3, neutral among them, with one */
  expressions?: Expression[];
}

/** The shape of a video (CONTRACTS §45.34). 9:16 is the default: Shorts, Reels and TikTok want it. */
export type VideoAspect = "9:16" | "1:1" | "16:9";
/** The six sizes, width × height; each belongs to one shape. */
export type VideoResolution = "1080x1920" | "720x1280" | "1080x1080" | "720x720" | "1920x1080" | "1280x720";
export type FrameWidth = 1080 | 720 | 1920 | 1280;
export type FrameHeight = 1920 | 1280 | 1080 | 720;

/** One size a video can have (`cli.ts catalog` lists them as `formats`). */
export interface VideoFormat {
  aspect: VideoAspect;
  resolution: VideoResolution;
  width: FrameWidth;
  height: FrameHeight;
  /** plain words for the owner */
  label: string;
  /** where on-screen text stays (captions, teaching text, the end card), output pixels: clear of the platforms'
   * buttons and tabs in 9:16, a centred band in 1:1 and 16:9 */
  safe: { left: number; top: number; right: number; bottom: number };
}

/** One face or noise `repairScript` changed (CONTRACTS §45.34): what it was, what it is now (null: left out). */
export interface ScriptRepair {
  sceneId: string;
  /** the beat's place in its scene's beats, from 0 */
  beat: number;
  castId: string;
  field: "face" | "noise";
  was: string;
  now: string | null;
  /** one plain sentence for the job's log */
  text: string;
}

export interface SceneActor {
  castId: CastId;
  /** 0..1 of the frame */
  x: number;
  y: number;
  facing: "left" | "right";
  /** a prop id of a car or truck in this scene */
  inCar?: string;
}

export interface SceneProp {
  propId: string;
  kind: PropKind;
  x: number;
  y: number;
  scale: number;
  /** degrees */
  rot: number;
  color?: Hex;
  state?: string;
  /** a key of script.cars, on kind "car" only: drawn as that car, `color` ignored */
  castId?: CastId;
}

export interface Beat {
  /** seconds from the scene's start */
  at: number;
  dur: number;
  /** a cast id, or a prop id of this scene (a car of the cast is reached by its prop id) */
  who: string;
  do: ActionId | PropAction;
  face?: Expression;
  to?: { x: number; y: number };
  dir?: "left" | "right";
  bubble?: BubbleId;
  noise?: NoiseId;
  /** Only in the writer's raw answer: normalizeScript() moves it into the scene's `sfx` list. */
  sfx?: SfxId;
}

export interface Scene {
  sceneId: string;
  /** ≤ 40 */
  title: string;
  /** 2..15 */
  durationSec: number;
  /** this scene's own seed (a "Remake this scene" gets a new one); falls back to the script's seed */
  seed?: number;
  set: SetId;
  /** top: a road seen from above, for showing how a car moves */
  view: "side" | "top";
  camera: CameraId;
  actors: SceneActor[];
  props: SceneProp[];
  beats: Beat[];
  /** this scene's editable effects, times from the scene's start (normalizeScript fills it from the beats) */
  sfx: SfxCue[];
  /** ≤ 60: on-screen teaching text */
  caption: string | null;
  note: string | null;
  /** ≤ 8 cuts between shots (§45.45), sorted, at least 0.6 s apart; missing: the whole scene all the way */
  cuts?: ShotCue[];
}

export interface CaptionCue {
  id: string;
  /** seconds, whole video */
  at: number;
  dur: number;
  /** ≤ 60 */
  text: string;
  /** a guidance step id (safety stories) */
  guidanceRef?: string;
}

export interface SfxCue {
  /** "{sceneId}.fx{k}" for the writer's effects; any unique id for the owner's */
  id: string;
  /** seconds from the scene's start */
  at: number;
  sfx: SfxId;
  /** 0..1 */
  volume: number;
}

export interface Citation {
  publisher: string;
  title: string;
  url: string;
  section?: string;
}

export interface StoryScript {
  engine: number;
  fps: 30;
  /** one of the six sizes (VideoFormat; CONTRACTS §45.34): 1080 × 1920 unless the story picked another shape */
  width: FrameWidth;
  height: FrameHeight;
  durationSec: number;
  title: string;
  seed: number;
  cast: Record<CastId, CastMember>;
  /** the cast's cars by cast id (never the same id as a `cast` key); missing in older scripts */
  cars?: Record<CastId, CarMember>;
  scenes: Scene[];
  music: { mood: MusicMood; volume: number } | null;
  captionsOn: boolean;
  captions: CaptionCue[];
  safety: { topicId: string; citations: Citation[] } | null;
  /** the drawing style (§45.45); missing: "classic", as every script before it */
  art?: ArtStyle;
}

/** One draw instruction in output pixels (0..width × 0..height of the script, 1080 × 1920 by default), painter's
 * order, source-over blending. */
export type Prim =
  | { k: "fill"; color: Hex }
  | { k: "grad"; x0: number; y0: number; x1: number; y1: number; stops: [number, Hex][] }
  | { k: "rect"; x: number; y: number; w: number; h: number; r: number; color: Hex; a?: number }
  | { k: "circle"; x: number; y: number; r: number; color: Hex; a?: number }
  | { k: "ellipse"; x: number; y: number; rx: number; ry: number; rot: number; color: Hex; a?: number }
  | { k: "poly"; pts: number[]; color: Hex; a?: number }
  | { k: "line"; pts: number[]; w: number; color: Hex; a?: number }
  | { k: "image"; asset: string; x: number; y: number; w: number; h: number; a?: number };

/** Text drawn over the video (captions and bubble symbols): the browser draws it, the agent writes it as ASS. */
export interface TextEvent {
  start: number;
  end: number;
  kind: "caption" | "bubble" | "endcard";
  text: string;
  /** centre, output pixels */
  x: number;
  y: number;
  /** px */
  size: number;
  color: Hex;
}

/** One sound to synthesize: an effect or a character noise, at an absolute time. */
export interface AudioEvent {
  at: number;
  kind: "sfx" | "noise";
  id: SfxId | NoiseId;
  volume: number;
  /** noises: the character's voice pitch (0.5..2) */
  pitch?: number;
  /** seconds; effects that loop (engine, wind, rain) */
  dur?: number;
  /** -1 (left) .. 1 (right) */
  pan?: number;
  /** noises: how the character makes it (CONTRACTS §45.34): "hum" is closed-mouth humming, "babble" an open voice */
  voice?: "babble" | "hum";
}

export interface CatalogEntry<T extends string> {
  id: T;
  label: string;
}

/** The look and voice choices of a character (CONTRACTS §45.33): the character agent's vocabulary. */
export interface LookCatalog {
  body: CatalogEntry<CharacterLook["body"]>[];
  hair: CatalogEntry<CharacterLook["hair"]["style"]>[];
  eyes: CatalogEntry<CharacterLook["eyes"]["shape"]>[];
  brows: CatalogEntry<CharacterLook["brows"]>[];
  nose: CatalogEntry<CharacterLook["nose"]>[];
  mouth: CatalogEntry<CharacterLook["mouth"]>[];
  pattern: CatalogEntry<CharacterLook["outfit"]["pattern"]>[];
  accessory: CatalogEntry<CharacterLook["accessory"]>[];
  voiceStyle: CatalogEntry<CharacterVoice["style"]>[];
}

export interface CarLookCatalog {
  body: CatalogEntry<CarBody>[];
  pattern: CatalogEntry<CarLook["pattern"]>[];
  windows: CatalogEntry<CarLook["windows"]>[];
  wheels: CatalogEntry<CarLook["wheels"]["style"]>[];
  frontLights: CatalogEntry<CarLook["lights"]["front"]>[];
  rearLights: CatalogEntry<CarLook["lights"]["rear"]>[];
  extra: CatalogEntry<CarLook["extra"]>[];
  eyes: CatalogEntry<CarLook["face"]["eyes"]>[];
  mouth: CatalogEntry<CarLook["face"]["mouth"]>[];
}

export interface Catalog {
  looks: LookCatalog;
  carLooks: CarLookCatalog;
  actions: CatalogEntry<ActionId>[];
  propActions: CatalogEntry<PropAction>[];
  sets: CatalogEntry<SetId>[];
  props: CatalogEntry<PropKind>[];
  cameras: CatalogEntry<CameraId>[];
  bubbles: CatalogEntry<BubbleId>[];
  noises: CatalogEntry<NoiseId>[];
  sfx: CatalogEntry<SfxId>[];
  expressions: CatalogEntry<Expression>[];
  movementStyles: CatalogEntry<MovementStyle>[];
  musicMoods: CatalogEntry<MusicMood>[];
  /** the drawing styles (§45.45), the default for new videos first */
  arts: CatalogEntry<ArtStyle>[];
  shots: CatalogEntry<ShotId>[];
}

export type ValidateResult = { ok: true; script: StoryScript } | { ok: false; errors: string[] };
