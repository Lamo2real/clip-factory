// The drawing style the live previews draw in (docs/CONTRACTS.md §45.45): the Stories app reads the workspace's own
// (Settings › Video, Night drive unless the owner picked Bright) and hands it to every character, car and cast preview
// below it. With no provider a preview draws Bright ("classic"), as before drawing styles.
import { createContext, useContext, type ReactNode } from "react";
import type { ArtStyle } from "../engine/types.ts";

const ArtContext = createContext<ArtStyle>("classic");

/** The drawing style for every preview inside it. */
export function ArtProvider({ art, children }: { art: ArtStyle; children: ReactNode }) {
  return <ArtContext.Provider value={art}>{children}</ArtContext.Provider>;
}

/** The drawing style the previews here draw in: the nearest ArtProvider's, else Bright. */
export function useArt(): ArtStyle {
  return useContext(ArtContext);
}

/** Said by Settings › Video the moment the owner picks another drawing style, so the open app's previews follow. */
export const ART_PICKED = "st-art-picked";

/** Tells the open app's previews that this workspace now draws new videos in `art`. */
export function sayArtPicked(ws: string, art: ArtStyle): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ART_PICKED, { detail: { ws, art } }));
}
