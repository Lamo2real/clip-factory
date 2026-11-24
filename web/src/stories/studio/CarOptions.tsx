// "Pick one" (docs/CONTRACTS.md §45.42): the cartoon cars one design made from the owner's photos, each driving
// gently with its name under it. The picked one is in the editor (the sliding highlight sits on it); "Make more" asks
// for 3 more that look different from these, up to 12; "Change photos" goes back to the photo strip.
import "../styles/sd-cars.css";
import type { CarInput } from "../api/types.ts";
import { CarPreview } from "../preview/CarPreview.tsx";
import { useWidth } from "./hooks.ts";
import { Pick } from "./kit.tsx";
import { showFace } from "./looks.ts";

/** The most cards "Make more" adds up to. */
export const MAX_CAR_OPTIONS = 12;

export function CarOptions({
  options,
  picked,
  onPick,
  onMore,
  onPhotos,
  busy,
}: {
  options: CarInput[];
  picked: number;
  onPick: (i: number) => void;
  onMore: () => void;
  onPhotos: () => void;
  /** a design is running: Make more waits */
  busy: boolean;
}) {
  const [box, width] = useWidth<HTMLElement>(600);
  const full = options.length >= MAX_CAR_OPTIONS;
  // 3 across, 2 on phones; the car fills its card less its padding.
  const cols = width >= 520 ? 3 : 2;
  const size = Math.max(96, Math.min(170, Math.floor((width - (cols - 1) * 10) / cols) - 36));
  return (
    <section className="st-s-caropts" aria-labelledby="st-caropts-title" ref={box}>
      <h3 className="st-s-caropts__title" id="st-caropts-title">
        Pick one
      </h3>
      <Pick
        label="The cars to pick from"
        hideLabel
        big
        className="st-s-caropts__grid"
        value={String(picked)}
        options={options.map((o, i) => ({
          value: String(i),
          label: o.name || `Car ${i + 1}`,
          line: i === picked ? "Picked" : undefined,
          art: <CarPreview car={o.car} movementStyle={o.movementStyle} expression={showFace(o)} move="drive" size={size} label={`${o.name || `Car ${i + 1}`}, driving`} />,
        }))}
        onChange={(v) => onPick(Number(v))}
      />
      {full ? <p className="st-s-field__hint">That&apos;s plenty. Pick one, or change the photos.</p> : null}
      <div className="st-s-actionbar st-s-caropts__bar">
        <button type="button" className="st-btn" onClick={onPhotos}>
          Change photos
        </button>
        <button type="button" className="st-btn" aria-disabled={busy || full || undefined} onClick={() => !busy && !full && onMore()}>
          Make more
        </button>
      </div>
    </section>
  );
}
