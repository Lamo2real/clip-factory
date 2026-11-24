import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { usePictureTop, useStatusBar } from "../app/statusBar.ts";
import type { Look } from "../lib/background.ts";
import { applyLook, useLook } from "../lib/look.ts";

/** How far the owner's picture runs past the window on every side (glass.css .backdrop__image: inset -2 %). */
export const PICTURE_BLEED = 0.02;

/**
 * What the glass refracts (§22): the desktop behind the window (see-through in the desktop app), the living Clip
 * Factory backdrop that slowly moves (see-through anywhere else: deep teal, two vermilion glows, leaf, a breath of
 * bone and two soft lenses), the owner's own picture, or their 1 to 3 colours.
 * Glass needs something varied behind it; over a flat colour it would read as a grey sheet.
 *
 * `away`: the application shell shows the other app (app/ClipsBackdrop.tsx). The backdrop stays the same element, is
 * not drawn and its drift waits (glass.css .backdrop--away), so back on screen it is exactly where the owner left it.
 * Without it (always, while Clips Funded is switched off) the backdrop is exactly as it always was.
 *
 * Under a phone's status bar (app/statusBar.ts, §11.1) the same backdrop is drawn once more, over the page, in the
 * status bar alone (glass.css .backdrop--cover): what scrolls up to the clock fades into the backdrop, and nothing
 * fixed and coloured lies across the top. It is drawn with the backdrop, in the same frame, so their drift is one;
 * the shade under the clock (.backdrop__shade, only where the look's top edge is too light for the white clock) is
 * part of both.
 */
export function Backdrop({ away = false }: { away?: boolean }) {
  const look = useLook();
  const bar = useStatusBar();
  // The owner's picture under the clock, read from its own pixels (planned for white until it is).
  const pictureTop = usePictureTop(look.kind === "picture" ? look.url : null, PICTURE_BLEED);
  useLayoutEffect(() => applyLook(look, document.documentElement, pictureTop), [look, pictureTop]);
  const covered = bar.h > 0 && look.kind !== "window";
  const drawnRef = useRef<HTMLDivElement>(null);
  const coverRef = useRef<HTMLDivElement>(null);
  // A cover that comes later than the backdrop (a phone turned upright) takes up its drift where the backdrop is.
  useLayoutEffect(() => {
    if (covered && drawnRef.current && coverRef.current) driftTogether(drawnRef.current, coverRef.current);
  }, [covered]);
  return (
    <>
      {drawn(look, away, drawnRef, false)}
      {covered ? drawn(look, away, coverRef, true) : null}
    </>
  );
}

/** One backdrop: the page's (`cover` false), or its cover under the status bar. */
function drawn(look: Look, away: boolean, ref: RefObject<HTMLDivElement | null>, cover: boolean) {
  const cls = (name: string) => `${name}${cover ? " backdrop--cover" : ""}${away ? " backdrop--away" : ""}`;
  if (look.kind === "window") {
    // The page is transparent. The veil here is empty for Clear and a light frost for Frosted; the tint that keeps
    // text readable sits on the panels (glass.css), so the desktop stays guessable between them.
    return (
      <div ref={ref} className={cls("backdrop backdrop--window")} aria-hidden="true">
        <span className="backdrop__veil" />
      </div>
    );
  }
  if (look.kind === "picture") {
    return (
      <div ref={ref} className={cls("backdrop has-image")} aria-hidden="true">
        <div className="backdrop__image" style={{ backgroundImage: `url("${look.url}")` }} />
        <span className="backdrop__shade" />
      </div>
    );
  }
  if (look.kind === "colours") {
    const [c1, c2 = c1, c3 = c2] = look.colours;
    const style = { "--c1": c1, "--c2": c2, "--c3": c3 } as CSSProperties;
    return (
      <div ref={ref} className={cls("backdrop backdrop--colours")} style={style} aria-hidden="true" data-colours={look.colours.join(" ")}>
        <span className="blob blob--a" />
        <span className="blob blob--b" />
        <span className="blob blob--c" />
        <span className="blob blob--d" />
        <span className="blob blob--e" />
        <span className="backdrop__veil" />
        <span className="backdrop__shade" />
      </div>
    );
  }
  return (
    <div ref={ref} className={cls(`backdrop${look.kind === "frosted" ? " backdrop--frosted" : ""}`)} aria-hidden="true">
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
      <span className="backdrop__shade" />
    </div>
  );
}

/**
 * Puts every drift of `cover` (its blobs, lens rings and caustics) where the same one of `backdrop` is: the two are
 * the same elements in the same order, so their animations pair up one to one. Only the time moves: a drift that waits
 * (away) keeps waiting.
 */
export function driftTogether(backdrop: Element, cover: Element) {
  if (typeof backdrop.getAnimations !== "function") return;
  const from = backdrop.getAnimations({ subtree: true });
  const to = cover.getAnimations({ subtree: true });
  if (from.length !== to.length) return;
  to.forEach((a, i) => {
    const t = from[i]!.currentTime;
    if (t !== null) a.currentTime = t;
  });
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
