// The sound effects editor of Review (docs/CONTRACTS.md §45.16.6, SceneEdit.sfx; spec §5.E "edit sound effects"):
// every effect of every scene on that scene's timeline. Add one, move it (drag its marker, use the arrow keys or the
// When slider), change it, make it louder or quieter, or remove it; and pick the music. A scene's whole list is sent
// back when it changed (SceneEdit.sfx replaces it), so Remake then remixes the sound.
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Dropdown } from "../../components/Dropdown.tsx";
import type { MusicMood, SfxCue, Story, StoryPatch, StoryScript } from "../api/types.ts";
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
    <div className="st-timeline" ref={track} role="group" aria-label={label}>
      <span className="st-timeline__line" aria-hidden="true" />
      <span className="st-timeline__ends" aria-hidden="true">
        <span>0:00</span>
        <span>{clock(duration)}</span>
      </span>
      {cues.map((c) => (
        <button
          key={c.id}
          type="button"
          className="st-timeline__mark"
          style={{ left: `${(c.at / Math.max(0.1, duration)) * 100}%` }}
          aria-label={`${sfxLabel(c.sfx)} at ${clock(c.at)}. Drag, or use the arrow keys, to move it.`}
          onPointerDown={(e) => down(e, c.id)}
          onPointerMove={move}
          onPointerUp={() => (dragging.current = null)}
          onPointerCancel={() => (dragging.current = null)}
          onKeyDown={(e) => key(e, c)}
        >
          <span className="st-timeline__name">{sfxLabel(c.sfx)}</span>
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
    <div className="st-editor-box">
      <Pick label="Music" value={mood} options={CATALOG.musicMoods.map((m) => ({ value: m.id, label: m.id === "none" ? "No music" : m.label }))} onChange={setMood} />
      <ol className="st-sfx">
        {script.scenes.map((sc, i) => {
          const list = lists[sc.sceneId] ?? [];
          return (
            <li key={sc.sceneId} className="st-sfx__scene">
              <h3 className="st-sfx__title">
                Scene {i + 1}: {sc.title} <span>({clock(sc.durationSec)})</span>
              </h3>
              <Timeline duration={sc.durationSec} cues={list} label={`Sounds in scene ${i + 1}`} onMove={(id, at) => edit(sc.sceneId, (l) => l.map((c) => (c.id === id ? { ...c, at } : c)))} />
              {list.length ? (
                <ul className="st-sfx__list">
                  {list.map((c) => (
                    <li key={c.id} className="st-sfx__row">
                      <span className="st-sfx__pick">
                        <span className="st-field__label" id={`${c.id}-l`}>
                          Sound
                        </span>
                        <Dropdown labelledBy={`${c.id}-l`} value={c.sfx} options={options} placeholder="Pick a sound" onChange={(v) => edit(sc.sceneId, (l) => l.map((x) => (x.id === c.id ? { ...x, sfx: v as SfxId } : x)))} />
                      </span>
                      <Slider label="When" min={0} max={sc.durationSec} step={0.1} value={c.at} words={clock(c.at)} onChange={(at) => edit(sc.sceneId, (l) => l.map((x) => (x.id === c.id ? { ...x, at } : x)))} />
                      <Slider label="How loud" min={0} max={1} step={0.05} value={c.volume} words={`${Math.round(c.volume * 100)}%`} onChange={(volume) => edit(sc.sceneId, (l) => l.map((x) => (x.id === c.id ? { ...x, volume } : x)))} />
                      <button type="button" className="st-btn st-btn--small st-btn--quiet" onClick={() => edit(sc.sceneId, (l) => l.filter((x) => x.id !== c.id))}>
                        Remove<span className="st-sr"> {sfxLabel(c.sfx)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="st-field__hint">No sounds in this scene.</p>
              )}
              <button type="button" className="st-btn st-btn--small" onClick={() => add(sc.sceneId, sc.durationSec)}>
                Add a sound<span className="st-sr"> to scene {i + 1}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      <div className="st-actionbar">
        <button type="button" className="st-btn st-btn--main" aria-disabled={!dirty || saving || undefined} onClick={() => dirty && !saving && save()}>
          {saving ? "Saving…" : dirty ? "Save sounds" : "No changes yet"}
        </button>
      </div>
    </div>
  );
}
