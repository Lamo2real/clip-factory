// Clip Factory Stories' logo (the owner, 22 Nov 2026: "the same logo as clip factory but with the colors in clip
// factory stories"): Clip Factory's own mark, the very same markup (components/ClipMark.tsx), recoloured by four
// Stories tokens (--st-mark-tile, --st-mark-letter, --st-mark-dot and --st-wordmark, styles/st-mark.css), beside the
// wordmark "Clip Factory Stories" in Clip Factory's wordmark type. The rail, the phone top bar (also over the first
// setup), the start-up card while Stories' own code loads (App.tsx) and the shell's round toggle that goes to Stories
// all show it. The round toggle that goes back to Clip Factory keeps Clip Factory's own mark.
import "../styles/st-mark.css";
import type { CSSProperties } from "react";
import { ClipMark } from "../../components/ClipMark.tsx";

/** The app's name, as a person reads it everywhere. */
export const STORIES_BRAND = "Clip Factory Stories";

/**
 * The mark: Clip Factory's "C" tile with its dot, in Stories' colours. `boot` is the start-up card's big breathing one.
 * `size` draws it smaller, in proportion, for the shell's round workspace toggle: the same "C" and dot, but without
 * Clip Factory's brand__ classes, so Clip Factory's top bar (where that toggle sits) still has one brand mark, its own.
 */
export function StoriesMark({ boot = false, size, className }: { boot?: boolean; size?: number; className?: string }) {
  if (size)
    return (
      <span className={`st-mark st-mark--sized${className ? ` ${className}` : ""}`} style={{ "--st-mark-size": `${size}px` } as CSSProperties} aria-hidden="true">
        C<span className="st-mark__dot" />
      </span>
    );
  return <ClipMark className={["st-mark", boot ? "brand__mark--boot" : "", className ?? ""].filter(Boolean).join(" ")} />;
}

/**
 * The wordmark: "Clip Factory Stories", in Clip Factory's wordmark type, coloured by --st-wordmark. "Clip *Factory*"
 * exactly as Clip Factory's own, with "Stories" under it: as wide as Clip Factory's brand, so it keeps its name in the
 * rail and in a phone's top bar wherever Clip Factory's does.
 */
export function StoriesWordmark({ className }: { className?: string }) {
  return (
    <span className={`st-wordmark${className ? ` ${className}` : ""}`}>
      <span className="st-wordmark__main">
        Clip <em>Factory</em>
      </span>{" "}
      <span className="st-wordmark__sub">Stories</span>
    </span>
  );
}
