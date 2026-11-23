// Funded Clips' logo (the owner, 22 Nov 2026: "the same logo as clip factory but with the colors in clip factory
// stories"): Clip Factory's own mark, the very same markup (ClipMark.tsx), recoloured by four tokens (--ws-mark-tile,
// --ws-mark-letter, --ws-mark-dot and --ws-wordmark, styles/ws-mark.css), beside the wordmark "Funded Clips" in Clip
// Factory's wordmark type. It is an element of the shell: Funded Clips' rail and phone top bar, the start-up card
// while Funded Clips' own code loads (app/App.tsx) and the shell's round toggle that goes to Funded Clips
// (app/WorkspaceDock.tsx) all show it, in Funded Clips' warm colours everywhere (its own stylesheet sets the four
// tokens inside its app, and the very same colours are the fallbacks outside it). So it lives here, its styles are in
// the main stylesheet, and it carries no code of Funded Clips itself. The round toggle that goes back to Clip Factory
// shows Clip Factory's real mark, the same small mark in Clip Factory's own colours (`workspace="clips"`).
import "../styles/ws-mark.css";
import type { CSSProperties } from "react";
import { ClipMark } from "./ClipMark.tsx";

/** The second app's name, as a person reads it everywhere. */
export const STORIES_BRAND = "Funded Clips";

/**
 * The mark: Clip Factory's "C" tile with its dot, in Funded Clips' colours. `boot` is the start-up card's big
 * breathing one. `size` draws it smaller, in proportion, for the shell's round workspace toggle: the same "C" and dot,
 * but without Clip Factory's brand__ classes, so the top bar where that toggle sits still has one brand mark, its own.
 * `workspace="clips"` (with `size`) is Clip Factory's own mark at that size, in Clip Factory's own colours: the round
 * toggle that goes back to Clip Factory.
 */
export function WorkspaceMark({ boot = false, size, className, workspace = "stories" }: { boot?: boolean; size?: number; className?: string; workspace?: "clips" | "stories" }) {
  if (size)
    return (
      <span
        className={`${workspace === "clips" ? "ws-clipmark" : "ws-mark"} ws-mark--sized${className ? ` ${className}` : ""}`}
        style={{ "--ws-mark-size": `${size}px` } as CSSProperties}
        aria-hidden="true"
      >
        C<span className="ws-mark__dot" />
      </span>
    );
  return <ClipMark className={["ws-mark", boot ? "brand__mark--boot" : "", className ?? ""].filter(Boolean).join(" ")} />;
}

/**
 * The wordmark: "Funded *Clips*", in Clip Factory's wordmark type, coloured by --ws-wordmark: one line, exactly as
 * Clip Factory's own "Clip *Factory*", with "Clips" in its italic. A few px wider than Clip Factory's brand, it
 * still keeps its name in the rail and in a phone's top bar from 340 px (e2e/stories-shell.spec.ts).
 */
export function WorkspaceWordmark({ className }: { className?: string }) {
  return (
    <span className={`ws-wordmark${className ? ` ${className}` : ""}`}>
      <span className="ws-wordmark__main">
        Funded <em>Clips</em>
      </span>
    </span>
  );
}
