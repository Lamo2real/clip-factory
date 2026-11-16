import { useLayoutEffect, useRef } from "react";

/**
 * The sliding highlight behind the chosen option of a switch bar, tab row or the menu (docs/CONTRACTS.md §20.12).
 *
 * It sits as the first child of the bar (its parent element, which must be position: relative) and moves to whichever child matches `active`: it slides there on a
 * spring and stretches a little while it travels. It is decoration only (aria-hidden), and the chosen item keeps its
 * own aria state. Until the first measure the container has no `has-glide` class, so the item paints its own static
 * highlight; nothing is lost if this never runs.
 */
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
      // Offsets inside the container (it is position: relative), so a scrolling tab row carries the glide with it.
      const b = box.getBoundingClientRect();
      const r = on.getBoundingClientRect();
      const x = r.left - b.left + box.scrollLeft - box.clientLeft;
      const y = r.top - b.top + box.scrollTop - box.clientTop;
      const key = `${x}|${y}|${r.width}|${r.height}`;
      if (key === last) return;
      // Slide only when the choice changed. A resize or a layout shift moves it instantly.
      const moved = last !== "" && ready && on !== lastOn;
      const [lx, ly] = last ? last.split("|").map(Number) : [x, y];
      last = key;
      lastOn = on;
      if (!moved) glide.classList.add("is-still");
      glide.style.setProperty("--glide-x", `${x}px`);
      glide.style.setProperty("--glide-y", `${y}px`);
      glide.style.width = `${r.width}px`;
      glide.style.height = `${r.height}px`;
      glide.style.opacity = "1";
      if (!box.classList.contains("has-glide")) box.classList.add("has-glide");
      if (moved) {
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
