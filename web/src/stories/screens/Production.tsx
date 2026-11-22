// Lamo Stories › Production (docs/CONTRACTS.md §45.9, §45.16.5, §45.25, §45.28, §45.34; spec §5.D). Make a new video
// (an idea or a short concept, the cast of 1 to 3, the length, captions, music, up to 3 reference videos to learn
// from, the shape and size, and the model and effort for this video, kept with it), filled in from the address
// (`?idea=`, `?ref=`, `?cast=`, `?sec=`: the chat's and a reference video's hand-over) and starting at a picked idea's
// own length; the list of every video being made or made with its eight-step track and Show more; and each video's own
// page: the step track, the storyboard filmstrip (live previews and the finished stills), Cancel, Try again (with its
// own "just this one" model and effort), "Next run: {model} · {effort}", and the production details with the model and
// effort that made each step. A running job is checked every 2 seconds.
import "../styles/studio.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { A } from "../../components/ui.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { storiesGoLater, useAppActive } from "../pane.tsx";
import { useLoad, usePoll } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import { starBurst } from "../ui.tsx";
import {
  STEP_LABEL,
  STEP_ORDER,
  type AiSetting,
  type Character,
  type GuidanceTopic,
  type Idea,
  type IdeaCategory,
  type ModelOverride,
  type MusicMood,
  type ProductionJob,
  type ReferenceVideo,
  type StoriesConfig,
  type Story,
  type StoryFormat,
  type StoryInput,
  type StoryScript,
} from "../api/types.ts";
import { CATALOG } from "../engine/catalog.ts";
import { CharacterPreview } from "../preview/CharacterPreview.tsx";
import { storiesHref } from "../routes.ts";
import { cleanPick, effortName, madeWith, ModelMenu, modelName, ModelsUsed, NextRun, SettingsFix, shortName, stoppedOn, StoryAi, storyUsual, useAiInfo, usualFor, type AiInfo } from "../studio/ai.tsx";
import { Filmstrip } from "../studio/Filmstrip.tsx";
import { usePaged, useSameScript, useWorkspace } from "../studio/hooks.ts";
import { formatOf, formatWords, sameFormat, ShapePicker } from "../studio/shape.tsx";
import { Busy, celebrate, Notice, Pick, ShowMore, Slider, Switch, Tag, TechDetails, TextField } from "../studio/kit.tsx";
import { showFace } from "../studio/looks.ts";
import { StepTrack } from "../studio/StepTrack.tsx";
import { ago, CATEGORY_LABEL, helpersLine, isConflict, NO_GUIDANCE, say, seconds, STATUS_LABEL, STATUS_TONE, STORAGE_WORDS } from "../studio/words.ts";
import { KIND_OPTIONS } from "./Ideas.tsx";
import type { StoriesScreenProps } from "./types.ts";

export function ProductionScreen({ ws, page }: StoriesScreenProps) {
  if (page.name === "production_new") {
    const refIds = page.refIds ?? [];
    const castIds = page.castIds ?? [];
    // A new hand-over (another chat button, another reference video) starts the form again from its address.
    const from = [page.ideaId ?? "", refIds.join(","), castIds.join(","), page.durationSec ?? ""].join("|");
    return <NewVideo key={from} ws={ws} ideaId={page.ideaId} refIds={refIds} castIds={castIds} durationSec={page.durationSec ?? null} />;
  }
  if (page.name === "production_story") return <StoryProduction ws={ws} storyId={page.storyId} />;
  return <ProductionList ws={ws} />;
}

/** A driving-safety idea no checked advice covers: it cannot become a video (§45.11.5). */
const blockedIdea = (i: Idea) => i.category === "driving_safety" && (i.needsGuidance || !i.safetyTopicId);

const isLive = (job: ProductionJob | null | undefined) => !!job && (job.status === "queued" || job.status === "running");

/** The music each kind of video starts with (the owner can change it). */
export const MOOD_FOR: Record<IdeaCategory, MusicMood> = { driving_safety: "tense", everyday_skills: "playful", comedy: "comedic", explainer: "wonder" };

// ---------- The list ----------

type Run = { story: Story; job: ProductionJob | null };

/** One page of videos, each with its latest job when it is being made or stopped (for its step track). */
async function runsPage(ws: string, cursor?: string): Promise<{ items: Run[]; nextCursor: string | null }> {
  const { stories, nextCursor } = await storiesApi().listStories(ws, cursor ? { status: "all", limit: 50, cursor } : { status: "all", limit: 50 });
  const items = await Promise.all(
    stories.map(async (story): Promise<Run> => {
      if (!(story.status === "producing" || story.status === "failed" || story.currentJobId)) return { story, job: null };
      try {
        return { story, job: (await storiesApi().getStory(ws, story.storyId)).job };
      } catch {
        return { story, job: null };
      }
    }),
  );
  return { items, nextCursor };
}

function ProductionList({ ws }: { ws: string }) {
  const list = usePaged((cursor) => runsPage(ws, cursor), ws, "st-production-runs", (r) => r.story.storyId);
  const all = list.data ?? [];
  const making = all.filter((r) => r.story.status === "producing" || r.story.status === "draft" || r.story.status === "failed");
  const made = all.filter((r) => !making.includes(r));
  // Not while Clip Factory is on screen (this page stays kept behind it): coming back reads it again at once.
  const active = useAppActive();
  usePoll(() => list.reload(), active && making.some((r) => r.story.status === "producing"), 2000);

  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div>
          <h1 className="st-s-head__title">Production</h1>
          <p className="st-s-head__lede">Every video being made, and every video made. Each one goes through eight steps.</p>
        </div>
        <A href={storiesHref({ name: "production_new", ideaId: null })} className="st-btn st-btn--main">
          Make a new video
        </A>
      </header>
      {list.error && !list.data ? (
        <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void list.reload()}>Try again</button>}>
          {list.error}
        </Notice>
      ) : !list.data ? (
        <Busy>Getting your videos…</Busy>
      ) : all.length === 0 ? (
        <div className="st-s-empty">
          <span className="st-s-empty__film" aria-hidden="true" />
          <h2 className="st-s-empty__title">No videos yet</h2>
          <p className="st-s-empty__text">Pick an idea and a character, and Lamo Stories makes the whole video.</p>
          <A href={storiesHref({ name: "production_new", ideaId: null })} className="st-btn st-btn--main">
            Make your first video
          </A>
        </div>
      ) : (
        <>
          {making.length ? (
            <>
              <h2 className="st-s-section">Being made</h2>
              <ul className="st-s-runs">
                {making.map((r) => (
                  <RunRow key={r.story.storyId} story={r.story} job={r.job} />
                ))}
              </ul>
            </>
          ) : null}
          {made.length ? (
            <>
              <h2 className="st-s-section">Made</h2>
              <ul className="st-s-runs">
                {made.map((r) => (
                  <RunRow key={r.story.storyId} story={r.story} job={r.job} />
                ))}
              </ul>
            </>
          ) : null}
          <ShowMore list={list} what="videos" />
        </>
      )}
    </section>
  );
}

function RunRow({ story, job }: { story: Story; job: ProductionJob | null }) {
  const href = storiesHref({ name: "production_story", storyId: story.storyId });
  const watch = ["review", "needs_check", "approved", "published"].includes(story.status);
  return (
    <li className="st-s-run">
      <A href={href} className="st-s-run__cover" aria-label={`Open ${story.title}`}>
        {story.coverUrl ? <img src={story.coverUrl} alt="" width={54} height={96} /> : <span className="st-s-run__blank" aria-hidden="true" />}
      </A>
      <span className="st-s-run__body">
        <span className="st-s-run__top">
          <A href={href} className="st-s-run__title">
            {story.title}
          </A>
          <Tag tone={STATUS_TONE[story.status]}>{STATUS_LABEL[story.status]}</Tag>
        </span>
        <span className="st-s-run__meta">
          {CATEGORY_LABEL[story.category]} · {seconds(story.actualDurationSec ?? story.durationSec)} · {ago(story.updatedAt)}
        </span>
        <StepTrack job={isLive(job) || story.status === "failed" ? job : null} story={story} compact label={`Making ${story.title}`} />
      </span>
      <span className="st-s-run__go">
        {watch ? (
          <A href={storiesHref({ name: "review_story", storyId: story.storyId })} className="st-btn">
            Watch it
          </A>
        ) : (
          <A href={href} className="st-btn">
            Open
          </A>
        )}
      </span>
    </li>
  );
}

// ---------- Make a new video ----------

function NewVideo({ ws, ideaId, refIds: givenRefs, castIds, durationSec }: { ws: string; ideaId: string | null; refIds: string[]; castIds: string[]; durationSec: number | null }) {
  const toast = useToast();
  const workspace = useWorkspace(ws);
  const cfg = (workspace?.configuration ?? {}) as Partial<StoriesConfig>;
  const data = useLoad(
    async () => {
      const [ideas, characters] = await Promise.all([storiesApi().listIdeas(ws, "all"), storiesApi().listCharacters(ws)]);
      return { ideas, characters };
    },
    ws,
  );
  const [topics, setTopics] = useState<GuidanceTopic[] | null>(null);
  const [source, setSource] = useState<"idea" | "own">("idea");
  const [picked, setPicked] = useState<string>(ideaId ?? "");
  const [title, setTitle] = useState("");
  const [logline, setLogline] = useState("");
  const [category, setCategory] = useState<IdeaCategory | "">("");
  // The address may bring the cast, the length and the reference videos (the chat's or a reference video's hand-over).
  const [cast, setCast] = useState<string[]>(() => castIds.slice(0, 3));
  const castTouched = useRef(castIds.length > 0);
  const [length, setLength] = useState<number | null>(durationSec);
  const [shape, setShape] = useState<StoryFormat | null>(null);
  const [captions, setCaptions] = useState<boolean | null>(null);
  const [mood, setMood] = useState<MusicMood | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [noAdvice, setNoAdvice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refIds, setRefIds] = useState<string[]>(() => givenRefs.slice(0, 3));
  const [ai, setAi] = useState<ModelOverride | null>(null);
  const info = useAiInfo(ws);
  const refs = useLoad(() => storiesApi().listReferences(ws), ws, "st-s-refvids");

  useEffect(() => {
    let live = true;
    storiesApi()
      .guidance(ws)
      .then((g) => live && setTopics(g.topics))
      .catch(() => live && setTopics(null));
    return () => {
      live = false;
    };
  }, [ws]);

  const ideas = useMemo(() => data.data?.ideas ?? [], [data.data]);
  const characters = useMemo(() => data.data?.characters ?? [], [data.data]);
  const usable = ideas.filter((i) => !blockedIdea(i));
  const idea = ideas.find((i) => i.ideaId === picked) ?? null;

  // With no ideas saved, the short form is the way in.
  useEffect(() => {
    if (data.data && !data.data.ideas.some((i) => !blockedIdea(i)) && !ideaId) setSource("own");
  }, [data.data, ideaId]);

  // The idea's own characters come along until the owner picks the cast himself (or the address brought one).
  useEffect(() => {
    if (castTouched.current || !idea?.characterIds?.length) return;
    setCast(idea.characterIds.filter((id) => characters.some((c) => c.characterId === id)).slice(0, 3));
  }, [idea, characters]);

  // Reference videos from the address keep only this workspace's own (a deleted one is dropped, so it never uses up
  // one of the 3 picks without a tile to unpick it).
  useEffect(() => {
    const list = refs.data;
    if (!list || !givenRefs.length) return;
    setRefIds((ids) => ids.filter((id) => list.some((r) => r.refId === id)));
    // Once, when the reference videos arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs.data]);

  // A cast from the address keeps only this workspace's own characters.
  useEffect(() => {
    if (!data.data || !castIds.length) return;
    setCast((c) => c.filter((id) => characters.some((x) => x.characterId === id)));
    // Once, when the characters arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.data]);

  const kind: IdeaCategory | "" = source === "idea" ? (idea?.category ?? "") : category;
  // The length: the owner's, else the address's, else a picked idea's own (its full idea was written for it), else
  // the workspace's default.
  const ideaLength = source === "idea" ? (idea?.concept?.durationSec ?? null) : null;
  const lengthSec = Math.min(90, Math.max(15, length ?? ideaLength ?? cfg.defaultDurationSec ?? 45));
  const usualShape = formatOf(workspace ? cfg : null);
  const format = shape ?? usualShape;
  const captionsOn = captions ?? cfg.captionsOn ?? true;
  const music: MusicMood = mood ?? (cfg.musicOn === false ? "none" : kind ? MOOD_FOR[kind] : "playful");

  function toggleCast(id: string) {
    castTouched.current = true;
    setProblem(null);
    setCast((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= 3 ? c : [...c, id]));
  }

  function check(): string | null {
    if (source === "idea") {
      if (!idea) return "Pick an idea, or tap Type my own.";
      if (blockedIdea(idea)) return NO_GUIDANCE;
    } else {
      if (!title.trim()) return "Give the video a title.";
      if (!logline.trim()) return "Write one line about what happens.";
      if (!category) return "Pick what kind of video it is.";
    }
    if (!cast.length) return "Pick at least one character.";
    return null;
  }

  async function make() {
    const why = check();
    setNoAdvice(why === NO_GUIDANCE);
    if (why) return setProblem(why);
    setBusy(true);
    setProblem(null);
    const body: StoryInput = { characterIds: cast, durationSec: lengthSec, captionsOn, musicMood: music };
    // This video's own shape, only when the owner picked one that is not the workspace's (§45.34). Nothing picked:
    // the API uses Settings › Video itself (also while it has not loaded here, or could not be read).
    if (shape && (!workspace || !sameFormat(shape, usualShape))) body.format = { ...shape };
    const own = cleanPick(ai);
    if (own) body.ai = { model: own.model ?? null, effort: own.effort ?? null };
    const usable = refIds.filter((id) => refs.data?.some((r) => r.refId === id));
    if (usable.length) body.referenceIds = usable;
    if (source === "idea" && idea) body.ideaId = idea.ideaId;
    else body.brief = { title: title.trim(), logline: logline.trim(), category: category as IdeaCategory };
    try {
      const { story } = await storiesApi().createStory(ws, body);
      celebrate(document.querySelector(".st-make"), 100);
      toast.success("Making your video now!");
      storiesGoLater(storiesHref({ name: "production_story", storyId: story.storyId }));
    } catch (e) {
      const msg = say(e);
      setNoAdvice(isConflict(e) && /checked advice/i.test(msg));
      setProblem(msg);
      setBusy(false);
    }
  }

  if (data.error && !data.data)
    return (
      <section className="st-page st-studio">
        <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void data.reload()}>Try again</button>}>
          {data.error}
        </Notice>
      </section>
    );

  const blockedCount = ideas.filter(blockedIdea).length;
  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div>
          <A href={storiesHref({ name: "production" })} className="st-s-back">
            ‹ Production
          </A>
          <h1 className="st-s-head__title">Make a new video</h1>
          <p className="st-s-head__lede">A few quick picks, then Lamo Stories writes, draws, animates and puts it all together.</p>
        </div>
      </header>
      {!data.data ? (
        <Busy>Getting your ideas and characters…</Busy>
      ) : (
        <div className="st-s-newvideo">
          <section className="st-s-panel" aria-labelledby="st-nv-1">
            <h2 className="st-s-panel__title" id="st-nv-1">
              <span className="st-s-num">1</span> The idea
            </h2>
            <Pick
              label="Where the idea comes from"
              hideLabel
              value={source}
              options={[
                { value: "idea", label: "Use an idea" },
                { value: "own", label: "Type my own" },
              ]}
              onChange={(v) => {
                setSource(v);
                setProblem(null);
              }}
            />
            {source === "idea" ? (
              usable.length || idea ? (
                <>
                  {idea && blockedIdea(idea) ? (
                    <Notice tone="bad">
                      “{idea.title}”: {NO_GUIDANCE}
                    </Notice>
                  ) : null}
                  <Pick
                    label="Pick an idea"
                    big
                    value={idea && !blockedIdea(idea) ? idea.ideaId : ""}
                    options={usable.map((i) => ({ value: i.ideaId, label: i.title, line: `${CATEGORY_LABEL[i.category]} · ${i.logline}` }))}
                    onChange={(v) => {
                      setPicked(v);
                      setProblem(null);
                    }}
                    className="st-s-ideapick"
                  />
                  {blockedCount ? (
                    <p className="st-s-field__hint">
                      {blockedCount === 1 ? "1 driving-safety idea needs" : `${blockedCount} driving-safety ideas need`} checked advice first, so {blockedCount === 1 ? "it is" : "they are"} not here.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="st-s-field__hint">
                  No ideas to use yet. Tap Type my own, or save some on the <A href={storiesHref({ name: "ideas" })}>Ideas</A> page.
                </p>
              )
            ) : (
              <>
                <TextField label="Title" value={title} onChange={setTitle} max={80} placeholder="For example: Dash learns to juggle" />
                <TextField label="What happens, in one line" value={logline} onChange={setLogline} max={280} multiline rows={2} placeholder="For example: Dash drops every ball, then finds the trick." />
                <Pick label="What kind of video?" big value={category} options={KIND_OPTIONS} onChange={setCategory} />
              </>
            )}
          </section>

          <section className="st-s-panel" aria-labelledby="st-nv-2">
            <h2 className="st-s-panel__title" id="st-nv-2">
              <span className="st-s-num">2</span> The cast <span className="st-s-panel__hint">(1 to 3)</span>
            </h2>
            {characters.length ? (
              <ul className="st-s-castpick">
                {characters.map((c) => (
                  <CastTile key={c.characterId} c={c} on={cast.includes(c.characterId)} full={cast.length >= 3} onToggle={() => toggleCast(c.characterId)} />
                ))}
              </ul>
            ) : (
              <p className="st-s-field__hint">
                You have no characters yet. <A href={storiesHref({ name: "character_new" })}>Make one first</A>.
              </p>
            )}
          </section>

          <section className="st-s-panel" aria-labelledby="st-nv-3">
            <h2 className="st-s-panel__title" id="st-nv-3">
              <span className="st-s-num">3</span> How long
            </h2>
            <Slider label="Length" min={15} max={90} step={5} value={lengthSec} onChange={setLength} words={seconds(lengthSec)} marks={{ from: 30, to: 60, label: "30 to 60 seconds works best." }} />
            {length === null && ideaLength ? <p className="st-s-field__hint">The full idea was written for {seconds(ideaLength)}.</p> : null}
          </section>

          <section className="st-s-panel" aria-labelledby="st-nv-shape">
            <h2 className="st-s-panel__title" id="st-nv-shape">
              <span className="st-s-num">4</span> Shape and size
            </h2>
            <ShapePicker value={format} usual={usualShape} onChange={setShape} usualKnown={!!workspace} picked={shape !== null} />
          </section>

          <section className="st-s-panel" aria-labelledby="st-nv-4">
            <h2 className="st-s-panel__title" id="st-nv-4">
              <span className="st-s-num">5</span> Words and music
            </h2>
            <Switch label="Captions" line="Short words on screen. No talking in Lamo Stories videos." checked={captionsOn} onChange={setCaptions} />
            <Pick label="Music" value={music} options={CATALOG.musicMoods.map((m) => ({ value: m.id, label: m.id === "none" ? "No music" : m.label }))} onChange={setMood} />
          </section>

          <section className="st-s-panel" aria-labelledby="st-nv-5">
            <h2 className="st-s-panel__title" id="st-nv-5">
              <span className="st-s-num">6</span> Videos to learn from <span className="st-s-panel__hint">(you can skip this)</span>
            </h2>
            <RefPicker refs={refs.data} error={refs.error} onRetry={() => void refs.reload()} picked={refIds} onChange={setRefIds} />
          </section>

          <section className="st-s-panel" aria-labelledby="st-nv-6">
            <h2 className="st-s-panel__title" id="st-nv-6">
              <span className="st-s-num">7</span> Model and effort for this video
            </h2>
            <p className="st-s-field__hint">The AI that writes and checks this video. It stays with the video, so its remakes use it too.</p>
            <div className="st-s-aiwho">
              <ModelMenu
                info={info}
                usual={usualFor(info, "storyboard")}
                value={ai}
                onChange={setAi}
                title="Model and effort for this video"
                note="Kept with this video. Its remakes use it too. Your other settings stay the same."
              />
            </div>
          </section>

          {problem ? (
            <Notice tone="bad">
              {problem}
              {noAdvice && topics?.length ? (
                <span className="st-s-topics">
                  Checked advice covers: {topics.map((t) => t.title).join(" · ")}.
                </span>
              ) : null}
            </Notice>
          ) : null}
          <div className="st-s-actionbar st-s-actionbar--pin">
            <button type="button" className="st-btn st-btn--main st-s-big st-make" aria-disabled={busy || undefined} onClick={() => !busy && void make()}>
              {busy ? "Starting…" : "Make the video"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Up to 3 reference videos whose analyses the writer reads (§45.28); only analysed ones can be picked. */
function RefPicker({
  refs,
  error,
  onRetry,
  picked,
  onChange,
}: {
  refs: ReferenceVideo[] | null;
  error: string | null;
  onRetry: () => void;
  picked: string[];
  onChange: (ids: string[]) => void;
}) {
  if (error && !refs)
    return (
      <Notice tone="info" action={<button type="button" className="st-btn" onClick={onRetry}>Try again</button>}>
        Your reference videos could not load. You can make the video without them.
      </Notice>
    );
  if (!refs) return <p className="st-s-field__hint">Getting your reference videos…</p>;
  if (!refs.length)
    return (
      <p className="st-s-field__hint">
        No reference videos yet. Upload one in <A href={storiesHref({ name: "references" })}>References</A> and Lamo Stories studies how it is made.
      </p>
    );
  // Only the picks that have a tile count (one that is not in the list can never be unpicked).
  const full = picked.filter((id) => refs.some((r) => r.refId === id)).length >= 3;
  return (
    <>
      <p className="st-s-field__hint">Pick up to 3. Lamo Stories borrows their timing and structure, never their characters or footage.</p>
      <ul className="st-s-refpick">
        {refs.map((r) => {
          const on = picked.includes(r.refId);
          const ready = r.status === "analyzed";
          const off = !on && (full || !ready);
          return (
            <li key={r.refId}>
              <button
                type="button"
                className={`st-s-reftile${on ? " is-on" : ""}`}
                aria-pressed={on}
                aria-disabled={off || undefined}
                title={!ready ? "Analyze it first in References." : off ? "Pick up to 3 reference videos." : undefined}
                onClick={() => {
                  if (off) return;
                  onChange(on ? picked.filter((x) => x !== r.refId) : [...picked, r.refId]);
                }}
              >
                <span className="st-s-reftile__tick" aria-hidden="true">
                  {on ? "✓" : "+"}
                </span>
                <span className="st-s-reftile__text">
                  <span className="st-s-reftile__title">{r.title}</span>
                  <span className="st-s-reftile__meta">{ready ? (r.durationSec ? seconds(r.durationSec) : "Studied") : r.status === "analyzing" ? "Being studied now" : "Not studied yet"}</span>
                </span>
              </button>
              {!ready && r.status !== "analyzing" ? (
                <A href={storiesHref({ name: "reference", refId: r.refId })} className="st-btn st-s-small">
                  Study it
                </A>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function CastTile({ c, on, full, onToggle }: { c: Character; on: boolean; full: boolean; onToggle: () => void }) {
  const off = !on && full;
  return (
    <li>
      <button
        type="button"
        className={`st-s-casttile${on ? " is-on" : ""}`}
        aria-pressed={on}
        aria-disabled={off || undefined}
        title={off ? "Pick up to 3 characters." : undefined}
        onClick={() => !off && onToggle()}
      >
        <CharacterPreview look={c.look} movementStyle={c.movementStyle} expression={on ? showFace(c) : "neutral"} action={on ? "wave" : "idle"} size={88} playing={on} label={c.name} />
        <span className="st-s-casttile__name">{c.name}</span>
        <span className="st-s-casttile__tick" aria-hidden="true">
          {on ? "✓" : "+"}
        </span>
      </button>
    </li>
  );
}

// ---------- One video's production page ----------

function StoryProduction({ ws, storyId }: { ws: string; storyId: string }) {
  const toast = useToast();
  const loaded = useLoad(() => storiesApi().getStory(ws, storyId), `${ws}:${storyId}`);
  const jobs = useLoad(() => storiesApi().storyJobs(ws, storyId), `${ws}:${storyId}:jobs`);
  const [busy, setBusy] = useState<"none" | "cancel" | "again" | "ai">("none");
  const [problem, setProblem] = useState<string | null>(null);
  const [pick, setPick] = useState<ModelOverride | null>(null);
  const info = useAiInfo(ws);
  const refs = useLoad(() => storiesApi().listReferences(ws), ws, "st-s-refvids");
  const wasLive = useRef(false);
  const story = loaded.data?.story ?? null;
  const job = loaded.data?.job ?? null;
  const script: StoryScript | null = useSameScript(loaded.data?.script ?? null);
  const live = isLive(job) || story?.status === "producing";

  // Not while Clip Factory is on screen: a run that finished meanwhile is noticed, and celebrated, once this page is
  // back on screen (never confetti or a toast over Clip Factory).
  const active = useAppActive();
  usePoll(() => loaded.reload(), live && active, 2000);

  // A run that finishes while the owner watches gets its celebration.
  useEffect(() => {
    if (live) {
      wasLive.current = true;
      return;
    }
    if (!wasLive.current || !story) return;
    wasLive.current = false;
    void jobs.reload();
    if (story.status === "review") {
      starBurst(undefined, 120);
      toast.success("Your video is ready to watch!");
    } else if (story.status === "needs_check") toast.info("Your video is made. Some facts need checking in Review.");
    else if (story.status === "failed") toast.error(job?.status === "failed" && job.error ? job.error : "Making the video stopped. Tap Try again.");
    // Only when the run state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, story?.status]);

  async function cancel() {
    setBusy("cancel");
    setProblem(null);
    try {
      const r = await storiesApi().cancelStory(ws, storyId);
      loaded.setData((d) => (d ? { ...d, story: r.story, job: r.job } : d));
      wasLive.current = false;
      toast.info("Stopped. Tap Try again to carry on later.");
    } catch (e) {
      setProblem(say(e));
    } finally {
      setBusy("none");
    }
  }

  async function again() {
    setBusy("again");
    setProblem(null);
    try {
      const override = cleanPick(pick);
      const r = override ? await storiesApi().produce(ws, storyId, { override }) : await storiesApi().produce(ws, storyId);
      loaded.setData((d) => (d ? { ...d, story: r.story, job: r.job } : d));
      setPick(null);
      void jobs.reload();
    } catch (e) {
      setProblem(say(e));
    } finally {
      setBusy("none");
    }
  }

  /** The video's own model and effort (kept with it); only while it waits for review, never during a run. */
  async function keepAi(next: ModelOverride | null) {
    if (!story) return;
    setBusy("ai");
    setProblem(null);
    try {
      const ai: AiSetting = { model: next?.model ?? null, effort: next?.effort ?? null };
      const r = await storiesApi().patchStory(ws, storyId, { version: story.version, ai });
      loaded.setData((d) => (d ? { ...d, story: r.story, script: r.script ?? d.script } : d));
      toast.success(next ? "Kept with this video. Its next remake uses it." : "This video uses your usual settings again.");
    } catch (e) {
      setProblem(say(e));
    } finally {
      setBusy("none");
    }
  }

  const firstStale = useMemo(() => STEP_ORDER.find((k) => story?.stale.includes(k)) ?? null, [story]);

  if (loaded.error && !story)
    return (
      <section className="st-page st-studio">
        <Notice tone="bad" action={<A href={storiesHref({ name: "production" })} className="st-btn">Back to Production</A>}>
          {loaded.error}
        </Notice>
      </section>
    );
  if (!story)
    return (
      <section className="st-page st-studio">
        <Busy>Getting the video…</Busy>
      </section>
    );

  const canTryAgain = !live && ["draft", "failed", "review", "needs_check"].includes(story.status) && story.stale.length > 0;
  const watch = ["review", "needs_check", "approved", "published"].includes(story.status);
  // The writer of the storyboard in the video now: the latest run's, else the newest run that wrote it.
  const wrote = job?.meta.writerModel ?? (live ? null : (madeWith([job, ...(jobs.data ?? [])]).find((u) => u.step === "storyboard" && u.task !== "captions")?.model ?? null));
  const writer = wrote ? modelName(info, wrote) : null;
  const editable = !live && ["review", "needs_check", "failed"].includes(story.status);
  const usual = storyUsual(info, story);

  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div>
          <A href={storiesHref({ name: "production" })} className="st-s-back">
            ‹ Production
          </A>
          <h1 className="st-s-head__title">{story.title}</h1>
          <p className="st-s-head__lede">
            <Tag tone={STATUS_TONE[story.status]}>{STATUS_LABEL[story.status]}</Tag> {CATEGORY_LABEL[story.category]} · {seconds(story.actualDurationSec ?? story.durationSec)}
          </p>
        </div>
        <div className="st-s-head__actions">
          {watch ? (
            <A href={storiesHref({ name: "review_story", storyId })} className="st-btn st-btn--main">
              {story.status === "needs_check" ? "Check it in Review" : "Watch it in Review"}
            </A>
          ) : null}
        </div>
      </header>

      <section className="st-s-panel" aria-label="The steps">
        <StepTrack job={job} story={story} label={`Making ${story.title}`} />
        {problem ? <Notice tone="bad">{problem}</Notice> : null}
        <div className="st-s-actionbar">
          {live ? (
            <button type="button" className="st-btn" aria-disabled={busy !== "none" || undefined} onClick={() => busy === "none" && void cancel()}>
              {busy === "cancel" ? "Stopping…" : "Cancel"}
            </button>
          ) : null}
          {canTryAgain && !pick ? <NextRun info={info} story={story} /> : null}
          {canTryAgain ? (
            <>
              <ModelMenu info={info} usual={usual} value={pick} onChange={setPick} note="Just for this run. This video's own setting and yours stay the same." />
              <button type="button" className="st-btn st-btn--main" aria-disabled={busy !== "none" || undefined} onClick={() => busy === "none" && void again()}>
                {busy === "again" ? "Starting…" : story.status === "draft" && story.stale.length === STEP_ORDER.length ? "Make the video" : firstStale ? `Try again from “${STEP_LABEL[firstStale]}”` : "Try again"}
              </button>
              {job?.status === "failed" ? <SettingsFix sentence={job.error} /> : null}
            </>
          ) : null}
        </div>
      </section>

      <section className="st-s-panel" aria-labelledby="st-board-title">
        <h2 className="st-s-panel__title" id="st-board-title">
          Storyboard
        </h2>
        {story.scenes.length ? (
          <>
            <p className="st-s-field__hint">Tap a scene to play it. The finished pictures appear once the scenes are drawn.</p>
            <Filmstrip script={script} scenes={story.scenes} />
          </>
        ) : (
          <p className="st-s-field__hint">{live ? "Writing the story… the scenes show here in a moment." : "No storyboard yet."}</p>
        )}
      </section>

      <details className="st-s-details">
        <summary className="st-s-details__sum">Production details</summary>
        <dl className="st-s-facts">
          {writer ? (
            <>
              <dt>Writer</dt>
              <dd>{writer}</dd>
            </>
          ) : null}
          <dt>Storyboard version</dt>
          <dd>{story.scriptVersion || "Not written yet"}</dd>
          <dt>Length</dt>
          <dd>
            Aim {seconds(story.durationSec)}
            {story.actualDurationSec ? `, made ${seconds(story.actualDurationSec)}` : ""}
          </dd>
          <dt>Size</dt>
          <dd>{formatWords(story.format)}, 30 frames a second</dd>
          {job ? (
            <>
              <dt>Helpers used</dt>
              <dd>{helpersLine(job.meta.providers) || "Lamo Stories' own built-in helpers"}</dd>
            </>
          ) : null}
          <dt>Model and effort for this video</dt>
          <dd>
            <StoryAi info={info} story={story} editable={editable && busy === "none"} onChange={(v) => void keepAi(v)} />
            <NextRun info={info} story={story} />
          </dd>
          {story.referenceIds.length ? (
            <>
              <dt>Videos it learns from</dt>
              <dd>{story.referenceIds.map((id) => refs.data?.find((r) => r.refId === id)?.title ?? "A reference video").join(", ")}</dd>
            </>
          ) : null}
          <dt>Saved in</dt>
          <dd>{STORAGE_WORDS}</dd>
        </dl>
        <ModelsUsed info={info} job={job} jobs={jobs.data} title={live ? "Models working on it" : "Made with"} />
        <TechDetails>
          <dl className="st-s-techfacts">
            <dt>Folder</dt>
            <dd className="st-s-facts__mono">{story.storageLocation}</dd>
            {job?.meta.engineVersion ? (
              <>
                <dt>Drawing engine</dt>
                <dd>Version {job.meta.engineVersion}</dd>
              </>
            ) : null}
            {script ? (
              <>
                <dt>Seed</dt>
                <dd>{script.seed}</dd>
              </>
            ) : null}
          </dl>
        </TechDetails>
        {jobs.data?.length ? (
          <>
            <h3 className="st-s-details__title">Every run</h3>
            <ul className="st-s-jobs">
              {jobs.data.map((j) => (
                <li key={j.jobId}>
                  <Tag tone={j.status === "failed" ? "coral" : j.status === "ready" ? "mint" : j.status === "needs_check" ? "coral" : "plain"}>
                    {j.status === "ready" ? "Done" : j.status === "needs_check" ? "Facts to check" : j.status === "failed" ? "Stopped" : j.status === "canceled" ? "Cancelled" : "Working"}
                  </Tag>{" "}
                  {j.jobType === "changes" ? (j.configuration.note ? "Changes" : "New take of a scene") : j.configuration.from ? `Again from “${STEP_LABEL[j.configuration.from as keyof typeof STEP_LABEL] ?? j.configuration.from}”` : "Made"} · {ago(j.createdAt)}
                  {j.meta.models.length ? <span className="st-s-jobs__models">{runModels(info, j)}</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </details>
    </section>
  );
}

/** One run's models in a line: "Write: Opus 5.5 · High"; a step that stopped on its model: "Write: Opus 5.5 · High (stopped)". */
export function runModels(info: AiInfo, j: ProductionJob): string {
  const word: Record<string, string> = { storyboard: "Write", safety: "Check", preview: "Last look" };
  // A step's other calls have their own words (the storyboard step's post captions, §45.35 D5).
  const task: Record<string, string> = { scene_rewrite: "New take", captions: "Captions" };
  return j.meta.models
    .map((m) => {
      const stopped = stoppedOn(j, m);
      return `${(m.task ? task[m.task] : undefined) ?? word[m.step] ?? m.step}: ${shortName(modelName(info, m.model))}${(m.effortApplied || stopped) && m.effort ? ` · ${effortName(m.effort)}` : ""}${stopped ? " (stopped)" : ""}`;
    })
    .join(" · ");
}
