// Stories › Settings › Look (the glass contract, first version): what is behind the glass. Clip Factory's three
// choices as Stories' own setting, kept in Stories' own prefs on this device (stories/look.ts), never Clip
// Factory's: See-through (the desktop through the window; Glass strength Clear or Frosted), Picture, Colours (the
// warm Ember preset is the default of the whole Look).
import { useRef, useState, type ChangeEvent } from "react";
import { nativeGlass, PRESETS, presetOf, setStoriesLook, setStoriesPicture, useStoriesLook, type GlassStrength, type LookMode } from "../look.ts";
import { Btn, SetCard, SetPick, type PickOption } from "./bits.tsx";

const MODES: PickOption<LookMode>[] = [
  { value: "see-through", label: "See-through", line: "The desktop shows through the window." },
  { value: "picture", label: "Picture", line: "A picture of yours behind the glass." },
  { value: "colours", label: "Colours", line: "Warm colours behind the glass." },
];
const STRENGTHS: PickOption<GlassStrength>[] = [
  { value: "clear", label: "Clear" },
  { value: "frosted", label: "Frosted" },
];
/** Pictures bigger than this are not kept (they would not fit in this device's storage). */
export const MAX_PICTURE_BYTES = 3_500_000;

export function LookSection() {
  const look = useStoriesLook();
  const file = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const preset = presetOf(look.colours);
  const inApp = nativeGlass() !== "none";

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!f.type.startsWith("image/") || f.size > MAX_PICTURE_BYTES) {
      setProblem("That picture is too big. Pick a smaller one.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : null;
      if (url && setStoriesPicture(url)) {
        setProblem(null);
        setStoriesLook({ mode: "picture" });
      } else setProblem("That picture is too big. Pick a smaller one.");
    };
    reader.readAsDataURL(f);
  };

  return (
    <SetCard title="Look" icon="brush" id="look" lede="What is behind the glass on this device. Clip Factory's own background stays as it is.">
      <div className="st-look">
        <SetPick label="Background" value={look.mode} options={MODES} onChange={(mode) => setStoriesLook({ mode })} stack />
        {look.mode === "see-through" ? (
          <>
            <SetPick label="Glass strength" value={look.strength} options={STRENGTHS} onChange={(strength) => setStoriesLook({ strength })} />
            {inApp ? null : <p className="st-stg-card__lede">In a browser or on a phone the window cannot show the desktop, so the Ember colours show.</p>}
          </>
        ) : null}
        {look.mode === "picture" ? (
          <div className="st-look__picture">
            <input ref={file} className="sr-only" type="file" accept="image/*" tabIndex={-1} aria-hidden="true" onChange={pick} />
            <Btn main onClick={() => file.current?.click()}>
              {look.picture ? "Choose another picture" : "Choose a picture"}
            </Btn>
            {look.picture ? (
              <Btn quiet onClick={() => setStoriesPicture(null)}>
                Remove the picture
              </Btn>
            ) : (
              <p className="st-stg-card__lede">Until you choose one, the Ember colours show.</p>
            )}
          </div>
        ) : null}
        {look.mode === "colours" ? (
          <SetPick
            label="Colours"
            value={preset}
            options={PRESETS.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(id) => {
              const p = PRESETS.find((x) => x.id === id);
              if (p) setStoriesLook({ colours: [...p.colours], mode: "colours" });
            }}
          />
        ) : null}
        {problem ? (
          <p className="st-stg-card__lede" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </SetCard>
  );
}
