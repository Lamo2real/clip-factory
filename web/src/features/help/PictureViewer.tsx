// A picture from an Ask question, bigger (docs/CONTRACTS.md §26). A glass dialog over everything, drawn on
// document.body like Sheet: the picture fits the screen, Escape or the close button closes it and the focus goes back
// to the tile that opened it. With 2 or more pictures, Previous and Next (and the ← → keys) step through them.
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon.tsx";

export interface ViewerPicture {
  url: string;
  width: number;
  height: number;
}

export const viewerAlt = (n: number, of: number) => `Your picture ${n} of ${of}`;

export function PictureViewer({
  pictures,
  start,
  opener,
  onClose,
}: {
  pictures: readonly ViewerPicture[];
  start: number;
  /** The tile that opened it: the focus goes back there (Safari does not focus a tapped button by itself). */
  opener?: HTMLElement | null;
  onClose: () => void;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(() => Math.min(Math.max(0, start), pictures.length - 1));
  const many = pictures.length > 1;
  const pic = pictures[at];

  useEffect(() => {
    const before = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    box.current?.querySelector<HTMLElement>(".help-viewer__close")?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
    // Once, when the viewer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = (by: number) => setAt((i) => (i + by + pictures.length) % pictures.length);

  // Keys are read on the window while the viewer is open: Safari does not focus a button on click, so after a tap
  // on Next the focus may be on the page. Captured first, so the Ask panel never sees them (Escape closes only this).
  const latest = useRef({ step, onClose, many });
  latest.current = { step, onClose, many };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const { step: go, onClose: close, many: several } = latest.current;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (several && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        e.stopPropagation();
        go(e.key === "ArrowRight" ? 1 : -1);
      } else if (e.key === "Tab") {
        // Every Tab is moved by hand: WebKit's own Tab skips buttons, so a trap that only steps in at the ends lets
        // the focus fall out to the page.
        e.preventDefault();
        e.stopPropagation();
        const buttons = Array.from(box.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
        if (!buttons.length) return;
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = i < 0 ? (e.shiftKey ? buttons.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]!.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!pic) return null;
  return createPortal(
    <div className="help-viewer-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="help-viewer glass glass--strong" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`}>
        <h2 className="sr-only" id={`${id}-t`}>
          {viewerAlt(at + 1, pictures.length)}
        </h2>
        <img key={pic.url} className="help-viewer__img" src={pic.url} width={pic.width} height={pic.height} alt={viewerAlt(at + 1, pictures.length)} />
        <div className="help-viewer__bar">
          {many ? (
            <button type="button" className="icon-btn help-viewer__step" aria-label="Previous picture" onClick={() => step(-1)}>
              <Icon name="chevronLeft" />
            </button>
          ) : null}
          {many ? (
            <span className="help-viewer__count" aria-hidden="true">
              {at + 1} / {pictures.length}
            </span>
          ) : null}
          {many ? (
            <button type="button" className="icon-btn help-viewer__step" aria-label="Next picture" onClick={() => step(1)}>
              <Icon name="chevronRight" />
            </button>
          ) : null}
        </div>
        <button type="button" className="icon-btn help-viewer__close" aria-label="Close picture" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
