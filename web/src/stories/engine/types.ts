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
  | "gasp";

export type PropAction = "move" | "skid" | "spin" | "stop" | "bump" | "tyre_burst" | "appear" | "vanish" | "wobble" | "flash";

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
  | "park";

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
}

export interface Beat {
  /** seconds from the scene's start */
  at: number;
  dur: number;
  /** a cast id or a prop id of this scene */
  who: string;
  do: ActionId | PropAction;
  face?: Expression;
  to?: { x: number; y: number };
  dir?: "left" | "right";
  bubble?: BubbleId;
  noise?: NoiseId;
  sfx?: SfxId;
}

export interface Scene {
  sceneId: string;
  /** ≤ 40 */
  title: string;
  /** 2..15 */
  durationSec: number;
  set: SetId;
  /** top: a road seen from above, for showing how a car moves */
  view: "side" | "top";
  camera: CameraId;
  actors: SceneActor[];
  props: SceneProp[];
  beats: Beat[];
  /** ≤ 60: on-screen teaching text */
  caption: string | null;
  note: string | null;
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
  id: string;
  /** seconds, whole video */
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
  width: 1080;
  height: 1920;
  durationSec: number;
  title: string;
  seed: number;
  cast: Record<CastId, CastMember>;
  scenes: Scene[];
  music: { mood: MusicMood; volume: number } | null;
  captionsOn: boolean;
  captions: CaptionCue[];
  /** owner-added effects; effects named on beats come from audioTrack() */
  sfx: SfxCue[];
  safety: { topicId: string; citations: Citation[] } | null;
}

/** One draw instruction in output pixels (0..1080 × 0..1920), painter's order, source-over blending. */
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
}

export interface CatalogEntry<T extends string> {
  id: T;
  label: string;
}

export interface Catalog {
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
}

export type ValidateResult = { ok: true; script: StoryScript } | { ok: false; errors: string[] };
