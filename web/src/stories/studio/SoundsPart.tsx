// The character editor's Sounds part (docs/CONTRACTS.md §45.41): every sound can be heard before it is picked. A
// person picks a voice (a "Hear" row plays each one at the chosen pitch, and letting go of the pitch slider plays the
// voice at the new pitch), its noises and its favourite effects, each chip with its own play button; a car has no
// voice and picks its car sounds first (§45.42). The samples are the videos' own sounds (samples.ts). Tapping a chip
// only picks it; its play button plays it, and a second tap stops it.
import { useState } from "react";
import { CATALOG } from "../engine/catalog.ts";
import type { CharacterKind, CharacterVoice, NoiseId, SfxId } from "../engine/types.ts";
import { setStoriesDevicePref } from "../prefs.ts";
import { Chip, HearButton, Notice, Pick, Slider, type HearProp } from "./kit.tsx";
import { CHAR_LIMITS, VOICE_STYLE } from "./looks.ts";
import { CAR_SFX, playSample, SAMPLE_WORDS, sampleUrl, snapPitch, useSamples, type SampleRef } from "./samples.ts";
import "../styles/sd-sounds.css";

function toggle<T extends string>(list: T[], v: T, max: number): T[] {
  if (list.includes(v)) return list.filter((x) => x !== v);
  return list.length >= max ? list : [...list, v];
}

/** Turns Clips Funded's Sounds on right here (the same switch as Settings › Sounds and motion): the page, and a
 * character not saved yet, stay as they are. */
function turnSoundsOn(): void {
  setStoriesDevicePref("sound.enabled", true);
}

export function SoundsPart({
  kind,
  name,
  voice,
  onChange,
  otherMaker,
}: {
  kind: CharacterKind;
  /** the character's name, for the lede */
  name: string;
  voice: CharacterVoice;
  onChange: (voice: CharacterVoice) => void;
  /** the workspace's effects maker is not the built-in one: the effects in videos can sound different */
  otherMaker?: boolean;
}) {
  const samples = useSamples();
  const car = kind === "car";
  const [more, setMore] = useState(() => car && voice.sfx.some((id) => !CAR_SFX.includes(id)));

  const hear = (label: string, ref: SampleRef, disabledWhy?: string): HearProp => ({
    label,
    playing: samples.playing === sampleUrl(ref),
    state: samples.state,
    disabledWhy,
    onHear: () => samples.toggle(ref),
  });

  const sfxChip = (id: SfxId) => {
    const label = CATALOG.sfx.find((s) => s.id === id)?.label ?? id;
    return (
      <Chip key={id} on={voice.sfx.includes(id)} onToggle={() => onChange({ ...voice, sfx: toggle<SfxId>(voice.sfx, id, CHAR_LIMITS.sfx) })} hear={hear(label, { kind: "sfx", id })}>
        {label}
      </Chip>
    );
  };

  const hints = (
    <>
      {samples.state === "off" ? (
        <div className="st-sd-hint" role="status">
          <span className="st-sd-hint__text">{SAMPLE_WORDS.soundsOff}</span>
          <button type="button" className="st-btn st-sd-hint__btn" onClick={turnSoundsOn}>
            {SAMPLE_WORDS.turnOn}
          </button>
        </div>
      ) : null}
      {otherMaker ? <p className="st-s-field__hint st-sd-other">{SAMPLE_WORDS.otherMaker}</p> : null}
    </>
  );
  const failed = samples.failed ? <Notice tone="bad">{SAMPLE_WORDS.failed}</Notice> : null;

  if (car) {
    const others = CATALOG.sfx.map((s) => s.id).filter((id) => !CAR_SFX.includes(id));
    return (
      <div className="st-s-editor__part st-sd" aria-label="Sounds" tabIndex={-1}>
        {hints}
        <p className="st-s-editor__lede">{name} has no voice. Pick its car sounds.</p>
        <div className="st-s-field">
          <span className="st-s-field__label">
            Car sounds ({voice.sfx.length} of {CHAR_LIMITS.sfx})
          </span>
          <div className="st-s-chips st-sd-chips">{CAR_SFX.map(sfxChip)}</div>
        </div>
        <button type="button" className="st-btn st-sd-more" aria-expanded={more} aria-controls="st-sd-more" onClick={() => setMore(!more)}>
          {more ? "Fewer sounds" : "More sounds"}
        </button>
        {more ? (
          <div className="st-s-field" id="st-sd-more" role="group" aria-label="More sounds">
            <div className="st-s-chips st-sd-chips">{others.map(sfxChip)}</div>
          </div>
        ) : null}
        {failed}
      </div>
    );
  }

  const style = voice.style;
  const voiced = style === "babble" || style === "hum";
  const quiet = voiced ? undefined : SAMPLE_WORDS.quiet;
  const noiseVoice = voiced ? style : "babble";
  return (
    <div className="st-s-editor__part st-sd" aria-label="Sounds" tabIndex={-1}>
      {hints}
      <p className="st-s-editor__lede">Clips Funded videos have no talking. {name} makes little noises instead. You will hear them in the video.</p>
      <Pick label="Voice" value={style} options={VOICE_STYLE} onChange={(s) => onChange({ ...voice, style: s })} />
      <div className="st-s-field st-sd-hearrow" role="group" aria-labelledby="st-sd-hear-l">
        <span className="st-s-field__label" id="st-sd-hear-l">
          Hear
        </span>
        <span className="st-sd-hearrow__btns">
          {(["babble", "hum"] as const).map((v) => {
            const label = v === "babble" ? "Babble" : "Hum";
            return (
              <HearButton key={v} {...hear(`${label} voice`, { kind: "noise", id: "babble", voice: v, pitch: voice.pitch })}>
                <span className="st-sd-hearrow__word">{label}</span>
              </HearButton>
            );
          })}
        </span>
      </div>
      <Slider
        label="Voice pitch"
        min={0.5}
        max={2}
        step={0.05}
        value={voice.pitch}
        words={voice.pitch < 0.85 ? "Low" : voice.pitch > 1.3 ? "High" : "Middle"}
        onChange={(pitch) => onChange({ ...voice, pitch })}
        onCommit={(pitch) => {
          if (voiced) playSample({ kind: "noise", id: "babble", voice: style, pitch: snapPitch(pitch) });
        }}
      />
      <div className="st-s-field">
        <span className="st-s-field__label">
          Noises ({voice.noises.length} of {CHAR_LIMITS.noises})
        </span>
        {voiced ? null : <p className="st-s-field__hint st-sd-quiet">{SAMPLE_WORDS.quietLine}</p>}
        <div className="st-s-chips st-sd-chips">
          {CATALOG.noises.map((n) => (
            <Chip
              key={n.id}
              on={voice.noises.includes(n.id)}
              onToggle={() => onChange({ ...voice, noises: toggle<NoiseId>(voice.noises, n.id, CHAR_LIMITS.noises) })}
              hear={hear(n.label, { kind: "noise", id: n.id, voice: noiseVoice, pitch: voice.pitch }, quiet)}
            >
              {n.label}
            </Chip>
          ))}
        </div>
      </div>
      <div className="st-s-field">
        <span className="st-s-field__label">
          Favourite sound effects ({voice.sfx.length} of {CHAR_LIMITS.sfx})
        </span>
        <div className="st-s-chips st-sd-chips">{CATALOG.sfx.map((s) => sfxChip(s.id))}</div>
      </div>
      {failed}
    </div>
  );
}
