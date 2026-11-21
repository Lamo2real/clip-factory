// Lamo Stories › Production (docs/CONTRACTS.md §45.9, §45.16.5; spec §5.D). Make a new video (an idea or a short
// concept, the cast of 1 to 3, the length, captions, music), the list of every video being made or made with its
// eight-step track, and each video's own page: the step track, the storyboard filmstrip (live previews and the
// finished stills), Cancel, Try again and the production details. A running job is checked every 2 seconds.
import "../styles/studio.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { A } from "../../components/ui.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { burst } from "../../lib/confetti.ts";
import { useLoad, usePoll } from "../../lib/hooks.ts";
import { CLIP_MODELS } from "../../lib/models.ts";
import { navigate } from "../../lib/router.ts";
import { storiesApi } from "../api/client.ts";
import { STEP_LABEL, STEP_ORDER, type Character, type GuidanceTopic, type Idea, type IdeaCategory, type MusicMood, type ProductionJob, type StoriesConfig, type Story, type StoryInput, type StoryScript } from "../api/types.ts";
import { CATALOG } from "../engine/catalog.ts";
import { CharacterPreview } from "../preview/CharacterPreview.tsx";
import { storiesHref } from "../routes.ts";
import { Filmstrip } from "../studio/Filmstrip.tsx";
import { useSameScript, useWorkspace } from "../studio/hooks.ts";
import { Busy, celebrate, Notice, Pick, Slider, Switch, Tag, TextField } from "../studio/kit.tsx";
import { StepTrack } from "../studio/StepTrack.tsx";
import { ago, CATEGORY_LABEL, isConflict, NO_GUIDANCE, say, seconds, STATUS_LABEL, STATUS_TONE } from "../studio/words.ts";
import { KIND_OPTIONS } from "./Ideas.tsx";
import type { StoriesScreenProps } from "./types.ts";

export function ProductionScreen({ ws, page }: StoriesScreenProps) {
  if (page.name === "production_new") return <NewVideo ws={ws} ideaId={page.ideaId} />;
  if (page.name === "production_story") return <StoryProduction ws={ws} storyId={page.storyId} />;
  return <ProductionList ws={ws} />;
}

/** A driving-safety idea no checked advice covers: it cannot become a video (§45.11.5). */
const blockedIdea = (i: Idea) => i.category === "driving_safety" && (i.needsGuidance || !i.safetyTopicId);

const isLive = (job: ProductionJob | null | undefined) => !!job && (job.status === "queued" || job.status === "running");

/** The music each kind of video starts with (the owner can change it). */
export const MOOD_FOR: Record<IdeaCategory, MusicMood> = { driving_safety: "tense", everyday_skills: "playful", comedy: "comedic", explainer: "wonder" };

// ---------- The list ----------

function ProductionList({ ws }: { ws: string }) {
  const list = useLoad(
    async () => {
      const { stories } = await storiesApi().listStories(ws, { status: "all", limit: 50 });
      const jobs: Record<string, ProductionJob | null> = {};
      await Promise.all(
        stories
          .filter((s) => s.status === "producing" || s.status === "failed" || s.currentJobId)
          .map(async (s) => {
            try {
              jobs[s.storyId] = (await storiesApi().getStory(ws, s.storyId)).job;
            } catch {
              jobs[s.storyId] = null;
            }
          }),
      );
      return { stories, jobs };
    },
    ws,
    "st-production",
  );
  const making = (list.data?.stories ?? []).filter((s) => s.status === "producing" || s.status === "draft" || s.status === "failed");
  const made = (list.data?.stories ?? []).filter((s) => !making.includes(s));
  usePoll(() => list.reload(), making.some((s) => s.status === "producing"), 2000);

  return (
    <section className="st-page st-studio">
      <header className="st-head">
        <div>
          <h1 className="st-head__title">Production</h1>
          <p className="st-head__lede">Every video being made, and every video made. Each one goes through eight steps.</p>
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
      ) : list.data.stories.length === 0 ? (
        <div className="st-empty">
          <span className="st-empty__film" aria-hidden="true" />
          <h2 className="st-empty__title">No videos yet</h2>
          <p className="st-empty__text">Pick an idea and a character, and Lamo Stories makes the whole video.</p>
          <A href={storiesHref({ name: "production_new", ideaId: null })} className="st-btn st-btn--main">
            Make your first video
          </A>
        </div>
      ) : (
        <>
          {making.length ? (
            <>
              <h2 className="st-section">Being made</h2>
              <ul className="st-runs">
                {making.map((s) => (
                  <RunRow key={s.storyId} story={s} job={list.data!.jobs[s.storyId] ?? null} />
                ))}
              </ul>
            </>
          ) : null}
          {made.length ? (
            <>
              <h2 className="st-section">Made</h2>
              <ul className="st-runs">
                {made.map((s) => (
                  <RunRow key={s.storyId} story={s} job={list.data!.jobs[s.storyId] ?? null} />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function RunRow({ story, job }: { story: Story; job: ProductionJob | null }) {
  const href = storiesHref({ name: "production_story", storyId: story.storyId });
  const watch = ["review", "needs_check", "approved", "published"].includes(story.status);
  return (
    <li className="st-run">
      <A href={href} className="st-run__cover" aria-label={`Open ${story.title}`}>
        {story.coverUrl ? <img src={story.coverUrl} alt="" width={54} height={96} /> : <span className="st-run__blank" aria-hidden="true" />}
      </A>
      <span className="st-run__body">
        <span className="st-run__top">
          <A href={href} className="st-run__title">
            {story.title}
          </A>
          <Tag tone={STATUS_TONE[story.status]}>{STATUS_LABEL[story.status]}</Tag>
        </span>
        <span className="st-run__meta">
          {CATEGORY_LABEL[story.category]} · {seconds(story.actualDurationSec ?? story.durationSec)} · {ago(story.updatedAt)}
        </span>
        <StepTrack job={isLive(job) || story.status === "failed" ? job : null} story={story} compact label={`Making ${story.title}`} />
      </span>
      <span className="st-run__go">
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

function NewVideo({ ws, ideaId }: { ws: string; ideaId: string | null }) {
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
  const [cast, setCast] = useState<string[]>([]);
  const castTouched = useRef(false);
  const [length, setLength] = useState<number | null>(null);
  const [captions, setCaptions] = useState<boolean | null>(null);
  const [mood, setMood] = useState<MusicMood | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [noAdvice, setNoAdvice] = useState(false);
  const [busy, setBusy] = useState(false);

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

  // The idea's own characters come along until the owner picks the cast himself.
  useEffect(() => {
    if (castTouched.current || !idea?.characterIds?.length) return;
    setCast(idea.characterIds.filter((id) => characters.some((c) => c.characterId === id)).slice(0, 3));
  }, [idea, characters]);

  const kind: IdeaCategory | "" = source === "idea" ? (idea?.category ?? "") : category;
  const lengthSec = length ?? Math.min(90, Math.max(15, cfg.defaultDurationSec ?? 45));
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
    if (source === "idea" && idea) body.ideaId = idea.ideaId;
    else body.brief = { title: title.trim(), logline: logline.trim(), category: category as IdeaCategory };
    try {
      const { story } = await storiesApi().createStory(ws, body);
      celebrate(document.querySelector(".st-make"), 100);
      toast.success("Making your video now!");
      navigate(storiesHref({ name: "production_story", storyId: story.storyId }));
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
      <header className="st-head">
        <div>
          <A href={storiesHref({ name: "production" })} className="st-back">
            ‹ Production
          </A>
          <h1 className="st-head__title">Make a new video</h1>
          <p className="st-head__lede">Four quick picks, then Lamo Stories writes, draws, animates and puts it all together.</p>
        </div>
      </header>
      {!data.data ? (
        <Busy>Getting your ideas and characters…</Busy>
      ) : (
        <div className="st-newvideo">
          <section className="st-panel" aria-labelledby="st-nv-1">
            <h2 className="st-panel__title" id="st-nv-1">
              <span className="st-num">1</span> The idea
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
                    className="st-ideapick"
                  />
                  {blockedCount ? (
                    <p className="st-field__hint">
                      {blockedCount === 1 ? "1 driving-safety idea needs" : `${blockedCount} driving-safety ideas need`} checked advice first, so {blockedCount === 1 ? "it is" : "they are"} not here.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="st-field__hint">
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

          <section className="st-panel" aria-labelledby="st-nv-2">
            <h2 className="st-panel__title" id="st-nv-2">
              <span className="st-num">2</span> The cast <span className="st-panel__hint">(1 to 3)</span>
            </h2>
            {characters.length ? (
              <ul className="st-castpick">
                {characters.map((c) => (
                  <CastTile key={c.characterId} c={c} on={cast.includes(c.characterId)} full={cast.length >= 3} onToggle={() => toggleCast(c.characterId)} />
                ))}
              </ul>
            ) : (
              <p className="st-field__hint">
                You have no characters yet. <A href={storiesHref({ name: "character_new" })}>Make one first</A>.
              </p>
            )}
          </section>

          <section className="st-panel" aria-labelledby="st-nv-3">
            <h2 className="st-panel__title" id="st-nv-3">
              <span className="st-num">3</span> How long
            </h2>
            <Slider label="Length" min={15} max={90} step={5} value={lengthSec} onChange={setLength} words={seconds(lengthSec)} marks={{ from: 30, to: 60, label: "30 to 60 seconds works best." }} />
          </section>

          <section className="st-panel" aria-labelledby="st-nv-4">
            <h2 className="st-panel__title" id="st-nv-4">
              <span className="st-num">4</span> Words and music
            </h2>
            <Switch label="Captions" line="Short words on screen. No talking in Lamo Stories videos." checked={captionsOn} onChange={setCaptions} />
            <Pick label="Music" value={music} options={CATALOG.musicMoods.map((m) => ({ value: m.id, label: m.id === "none" ? "No music" : m.label }))} onChange={setMood} />
          </section>

          {problem ? (
            <Notice tone="bad">
              {problem}
              {noAdvice && topics?.length ? (
                <span className="st-topics">
                  Checked advice covers: {topics.map((t) => t.title).join(" · ")}.
                </span>
              ) : null}
            </Notice>
          ) : null}
          <div className="st-actionbar st-actionbar--pin">
            <button type="button" className="st-btn st-btn--main st-btn--big st-make" aria-disabled={busy || undefined} onClick={() => !busy && void make()}>
              {busy ? "Starting…" : "Make the video"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function CastTile({ c, on, full, onToggle }: { c: Character; on: boolean; full: boolean; onToggle: () => void }) {
  const off = !on && full;
  return (
    <li>
      <button
        type="button"
        className={`st-casttile${on ? " is-on" : ""}`}
        aria-pressed={on}
        aria-disabled={off || undefined}
        title={off ? "Pick up to 3 characters." : undefined}
        onClick={() => !off && onToggle()}
      >
        <CharacterPreview look={c.look} movementStyle={c.movementStyle} expression={on ? "happy" : "neutral"} action={on ? "wave" : "idle"} size={88} playing={on} label={c.name} />
        <span className="st-casttile__name">{c.name}</span>
        <span className="st-casttile__tick" aria-hidden="true">
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
  const [busy, setBusy] = useState<"none" | "cancel" | "again">("none");
  const [problem, setProblem] = useState<string | null>(null);
  const wasLive = useRef(false);
  const story = loaded.data?.story ?? null;
  const job = loaded.data?.job ?? null;
  const script: StoryScript | null = useSameScript(loaded.data?.script ?? null);
  const live = isLive(job) || story?.status === "producing";

  usePoll(() => loaded.reload(), live, 2000);

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
      burst(undefined, 120);
      toast.success("Your video is ready to watch!");
    } else if (story.status === "needs_check") toast.info("Your video is made. Some facts need checking in Review.");
    else if (story.status === "failed") toast.error("Making the video stopped. Tap Try again.");
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
      const r = await storiesApi().produce(ws, storyId);
      loaded.setData((d) => (d ? { ...d, story: r.story, job: r.job } : d));
      void jobs.reload();
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
  const writer = job?.meta.writerModel ? (CLIP_MODELS.find((m) => m.key === job.meta.writerModel)?.label ?? job.meta.writerModel) : null;

  return (
    <section className="st-page st-studio">
      <header className="st-head">
        <div>
          <A href={storiesHref({ name: "production" })} className="st-back">
            ‹ Production
          </A>
          <h1 className="st-head__title">{story.title}</h1>
          <p className="st-head__lede">
            <Tag tone={STATUS_TONE[story.status]}>{STATUS_LABEL[story.status]}</Tag> {CATEGORY_LABEL[story.category]} · {seconds(story.actualDurationSec ?? story.durationSec)}
          </p>
        </div>
        <div className="st-head__actions">
          {watch ? (
            <A href={storiesHref({ name: "review_story", storyId })} className="st-btn st-btn--main">
              {story.status === "needs_check" ? "Check it in Review" : "Watch it in Review"}
            </A>
          ) : null}
        </div>
      </header>

      <section className="st-panel" aria-label="The steps">
        <StepTrack job={job} story={story} label={`Making ${story.title}`} />
        {problem ? <Notice tone="bad">{problem}</Notice> : null}
        <div className="st-actionbar">
          {live ? (
            <button type="button" className="st-btn" aria-disabled={busy !== "none" || undefined} onClick={() => busy === "none" && void cancel()}>
              {busy === "cancel" ? "Stopping…" : "Cancel"}
            </button>
          ) : null}
          {canTryAgain ? (
            <button type="button" className="st-btn st-btn--main" aria-disabled={busy !== "none" || undefined} onClick={() => busy === "none" && void again()}>
              {busy === "again" ? "Starting…" : story.status === "draft" && story.stale.length === STEP_ORDER.length ? "Make the video" : firstStale ? `Try again from “${STEP_LABEL[firstStale]}”` : "Try again"}
            </button>
          ) : null}
        </div>
      </section>

      <section className="st-panel" aria-labelledby="st-board-title">
        <h2 className="st-panel__title" id="st-board-title">
          Storyboard
        </h2>
        {story.scenes.length ? (
          <>
            <p className="st-field__hint">Tap a scene to play it. The finished pictures appear once the scenes are drawn.</p>
            <Filmstrip script={script} scenes={story.scenes} />
          </>
        ) : (
          <p className="st-field__hint">{live ? "Writing the story… the scenes show here in a moment." : "No storyboard yet."}</p>
        )}
      </section>

      <details className="st-details">
        <summary className="st-details__sum">Production details</summary>
        <dl className="st-facts">
          {writer ? (
            <>
              <dt>Writer</dt>
              <dd>{writer}</dd>
            </>
          ) : null}
          <dt>Storyboard version</dt>
          <dd>{story.scriptVersion || "Not written yet"}</dd>
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
          <dt>Length</dt>
          <dd>
            Aim {seconds(story.durationSec)}
            {story.actualDurationSec ? `, made ${seconds(story.actualDurationSec)}` : ""}
          </dd>
          <dt>Size</dt>
          <dd>Vertical 9:16, 1080 × 1920, 30 frames a second</dd>
          {job ? (
            <>
              <dt>Made with</dt>
              <dd>{Object.values(job.meta.providers).join(", ") || "Built-in"}</dd>
            </>
          ) : null}
          <dt>Saved in</dt>
          <dd className="st-facts__mono">{story.storageLocation}</dd>
        </dl>
        {jobs.data?.length ? (
          <>
            <h3 className="st-details__title">Every run</h3>
            <ul className="st-jobs">
              {jobs.data.map((j) => (
                <li key={j.jobId}>
                  <Tag tone={j.status === "failed" ? "coral" : j.status === "ready" ? "mint" : j.status === "needs_check" ? "coral" : "plain"}>
                    {j.status === "ready" ? "Done" : j.status === "needs_check" ? "Facts to check" : j.status === "failed" ? "Stopped" : j.status === "canceled" ? "Cancelled" : "Working"}
                  </Tag>{" "}
                  {j.jobType === "changes" ? (j.configuration.note ? "Changes" : "New take of a scene") : j.configuration.from ? `Again from “${STEP_LABEL[j.configuration.from as keyof typeof STEP_LABEL] ?? j.configuration.from}”` : "Made"} · {ago(j.createdAt)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </details>
    </section>
  );
}
