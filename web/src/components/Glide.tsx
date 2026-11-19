import { useLayoutEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/prefs.ts";

/**
 * The sliding highlight behind the chosen option of a switch bar, tab row or the menu (docs/CONTRACTS.md §20.13).
 *
 * It sits as the first child of the bar (its parent element, which must be position: relative) and moves to whichever
 * child matches `active`: it slides there and stretches a little along the way, then settles without overshooting. It
 * is decoration only (aria-hidden), and the chosen item keeps its own aria state. Until the first measure the
 * container has no `has-glide` class, so the item paints its own static highlight; nothing is lost if this never runs.
 *
 * The slide is transform only (FLIP): the glide takes its new place and size at once, and one Web Animation on
 * `transform` carries it there from the old box (translate + scale, with the stretch folded in). Nothing animates its
 * width, height or position, so the browser runs the slide on the compositor (WebKit too), and a busy main thread,
 * such as a new page being drawn under the glass, cannot make it stutter.
 */

/** How long a slide takes, and its curve: a plain ease-out that never passes the target (no spring, no creep back). */
export const GLIDE_MS = 360;
export const GLIDE_EASE = [0.22, 1, 0.36, 1] as const;
/** The id of the slide's Web Animation, so tests can find it. */
export const GLIDE_ANIMATION_ID = "glide-slide";
/** Keyframes per slide: the curve is sampled this often and run linearly in between, which follows it within a pixel. */
const STEPS = 24;

export type Box = { x: number; y: number; width: number; height: number };

/** Solves a CSS cubic-bezier(x1, y1, x2, y2) for its progress at time t (0..1). */
export function cubicBezier([x1, y1, x2, y2]: readonly number[], t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const bx = (u: number) => 3 * u * (1 - u) * (1 - u) * x1! + 3 * u * u * (1 - u) * x2! + u * u * u;
  const by = (u: number) => 3 * u * (1 - u) * (1 - u) * y1! + 3 * u * u * (1 - u) * y2! + u * u * u;
  let lo = 0;
  let hi = 1;
  let u = t;
  for (let i = 0; i < 40; i++) {
    u = (lo + hi) / 2;
    if (bx(u) < t) lo = u;
    else hi = u;
  }
  return by(u);
}

/**
 * The slide's keyframes from `from` to `to`, as transforms of an element that already has `to`'s size and stands at
 * `to` (transform-origin 0 0), so the last keyframe is exactly its resting transform. Along the way it stretches along
 * its path and narrows across it (at most +9% / -7%, centred on where it is), and the stretch eases back to nothing
 * before it lands.
 */
export function slideFrames(from: Box, to: Box, axis: "x" | "y"): Keyframe[] {
  const stretch = Math.hypot(to.x - from.x, to.y - from.y) > 4 ? 1 : 0;
  const f = (n: number) => Number(n.toFixed(3));
  const frames: Keyframe[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const p = cubicBezier(GLIDE_EASE, t);
    const bump = stretch * Math.sin(Math.PI * Math.pow(t, 0.6)) ** 2;
    const along = 1 + 0.09 * bump;
    const across = 1 - 0.07 * bump;
    const w = (from.width + (to.width - from.width) * p) * (axis === "x" ? along : across);
    const h = (from.height + (to.height - from.height) * p) * (axis === "x" ? across : along);
    const cx = from.x + from.width / 2 + (to.x + to.width / 2 - (from.x + from.width / 2)) * p;
    const cy = from.y + from.height / 2 + (to.y + to.height / 2 - (from.y + from.height / 2)) * p;
    const sx = to.width ? w / to.width : 1;
    const sy = to.height ? h / to.height : 1;
    frames.push({ offset: t, transform: `translate(${f(cx - w / 2)}px, ${f(cy - h / 2)}px) scale(${f(sx)}, ${f(sy)})` });
  }
  return frames;
}

/** Where the glide is painted right now (mid-slide included), in its container's coordinates. */
function paintedBox(glide: HTMLElement, size: Box): Box | null {
  const m = getComputedStyle(glide).transform;
  if (!m || m === "none" || typeof DOMMatrixReadOnly === "undefined") return null;
  try {
    const mx = new DOMMatrixReadOnly(m);
    return { x: mx.e, y: mx.f, width: size.width * mx.a, height: size.height * mx.d };
  } catch {
    return null;
  }
}

/** The element's layout rectangle relative to `box`'s padding edge, ignoring CSS transforms on it or its parents. */
function layoutBox(el: HTMLElement, box: HTMLElement): Box {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== box) {
    x += node.offsetLeft;
    y += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    if (!parent || parent === box || !box.contains(parent)) {
      if (parent !== box) {
        // The box is not in the offset chain (not positioned): fall back to the painted offset of what we reached.
        const b = box.getBoundingClientRect();
        const p = (parent ?? document.body).getBoundingClientRect();
        x += p.left - b.left - box.clientLeft + box.scrollLeft;
        y += p.top - b.top - box.clientTop + box.scrollTop;
      }
      break;
    }
    x += parent.clientLeft;
    y += parent.clientTop;
    node = parent;
  }
  // Offsets are already in the box's scrolled coordinates, so a scrolling tab row carries the glide with it.
  return { x, y, width: el.offsetWidth, height: el.offsetHeight };
}

export function Glide({
  active,
  className = "",
  as: Tag = "span",
}: {
  /** CSS selector for the chosen item inside the container, e.g. ".is-on". */
  active: string;
  className?: string;
  /** "li" inside a list, so the list stays valid HTML. */
  as?: "span" | "li";
}) {
  const ref = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    // The parent, not a ref from it: a parent's ref is attached after its children's layout effects run.
    const glide = ref.current;
    const box = glide?.parentElement;
    if (!glide || !box) return;
    let last: Box | null = null;
    let lastOn: HTMLElement | null = null;
    let ready = false;
    let frame = 0;
    let slide: Animation | null = null;

    const place = () => {
      const on = box.querySelector<HTMLElement>(active);
      if (!on || on.offsetParent === null) {
        slide?.cancel();
        slide = null;
        glide.style.opacity = "0";
        lastOn = null;
        if (box.classList.contains("has-glide")) box.classList.remove("has-glide");
        last = null;
        return;
      }
      // The item's layout box inside the container, not its painted one: a tapped item is still shrunk by its press
      // effect (scale) when this runs, and measuring that made the glide aim small, then jump to the full size a
      // moment later. Layout offsets ignore transforms, so the target is right from the first frame.
      const r = layoutBox(on, box);
      if (last && last.x === r.x && last.y === r.y && last.width === r.width && last.height === r.height) return;
      // Slide when the choice changed. A resize or a layout shift moves it instantly, except while a slide is still
      // under way: then it re-aims smoothly from where it is painted, so nothing ever skips mid-travel.
      const travelling = slide !== null && slide.playState === "running";
      const moved = last !== null && ready && (on !== lastOn || travelling);
      const from = travelling && last ? (paintedBox(glide, last) ?? last) : last;
      last = r;
      lastOn = on;
      slide?.cancel();
      slide = null;
      if (!moved) glide.classList.add("is-still");
      // The new place and size, at once. Only the transform below animates.
      glide.style.setProperty("--glide-x", `${r.x}px`);
      glide.style.setProperty("--glide-y", `${r.y}px`);
      glide.style.width = `${r.width}px`;
      glide.style.height = `${r.height}px`;
      glide.style.opacity = "1";
      if (!box.classList.contains("has-glide")) box.classList.add("has-glide");
      if (moved && from && !prefersReducedMotion() && typeof glide.animate === "function") {
        const axis = Math.abs(r.x - from.x) >= Math.abs(r.y - from.y) ? "x" : "y";
        glide.dataset.axis = axis;
        const run = glide.animate(slideFrames(from, r, axis), { duration: GLIDE_MS, easing: "linear", id: GLIDE_ANIMATION_ID });
        slide = run;
        run.onfinish = () => {
          if (slide === run) slide = null;
        };
      }
      if (!moved) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          glide.classList.remove("is-still");
          ready = true;
        });
      }
    };

    place();
    // Older browsers and test DOMs have no ResizeObserver: then window resizes and class changes still move it.
    const ro: Pick<ResizeObserver, "observe" | "disconnect"> =
      typeof ResizeObserver === "undefined" ? { observe: () => undefined, disconnect: () => undefined } : new ResizeObserver(place);
    ro.observe(box);
    for (const child of Array.from(box.children)) if (child !== glide) ro.observe(child);
    // Ignore our own writes (the bar's has-glide class, the glide's classes and style), or this would feed itself.
    const mo = new MutationObserver((records) => {
      if (records.every((m) => m.type === "attributes" && (m.target === box || m.target === glide))) return;
      for (const child of Array.from(box.children)) if (child !== glide) ro.observe(child);
      place();
    });
    mo.observe(box, { subtree: true, attributes: true, attributeFilter: ["class", "aria-checked", "aria-selected", "aria-current"], childList: true });
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(frame);
      slide?.cancel();
      window.removeEventListener("resize", place);
      box.classList.remove("has-glide");
    };
  }, [active]);

  return <Tag ref={ref as never} className={`glide is-still ${className}`.trim()} aria-hidden="true" />;
}
