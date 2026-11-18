import { useLayoutEffect, useRef } from "react";

/**
 * The sliding highlight behind the chosen option of a switch bar, tab row or the menu (docs/CONTRACTS.md §20.12).
 *
 * It sits as the first child of the bar (its parent element, which must be position: relative) and moves to whichever child matches `active`: it slides there on a
 * spring and stretches a little while it travels. It is decoration only (aria-hidden), and the chosen item keeps its
 * own aria state. Until the first measure the container has no `has-glide` class, so the item paints its own static
 * highlight; nothing is lost if this never runs.
 */
/** The element's layout rectangle relative to `box`'s padding edge, ignoring CSS transforms on it or its parents. */
function layoutBox(el: HTMLElement, box: HTMLElement) {
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
    let last = "";
    let lastOn: HTMLElement | null = null;
    let ready = false;
    let frame = 0;

    const place = () => {
      const on = box.querySelector<HTMLElement>(active);
      if (!on || on.offsetParent === null) {
        glide.style.opacity = "0";
        lastOn = null;
        if (box.classList.contains("has-glide")) box.classList.remove("has-glide");
        last = "";
        return;
      }
      // The item's layout box inside the container, not its painted one: a tapped item is still shrunk by its press
      // effect (scale) when this runs, and measuring that made the glide aim small, then jump to the full size a
      // moment later. Layout offsets ignore transforms, so the target is right from the first frame.
      const r = layoutBox(on, box);
      const x = r.x;
      const y = r.y;
      const key = `${x}|${y}|${r.width}|${r.height}`;
      if (key === last) return;
      // Slide when the choice changed. A resize or a layout shift moves it instantly, except while a slide is still
      // under way: then it re-aims smoothly, so nothing ever skips frames mid-travel.
      const travelling = glide.classList.contains("is-moving");
      const moved = last !== "" && ready && (on !== lastOn || travelling);
      const [lx, ly] = last ? last.split("|").map(Number) : [x, y];
      const lastOnBefore = lastOn;
      last = key;
      lastOn = on;
      if (!moved) glide.classList.add("is-still");
      else if (glide.classList.contains("is-still")) {
        // A layout update just before the tap left it in "no transition" mode: leave it now, from where it stands.
        cancelAnimationFrame(frame);
        glide.classList.remove("is-still");
        void glide.offsetWidth;
      }
      glide.style.setProperty("--glide-x", `${x}px`);
      glide.style.setProperty("--glide-y", `${y}px`);
      glide.style.width = `${r.width}px`;
      glide.style.height = `${r.height}px`;
      glide.style.opacity = "1";
      if (!box.classList.contains("has-glide")) box.classList.add("has-glide");
      if (moved && on !== lastOnBefore) {
        // Stretch along the way it travels, then settle (CSS animation, skipped under reduced motion).
        const sideways = Math.abs(x - lx!) >= Math.abs(y - ly!);
        glide.dataset.axis = sideways ? "x" : "y";
        glide.classList.remove("is-moving");
        void glide.offsetWidth;
        glide.classList.add("is-moving");
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
      window.removeEventListener("resize", place);
      box.classList.remove("has-glide");
    };
  }, [active]);

  return (
    <Tag
      ref={ref as never}
      className={`glide is-still ${className}`.trim()}
      aria-hidden="true"
      onAnimationEnd={(e: { currentTarget: HTMLElement }) => e.currentTarget.classList.remove("is-moving")}
    />
  );
}
