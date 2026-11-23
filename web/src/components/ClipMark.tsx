// Clip Factory's mark: the italic "C" on its tile with the dot (.brand__mark and .brand__dot, styles/layout.css).
// One markup for both apps: Clip Factory draws it in its own colours, and Clips Funded draws the very same
// mark in its colours (WorkspaceMark.tsx adds the ws-mark class, whose tokens recolour it).
import type { CSSProperties } from "react";

/** The mark. `className` adds to brand__mark (brand__mark--boot for the start-up card, ws-mark for Clips Funded). */
export function ClipMark({ className, style }: { className?: string; style?: CSSProperties | undefined }) {
  return (
    <span className={className ? `brand__mark ${className}` : "brand__mark"} style={style} aria-hidden="true">
      C<span className="brand__dot" />
    </span>
  );
}
