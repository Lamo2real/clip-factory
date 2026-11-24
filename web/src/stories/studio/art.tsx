// A video's drawing style (docs/CONTRACTS.md §45.45): Night drive (soft night colours, street lights and film-like
// close-ups, the default for new videos) or Bright (the bright, sunny cartoon look of the first videos). Settings ›
// Video sets the one new videos start with; Production › New can change it for one video, and the story keeps it as
// `art`. A story made before drawing styles has none and is drawn Bright.
import { useEffect, useState, type ReactNode } from "react";
import { storiesApi } from "../api/client.ts";
import { ART_STYLES, DEFAULT_ART, type ArtStyle, type StoriesConfig } from "../api/types.ts";
import { ART_PICKED, ArtProvider } from "../preview/art.tsx";
import { CharacterPreview } from "../preview/CharacterPreview.tsx";
import { Pick } from "./kit.tsx";
import { DEFAULT_LOOK } from "./looks.ts";

/** Each style's name and one line, in the order the picks show them (the default first). */
export const ART_WORDS: Record<ArtStyle, { label: string; line: string }> = {
  night_drive: { label: "Night drive", line: "Soft night colours, street lights and film-like close-ups." },
  classic: { label: "Bright", line: "The bright, sunny cartoon look of the first videos." },
};

export const isArt = (v: unknown): v is ArtStyle => typeof v === "string" && (ART_STYLES as string[]).includes(v);

/** The workspace's drawing style for new videos (Settings › Video), or Night drive when it has none yet. */
export function artOf(cfg: Partial<StoriesConfig> | null | undefined): ArtStyle {
  const art = (cfg?.video as { art?: unknown } | undefined)?.art;
  return isArt(art) ? art : DEFAULT_ART;
}

/** A story's drawing style: its own, else Bright (a story made before drawing styles). */
export function storyArt(story: { art?: unknown } | null | undefined): ArtStyle {
  return isArt(story?.art) ? story.art : "classic";
}

/** "Night drive" or "Bright". */
export function artWords(art: ArtStyle): string {
  return ART_WORDS[art].label;
}

/** A small still of a sample character drawn in a style, for a pick option. */
export function ArtSample({ art, size = 56 }: { art: ArtStyle; size?: number }) {
  return <CharacterPreview look={DEFAULT_LOOK} movementStyle="calm" expression="happy" size={size} playing={false} label={`A character drawn in ${artWords(art)}`} art={art} />;
}

/** The two styles as pick options with their sample pictures. */
export function artOptions(size = 56): { value: ArtStyle; label: string; line: string; art: ReactNode }[] {
  return ART_STYLES.map((a) => ({ value: a, label: ART_WORDS[a].label, line: ART_WORDS[a].line, art: <ArtSample art={a} size={size} /> }));
}

/**
 * The drawing style pick of Production › New, beside the shape. `usualKnown`: Settings › Video has loaded;
 * `picked`: the owner chose this video's style here.
 */
export function ArtPicker({ value, onChange, usual, usualKnown = true, picked = false }: { value: ArtStyle; onChange: (a: ArtStyle) => void; usual: ArtStyle; usualKnown?: boolean; picked?: boolean }) {
  return (
    <div className="st-s-art">
      <Pick label="Drawing style" value={value} options={artOptions()} onChange={onChange} className="st-s-artpick" />
      <p className="st-s-field__hint">
        {!usualKnown && !picked ? "Your usual drawing style from Settings › Video is used, unless you pick one here." : usualKnown && value === usual ? "From Settings › Video." : "Just for this video. Settings › Video stays the same."}
      </p>
    </div>
  );
}

/**
 * The workspace's drawing style for every preview inside it (the Stories app's pages): read once per workspace, and
 * again the moment Settings › Video picks another one. Night drive until it is read (the default for new videos).
 */
export function WorkspaceArt({ ws, children }: { ws: string; children: ReactNode }) {
  const [art, setArt] = useState<ArtStyle>(DEFAULT_ART);
  useEffect(() => {
    let live = true;
    try {
      Promise.resolve(storiesApi().getWorkspace(ws))
        .then((w) => {
          if (live && w) setArt(artOf(w.configuration as Partial<StoriesConfig>));
        })
        .catch(() => undefined);
    } catch {
      // no workspace to read: the default stays
    }
    const picked = (e: Event) => {
      const d = (e as CustomEvent<{ ws?: string; art?: unknown }>).detail;
      if (d?.ws === ws && isArt(d.art)) setArt(d.art);
    };
    window.addEventListener(ART_PICKED, picked);
    return () => {
      live = false;
      window.removeEventListener(ART_PICKED, picked);
    };
  }, [ws]);
  return <ArtProvider art={art}>{children}</ArtProvider>;
}
