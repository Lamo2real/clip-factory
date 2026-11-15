import { usePrefs } from "../lib/prefs.ts";

/**
 * What the glass refracts: a slow sage, off-white and tomato mesh, or the owner's own picture.
 * Glass needs something varied behind it; over a flat colour it would read as a grey sheet.
 */
export function Backdrop() {
  const { background } = usePrefs();
  return (
    <div className={`backdrop${background ? " has-image" : ""}`} aria-hidden="true">
      {background ? (
        <div className="backdrop__image" style={{ backgroundImage: `url("${background}")` }} />
      ) : (
        <>
          <span className="blob blob--a" />
          <span className="blob blob--b" />
          <span className="blob blob--c" />
          <span className="blob blob--d" />
          <span className="backdrop__grain" />
        </>
      )}
    </div>
  );
}

/** The refraction filter (Chromium uses it inside backdrop-filter; other browsers fall back to blur). */
export function GlassFilter() {
  return (
    <svg className="glass-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <filter id="cf-refract" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.008 0.012" numOctaves="2" seed="7" result="noise" />
        <feGaussianBlur in="noise" stdDeviation="2.5" result="soft" />
        <feDisplacementMap in="SourceGraphic" in2="soft" scale="34" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
