// Clip Stories' logo (the owner, 22 Nov 2026: "the same logo as clip factory but with the colors in clip factory
// stories"): Clip Factory's own mark, the very same markup (ClipMark.tsx), recoloured by four tokens (--ws-mark-tile,
// --ws-mark-letter, --ws-mark-dot and --ws-wordmark, styles/ws-mark.css), beside the wordmark "Clip Stories" in Clip
// Factory's wordmark type. It is an element of the shell: Clip Stories' rail and phone top bar, the start-up card
// while Clip Stories' own code loads (app/App.tsx) and the shell's round toggle that goes to Clip Stories
// (app/WorkspaceDock.tsx) all show it. So it lives here, its styles are in the main stylesheet, and it carries no
// look of Clip Stories itself: Clip Stories' own stylesheet sets the four tokens, and until it does each falls back
// to today's colours. The round toggle that goes back to Clip Factory keeps Clip Factory's own mark.
import "../styles/ws-mark.css";
import type { CSSProperties } from "react";
import { ClipMark } from "./ClipMark.tsx";

/** The second app's name, as a person reads it everywhere. */
export const STORIES_BRAND = "Clip Stories";

/**
 * The mark: Clip Factory's "C" tile with its dot, in Clip Stories' colours. `boot` is the start-up card's big
 * breathing one. `size` draws it smaller, in proportion, for the shell's round workspace toggle: the same "C" and dot,
 * but without Clip Factory's brand__ classes, so Clip Factory's top bar (where that toggle sits) still has one brand
 * mark, its own.
 */
export function WorkspaceMark({ boot = false, size, className }: { boot?: boolean; size?: number; className?: string }) {
  if (size)
    return (
      <span className={`ws-mark ws-mark--sized${className ? ` ${className}` : ""}`} style={{ "--ws-mark-size": `${size}px` } as CSSProperties} aria-hidden="true">
        C<span className="ws-mark__dot" />
      </span>
    );
  return <ClipMark className={["ws-mark", boot ? "brand__mark--boot" : "", className ?? ""].filter(Boolean).join(" ")} />;
}

/**
 * The wordmark: "Clip *Stories*", in Clip Factory's wordmark type, coloured by --ws-wordmark: one line, exactly as
 * Clip Factory's own "Clip *Factory*", with "Stories" in its italic. No wider than Clip Factory's brand, so it keeps
 * its name in the rail and in a phone's top bar wherever Clip Factory's does.
 */
export function WorkspaceWordmark({ className }: { className?: string }) {
  return (
    <span className={`ws-wordmark${className ? ` ${className}` : ""}`}>
      <span className="ws-wordmark__main">
        Clip <em>Stories</em>
      </span>
    </span>
  );
}
