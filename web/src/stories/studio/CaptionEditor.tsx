// The captions editor of Review (docs/CONTRACTS.md §45.16.6, §45.9, §45.34; spec §5.E "edit captions"): the words on
// the video (each caption's text, when it starts and how long it shows, plus each scene's own words, and captions on
// or off) and the six post captions, each with its platform's limit. Save sends only what changed; the API then marks
// the steps it makes out of date (captions, put together, ready to watch and the fact check), so Remake shows.
// "Write them again" asks the storyboard agent for new post captions (a captions task, with its own model menu): the
// draft shows next to the saved words, and only "Use these" saves it (PATCH postCaptions).
import { useMemo, useState } from "react";
import { storiesApi } from "../api/client.ts";
import type { AiTask, CaptionCue, Captions, CaptionsResult, ModelOverride, Story, StoryPatch, StoryScript } from "../api/types.ts";
import { cleanPick, LISTED_INFO, merged, ModelMenu, storyUsual, TaskLine, useAiTask, type AiInfo } from "./ai.tsx";
import { celebrate, Notice, Pick, Slider, Switch, TextField } from "./kit.tsx";
import { clock } from "./words.ts";

/** The platforms' own caption limits (the same as Lamo Clips', CONTRACTS §17.6). */
export const POST_LIMITS: Record<keyof Captions, number> = { youtubeTitle: 100, youtubeDescription: 5000, instagram: 2200, facebook: 5000, tiktok: 2200, x: 280 };

const POST_FIELDS: { key: keyof Captions; label: string; rows: number }[] = [
  { key: "youtubeTitle", label: "YouTube title", rows: 1 },
  { key: "youtubeDescription", label: "YouTube description", rows: 4 },
  { key: "tiktok", label: "TikTok", rows: 3 },
  { key: "instagram", label: "Instagram", rows: 3 },
  { key: "facebook", label: "Facebook", rows: 3 },
  { key: "x", label: "X", rows: 2 },
];

type Edit = Omit<StoryPatch, "version">;

/** Which scene a moment of the video falls in (1-based), for the caption rows. */
function sceneAt(script: StoryScript, t: number): number {
  let start = 0;
  for (let i = 0; i < script.scenes.length; i += 1) {
    start += script.scenes[i]!.durationSec;
    if (t < start) return i + 1;
  }
  return script.scenes.length;
}

/** The draft a finished "Write them again" task carries (result.postCaptions), filled out to all six; null when none. */
export function captionsDraft(task: AiTask): CaptionsResult | null {
  const r = task.result as Partial<CaptionsResult> | null;
  const p = r?.postCaptions as Partial<Captions> | undefined;
  if (!p || typeof p !== "object") return null;
  const keys = Object.keys(POST_LIMITS) as (keyof Captions)[];
  if (!keys.some((k) => typeof p[k] === "string")) return null;
  const postCaptions = Object.fromEntries(keys.map((k) => [k, typeof p[k] === "string" ? p[k]!.slice(0, POST_LIMITS[k]) : ""])) as unknown as Captions;
  return { storyId: typeof r?.storyId === "string" ? r.storyId : "", scriptVersion: typeof r?.scriptVersion === "number" ? r.scriptVersion : 0, postCaptions };
}

/** Why these captions cannot be saved, or null. */
export function captionsProblem(cues: CaptionCue[], total: number): string | null {
  for (const [i, c] of cues.entries()) {
    if (!c.text.trim()) return `Caption ${i + 1} has no words. Type some or remove it.`;
    if (c.text.length > 60) return `Caption ${i + 1} is too long: keep it to 60 letters.`;
    if (c.at + c.dur > total + 0.5) return `Caption ${i + 1} goes past the end of the video. Make it shorter or start it earlier.`;
  }
  return null;
}

export function CaptionEditor({
  ws,
  info = LISTED_INFO,
  story,
  script,
  saving,
  onSave,
}: {
  ws: string;
  info?: AiInfo;
  story: Story;
  script: StoryScript;
  saving: boolean;
  onSave: (e: Edit) => void;
}) {
  const total = useMemo(() => script.scenes.reduce((s, sc) => s + sc.durationSec, 0), [script]);
  const [tab, setTab] = useState<"video" | "posts">("video");
  const [cues, setCues] = useState<CaptionCue[]>(() => [...script.captions].sort((a, b) => a.at - b.at));
  const [on, setOn] = useState(script.captionsOn);
  const [sceneWords, setSceneWords] = useState<Record<string, string>>(() => Object.fromEntries(script.scenes.map((sc) => [sc.sceneId, sc.caption ?? ""])));
  const [posts, setPosts] = useState<Captions>(story.postCaptions);
  const [problem, setProblem] = useState<string | null>(null);
  /** "Write them again": the model and effort for that one run, and the draft it brought back. */
  const [pick, setPick] = useState<ModelOverride | null>(null);
  const [draft, setDraft] = useState<CaptionsResult | null>(null);
  const writeUsual = storyUsual(info, story, "captions");
  const writing = useAiTask(
    ws,
    (task) => {
      const d = captionsDraft(task);
      if (!d) return setProblem("No new words came back. Tap Write them again.");
      setDraft(d);
    },
    () => writeAgain(),
  );

  function writeAgain() {
    if (writing.phase === "working") return;
    setProblem(null);
    setDraft(null);
    const override = cleanPick(pick);
    void writing.start(() => storiesApi().writeCaptions(ws, story.storyId, override ? { override } : undefined));
  }

  /** "Use these": only the places whose words changed are saved (PATCH postCaptions). */
  function takeDraft(from: HTMLElement | null) {
    if (!draft) return;
    const changes = (Object.keys(POST_LIMITS) as (keyof Captions)[]).filter((k) => draft.postCaptions[k] !== story.postCaptions[k]);
    if (!changes.length) {
      setDraft(null);
      return;
    }
    setPosts(draft.postCaptions);
    celebrate(from, 60);
    onSave({ postCaptions: Object.fromEntries(changes.map((k) => [k, draft.postCaptions[k]])) });
  }

  const cuesChanged = JSON.stringify(cues) !== JSON.stringify([...script.captions].sort((a, b) => a.at - b.at));
  const sceneChanges = script.scenes.filter((sc) => (sceneWords[sc.sceneId] ?? "").trim() !== (sc.caption ?? "")).map((sc) => sc.sceneId);
  const videoDirty = cuesChanged || on !== script.captionsOn || sceneChanges.length > 0;
  const postChanges = (Object.keys(POST_LIMITS) as (keyof Captions)[]).filter((k) => posts[k] !== story.postCaptions[k]);

  const setCue = (id: string, patch: Partial<CaptionCue>) => {
    setProblem(null);
    setCues((list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  function addCue() {
    const last = cues[cues.length - 1];
    const at = Math.max(0, Math.min(total - 2, last ? last.at + last.dur + 0.2 : 0.5));
    setCues((list) => [...list, { id: `own-${Date.now().toString(36)}`, at: Math.round(at * 10) / 10, dur: 2, text: "" }]);
  }

  function saveVideo() {
    const why = captionsProblem(cues, total);
    if (why) return setProblem(why);
    if (sceneChanges.some((id) => (sceneWords[id] ?? "").length > 60)) return setProblem("Scene words can be up to 60 letters.");
    const edit: Edit = {};
    if (cuesChanged) edit.captions = cues.map((c) => ({ ...c, text: c.text.trim() }));
    if (on !== script.captionsOn) edit.captionsOn = on;
    if (sceneChanges.length) edit.scenes = sceneChanges.map((sceneId) => ({ sceneId, caption: (sceneWords[sceneId] ?? "").trim() || null }));
    onSave(edit);
  }

  function savePosts() {
    const over = postChanges.find((k) => posts[k].length > POST_LIMITS[k]);
    if (over) return setProblem(`The ${POST_FIELDS.find((f) => f.key === over)?.label} words are too long.`);
    onSave({ postCaptions: Object.fromEntries(postChanges.map((k) => [k, posts[k]])) });
  }

  return (
    <div className="st-s-editor-box">
      <Pick
        label="Which words"
        hideLabel
        value={tab}
        onChange={(t) => {
          setTab(t);
          setProblem(null);
        }}
        options={[
          { value: "video", label: "On the video" },
          { value: "posts", label: "With the post" },
        ]}
      />
      {tab === "video" ? (
        <div className="st-s-captions">
          <Switch label="Show captions" line="Short words on screen. The video has no talking." checked={on} onChange={setOn} />
          {cues.length ? (
            <ol className="st-s-cues">
              {cues.map((c, i) => (
                <li key={c.id} className="st-s-cue">
                  <span className="st-s-cue__head">
                    <strong>Caption {i + 1}</strong>
                    <span>
                      Scene {sceneAt(script, c.at)} · {clock(c.at)} to {clock(c.at + c.dur)}
                    </span>
                    <button type="button" className="st-btn st-s-small st-s-quiet" onClick={() => setCues((l) => l.filter((x) => x.id !== c.id))}>
                      Remove<span className="st-s-sr"> caption {i + 1}</span>
                    </button>
                  </span>
                  <TextField label="Words" value={c.text} max={60} onChange={(text) => setCue(c.id, { text })} />
                  <span className="st-s-cue__times">
                    <Slider label="Starts at" min={0} max={Math.max(0.5, Math.round((total - 0.5) * 10) / 10)} step={0.1} value={c.at} words={clock(c.at)} onChange={(at) => setCue(c.id, { at })} />
                    <Slider label="Shows for" min={0.5} max={10} step={0.1} value={c.dur} words={`${c.dur.toFixed(1)} s`} onChange={(dur) => setCue(c.id, { dur })} />
                  </span>
                  {c.guidanceRef ? <span className="st-s-field__hint">From the checked advice. If you change these words, the facts are checked again.</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="st-s-field__hint">No captions yet.</p>
          )}
          <button type="button" className="st-btn" onClick={addCue}>
            Add a caption
          </button>
          <fieldset className="st-s-group">
            <legend className="st-s-group__title">Words on each scene</legend>
            {script.scenes.map((sc, i) => (
              <TextField
                key={sc.sceneId}
                label={`Scene ${i + 1}: ${sc.title}`}
                value={sceneWords[sc.sceneId] ?? ""}
                max={60}
                placeholder="No words on this scene"
                onChange={(v) => {
                  setProblem(null);
                  setSceneWords((m) => ({ ...m, [sc.sceneId]: v }));
                }}
              />
            ))}
          </fieldset>
          {problem ? <Notice tone="bad">{problem}</Notice> : null}
          <div className="st-s-actionbar">
            <button type="button" className="st-btn st-btn--main" aria-disabled={!videoDirty || saving || undefined} onClick={() => videoDirty && !saving && saveVideo()}>
              {saving ? "Saving…" : videoDirty ? "Save captions" : "No changes yet"}
            </button>
          </div>
        </div>
      ) : (
        <div className="st-s-captions">
          <p className="st-s-field__hint">What each place shows with the video. Each one has its own limit.</p>
          <div className="st-s-aipair st-s-rewrite">
            <button type="button" className="st-btn" aria-disabled={writing.phase === "working" || saving || undefined} onClick={() => !saving && writeAgain()}>
              {writing.phase === "working" ? "Writing…" : "Write them again"}
            </button>
            <ModelMenu info={info} usual={writeUsual} value={pick} onChange={setPick} compact />
          </div>
          <TaskLine info={info} kind="captions" run={writing} expected={merged(info, writeUsual, pick)} />
          {draft ? (
            <section className="st-s-draftcaps" aria-labelledby="st-draftcaps-title">
              <h3 className="st-s-draftcaps__title" id="st-draftcaps-title">
                New words to look at
              </h3>
              <p className="st-s-field__hint">
                {draft.scriptVersion && draft.scriptVersion !== story.scriptVersion ? "Written from an older storyboard. " : ""}Nothing changes until you tap Use these.
              </p>
              <ul className="st-s-draftcaps__list">
                {POST_FIELDS.map((f) => {
                  const same = draft.postCaptions[f.key] === story.postCaptions[f.key];
                  return (
                    <li key={f.key} className={`st-s-draftcaps__row${same ? " is-same" : ""}`}>
                      <span className="st-s-draftcaps__place">
                        {f.label}
                        {same ? " (the same)" : ""}
                      </span>
                      <span className="st-s-draftcaps__pair">
                        <span className="st-s-draftcaps__was">
                          <span className="st-s-draftcaps__tag">Saved</span>
                          <span className="st-s-draftcaps__words">{story.postCaptions[f.key] || "No words yet"}</span>
                        </span>
                        <span className="st-s-draftcaps__new">
                          <span className="st-s-draftcaps__tag">New</span>
                          <span className="st-s-draftcaps__words">{draft.postCaptions[f.key] || "No words"}</span>
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="st-s-actionbar">
                <button type="button" className="st-btn" onClick={() => setDraft(null)}>
                  Keep the saved words
                </button>
                <button type="button" className="st-btn st-btn--main" aria-disabled={saving || undefined} onClick={(e) => !saving && takeDraft(e.currentTarget)}>
                  {saving ? "Saving…" : "Use these"}
                </button>
              </div>
            </section>
          ) : null}
          {POST_FIELDS.map((f) => (
            <TextField key={f.key} label={f.label} value={posts[f.key]} max={POST_LIMITS[f.key]} multiline={f.rows > 1} rows={f.rows} onChange={(v) => setPosts((p) => ({ ...p, [f.key]: v }))} hint={`Up to ${POST_LIMITS[f.key].toLocaleString("en-GB")} letters.`} />
          ))}
          {problem ? <Notice tone="bad">{problem}</Notice> : null}
          <div className="st-s-actionbar">
            <button type="button" className="st-btn st-btn--main" aria-disabled={!postChanges.length || saving || undefined} onClick={() => postChanges.length && !saving && savePosts()}>
              {saving ? "Saving…" : postChanges.length ? "Save post words" : "No changes yet"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
