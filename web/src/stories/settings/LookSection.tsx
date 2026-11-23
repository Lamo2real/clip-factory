// Stories › Settings › Look (its own page, /stories/settings/look): what is behind the glass. Clip Factory's three
// choices as Stories' own setting, kept in Stories' own prefs on this device (stories/look.ts), never Clip Factory's:
// See-through (the desktop through the window; Glass strength Clear or Frosted), Picture (one of yours, shrunk to fit
// this device), Colours (the warm Ember preset is the default of the whole Look). Every choice shows what you get: a
// little picture of it beside its name. The pick-one bars are Settings' own (SetPick: the sliding highlight, arrows,
// never disabled).
import { useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { EMBER, nativeGlass, PRESETS, presetOf, setStoriesLook, setStoriesPicture, stageColours, useStoriesLook, type GlassStrength, type LookMode, type StoriesLook } from "../look.ts";
import { Btn, SectionBar, SetCard, SetPick, type PickOption } from "./bits.tsx";

/** Pictures bigger than this are not even opened. */
export const MAX_PICTURE_BYTES = 25_000_000;
/** A picture is kept at most this wide or tall (it only ever sits behind frosted glass). */
export const PICTURE_SIDE = 1920;

/** The colours as they really sit behind the glass: the base, and the two lights in their own places. */
export function meshStyle(colours: readonly string[]): CSSProperties {
  const [c1, c2 = c1, c3 = c2] = colours;
  return {
    background: `radial-gradient(70% 90% at 100% 0%, ${c3} 0, transparent 70%), radial-gradient(80% 90% at 0% 100%, ${c2} 0, transparent 72%), ${c1}`,
  };
}

/** A little picture of each choice: what you get (decorative; the words say it). */
function Art({ kind, look }: { kind: LookMode; look: StoriesLook }) {
  if (kind === "see-through")
    return (
      <span className="st-look__art st-look__art--window" aria-hidden="true">
        <span className="st-look__pane" />
      </span>
    );
  if (kind === "picture")
    return (
      <span className="st-look__art st-look__art--picture" aria-hidden="true" style={look.picture ? { backgroundImage: `url("${look.picture}")` } : undefined}>
        {look.picture ? null : <span className="st-look__pane" />}
      </span>
    );
  return (
    <span className="st-look__art st-look__art--colours" aria-hidden="true" style={meshStyle(look.mode === "colours" ? stageColours(look) : EMBER)}>
      <span className="st-look__pane" />
    </span>
  );
}

/** Three dots of a preset's colours. */
function Swatches({ colours }: { colours: readonly string[] }) {
  return (
    <span className="st-look__swatches" aria-hidden="true">
      {colours.map((c) => (
        <span key={c} className="st-look__swatch" style={{ background: c }} />
      ))}
    </span>
  );
}

/** Reads a picture and makes it small enough to keep: at most PICTURE_SIDE on its long side, as a JPEG. */
export function shrinkPicture(file: File, side = PICTURE_SIDE): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("unreadable"));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      if (!url.startsWith("data:image/")) return reject(new Error("not a picture"));
      if (typeof Image === "undefined" || typeof document === "undefined") return resolve(url);
      const img = new Image();
      img.onerror = () => reject(new Error("unreadable"));
      img.onload = () => {
        const k = Math.min(1, side / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round((img.naturalWidth || 1) * k));
        c.height = Math.max(1, Math.round((img.naturalHeight || 1) * k));
        const ctx = c.getContext("2d");
        if (!ctx) return resolve(url);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        try {
          resolve(c.toDataURL("image/jpeg", 0.82));
        } catch {
          resolve(url);
        }
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
  });
}

export function LookSection() {
  const look = useStoriesLook();
  const file = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preset = presetOf(look.colours);
  const inApp = nativeGlass() !== "none";

  const modes: PickOption<LookMode>[] = [
    { value: "see-through", label: "See-through", line: "The desktop shows through the window.", chip: <Art kind="see-through" look={look} /> },
    { value: "picture", label: "Picture", line: "A picture of yours behind the glass.", chip: <Art kind="picture" look={look} /> },
    { value: "colours", label: "Colours", line: "Warm colours behind the glass.", chip: <Art kind="colours" look={look} /> },
  ];
  const strengths: PickOption<GlassStrength>[] = [
    { value: "clear", label: "Clear" },
    { value: "frosted", label: "Frosted" },
  ];

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!f.type.startsWith("image/") || f.size > MAX_PICTURE_BYTES) {
      setProblem("That picture is too big. Pick a smaller one.");
      return;
    }
    setBusy(true);
    shrinkPicture(f)
      .then((url) => {
        if (setStoriesPicture(url)) {
          setProblem(null);
          setStoriesLook({ mode: "picture" });
        } else setProblem("That picture is too big. Pick a smaller one.");
      })
      .catch(() => setProblem("That picture is too big. Pick a smaller one."))
      .finally(() => setBusy(false));
  };

  return (
    <>
      {/* Its own page, Settings › Look (/stories/settings/look): the note in the section head's plate, like every page's. */}
      <SectionBar>
        <p className="st-stg-small">Kept on this device. Clip Factory's own background stays as it is.</p>
      </SectionBar>
      <SetCard title="Background" icon="brush" id="look" lede="Pick one. It changes at once.">
        <div className="st-look">
          <SetPick label="Background" value={look.mode} options={modes} onChange={(mode) => setStoriesLook({ mode })} stack className="st-look__modes" />
          {look.mode === "see-through" ? (
            <>
              <SetPick label="Glass strength" value={look.strength} options={strengths} onChange={(strength) => setStoriesLook({ strength })} />
              {inApp ? null : <p className="st-stg-card__lede">In a browser or on a phone the window cannot show the desktop, so the Ember colours show.</p>}
            </>
          ) : null}
          {look.mode === "picture" ? (
            <div className="st-look__picture">
              <span className="st-look__thumb" aria-hidden="true" style={look.picture ? { backgroundImage: `url("${look.picture}")` } : meshStyle(EMBER)} />
              <div className="st-look__actions">
                <input ref={file} className="sr-only" type="file" accept="image/*" tabIndex={-1} aria-hidden="true" onChange={pick} />
                <Btn main off={busy} onClick={() => file.current?.click()}>
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
            </div>
          ) : null}
          {look.mode === "colours" ? (
            <SetPick
              label="Colours"
              value={preset}
              options={PRESETS.map((p) => ({ value: p.id, label: p.name, chip: <Swatches colours={p.colours} /> }))}
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
    </>
  );
}
