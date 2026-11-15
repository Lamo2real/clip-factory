import { useLiveStatus } from "../lib/live.ts";

/**
 * A small, calm sign that the app is connected and changes show up by themselves. It only appears while connected:
 * a dropped connection simply hides it (the app quietly reconnects), so there is never anything to worry about.
 */
export function LiveDot({ compact = false }: { compact?: boolean }) {
  const status = useLiveStatus();
  if (status !== "live") return null;
  return (
    <span className={`live-dot glass${compact ? " live-dot--compact" : ""}`} title="Live: changes show up by themselves">
      <span className="live-dot__light" aria-hidden="true" />
      <span className={compact ? "sr-only" : "live-dot__label"}>Live</span>
      <span className="sr-only">: changes show up by themselves</span>
    </span>
  );
}
