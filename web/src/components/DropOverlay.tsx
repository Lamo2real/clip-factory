// What a drop zone shows (docs/CONTRACTS.md §45.40.1): nothing at rest; while something is dragged over the zone, a
// glass layer over it (an element zone) or over the window (a page zone) with one glass pill in its middle: one big
// icon and the words. A refused drop turns the pill coral with an X and the one short line; it shakes three times
// (not with reduced motion) and fades after 1.6 s. The layer never takes the pointer, and is hidden from screen
// readers: they hear the refusal from the status line that is always there.
//
// The layout and motion are styles/drop.css; the look is the app's own glass: Clip Factory's green glass
// (drop-layer--clips, drop.css), or Clips Funded's (st-drop, stories/styles/st-drop.css). An element zone gets the
// class `drop-host` (position: relative) and has this inside it; a page zone's layer is portalled to `host`.
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DropScope, FileDrop } from "../lib/useFileDrop.ts";
import { Icon } from "./Icon.tsx";

/** How long a refused drop keeps its pill on screen (drop.css fades it over its last 240 ms). */
export const REFUSED_SHOW_MS = 1600;
/** The busy line when the zone gives none of its own. */
export const BUSY_WORDS = "Wait a moment.";

export function DropOverlay(props: {
  drop: FileDrop;
  scope: DropScope;
  words: { file: string; link?: string; either?: string; busy?: string };
  /** The app's glass: "clips" draws class drop-layer--clips (green glass), "stories" draws class st-drop (st-drop.css). */
  look?: "clips" | "stories";
  icon?: ReactNode; // one big icon; default: the upload arrow
  /** Page scope only: where the layer is portalled. Default document.body. Clips Funded passes its .stories-app root so its --st-* tokens apply. */
  host?: Element | null;
}) {
  const { drop, scope, words, look = "clips", icon, host } = props;
  // The refusal whose pill has had its 1.6 s (its line stays in the status line until the hook clears it).
  const [gone, setGone] = useState(0);
  useEffect(() => {
    if (!drop.refusals) return;
    const n = drop.refusals;
    const t = setTimeout(() => setGone(n), REFUSED_SHOW_MS);
    return () => clearTimeout(t);
  }, [drop.refusals]);

  const refusedNow = drop.over === null && drop.refused !== null && gone !== drop.refusals;
  const mode = drop.over ?? (refusedNow ? "refused" : null);
  const say =
    mode === "refused"
      ? drop.refused
      : mode === "busy"
        ? (words.busy ?? BUSY_WORDS)
        : mode === "link"
          ? (words.link ?? words.file)
          : mode === "either"
            ? (words.either ?? words.file)
            : words.file;

  const layer = mode ? (
    <div
      // A new refusal is a new layer, so its shake and fade start again.
      key={mode === "refused" ? `refused-${drop.refusals}` : "over"}
      className={`drop-layer drop-layer--${scope} ${look === "stories" ? "st-drop" : "drop-layer--clips"} is-${mode}`}
      aria-hidden="true"
    >
      <div className="drop-layer__pill">
        <span className="drop-layer__icon">{mode === "refused" ? <Icon name="x" size={40} /> : (icon ?? <Icon name="upload" size={40} />)}</span>
        <span className="drop-layer__words">{say}</span>
      </div>
    </div>
  ) : null;
  const status = (
    <span className="sr-only" role="status">
      {drop.refused ?? ""}
    </span>
  );

  if (scope === "page") {
    const to = host ?? (typeof document !== "undefined" ? document.body : null);
    return to
      ? createPortal(
          <>
            {layer}
            {status}
          </>,
          to,
        )
      : null;
  }
  return (
    <>
      {layer}
      {status}
    </>
  );
}
