// A video's shape and size (docs/CONTRACTS.md §45.34 "Video size and shape"): tall 9:16 (what Shorts, Reels and TikTok
// want, the default), square 1:1 or wide 16:9, each in two sizes. Production › New starts from the workspace's own
// video setting (Settings › Video) and can change it for one video; the story then keeps it as `format`.
import type { StoriesConfig, StoryFormat } from "../api/types.ts";
import { Pick } from "./kit.tsx";

type Aspect = StoryFormat["aspect"];

/** Each shape's sizes, the sharpest first (the resolution must match the aspect). */
export const SHAPE_SIZES: Record<Aspect, [number, number][]> = {
  "9:16": [
    [1080, 1920],
    [720, 1280],
  ],
  "1:1": [
    [1080, 1080],
    [720, 720],
  ],
  "16:9": [
    [1920, 1080],
    [1280, 720],
  ],
};

export const SHAPE_WORD: Record<Aspect, string> = { "9:16": "Tall", "1:1": "Square", "16:9": "Wide" };

const SHAPE_LINE: Record<Aspect, string> = {
  "9:16": "9:16. Shorts, Reels and TikTok want this.",
  "1:1": "1:1. For feeds.",
  "16:9": "16:9. For YouTube on a computer or a TV.",
};

export const VERTICAL: StoryFormat = { aspect: "9:16", width: 1080, height: 1920 };

/** The workspace's own shape (StoriesConfig.video: aspect and resolution), or tall 1080 × 1920. */
export function formatOf(cfg: Partial<StoriesConfig> | null | undefined): StoryFormat {
  const v = (cfg?.video ?? {}) as { aspect?: string; resolution?: string };
  const aspect = v.aspect as Aspect | undefined;
  const [w, h] = (v.resolution ?? "").split("x").map(Number);
  if (aspect && SHAPE_SIZES[aspect]?.some(([a, b]) => a === w && b === h)) return { aspect, width: w!, height: h! };
  return { ...VERTICAL };
}

export function sameFormat(a: StoryFormat, b: StoryFormat): boolean {
  return a.aspect === b.aspect && a.width === b.width && a.height === b.height;
}

/** "Tall (9:16), 1080 × 1920". */
export function formatWords(f: StoryFormat | null | undefined): string {
  const x = f ?? VERTICAL;
  return `${SHAPE_WORD[x.aspect] ?? x.aspect} (${x.aspect}), ${x.width} × ${x.height}`;
}

/**
 * The shape picker of Production › New: the shape, then its size (both on <Glide> pick bars).
 * `usualKnown`: Settings › Video has loaded (until then `usual` is only the tall default, and nothing picked means the
 * workspace's own shape is used); `picked`: the owner chose this video's shape here.
 */
export function ShapePicker({ value, onChange, usual, usualKnown = true, picked = false }: { value: StoryFormat; onChange: (f: StoryFormat) => void; usual: StoryFormat; usualKnown?: boolean; picked?: boolean }) {
  const sizes = SHAPE_SIZES[value.aspect];
  return (
    <div className="st-s-shape">
      <Pick
        label="Shape"
        big
        value={value.aspect}
        options={(Object.keys(SHAPE_SIZES) as Aspect[]).map((a) => ({
          value: a,
          label: SHAPE_WORD[a],
          line: SHAPE_LINE[a],
          art: <span className={`st-s-shape__art st-s-shape__art--${a === "9:16" ? "tall" : a === "1:1" ? "square" : "wide"}`} aria-hidden="true" />,
        }))}
        onChange={(aspect) => {
          // The workspace's own size when it is this shape, else the sharpest one.
          const [w, h] = usual.aspect === aspect ? [usual.width, usual.height] : SHAPE_SIZES[aspect][0]!;
          onChange({ aspect, width: w, height: h });
        }}
        className="st-s-shapepick"
      />
      <Pick
        label="Size"
        value={`${value.width}x${value.height}`}
        options={sizes.map(([w, h], i) => ({ value: `${w}x${h}`, label: `${w} × ${h}`, line: i === 0 ? "The sharpest" : "A smaller file" }))}
        onChange={(v) => {
          const [w, h] = v.split("x").map(Number);
          onChange({ aspect: value.aspect, width: w!, height: h! });
        }}
      />
      <p className="st-s-field__hint">
        {!usualKnown && !picked ? "Your usual shape from Settings › Video is used, unless you pick one here." : usualKnown && sameFormat(value, usual) ? "From Settings › Video." : "Just for this video. Settings › Video stays the same."}
      </p>
    </div>
  );
}
