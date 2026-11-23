import { useLayoutEffect, type CSSProperties } from "react";
import { applyLook, useLook } from "../lib/look.ts";

/**
 * What the glass refracts (§22): the desktop behind the window (see-through in the desktop app), the living Clip
 * Factory backdrop that slowly moves (see-through anywhere else: deep teal, two vermilion glows, leaf, a breath of
 * bone and two soft lenses), the owner's own picture, or their 1 to 3 colours.
 * Glass needs something varied behind it; over a flat colour it would read as a grey sheet.
 *
 * `away`: the application shell shows the other app (app/ClipsBackdrop.tsx). The backdrop stays the same element, is
 * not drawn and its drift waits (glass.css .backdrop--away), so back on screen it is exactly where the owner left it.
 * Without it (always, while Clips Funded is switched off) the backdrop is exactly as it always was.
 */
export function Backdrop({ away = false }: { away?: boolean }) {
  const look = useLook();
  useLayoutEffect(() => applyLook(look), [look]);
  const cls = (name: string) => (away ? `${name} backdrop--away` : name);

  if (look.kind === "window") {
    // The page is transparent. The veil here is empty for Clear and a light frost for Frosted; the tint that keeps
    // text readable sits on the panels (glass.css), so the desktop stays guessable between them.
    return (
      <div className={cls("backdrop backdrop--window")} aria-hidden="true">
        <span className="backdrop__veil" />
      </div>
    );
  }
  if (look.kind === "picture") {
    return (
      <div className={cls("backdrop has-image")} aria-hidden="true">
        <div className="backdrop__image" style={{ backgroundImage: `url("${look.url}")` }} />
      </div>
    );
  }
  if (look.kind === "colours") {
    const [c1, c2 = c1, c3 = c2] = look.colours;
    const style = { "--c1": c1, "--c2": c2, "--c3": c3 } as CSSProperties;
    return (
      <div className={cls("backdrop backdrop--colours")} style={style} aria-hidden="true" data-colours={look.colours.join(" ")}>
        <span className="blob blob--a" />
        <span className="blob blob--b" />
        <span className="blob blob--c" />
        <span className="blob blob--d" />
        <span className="blob blob--e" />
        <span className="backdrop__veil" />
      </div>
    );
  }
  return (
    <div className={cls(`backdrop${look.kind === "frosted" ? " backdrop--frosted" : ""}`)} aria-hidden="true">
      <span className="blob blob--a" />
      <span className="blob blob--b" />
      <span className="blob blob--c" />
      <span className="blob blob--d" />
      <span className="blob blob--e" />
      {look.kind === "frosted" ? (
        <>
          <span className="backdrop__frost" />
          <span className="backdrop__caustic backdrop__caustic--a" />
          <span className="backdrop__caustic backdrop__caustic--b" />
        </>
      ) : null}
      <span className="backdrop__grain" />
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
