// "Write it myself" (docs/CONTRACTS.md §45.46.2): the owner's own scene
// list. Each scene has What happens and an optional Caption (the words on screen, kept exactly as typed), its Who chips
// (read from the words, or picked by hand), its Where (read from the words, or picked), and a plain question when the
// words name someone the app does not know ("Who is Max?"). Scenes move with ↑ and ↓, a scene with words taken out
// comes back with Undo, "Paste a script" makes the list from a pasted text, and "Your video" shows what will be made.
// Also here: the "Your script" chip, Review's "Your script" panel and the Change my script sheet (Make it again).
// On the warm liquid glass (styles/GLASS-CONTRACT.md): scene rows and tiles are controls (--st-r-control), chips round.
import { useEffect, useId, useRef, useState } from "react";
import { useToast } from "../../components/Toasts.tsx";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import { isCar, type Character, type OwnScript, type ProductionJob, type Story, type StoryScript } from "../api/types.ts";
import { storiesReduceMotion } from "../prefs.ts";
import { Busy, Chip, Notice, StSheet, TextField } from "./kit.tsx";
import {
  OWN,
  PLACES,
  castInNoScene,
  draftFromOwn,
  fitTarget,
  letters,
  names,
  newScene,
  openAsks,
  placeLabel,
  sameScript,
  saysCar,
  sceneWho,
  scenePlace,
  scriptProblem,
  shares,
  splitScript,
  toOwnScript,
  tooLong,
  written,
  type Ask,
  type DraftScene,
  type Fix,
  type ScriptDraft,
} from "./ownScript.ts";
import { say } from "./words.ts";

/** The element a fix points at (a scene's What happens, its Caption, its question, or Add a scene). */
export function fixId(prefix: string, draft: ScriptDraft, fix: Fix): string {
  if ("add" in fix) return `${prefix}-add`;
  const key = draft.scenes[fix.scene]?.key ?? "";
  return `${prefix}-${fix.field === "what" ? "what" : fix.field === "caption" ? "cap" : "ask"}-${key}`;
}

/** Brings a field into view and gives it the focus (a question: its first button). */
export function focusField(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  el.scrollIntoView?.({ block: "center", behavior: storiesReduceMotion() ? "auto" : "smooth" });
  const target = el.matches("input, textarea, button") ? el : (el.querySelector<HTMLElement>("button, input, textarea") ?? el);
  if (target === el && !el.matches("input, textarea, button")) el.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  return true;
}

/** A scene's field: its counter always shows ("19/160"); over the limit it turns red and says so (never cut). */
function SceneField({
  id,
  label,
  value,
  onChange,
  max,
  multiline = false,
  placeholder,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  multiline?: boolean;
  placeholder?: string;
  hint?: string | null;
}) {
  const over = tooLong(value, max);
  const describedBy = [`${id}-c`, hint ? `${id}-h` : "", over ? `${id}-p` : ""].filter(Boolean).join(" ");
  return (
    <div className={`st-s-field st-sc-field${over ? " is-bad" : ""}`}>
      <label className="st-s-field__label st-sc-field__label" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea id={id} className="st-s-input st-s-input--area" rows={2} value={value} placeholder={placeholder} aria-invalid={!!over || undefined} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={id} className="st-s-input" value={value} placeholder={placeholder} aria-invalid={!!over || undefined} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />
      )}
      <span className={`st-s-field__count st-sc-count${over ? " is-over" : ""}`} id={`${id}-c`}>
        {letters(value.trim())}/{max}
      </span>
      {hint ? (
        <span className="st-s-field__hint" id={`${id}-h`}>
          {hint}
        </span>
      ) : null}
      {over ? (
        <span className="st-s-field__problem" id={`${id}-p`}>
          {over}
        </span>
      ) : null}
      {/* said once when the field goes over its limit, not on every key (the counter shows the number) */}
      <span className="st-s-sr" aria-live="polite">
        {over ? "Too long." : ""}
      </span>
    </div>
  );
}

export interface ScriptEditorProps {
  draft: ScriptDraft;
  update: (fn: (d: ScriptDraft) => ScriptDraft) => void;
  /** every character of the workspace (the names the words may use) */
  characters: Character[];
  /** the picked cast, ids (people first, then the car) */
  cast: string[];
  /** adds a character the words name to the cast ("Add Rosa"); left out: the cast is fixed (Change my script) */
  onAddToCast?: (characterId: string) => void;
  /** why that character can't join the cast now, or null */
  addWhy?: (characterId: string) => string | null;
  /** the video's length, for the preview's "about 5 s" */
  lengthSec: number;
  /** the fields' id prefix (the page and a sheet each have their own) */
  prefix?: string;
  /** a hint over the list ("Started from your idea. Change anything.") */
  note?: string | null;
}

export function ScriptEditor({ draft, update, characters, cast, onAddToCast, addWhy, lengthSec, prefix = "st-sc", note }: ScriptEditorProps) {
  const toast = useToast();
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [replaceAsk, setReplaceAsk] = useState<ReturnType<typeof splitScript> | null>(null);
  const [placeFor, setPlaceFor] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const castChars = cast.map((id) => characters.find((c) => c.characterId === id)).filter((c): c is Character => !!c);
  const asks = openAsks(draft, cast, characters);
  const count = draft.scenes.length;

  // The field a tap moved, added or brought back gets the focus once it is drawn.
  useEffect(() => {
    if (!pending.current) return;
    const id = pending.current;
    pending.current = null;
    document.getElementById(id)?.focus({ preventScroll: false });
  });

  const setScene = (key: string, change: (s: DraftScene, d: ScriptDraft) => DraftScene) => update((d) => ({ ...d, scenes: d.scenes.map((s) => (s.key === key ? change(s, d) : s)) }));

  function add() {
    const s = newScene();
    pending.current = `${prefix}-what-${s.key}`;
    update((d) => ({ ...d, scenes: [...d.scenes, s] }));
  }

  function move(i: number, by: -1 | 1) {
    const j = i + by;
    if (j < 0 || j >= count) return;
    const key = draft.scenes[i]!.key;
    pending.current = `${prefix}-${by < 0 ? "up" : "down"}-${key}`;
    update((d) => {
      const scenes = [...d.scenes];
      const at = scenes.findIndex((s) => s.key === key);
      const to = at + by;
      if (at < 0 || to < 0 || to >= scenes.length) return d;
      [scenes[at], scenes[to]] = [scenes[to]!, scenes[at]!];
      return { ...d, scenes };
    });
  }

  function takeOut(i: number) {
    const s = draft.scenes[i]!;
    const next = draft.scenes[i + 1] ?? draft.scenes[i - 1];
    pending.current = next ? `${prefix}-what-${next.key}` : `${prefix}-add`;
    update((d) => ({ ...d, scenes: d.scenes.filter((x) => x.key !== s.key) }));
    if (!written(s)) return;
    toast.undo(`Scene ${i + 1} taken out.`, {
      onUndo: () =>
        update((d) => {
          if (d.scenes.some((x) => x.key === s.key)) return d;
          const scenes = [...d.scenes];
          scenes.splice(Math.min(i, scenes.length), 0, s);
          return { ...d, scenes };
        }),
      onCommit: () => {},
    });
  }

  function answer(ask: Ask, to: string) {
    const low = ask.name.toLowerCase();
    update((d) => ({
      answers: { ...d.answers, [low]: to },
      // picking someone ticks them in every scene that names the name (one picked by hand too); Not a name and Leave
      // out tick nobody
      scenes:
        to === "out" || to === "seen"
          ? d.scenes
          : d.scenes.map((s) => (s.who && names(s.what, ask.name) && !s.who.includes(to) ? { ...s, who: [...s.who, to] } : s)),
    }));
  }

  function makeScenes() {
    const parts = splitScript(pasted);
    if (!parts.length) return;
    if (draft.scenes.some(written)) return setReplaceAsk(parts);
    replaceWith(parts);
  }

  function replaceWith(parts: ReturnType<typeof splitScript>) {
    const scenes = parts.map((p) => newScene(p.what, p.caption ?? ""));
    pending.current = scenes[0] ? `${prefix}-what-${scenes[0].key}` : null;
    update((d) => ({ ...d, scenes }));
    setReplaceAsk(null);
    setPasting(false);
    setPasted("");
  }

  const placeScene = placeFor ? draft.scenes.find((s) => s.key === placeFor) : undefined;
  const placeNo = placeScene ? draft.scenes.indexOf(placeScene) + 1 : 0;

  return (
    <div className="st-sc">
      <div className="st-sc-head">
        <h3 className="st-sc-head__title">Your scenes</h3>
        <button type="button" className="st-btn st-s-small st-sc-head__paste" aria-expanded={pasting} onClick={() => setPasting((p) => !p)}>
          Paste a script
        </button>
      </div>
      {note ? <p className="st-s-field__hint">{note}</p> : null}
      {pasting ? (
        <div className="st-sc-paste">
          <TextField label="Your script" multiline rows={6} value={pasted} onChange={setPasted} max={6000} placeholder={"Scene 1: Dash wakes up late.\nCaption: Oh no!"} id={`${prefix}-paste`} />
          <div className="st-s-actionbar">
            <button type="button" className="st-btn st-btn--main" aria-disabled={!pasted.trim() || undefined} onClick={makeScenes}>
              Make scenes
            </button>
          </div>
        </div>
      ) : null}
      <ol className="st-sc-list">
        {draft.scenes.map((s, i) => {
          const n = i + 1;
          const who = sceneWho(s, draft, cast, characters);
          const place = scenePlace(s, draft, cast, characters);
          const mine = asks.filter((a) => a.scene === i);
          return (
            <li key={s.key} id={`${prefix}-scene-${s.key}`} className={`st-sc-scene${mine.length ? " is-asking" : ""}`}>
              <div className="st-sc-scene__head">
                <h4 className="st-sc-scene__num" id={`${prefix}-n-${s.key}`}>
                  Scene {n}
                </h4>
                <span className="st-sc-scene__tools">
                  <button type="button" id={`${prefix}-up-${s.key}`} className="st-s-iconbtn st-round-btn st-sc-tool" aria-label={`Move scene ${n} up`} aria-disabled={i === 0 || undefined} onClick={() => move(i, -1)}>
                    <span aria-hidden="true">↑</span>
                  </button>
                  <button type="button" id={`${prefix}-down-${s.key}`} className="st-s-iconbtn st-round-btn st-sc-tool" aria-label={`Move scene ${n} down`} aria-disabled={i === count - 1 || undefined} onClick={() => move(i, 1)}>
                    <span aria-hidden="true">↓</span>
                  </button>
                  <button type="button" className="st-s-iconbtn st-round-btn st-sc-tool" aria-label={`Take out scene ${n}`} onClick={() => takeOut(i)}>
                    <span aria-hidden="true">✕</span>
                  </button>
                </span>
              </div>
              <SceneField
                id={`${prefix}-what-${s.key}`}
                label="What happens"
                multiline
                value={s.what}
                max={OWN.what}
                placeholder={i === 0 ? "For example: Dash wakes up late." : "What happens next?"}
                onChange={(v) => setScene(s.key, (x) => ({ ...x, what: v }))}
              />
              <SceneField
                id={`${prefix}-cap-${s.key}`}
                label="Caption"
                value={s.caption}
                max={OWN.caption}
                placeholder="Words on screen, or skip"
                onChange={(v) => setScene(s.key, (x) => ({ ...x, caption: v }))}
              />
              <div className="st-sc-scene__meta">
                <div className="st-sc-who" role="group" aria-label={`Who is in scene ${n}`}>
                  <span className="st-sc-who__label">{who.length ? "Who:" : "Who: AI picks"}</span>
                  {castChars.map((c) => (
                    <Chip
                      key={c.characterId}
                      on={who.includes(c.characterId)}
                      onToggle={() => setScene(s.key, (x, d) => {
                        const now = sceneWho(x, d, cast, characters);
                        return { ...x, who: now.includes(c.characterId) ? now.filter((id) => id !== c.characterId) : [...now, c.characterId] };
                      })}
                    >
                      {c.name}
                    </Chip>
                  ))}
                </div>
                <button type="button" className="st-pill st-pill--small st-sc-where" aria-haspopup="dialog" onClick={() => setPlaceFor(s.key)}>
                  Where: {placeLabel(place) ?? "AI picks"} <span aria-hidden="true">▾</span>
                </button>
              </div>
              {mine.map(({ ask }, k) => (
                <AskRow
                  key={ask.name}
                  id={k === 0 ? `${prefix}-ask-${s.key}` : undefined}
                  ask={ask}
                  cast={castChars}
                  // a car's own name in words about a car ("drives his Ferrari"): the workspace's cars may be it
                  others={onAddToCast && saysCar(s.what) ? characters.filter((c) => isCar(c) && !cast.includes(c.characterId) && !addWhy?.(c.characterId)) : []}
                  onAnswer={(to) => {
                    // someone not in the cast yet joins it first, then is the answer
                    if (!cast.includes(to) && onAddToCast) onAddToCast(to);
                    answer(ask, to);
                  }}
                  onAdd={onAddToCast}
                  addWhy={addWhy}
                />
              ))}
            </li>
          );
        })}
      </ol>
      {count > OWN.max ? (
        <p className="st-s-field__problem st-sc-over" role="alert">
          Up to 12 scenes. Join some, or take some out.
        </p>
      ) : null}
      <div className="st-sc-addrow">
        {count < OWN.max ? (
          <button type="button" id={`${prefix}-add`} className="st-btn st-sc-add" onClick={add}>
            + Add a scene
          </button>
        ) : null}
        <span className="st-s-field__hint">2 to 12 scenes.</span>
      </div>
      <ScriptPreview draft={draft} cast={cast} characters={characters} lengthSec={lengthSec} asking={new Set(asks.map((a) => a.scene))} prefix={prefix} />
      {(() => {
        // someone in the cast that no scene has: never drawn (a car the words never name, say), so the page says so
        const idle = castInNoScene(draft, cast, characters)
          .map((id) => characters.find((c) => c.characterId === id)?.name)
          .filter((n): n is string => !!n);
        return idle.length ? (
          <p className="st-s-field__hint st-sc-idle" role="status">
            {idle.join(" and ")} {idle.length === 1 ? "isn't" : "aren't"} in any scene. Tick {idle.length === 1 ? idle[0] : "them"} in a scene&apos;s Who, or take {idle.length === 1 ? idle[0] : "them"} out of the cast.
          </p>
        ) : null;
      })()}
      {replaceAsk ? (
        <StSheet
          title="Replace your scenes?"
          onClose={() => setReplaceAsk(null)}
          actions={
            <>
              <button type="button" className="st-btn" onClick={() => setReplaceAsk(null)}>
                Keep mine
              </button>
              <button type="button" className="st-btn st-btn--main" onClick={() => replaceWith(replaceAsk)}>
                Replace
              </button>
            </>
          }
        >
          <p>
            {replaceAsk.length === 1 ? "1 scene" : `${replaceAsk.length} scenes`} from your script take the place of the scenes you wrote.
          </p>
        </StSheet>
      ) : null}
      {placeScene ? (
        <StSheet title={`Where is scene ${placeNo}?`} onClose={() => setPlaceFor(null)}>
          <div className="st-s-chips st-sc-places" role="group" aria-label={`Where is scene ${placeNo}?`}>
            {[{ id: "ai" as const, label: "AI picks" }, ...PLACES].map((p) => {
              const on = p.id === "ai" ? scenePlace(placeScene, draft, cast, characters) === null : scenePlace(placeScene, draft, cast, characters) === p.id;
              return (
                <Chip
                  key={p.id}
                  on={on}
                  onToggle={() => {
                    setScene(placeScene.key, (x) => ({ ...x, place: p.id }));
                    setPlaceFor(null);
                  }}
                >
                  {p.label}
                </Chip>
              );
            })}
          </div>
        </StSheet>
      ) : null}
    </div>
  );
}

/**
 * A question about a name in a scene: who it is ("It's Dash": one of the cast, or in words about a car one of the
 * workspace's cars, which then joins the cast; Not a name; or left out), or a character not in the cast.
 */
function AskRow({ id, ask, cast, others = [], onAnswer, onAdd, addWhy }: { id?: string; ask: Ask; cast: Character[]; others?: Character[]; onAnswer: (to: string) => void; onAdd?: (characterId: string) => void; addWhy?: (characterId: string) => string | null }) {
  const why = ask.kind === "outside" && onAdd ? (addWhy?.(ask.characterId) ?? null) : null;
  const words = ask.kind === "who" ? `Who is ${ask.name}?` : `${ask.name} isn't in the cast.`;
  return (
    <div className="st-sc-ask" id={id} role="group" aria-label={words}>
      <span className="st-sc-ask__q">{words}</span>
      <span className="st-sc-ask__answers">
        {ask.kind === "who"
          ? [...cast, ...others].map((c) => (
              <button key={c.characterId} type="button" className="st-pill st-pill--small" onClick={() => onAnswer(c.characterId)}>
                It&apos;s {c.name}
              </button>
            ))
          : onAdd ? (
              <button type="button" className="st-pill st-pill--small" aria-disabled={!!why || undefined} title={why ?? undefined} onClick={() => !why && onAdd(ask.characterId)}>
                Add {ask.name}
              </button>
            ) : null}
        {ask.kind === "who" ? (
          // a word with a capital that is no one ("Breakfast"): nothing is left out, and nobody is asked for it again
          <button type="button" className="st-pill st-pill--small" onClick={() => onAnswer("seen")}>
            Not a name
          </button>
        ) : null}
        <button type="button" className="st-pill st-pill--small" onClick={() => onAnswer("out")}>
          Leave {ask.name} out
        </button>
      </span>
      {why ? <span className="st-s-field__hint">{why}</span> : null}
    </div>
  );
}

/** "Your video": one small tile a scene, in order, and the total line (built from the same state as the list). */
function ScriptPreview({ draft, cast, characters, lengthSec, asking, prefix }: { draft: ScriptDraft; cast: string[]; characters: Character[]; lengthSec: number; asking: Set<number>; prefix: string }) {
  const titleId = useId();
  const own = toOwnScript(draft, cast, characters).scenes;
  const share = shares(lengthSec, own);
  const total = Math.round(fitTarget(lengthSec, own));
  const made = own.filter((s) => s.what);
  const captions = own.filter((s) => s.caption).length;
  if (!draft.scenes.some(written)) return null;
  const name = (id: string) => characters.find((c) => c.characterId === id)?.name ?? "";
  return (
    <section className="st-sc-preview" aria-labelledby={titleId}>
      <h3 className="st-sc-head__title" id={titleId}>
        Your video
      </h3>
      <ol className="st-sc-tiles">
        {own.map((s, i) => {
          const key = draft.scenes[i]!.key;
          return (
            <li key={key}>
              <button type="button" className={`st-sc-tile${asking.has(i) ? " is-asking" : ""}${s.what ? "" : " is-empty"}`} onClick={() => focusField(`${prefix}-what-${key}`)}>
                <span className="st-sc-tile__num">{i + 1}</span>
                <span className="st-sc-tile__place">{placeLabel(s.place) ?? "AI picks"}</span>
                <span className="st-sc-tile__who">{s.who?.length ? s.who.map(name).join(", ") : "AI picks"}</span>
                {s.caption ? <span className="st-sc-tile__words">“{s.caption}”</span> : null}
                <span className="st-sc-tile__time">about {share[i]} s</span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="st-s-field__hint st-sc-total">
        {made.length === 1 ? "1 scene" : `${made.length} scenes`} · about {total} seconds · {captions === 1 ? "1 caption" : `${captions} captions`}
      </p>
    </section>
  );
}

// ---------- The video's own page and Review ----------

/** A character's cast id in a script (people and cars). */
function keyOf(script: StoryScript, characterId: string): string | null {
  for (const [k, m] of Object.entries(script.cast)) if (m.characterId === characterId) return k;
  return null;
}

/** The "Your script" chip (glass, round): on a video made from the owner's own script. */
export function OwnChip() {
  return <span className="st-chip st-chip--sun st-sc-chip">Your script</span>;
}

/** Review's "Your script" panel: the owner's scenes as written, with who, where and what the agent said about them. */
export function ScriptPanel({ ws, own, script }: { ws: string; own: OwnScript; script: StoryScript | null }) {
  const chars = useLoad(() => storiesApi().listCharacters(ws), `${ws}:own-script-names`);
  const name = (id: string) => chars.data?.find((c) => c.characterId === id)?.name ?? script?.cast[keyOf(script, id) ?? ""]?.name ?? null;
  return (
    <section className="st-s-panel st-glass st-sc-panel" aria-labelledby="st-own-title">
      <h2 className="st-s-panel__title" id="st-own-title">
        Your script
      </h2>
      <ol className="st-sc-written">
        {own.scenes.map((s, i) => {
          const sc = script?.scenes.find((x) => x.sceneId === (s.sceneId ?? `s${i + 1}`)) ?? script?.scenes[i];
          const who = (s.who ?? []).map(name).filter(Boolean);
          return (
            <li key={s.sceneId ?? i} className="st-sc-written__scene">
              <span className="st-sc-scene__num">Scene {i + 1}</span>
              <span className="st-sc-written__what">{s.what}</span>
              {s.caption ? <span className="st-sc-written__words">“{s.caption}”</span> : null}
              <span className="st-sc-written__meta">
                {who.length ? who.join(", ") : "AI picks who"} · {placeLabel(s.place) ?? "AI picks where"}
              </span>
              {sc?.note ? <span className="st-s-field__hint">{sc.note}</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * Change my script (§45.46.8): the same scene list, filled from the video's script, and Make it again (the changes saved,
 * then the steps they made out of date run). No note box: the AI never changes what happens. `focus` opens it at a scene.
 */
export function ChangeScriptSheet({ ws, story, focus, why, onClose, onStarted }: { ws: string; story: Story; focus?: number | null; why?: string[]; onClose: () => void; onStarted: (r: { story: Story; job: ProductionJob }) => void }) {
  const toast = useToast();
  const chars = useLoad(() => storiesApi().listCharacters(ws), `${ws}:own-script-cast`);
  const characters = chars.data ?? null;
  const [draft, setDraft] = useState<ScriptDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The story as this sheet last saved it: a retry after a failed start sends its version, never the old one. */
  const [saved, setSaved] = useState<Story | null>(null);
  const opened = useRef(false);
  const cast = story.characterIds;

  useEffect(() => {
    if (!characters || draft || !story.ownScript) return;
    setDraft(draftFromOwn(story.ownScript, cast, characters));
  }, [characters, draft, story.ownScript, cast]);

  // Opened at a scene (Fix the words): that scene's words get the focus once they are drawn.
  useEffect(() => {
    if (!draft || opened.current) return;
    opened.current = true;
    const at = focus ? draft.scenes[focus - 1] : undefined;
    if (at) requestAnimationFrame(() => focusField(`st-scs-what-${at.key}`));
  }, [draft, focus]);

  async function again() {
    if (!draft || !characters || busy) return;
    const bad = scriptProblem(draft, cast, characters);
    if (bad) {
      setProblem(bad.text);
      focusField(fixId("st-scs", draft, bad.fix));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const own = toOwnScript(draft, cast, characters);
      let now = saved ?? story;
      if (!sameScript(own, now.ownScript)) {
        now = (await storiesApi().patchStory(ws, story.storyId, { version: now.version, ownScript: own })).story;
        setSaved(now);
      }
      const r = await storiesApi().produce(ws, story.storyId, now.stale.length ? {} : { from: "storyboard" });
      onStarted(r);
      toast.success("Making it again!");
      onClose();
    } catch (e) {
      setProblem(say(e));
      setBusy(false);
    }
  }

  return (
    <StSheet
      title="Change my script"
      wide
      className="st-sc-sheet"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="st-btn" onClick={onClose}>
            Keep it
          </button>
          <button type="button" className="st-btn st-btn--main" aria-disabled={busy || !draft || undefined} onClick={() => void again()}>
            {busy ? "Starting…" : "Make it again"}
          </button>
        </>
      }
    >
      {why?.length ? (
        // Fix the words: the reason stays in view while the owner changes the scene
        <Notice tone="bad">
          <ul className="st-s-list st-sc-why">
            {why.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {chars.error && !characters ? (
        <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void chars.reload()}>Try again</button>}>
          {chars.error}
        </Notice>
      ) : !draft || !characters ? (
        <Busy>Getting your script…</Busy>
      ) : (
        <ScriptEditor
          draft={draft}
          update={(fn) => {
            setProblem(null);
            setDraft((d) => (d ? fn(d) : d));
          }}
          characters={characters}
          cast={cast}
          lengthSec={story.durationSec}
          prefix="st-scs"
          note="Clips Funded sets up your scenes again. Your words stay as you write them."
        />
      )}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
    </StSheet>
  );
}
