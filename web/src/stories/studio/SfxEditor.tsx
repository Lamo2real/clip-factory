// The sound effects editor of Review (docs/CONTRACTS.md §45.16.6, SceneEdit.sfx; spec §5.E "edit sound effects"):
// every effect of every scene on that scene's timeline. Add one, move it (drag its marker, use the arrow keys or the
// When slider), change it, make it louder or quieter, or remove it; and pick the music. A scene's whole list is sent
// back when it changed (SceneEdit.sfx replaces it), so Remake then remixes the sound. The place's own sounds (wind,
// rain, traffic, a car's engine) are in each scene's list from its start, with ids "{sceneId}.amb{k}" (the engine's
// BED_ID, CONTRACTS §45.34): labelled "(whole scene)", they can be moved or removed like any other.
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Dropdown } from "../../components/Dropdown.tsx";
import type { MusicMood, SfxCue, Story, StoryPatch, StoryScript } from "../api/types.ts";
import { BED_ID } from "../engine/ambience.ts";
import { CATALOG } from "../engine/catalog.ts";
import type { SfxId } from "../engine/types.ts";
import { Notice, Pick, Slider } from "./kit.tsx";
import { clock } from "./words.ts";

type Edit = Omit<StoryPatch, "version">;

const SFX_LABEL = new Map<string, string>(CATALOG.sfx.map((e) => [e.id, e.label]));
const r1 = (n: number) => Math.round(n * 10) / 10;

export function sfxLabel(id: string): string {
  return SFX_LABEL.get(id) ?? id;
}

/** True for a place's own sound (the engine wrote it for the whole scene: "{sceneId}.amb{k}"). */
export function isPlaceSound(c: Pick<SfxCue, "id">): boolean {
  return BED_ID.test(c.id);
}

/** A cue's name in the editor: "Wind (whole scene)" for a place's own sound. */
export function cueLabel(c: Pick<SfxCue, "id" | "sfx">): string {
  return isPlaceSound(c) ? `${sfxLabel(c.sfx)} (whole scene)` : sfxLabel(c.sfx);
}

/** The scenes whose effects list differs from the script's. */
export function changedScenes(script: StoryScript, lists: Record<string, SfxCue[]>): string[] {
  return script.scenes.filter((sc) => JSON.stringify(lists[sc.sceneId] ?? []) !== JSON.stringify(sc.sfx)).map((sc) => sc.sceneId);
}

function Timeline({ duration, cues, onMove, label }: { duration: number; cues: SfxCue[]; onMove: (id: string, at: number) => void; label: string }) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<string | null>(null);

  function atFrom(clientX: number): number {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0;
    return r1(Math.max(0, Math.min(duration, ((clientX - box.left) / box.width) * duration)));
  }

  function down(e: PointerEvent<HTMLButtonElement>, id: string) {
    dragging.current = id;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function move(e: PointerEvent<HTMLButtonElement>) {
    if (dragging.current) onMove(dragging.current, atFrom(e.clientX));
  }

  function key(e: KeyboardEvent<HTMLButtonElement>, c: SfxCue) {
    const step = e.shiftKey ? 1 : 0.1;
    if (e.key === "ArrowLeft") onMove(c.id, r1(Math.max(0, c.at - step)));
    else if (e.key === "ArrowRight") onMove(c.id, r1(Math.min(duration, c.at + step)));
    else return;
    e.preventDefault();
  }

  return (
    <div className="st-s-timeline" ref={track} role="group" aria-label={label}>
      <span className="st-s-timeline__line" aria-hidden="true" />
      <span className="st-s-timeline__ends" aria-hidden="true">
        <span>0:00</span>
        <span>{clock(duration)}</span>
      </span>
      {cues.map((c) => (
        <button
          key={c.id}
          type="button"
          style={{ left: `${(c.at / Math.max(0.1, duration)) * 100}%` }}
          className={`st-s-timeline__mark${isPlaceSound(c) ? " is-place" : ""}`}
          aria-label={`${cueLabel(c)} at ${clock(c.at)}. Drag, or use the arrow keys, to move it.`}
          onPointerDown={(e) => down(e, c.id)}
          onPointerMove={move}
          onPointerUp={() => (dragging.current = null)}
          onPointerCancel={() => (dragging.current = null)}
          onKeyDown={(e) => key(e, c)}
        >
          {/* The short name on the chip ("Wind"); "(whole scene)" is in its label and in the row below (§45.35 D21). */}
          <span className="st-s-timeline__name">{sfxLabel(c.sfx)}</span>
        </button>
      ))}
    </div>
  );
}

export function SfxEditor({ story, script, saving, onSave }: { story: Story; script: StoryScript; saving: boolean; onSave: (e: Edit) => void }) {
  const [lists, setLists] = useState<Record<string, SfxCue[]>>(() => Object.fromEntries(script.scenes.map((sc) => [sc.sceneId, [...sc.sfx]])));
  const [mood, setMood] = useState<MusicMood>(story.musicMood);
  const [problem, setProblem] = useState<string | null>(null);
  const changed = useMemo(() => changedScenes(script, lists), [script, lists]);
  const dirty = changed.length > 0 || mood !== story.musicMood;
  const options = useMemo(() => CATALOG.sfx.map((e) => ({ value: e.id, label: e.label })), []);

  const edit = (sceneId: string, fn: (l: SfxCue[]) => SfxCue[]) => {
    setProblem(null);
    setLists((all) => ({ ...all, [sceneId]: fn(all[sceneId] ?? []) }));
  };

  function add(sceneId: string, duration: number) {
    const list = lists[sceneId] ?? [];
    let n = list.length + 1;
    while (list.some((c) => c.id === `${sceneId}.own${n}`)) n += 1;
    edit(sceneId, (l) => [...l, { id: `${sceneId}.own${n}`, at: r1(duration / 2), sfx: "pop", volume: 0.8 }]);
  }

  function save() {
    for (const sc of script.scenes) for (const c of lists[sc.sceneId] ?? []) if (c.at < 0 || c.at > sc.durationSec) return setProblem(`A sound in “${sc.title}” is outside the scene.`);
    const e: Edit = {};
    if (changed.length) e.scenes = changed.map((sceneId) => ({ sceneId, sfx: [...(lists[sceneId] ?? [])].sort((a, b) => a.at - b.at) }));
    if (mood !== story.musicMood) e.musicMood = mood;
    onSave(e);
  }

  return (
    <div className="st-s-editor-box">
      <Pick label="Music" value={mood} options={CATALOG.musicMoods.map((m) => ({ value: m.id, label: m.id === "none" ? "No music" : m.label }))} onChange={setMood} />
      <p className="st-s-field__hint">
        Each place has its own sounds (rain, wind, traffic, a car&apos;s engine). They are in the list from the start of each scene, marked “(whole scene)”. Move them or remove them like any other sound.
      </p>
      <ol className="st-s-sfx">
        {script.scenes.map((sc, i) => {
          const list = lists[sc.sceneId] ?? [];
          return (
            <li key={sc.sceneId} className="st-s-sfx__scene">
              <h3 className="st-s-sfx__title">
                Scene {i + 1}: {sc.title} <span>({clock(sc.durationSec)})</span>
              </h3>
              <Timeline duration={sc.durationSec} cues={list} label={`Sounds in scene ${i + 1}`} onMove={(id, at) => edit(sc.sceneId, (l) => l.map((c) => (c.id === id ? { ...c, at } : c)))} />
              {list.length ? (
                <ul className="st-s-sfx__list">
                  {list.map((c) => (
                    <li key={c.id} className={`st-s-sfx__row${isPlaceSound(c) ? " is-place" : ""}`}>
                      <span className="st-s-sfx__pick">
                        <span className="st-s-field__label" id={`${c.id}-l`}>
                          {isPlaceSound(c) ? "Sound (whole scene)" : "Sound"}
                        </span>
                        <Dropdown labelledBy={`${c.id}-l`} value={c.sfx} options={options} placeholder="Pick a sound" onChange={(v) => edit(sc.sceneId, (l) => l.map((x) => (x.id === c.id ? { ...x, sfx: v as SfxId } : x)))} />
                      </span>
                      <Slider label="When" min={0} max={sc.durationSec} step={0.1} value={c.at} words={clock(c.at)} onChange={(at) => edit(sc.sceneId, (l) => l.map((x) => (x.id === c.id ? { ...x, at } : x)))} />
                      <Slider label="How loud" min={0} max={1} step={0.05} value={c.volume} words={`${Math.round(c.volume * 100)}%`} onChange={(volume) => edit(sc.sceneId, (l) => l.map((x) => (x.id === c.id ? { ...x, volume } : x)))} />
                      <button type="button" className="st-btn st-s-small st-s-quiet" onClick={() => edit(sc.sceneId, (l) => l.filter((x) => x.id !== c.id))}>
                        Remove<span className="st-s-sr"> {cueLabel(c)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="st-s-field__hint">No sounds in this scene.</p>
              )}
              <button type="button" className="st-btn st-s-small" onClick={() => add(sc.sceneId, sc.durationSec)}>
                Add a sound<span className="st-s-sr"> to scene {i + 1}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      <div className="st-s-actionbar">
        <button type="button" className="st-btn st-btn--main" aria-disabled={!dirty || saving || undefined} onClick={() => dirty && !saving && save()}>
          {saving ? "Saving…" : dirty ? "Save sounds" : "No changes yet"}
        </button>
      </div>
    </div>
  );
}
