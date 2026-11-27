// Lamo Stories › Production (docs/CONTRACTS.md §45.9, §45.16.5, §45.25, §45.28, §45.34; spec §5.D). Make a new video
// (an idea or a short concept, who is in it (§45.47), the length, captions, music, up to 3 reference videos to learn
// from, the shape and size, and the model and effort for this video, kept with it), filled in from the address
// (`?idea=`, `?ref=`, `?cast=`, `?sec=`: the chat's and a reference video's hand-over) and starting at a picked idea's
// own length; the list of every video being made or made with its eight-step track and Show more; and each video's own
// page: the step track, the storyboard filmstrip (live previews and the finished stills), Cancel, Try again (with its
// own "just this one" model and effort), "Next run: {model} · {effort}", and the production details with the model and
// effort that made each step. A running job is checked every 2 seconds. On the warm liquid glass
// (styles/GLASS-CONTRACT.md): the words loose on the page sit on a .st-plate, every panel and row is .st-glass, and a
// video's page opens with its preview, hero glass holding the ArcDial (the render progress) and the video's MediaRow.
// A cast may be people and up to 2 vehicles (§45.43, §45.47: CastPicker's "Who is in it", the main character first, an
// optional villain, then the vehicles), and a video can be filed in a series (§45.44): the list shows one series or
// all (`?series=`), a new video picks its series and starts with its cast. Drafts (§45.47): Save draft keeps the form on
// the server, it then saves itself 2 s after each change, "Your drafts (N)" and the list's Drafts group open one
// (`?draft=`), and making the video deletes it.
// Write it myself (§45.46): the idea's third choice, the owner's own scenes (ScriptEditor), staged and never rewritten;
// its video's page shows the "Your script" chip and Change my script.
import "../styles/studio.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { A } from "../../components/ui.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { navigate } from "../../lib/router.ts";
import { storiesGoLater, useAppActive } from "../pane.tsx";
import { storiesReduceMotion } from "../prefs.ts";
import { useLoad, usePoll } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import { starBurst } from "../ui.tsx";
import {
  isCar,
  STEP_LABEL,
  STEP_ORDER,
  type AiSetting,
  type ArtStyle,
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
  type TaskKind,
  type VideoDraft,
  type VideoDraftForm,
} from "../api/types.ts";
import { CATALOG } from "../engine/catalog.ts";
import { storiesHref } from "../routes.ts";
import { cleanPick, effortName, insteadPick, madeWith, ModelIdList, modelIdLine, ModelMenu, modelName, modelOf, ModelsUsed, NextRun, runTask, sendPick, SettingsFix, shortName, stoppedOn, StoryAi, storyUsual, UnusableSheet, unusableAsk, useAiInfo, usedOf, usualFor, type AiInfo } from "../studio/ai.tsx";
import { CastPicker, castOrder, castProblem, FULL_STORY, NO_MAIN, NO_ROLES, PEOPLE_MAX, rolesOf, SAME_VILLAIN, STORY_CAST_MAX, storyCastProblem, storyOrder, TOO_MANY_PEOPLE, TOO_MANY_VEHICLES, type RolePick } from "../studio/CastPicker.tsx";
import { AUTOSAVE_MS, DraftRow, DraftsFold, draftScript, scriptOfDraft, useDrafts } from "../studio/Drafts.tsx";
import { ReuseButton, useReuse } from "../studio/Reuse.tsx";
import { Filmstrip } from "../studio/Filmstrip.tsx";
import { filterOf, MoveToSeries, SeriesField, seriesQuery, SeriesSwitch, useSeriesList, type SeriesFilter } from "../studio/SeriesSwitch.tsx";
import { ArcDial, MediaRow, StatNumeral } from "../glass/index.ts";
import { usePaged, useReferenceList, useSameScript, useWorkspace } from "../studio/hooks.ts";
import { formatOf, formatWords, sameFormat, ShapePicker } from "../studio/shape.tsx";
import { ArtPicker, artOf, artWords, storyArt } from "../studio/art.tsx";
import { Busy, celebrate, Notice, Pick, ShowMore, Slider, Switch, Tag, TechDetails, TextField } from "../studio/kit.tsx";
import { useLeaveGuard } from "../studio/leaveGuard.tsx";
import { newCharacter } from "../studio/looks.ts";
import { defaultLength, draftFromIdea, emptyDraft, fitTarget, hasCaption, lengthRange, namesIn, saysCar, scriptProblem, stepLabel, toOwnScript, written, type ScriptDraft } from "../studio/ownScript.ts";
import { ChangeScriptSheet, fixId, focusField, ScriptEditor } from "../studio/ScriptEditor.tsx";
import { currentStep, nowLine, StepTrack, stepsOf } from "../studio/StepTrack.tsx";
import { ago, CATEGORY_LABEL, DRAFT_WORDS, helpersLine, isConflict, NO_GUIDANCE, notMadeYet, say, seconds, STATUS_TONE, statusLabel, STORAGE_WORDS } from "../studio/words.ts";
import { KIND_OPTIONS } from "./Ideas.tsx";
import type { StoriesScreenProps } from "./types.ts";

export function ProductionScreen({ ws, page }: StoriesScreenProps) {
  if (page.name === "production_new") {
    const refIds = page.refIds ?? [];
    const castIds = page.castIds ?? [];
    // A new hand-over (another chat button, another reference video) starts the form again from its address.
    const from = [page.ideaId ?? "", refIds.join(","), castIds.join(","), page.durationSec ?? "", page.seriesId ?? "", page.art ?? "", page.draftId ?? ""].join("|");
    return <NewVideo key={from} ws={ws} ideaId={page.ideaId} refIds={refIds} castIds={castIds} durationSec={page.durationSec ?? null} seriesId={page.seriesId ?? null} givenArt={page.art ?? null} draftId={page.draftId ?? null} />;
  }
  if (page.name === "production_story") return <StoryProduction ws={ws} storyId={page.storyId} />;
  return <ProductionList ws={ws} filter={filterOf(page.name === "production" ? page : {})} />;
}

/** A driving-safety idea no checked advice covers: it cannot become a video (§45.11.5). */
const blockedIdea = (i: Idea) => i.category === "driving_safety" && (i.needsGuidance || !i.safetyTopicId);

const isLive = (job: ProductionJob | null | undefined) => !!job && (job.status === "queued" || job.status === "running");

/** The music each kind of video starts with (the owner can change it). */
export const MOOD_FOR: Record<IdeaCategory, MusicMood> = { driving_safety: "tense", everyday_skills: "playful", comedy: "comedic", explainer: "wonder" };

// ---------- The list ----------

type Run = { story: Story; job: ProductionJob | null };

/** One page of videos (of one series, or none, when `seriesId` is set), each with its latest job when it is being
 * made or stopped (for its step track). */
async function runsPage(ws: string, cursor?: string, seriesId?: string): Promise<{ items: Run[]; nextCursor: string | null }> {
  const only = seriesId ? { seriesId } : {};
  const { stories, nextCursor } = await storiesApi().listStories(ws, cursor ? { status: "all", limit: 50, cursor, ...only } : { status: "all", limit: 50, ...only });
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

function ProductionList({ ws, filter }: { ws: string; filter: SeriesFilter }) {
  const seriesId = seriesQuery(filter);
  const list = usePaged((cursor) => runsPage(ws, cursor, seriesId), seriesId ? `${ws}:${seriesId}` : ws, "st-production-runs", (r) => r.story.storyId);
  const all = list.data ?? [];
  // Being made: a run is on (a draft whose run is queued too). A draft nothing is making (never started, or stopped
  // with Cancel) and a stopped one wait for the owner's tap, under "Not made yet".
  const making = all.filter((r) => r.story.status === "producing" || (r.story.status === "draft" && !notMadeYet(r.story)));
  const waiting = all.filter((r) => r.story.status === "failed" || notMadeYet(r.story));
  const made = all.filter((r) => !making.includes(r) && !waiting.includes(r));
  // Not while Clip Factory is on screen (this page stays kept behind it): coming back reads it again at once.
  const active = useAppActive();
  usePoll(() => list.reload(), active && making.some((r) => r.story.status === "producing"), 2000);
  // inside one series, a new video is filed there and starts with its cast
  const newVideo = storiesHref({ name: "production_new", ideaId: null, ...(seriesId && seriesId !== "none" ? { seriesId } : {}) });
  // Saved drafts (§45.47) of the series shown (none: those filed in no series), above Being made.
  const drafts = useDrafts(ws);
  const reuse = useReuse(ws);
  const draftsHere = drafts.items.filter((d) => !seriesId || (seriesId === "none" ? !d.form.seriesId : d.form.seriesId === seriesId));
  const draftGroup = draftsHere.length ? (
    <>
      <h2 className="st-s-section st-plate">{DRAFT_WORDS.group}</h2>
      <ul className="st-s-runs">
        {draftsHere.map((d) => (
          <DraftRow key={d.draftId} draft={d} onDelete={() => drafts.remove(d)} />
        ))}
      </ul>
    </>
  ) : null;

  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div className="st-plate">
          <h1 className="st-s-head__title">Production</h1>
          <p className="st-s-head__lede">Every video you make shows up here.</p>
        </div>
        <SeriesSwitch ws={ws} value={filter} onChange={(v) => navigate(storiesHref({ name: "production", ...(seriesQuery(v) ? { seriesId: seriesQuery(v) } : {}) }))} />
        <A href={newVideo} className="st-btn st-btn--main">
          Make a new video
        </A>
      </header>
      {list.error && !list.data ? (
        <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void list.reload()}>Try again</button>}>
          {list.error}
        </Notice>
      ) : !list.data ? (
        <Busy plate>Getting your videos…</Busy>
      ) : all.length === 0 ? (
        <>
        {draftGroup}
        <div className="st-s-empty st-glass">
          <span className="st-s-empty__film" aria-hidden="true" />
          <h2 className="st-s-empty__title">No videos yet</h2>
          <p className="st-s-empty__text">Pick an idea and a character. Clips Funded does the rest.</p>
          <A href={newVideo} className="st-btn st-btn--main">
            Make your first video
          </A>
        </div>
        </>
      ) : (
        <>
          {draftGroup}
          {making.length ? (
            <>
              <h2 className="st-s-section st-plate">Being made</h2>
              <ul className="st-s-runs">
                {making.map((r) => (
                  <RunRow key={r.story.storyId} ws={ws} story={r.story} job={r.job} onMoved={() => void list.reload()} />
                ))}
              </ul>
            </>
          ) : null}
          {waiting.length ? (
            <>
              <h2 className="st-s-section st-plate">Not made yet</h2>
              <ul className="st-s-runs">
                {waiting.map((r) => (
                  <RunRow key={r.story.storyId} ws={ws} story={r.story} job={r.job} onMoved={() => void list.reload()} />
                ))}
              </ul>
            </>
          ) : null}
          {made.length ? (
            <>
              <h2 className="st-s-section st-plate">Made</h2>
              <ul className="st-s-runs">
                {made.map((r) => (
                  <RunRow key={r.story.storyId} ws={ws} story={r.story} job={r.job} onMoved={() => void list.reload()} reuse={reuse} />
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

function RunRow({ ws, story, job, onMoved, reuse }: { ws: string; story: Story; job: ProductionJob | null; onMoved: () => void; reuse?: ReturnType<typeof useReuse> }) {
  const href = storiesHref({ name: "production_story", storyId: story.storyId });
  const watch = ["review", "needs_check", "approved", "published"].includes(story.status);
  return (
    <li className="st-s-run st-glass">
      <A href={href} className="st-s-run__cover" aria-label={`Open ${story.title}`}>
        {story.coverUrl ? <img src={story.coverUrl} alt="" width={54} height={96} /> : <span className="st-s-run__blank" aria-hidden="true" />}
      </A>
      <span className="st-s-run__body">
        <span className="st-s-run__top">
          <A href={href} className="st-s-run__title">
            {story.title}
          </A>
          <Tag tone={STATUS_TONE[story.status]}>{statusLabel(story)}</Tag>
        </span>
        <span className="st-s-run__meta">
          {CATEGORY_LABEL[story.category]} · {seconds(story.actualDurationSec ?? story.durationSec)} · {ago(story.updatedAt)}
        </span>
        <StepTrack job={isLive(job) || story.status === "failed" ? job : null} story={story} compact label={`Making ${story.title}`} />
      </span>
      <span className="st-s-run__go">
        <MoveToSeries ws={ws} kind="story" id={story.storyId} title={story.title} current={story.seriesId ?? null} onMoved={onMoved} />
        {reuse ? <ReuseButton story={story} busy={reuse.busy} onReuse={(id) => void reuse.reuse(id)} /> : null}
        {watch ? (
          <A href={storiesHref({ name: "review_story", storyId: story.storyId })} className="st-btn">
            Watch it
          </A>
        ) : (
          <A href={href} className="st-btn">
            {notMadeYet(story) ? "Make it" : "Open"}
          </A>
        )}
      </span>
    </li>
  );
}

// ---------- Make a new video ----------

/** The cast sentences: a problem with one of them shows panel 2, Who is in it. */
const CAST_WORDS = new Set(["Pick at least one character.", NO_MAIN, SAME_VILLAIN, TOO_MANY_VEHICLES, TOO_MANY_PEOPLE, "Add someone to drive it."]);
const CAST_FULL = FULL_STORY;

function NewVideo({ ws, ideaId, refIds: givenRefs, castIds, durationSec, seriesId: givenSeries, givenArt, draftId }: { ws: string; ideaId: string | null; refIds: string[]; castIds: string[]; durationSec: number | null; seriesId: string | null; givenArt: ArtStyle | null; draftId: string | null }) {
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
  const [source, setSource] = useState<"idea" | "own" | "script">("idea");
  // Write it myself (§45.46): the owner's scenes, and the idea they started from (its steps), if any.
  const [draft, setDraft] = useState<ScriptDraft>(() => emptyDraft());
  const [fromIdea, setFromIdea] = useState<string | null>(null);
  /** The field a problem with the scenes points at (check() sets it, showFix() focuses it). */
  const scriptFix = useRef<string | null>(null);
  const [picked, setPicked] = useState<string>(ideaId ?? "");
  const [title, setTitle] = useState("");
  const [logline, setLogline] = useState("");
  const [category, setCategory] = useState<IdeaCategory | "">("");
  // The address may bring the cast, the length and the reference videos (the chat's or a reference video's hand-over).
  const [cast, setCast] = useState<string[]>(() => castIds.slice(0, 3));
  const castTouched = useRef(castIds.length > 0);
  // The main character and the villain (§45.47); no main picked: the first person in the cast.
  const [roles, setRoles] = useState<RolePick>(NO_ROLES);
  // The series it is filed in (§45.44): the address's, else a picked idea's, until the owner picks one himself.
  const [series, setSeries] = useState<string | null>(givenSeries && givenSeries !== "none" ? givenSeries : null);
  const seriesTouched = useRef(!!givenSeries);
  const seriesList = useSeriesList(ws).list;
  const [length, setLength] = useState<number | null>(durationSec);
  const [shape, setShape] = useState<StoryFormat | null>(null);
  // the drawing style the address carries (the chat's Make the video, §45.45), else the workspace's
  const [art, setArt] = useState<ArtStyle | null>(givenArt);
  const [captions, setCaptions] = useState<boolean | null>(null);
  const [mood, setMood] = useState<MusicMood | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [noAdvice, setNoAdvice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refIds, setRefIds] = useState<string[]>(() => givenRefs.slice(0, 3));
  const [ai, setAi] = useState<ModelOverride | null>(null);
  /** The question before making it with a model the studio knows cannot be used (§45.36 E12). */
  const [asking, setAsking] = useState<ReturnType<typeof unusableAsk>>(null);
  const info = useAiInfo(ws);
  const refs = useReferenceList(ws);
  /** The address's reference ids were checked against a list read just now (never a remembered one, §45.36 E2). */
  const refsChecked = useRef(false);
  /** The owner picked the cast himself (a pick to keep when he leaves). */
  const [castPicked, setCastPicked] = useState(false);
  // Picks and typing not made into a video yet: leaving asks first (never while it starts: it goes to its page).
  const dirty =
    !!title.trim() ||
    !!logline.trim() ||
    category !== "" ||
    picked !== (ideaId ?? "") ||
    castPicked ||
    length !== durationSec ||
    shape !== null ||
    captions !== null ||
    mood !== null ||
    ai !== null ||
    refIds.join(",") !== givenRefs.slice(0, 3).join(",") ||
    draft.scenes.some(written);

  // ---- Drafts (§45.47) ----
  const drafts = useDrafts(ws);
  /** The draft this form is (after Save draft, or opened with ?draft=): it then saves itself. */
  const [saved, setSaved] = useState<{ draftId: string; version: number } | null>(null);
  /** The form as last saved or opened (what "Saved" means), and whether a save is on its way. */
  const [savedJson, setSavedJson] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** The last save failed: "Save draft" comes back instead of "Saving…" (a stale version stops the draft, below). */
  const [saveFailed, setSaveFailed] = useState(false);
  const [gonePicks, setGonePicks] = useState(false);
  const [draftGone, setDraftGone] = useState(false);
  const opened = useLoad(async () => (draftId ? await storiesApi().getVideoDraft(ws, draftId) : null), `${ws}:${draftId ?? ""}`);
  /** The opened draft is in the form (at once when there is none). */
  const [ready, setReady] = useState(!draftId);
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const carIds = new Set((data.data?.characters ?? []).filter(isCar).map((c) => c.characterId));
  /** The draft as the last save left it (the chain reads it, never a stale render's). */
  const savedRef = useRef<{ draftId: string; version: number } | null>(null);
  const formJson = JSON.stringify(formNow());
  // With a draft, only changes since its last save hold the page.
  const unsaved = saved ? formJson !== savedJson : dirty;
  const leave = useLeaveGuard(unsaved && !busy && ready, { onSave: () => saveDraft(false) });

  /** The form as a draft keeps it: only what the owner typed or picked (a default stays a default). */
  function formNow(): VideoDraftForm {
    const f: VideoDraftForm = { source };
    const idea = source === "script" ? (fromIdea ?? picked) : picked;
    if (idea) f.ideaId = idea;
    if (title.trim()) f.title = title;
    if (logline.trim()) f.logline = logline;
    if (category) f.category = category;
    const script = draftScript(draft);
    if (script) f.script = script;
    if (cast.length) f.characterIds = cast.slice(0, STORY_CAST_MAX);
    // the roles as picked; a villain with no main picked keeps the first other person as the main
    const main = roles.mainId ?? (roles.villainId ? (cast.find((id) => id !== roles.villainId && !carIds.has(id)) ?? null) : null);
    if (main) f.roles = { mainId: main, ...(roles.villainId && roles.villainId !== main ? { villainId: roles.villainId } : {}) };
    if (series) f.seriesId = series;
    else if (seriesTouched.current) f.seriesId = null;
    if (length !== null) f.durationSec = length;
    if (shape) f.format = { ...shape };
    if (art) f.art = art;
    if (captions !== null) f.captionsOn = captions;
    if (mood) f.musicMood = mood;
    if (refIds.length) f.referenceIds = [...refIds];
    if (ai) f.ai = { ...ai };
    return f;
  }

  /** Saves the form as a draft: the first time makes it (Save draft), then each save sends the version it read. */
  function saveDraft(auto: boolean): Promise<boolean> {
    const run = saveChain.current.catch(() => undefined).then(async () => {
      const form = formNow();
      const json = JSON.stringify(form);
      setSaving(true);
      try {
        const next: VideoDraft = savedRef.current ? await storiesApi().saveVideoDraft(ws, savedRef.current.draftId, { form, version: savedRef.current.version }) : await storiesApi().createVideoDraft(ws, { form });
        savedRef.current = { draftId: next.draftId, version: next.version };
        setSaved(savedRef.current);
        setSavedJson(json);
        setSaveFailed(false);
        if (!auto) toast.success(DRAFT_WORDS.saved);
        return true;
      } catch (e) {
        toast.error(say(e, "The draft could not be saved. Try again."), { group: "st-draft-save" });
        if (isConflict(e)) {
          // Changed on another screen: this form lets go of that draft, so autosave stops sending a stale version.
          // "Save draft" then keeps this form as a new draft; the other one stays in "Your drafts".
          savedRef.current = null;
          setSaved(null);
          setSavedJson(null);
          setSaveFailed(false);
        } else setSaveFailed(true);
        return false;
      } finally {
        setSaving(false);
      }
    });
    saveChain.current = run;
    return run;
  }

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
  // The series' own ideas first.
  const usable = ideas.filter((i) => !blockedIdea(i)).sort((a, b) => Number(!!series && b.seriesId === series) - Number(!!series && a.seriesId === series));
  const idea = ideas.find((i) => i.ideaId === picked) ?? null;
  const known = (ids: string[]) => ids.filter((id) => characters.some((c) => c.characterId === id)).slice(0, 3);

  // With no ideas saved, the short form is the way in.
  useEffect(() => {
    if (data.data && !data.data.ideas.some((i) => !blockedIdea(i)) && !ideaId) setSource("own");
  }, [data.data, ideaId]);

  // The idea's own characters come along until the owner picks the cast himself (or the address brought one).
  useEffect(() => {
    if (castTouched.current || !idea?.characterIds?.length) return;
    setCast(idea.characterIds.filter((id) => characters.some((c) => c.characterId === id)).slice(0, 3));
  }, [idea, characters]);

  // A picked idea files the video in its series, until the owner picks the series himself.
  useEffect(() => {
    if (!seriesTouched.current) setSeries(idea?.seriesId ?? null);
  }, [idea]);

  // The series' cast comes along while the cast is untouched and the idea brings none.
  const seriesCast = useMemo(() => (seriesList ?? []).find((x) => x.seriesId === series)?.castIds ?? null, [seriesList, series]);
  useEffect(() => {
    if (castTouched.current || idea?.characterIds?.length || !seriesCast?.length || !data.data) return;
    setCast(seriesCast.filter((id) => data.data!.characters.some((c) => c.characterId === id)).slice(0, 3));
  }, [seriesCast, idea, data.data]);

  // Reference videos from the address keep only this workspace's own (a deleted one is dropped, so it never uses up
  // one of the 3 picks without a tile to unpick it). Only against the list read just now: a list remembered from an
  // earlier visit lacks a video uploaded since, which must stay picked (§45.36 E2). A list that could not be read
  // drops nothing.
  useEffect(() => {
    const list = refs.data;
    if (refsChecked.current || refs.loading || refs.error || !list || !givenRefs.length) return;
    refsChecked.current = true;
    setRefIds((ids) => ids.filter((id) => list.some((r) => r.refId === id)));
    // Once, when the fresh list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs.data, refs.loading, refs.error]);

  // A cast from the address keeps only this workspace's own characters.
  useEffect(() => {
    if (!data.data || !castIds.length) return;
    setCast((c) => c.filter((id) => characters.some((x) => x.characterId === id)));
    // Once, when the characters arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.data]);

  // Opening a draft (?draft=, §45.47): its picks come back once the ideas and characters are here; ids that are gone
  // (characters, the idea) are left out and the page says so. A draft that is gone starts a new form, and says so.
  useEffect(() => {
    if (ready || !data.data || opened.loading) return;
    const d = opened.data;
    // A draft that could not be read for another reason (a network blip) stays unopened: Try again, below. Starting
    // an empty form then would make a second draft next to the one that is still there.
    if (!d && opened.error && !opened.missing) return;
    setReady(true);
    if (!d) {
      if (opened.missing) setDraftGone(true);
      return;
    }
    const f = d.form;
    const knownChar = (id: string) => data.data!.characters.some((c) => c.characterId === id);
    let dropped = false;
    if (f.source) setSource(f.source);
    if (f.ideaId) {
      if (data.data.ideas.some((i) => i.ideaId === f.ideaId)) {
        setPicked(f.ideaId);
        if (f.source === "script") setFromIdea(f.ideaId);
      } else {
        setPicked("");
        dropped = true;
      }
    }
    if (f.title) setTitle(f.title);
    if (f.logline) setLogline(f.logline);
    if (f.category && f.category in CATEGORY_LABEL) setCategory(f.category as IdeaCategory);
    if (f.script) {
      const back = scriptOfDraft(f.script, knownChar);
      setDraft(back.script);
      dropped ||= back.dropped;
    }
    if (f.characterIds) {
      const keep = f.characterIds.filter(knownChar).slice(0, STORY_CAST_MAX);
      dropped ||= keep.length !== f.characterIds.length;
      castTouched.current = true;
      setCastPicked(true);
      setCast(keep);
      if (f.roles) setRoles({ mainId: f.roles.mainId && keep.includes(f.roles.mainId) ? f.roles.mainId : null, villainId: f.roles.villainId && keep.includes(f.roles.villainId) ? f.roles.villainId : null });
    }
    if (f.seriesId !== undefined) {
      seriesTouched.current = true;
      setSeries(f.seriesId);
    }
    if (f.durationSec !== undefined) setLength(f.durationSec);
    if (f.format) setShape(f.format);
    if (f.art) setArt(f.art);
    if (f.captionsOn !== undefined) setCaptions(f.captionsOn);
    if (f.musicMood && CATALOG.musicMoods.some((m) => m.id === f.musicMood)) setMood(f.musicMood as MusicMood);
    if (f.referenceIds) setRefIds(f.referenceIds.slice(0, 3));
    if (f.ai) setAi(f.ai);
    setGonePicks(dropped);
    savedRef.current = { draftId: d.draftId, version: d.version };
    setSaved(savedRef.current);
    // "Saved" is the form as it opens (worked out on the next render, once every pick above is in).
    setSavedJson(null);
  }, [data.data, opened.data, opened.loading, opened.error, opened.missing, ready]);

  // The opened form is what "Saved" means: set on the render after the picks went in.
  useEffect(() => {
    if (saved && savedJson === null) setSavedJson(formJson);
  }, [saved, savedJson, formJson]);

  // The draft's reference videos and series that are gone (their lists come later) are left out the same way.
  useEffect(() => {
    if (!saved || !opened.data || refs.loading || refs.error || !refs.data) return;
    const list = refs.data;
    const keep = refIds.filter((id) => list.some((r) => r.refId === id));
    if (keep.length === refIds.length) return;
    setRefIds(keep);
    setGonePicks(true);
    // Once, when the list is here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs.data, refs.loading, refs.error, opened.data, saved]);
  useEffect(() => {
    if (!saved || !opened.data || !seriesList || !series) return;
    if (seriesList.some((x) => x.seriesId === series)) return;
    setSeries(null);
    setGonePicks(true);
    // Once, when the series are here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesList, opened.data, saved]);

  // Autosave (§45.47 D3): once there is a draft, 2 s after the last change; never while the video starts.
  useEffect(() => {
    if (!saved || savedJson === null || busy || saveFailed || formJson === savedJson) return;
    const t = window.setTimeout(() => void saveDraft(true), AUTOSAVE_MS);
    return () => window.clearTimeout(t);
    // The form's JSON is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formJson, saved, savedJson, busy, saveFailed]);

  const kind: IdeaCategory | "" = source === "idea" ? (idea?.category ?? "") : category;
  // The owner's scenes as they will be sent (Write it myself): the length and the captions follow them.
  const ownScenes = useMemo(() => (source === "script" ? toOwnScript(draft, cast, characters).scenes : []), [source, draft, cast, characters]);
  const ownWritten = ownScenes.filter((x) => x.what);
  // The length: the owner's, else the address's, else what the owner's scenes need, else a picked idea's own (its full
  // idea was written for it), else the workspace's default.
  const ideaLength = source === "idea" ? (idea?.concept?.durationSec ?? null) : null;
  const scriptLength = ownWritten.length ? defaultLength(ownWritten) : null;
  const lengthSec = Math.min(90, Math.max(15, length ?? scriptLength ?? ideaLength ?? cfg.defaultDurationSec ?? 45));
  const usualShape = formatOf(workspace ? cfg : null);
  const format = shape ?? usualShape;
  const usualArt = artOf(workspace ? cfg : null);
  const drawing = art ?? usualArt;
  // The owner's first caption turns the captions on, unless the owner set the switch himself.
  const ownWords = source === "script" && hasCaption({ scenes: ownScenes });
  const captionsOn = captions ?? (ownWords ? true : (cfg.captionsOn ?? true));
  const music: MusicMood = mood ?? (cfg.musicOn === false ? "none" : kind ? MOOD_FOR[kind] : "playful");
  /** The task that makes the storyboard: the owner's script is staged with "Plan the animation" (§45.46). */
  const writeTask: TaskKind = source === "script" ? "animation_plan" : "storyboard";

  function pickCast(ids: string[]) {
    castTouched.current = true;
    setCastPicked(true);
    setProblem(null);
    setCast(ids.slice(0, STORY_CAST_MAX));
  }

  function pickRoles(next: RolePick) {
    castTouched.current = true;
    setCastPicked(true);
    setProblem(null);
    setRoles(next);
  }

  const peopleIn = (ids: string[]) => ids.filter((id) => !characters.some((c) => c.characterId === id && isCar(c))).length;

  /** Why a character the words name can't join the cast now (3 people, 4 in all, 2 vehicles, a vehicle needs a person), or null. */
  function castJoinWhy(id: string, now: string[] = cast): string | null {
    if (now.includes(id)) return null;
    const vehicle = characters.some((c) => c.characterId === id && isCar(c));
    if (now.length >= STORY_CAST_MAX || (!vehicle && peopleIn(now) >= PEOPLE_MAX)) return CAST_FULL;
    const next = castOrder([...now, id], characters).map((x) => characters.find((c) => c.characterId === x)).filter((c): c is Character => !!c);
    return castProblem(next);
  }

  // Write it myself: a character the words name comes into the cast by itself, while the owner has not picked the cast
  // himself and the cast rule allows it (the people first, then a car); otherwise its scene asks. Words that put a car
  // in a scene ("the car", "drives") bring the workspace's only car in too. The page says who joined this way, so a ✓
  // the owner did not tap is never a surprise; and one who joined this way leaves again once no scene names them (a
  // name typed over: "Bolt runs" changed to "Pip runs"), so the hints never disagree and the cast never fills up.
  const [joined, setJoined] = useState<string[]>([]);
  useEffect(() => {
    if (source !== "script" || castPicked || !characters.length) return;
    const named = draft.scenes.flatMap((x) => namesIn(x.what, characters)).filter((c) => draft.answers[c.name.trim().toLowerCase()] !== "out");
    const cars = characters.filter((c) => isCar(c));
    const carWords = draft.scenes.some((x) => saysCar(x.what));
    const answered = new Set(Object.values(draft.answers));
    const stays = (id: string) => named.some((c) => c.characterId === id) || answered.has(id) || (carWords && cars.length === 1 && cars[0]!.characterId === id);
    const gone = joined.filter((id) => cast.includes(id) && !stays(id));
    if (carWords && cars.length === 1 && !named.some((c) => isCar(c)) && !cast.some((id) => cars.some((c) => c.characterId === id))) named.push(cars[0]!);
    let next = cast.filter((id) => !gone.includes(id));
    for (const c of [...named.filter((x) => !isCar(x)), ...named.filter((x) => isCar(x))]) if (!next.includes(c.characterId) && !castJoinWhy(c.characterId, next)) next = castOrder([...next, c.characterId], characters);
    if (next.join() !== cast.join()) {
      setJoined((j) => [...new Set([...j.filter((id) => !gone.includes(id)), ...next.filter((id) => !cast.includes(id))])]);
      setCast(next);
    }
    // Reads the cast it changes; runs when the words change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, source, castPicked, characters]);

  /**
   * "Make Zara" (Who is Zara?): a new character with that name and the usual look, made right here so the scenes stay as
   * typed; it joins the cast as one the words brought in. Its look can be changed in Characters later.
   */
  async function makeNamed(name: string) {
    const why = makeWhy();
    if (why) return;
    try {
      const made = await storiesApi().createCharacter(ws, { ...newCharacter(), name: name.trim() });
      data.setData((d) => (d ? { ...d, characters: [...d.characters, made] } : d));
      setJoined((j) => [...new Set([...j, made.characterId])]);
      setCast((c) => (c.includes(made.characterId) ? c : castOrder([...c, made.characterId], [...characters, made])));
      toast.success(`Say hi to ${made.name}! Change how ${made.name} looks in Characters.`);
    } catch (e) {
      toast.error(say(e));
    }
  }

  /** Why a new character can't join the cast now (3 people, 4 in all), or null. */
  function makeWhy(): string | null {
    return cast.length >= STORY_CAST_MAX || peopleIn(cast) >= PEOPLE_MAX ? CAST_FULL : null;
  }
  const joinedNames = source === "script" ? joined.filter((id) => cast.includes(id)).map((id) => characters.find((c) => c.characterId === id)?.name).filter((n): n is string => !!n) : [];

  /** Write it myself from here: the scene list starts from the picked idea's steps when it is still empty. */
  function pickSource(v: "idea" | "own" | "script") {
    setSource(v);
    setProblem(null);
    if (v !== "script" || draft.scenes.some(written) || !idea) return;
    setDraft(draftFromIdea(idea));
    setFromIdea(idea.ideaId);
    setTitle(idea.title);
    setCategory(idea.category);
  }

  function check(): string | null {
    scriptFix.current = null;
    if (source === "idea") {
      if (!idea) return "Pick an idea, or tap Type an idea.";
      if (blockedIdea(idea)) return NO_GUIDANCE;
    } else if (source === "script") {
      if (!title.trim()) {
        scriptFix.current = "st-sc-title";
        return "Give the video a title.";
      }
      if (!category) {
        scriptFix.current = "st-sc-kind";
        return "Pick what kind of video it is.";
      }
      const bad = scriptProblem(draft, cast, characters);
      if (bad) {
        scriptFix.current = fixId("st-sc", draft, bad.fix);
        return bad.text;
      }
    } else {
      if (!title.trim()) return "Give the video a title.";
      if (!logline.trim()) return "Write one line about what happens.";
      if (!category) return "Pick what kind of video it is.";
    }
    if (!cast.length) return "Pick at least one character.";
    return storyCastProblem(cast, characters, roles);
  }

  /** A missing pick: its part comes into view with the focus (on a phone it is far above the pinned button). */
  function showFix(why: string) {
    // Write it myself: the field the problem names (its title, its kind, a scene's words or its question).
    if (source === "script" && scriptFix.current && focusField(scriptFix.current)) return;
    const part = document.getElementById(CAST_WORDS.has(why) ? "st-nv-2" : "st-nv-1");
    const box = part?.closest("section");
    if (!part || !box) return;
    box.scrollIntoView?.({ block: "start", behavior: storiesReduceMotion() ? "auto" : "smooth" });
    const field = source === "own" ? box.querySelector<HTMLElement>(!title.trim() ? "input.st-s-input" : !logline.trim() ? "textarea" : "input[type=radio]") : null;
    if (field && !CAST_WORDS.has(why)) return field.focus({ preventScroll: true });
    part.setAttribute("tabindex", "-1");
    part.focus({ preventScroll: true });
  }

  async function make(pickNow: ModelOverride | null = ai, sure = false) {
    const why = check();
    setNoAdvice(why === NO_GUIDANCE);
    if (why) {
      setProblem(why);
      showFix(why);
      return;
    }
    // A model picked on purpose that the studio knows cannot be used: ask first, never swap it by itself.
    const ask = sure ? null : unusableAsk(info, usualFor(info, writeTask), pickNow);
    if (ask) return setAsking(ask);
    setAsking(null);
    setBusy(true);
    setProblem(null);
    // The people in the order they were picked, then the car (§45.43); the series when one is picked, and null when the
    // owner picked No series himself, so an idea's own series does not file it anyway (§45.44).
    // The main character goes first (§45.47); the roles only when the owner picked one (a villain, or the main).
    const body: StoryInput = { characterIds: storyOrder(cast, characters, roles), durationSec: lengthSec, captionsOn, musicMood: music };
    const picked = rolesOf(cast, characters, roles);
    if (picked && (picked.villainId || roles.mainId)) body.roles = picked;
    // The draft it is made from goes (§45.47): a save on its way (even the very first one) is waited for, then the
    // draft is read from the ref, never this click's render; busy stops autosave, so none starts after this.
    await saveChain.current.catch(() => undefined);
    if (savedRef.current) body.draftId = savedRef.current.draftId;
    if (series) body.seriesId = series;
    else if (seriesTouched.current) body.seriesId = null;
    // This video's own shape, only when the owner picked one that is not the workspace's (§45.34). Nothing picked:
    // the API uses Settings › Video itself (also while it has not loaded here, or could not be read).
    if (shape && (!workspace || !sameFormat(shape, usualShape))) body.format = { ...shape };
    // This video's own drawing style the same way (§45.45): nothing picked, the API uses Settings › Video's.
    if (art && (!workspace || art !== usualArt)) body.art = art;
    // Kept with this video: only what the owner picked in its menu. When the usual model cannot be used, the model the
    // menu shows instead goes with the first job only, never kept (§45.5 `override`, §45.36 E12), so a later remake
    // uses the usual again once it works.
    const own = cleanPick(pickNow);
    if (own) body.ai = { model: own.model ?? null, effort: own.effort ?? null };
    const stand = own?.model ? undefined : sendPick(info, usualFor(info, writeTask), pickNow);
    if (stand?.model) body.override = stand;
    const usable = refIds.filter((id) => refs.data?.some((r) => r.refId === id));
    if (usable.length) body.referenceIds = usable;
    if (source === "idea" && idea) body.ideaId = idea.ideaId;
    else if (source === "script") {
      // The owner's scenes, the words exactly as typed (§45.46); the idea they started from, while its kind is kept.
      body.ownScript = toOwnScript(draft, body.characterIds, characters);
      const started = fromIdea ? ideas.find((i) => i.ideaId === fromIdea) : undefined;
      if (started && started.category === category) {
        body.ideaId = started.ideaId;
        if (title.trim() !== started.title) body.title = title.trim();
      } else body.brief = { title: title.trim(), logline: body.ownScript.scenes[0]?.what ?? "", category: category as IdeaCategory };
    } else body.brief = { title: title.trim(), logline: logline.trim(), category: category as IdeaCategory };
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
  const storySoFar = series ? ((seriesList ?? []).find((x) => x.seriesId === series)?.storySoFar ?? "").trim() : "";
  const range = ownWritten.length ? lengthRange(ownWritten) : null;
  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div className="st-plate">
          <A href={storiesHref({ name: "production" })} className="st-s-back st-s-back--orb">
            <span className="st-s-back__orb">‹</span> Production
          </A>
          <h1 className="st-s-head__title">Make a new video</h1>
          <p className="st-s-head__lede">Pick a few things. Clips Funded makes the rest.</p>
        </div>
      </header>
      {draftGone ? <Notice tone="bad">{DRAFT_WORDS.gone}</Notice> : null}
      {gonePicks ? <Notice tone="bad">{DRAFT_WORDS.gonePicks}</Notice> : null}
      <DraftsFold drafts={drafts.items.filter((d) => d.draftId !== saved?.draftId)} onDelete={drafts.remove} />
      {opened.error && !opened.missing && !ready ? (
        <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void opened.reload()}>Try again</button>}>
          {opened.error}
        </Notice>
      ) : !data.data || !ready ? (
        <Busy plate>Getting your ideas and characters…</Busy>
      ) : (
        <div className="st-s-newvideo">
          <SeriesField
            ws={ws}
            value={series}
            onChange={(id, s) => {
              seriesTouched.current = true;
              setSeries(id);
              setProblem(null);
              if (!castTouched.current && s?.castIds.length) setCast(known(s.castIds));
            }}
          />
          <section className="st-s-panel st-glass" aria-labelledby="st-nv-1">
            <h2 className="st-s-panel__title" id="st-nv-1">
              <span className="st-s-num">1</span> The idea
            </h2>
            <Pick
              label="Where the idea comes from"
              hideLabel
              value={source}
              options={[
                { value: "idea", label: "Use an idea" },
                { value: "own", label: "Type an idea" },
                { value: "script", label: "Write it myself" },
              ]}
              onChange={pickSource}
            />
            {/* one short line a choice: only Write it myself makes the video from the owner's own words */}
            {source === "script" ? <p className="st-s-field__hint st-sc-lede">You write what happens. Clips Funded draws it.</p> : null}
            {source === "own" ? <p className="st-s-field__hint st-sc-lede">You type the idea. Clips Funded writes the story.</p> : null}
            {source === "script" ? (
              <>
                <TextField id="st-sc-title" label="Title" value={title} onChange={setTitle} max={80} placeholder="For example: Dash learns to juggle" />
                <div id="st-sc-kind">
                  <Pick label="What kind of video?" big value={category} options={KIND_OPTIONS} onChange={setCategory} />
                </div>
                {storySoFar ? (
                  <details className="st-sc-sofar">
                    <summary className="st-sc-sofar__sum">The story so far</summary>
                    <p className="st-sc-sofar__text">{storySoFar}</p>
                  </details>
                ) : null}
                <ScriptEditor
                  draft={draft}
                  update={(fn) => {
                    setProblem(null);
                    setDraft(fn);
                  }}
                  characters={characters}
                  cast={storyOrder(cast, characters, roles)}
                  onAddToCast={(id) => pickCast(castOrder([...cast, id], characters))}
                  addWhy={(id) => castJoinWhy(id)}
                  onMake={makeNamed}
                  makeWhy={makeWhy}
                  lengthSec={lengthSec}
                  note={fromIdea && fromIdea === idea?.ideaId ? "Started from your idea. Change anything." : null}
                />
              </>
            ) : source === "idea" ? (
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
                      {blockedCount === 1 ? "1 driving-safety idea is hidden. It needs" : `${blockedCount} driving-safety ideas are hidden. They need`} checked advice first.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="st-s-field__hint">
                  {series ? (
                    <>
                      No ideas yet. Tap Type an idea, or <A href={storiesHref({ name: "ideas", seriesId: series, ask: true })}>ask for ideas</A> for this series.
                    </>
                  ) : (
                    <>
                      No ideas yet. Tap Type an idea, or add some in <A href={storiesHref({ name: "ideas" })}>Ideas</A>.
                    </>
                  )}
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

          <section className="st-s-panel st-glass" aria-labelledby="st-nv-2">
            <h2 className="st-s-panel__title" id="st-nv-2">
              <span className="st-s-num">2</span> Who is in it
            </h2>
            {characters.length ? (
              <>
                <CastPicker characters={characters} value={cast} onChange={pickCast} max={STORY_CAST_MAX} roles={roles} onRoles={pickRoles} />
                {joinedNames.length ? (
                  <p className="st-s-field__hint st-sc-joined">
                    {joinedNames.length === 1 ? `${joinedNames[0]} is` : `${joinedNames.slice(0, -1).join(", ")} and ${joinedNames[joinedNames.length - 1]} are`} in your scenes, so {joinedNames.length === 1 ? `${joinedNames[0]} is` : "they're"} ticked already.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="st-s-field__hint">
                No characters yet. <A href={storiesHref({ name: "character_new" })}>Make one first</A>.
              </p>
            )}
          </section>

          <section className="st-s-panel st-glass" aria-labelledby="st-nv-3">
            <h2 className="st-s-panel__title" id="st-nv-3">
              <span className="st-s-num">3</span> How long
            </h2>
            {/* Write it myself: the length its scenes need is picked by itself; one line only when the pick can't be met */}
            <Slider label="Length" min={15} max={90} step={5} value={lengthSec} onChange={setLength} words={seconds(lengthSec)} marks={source === "script" ? undefined : { from: 30, to: 60, label: "30 to 60 seconds works best." }} stepper />
            {length === null && ideaLength ? <p className="st-s-field__hint">The full idea was written for {seconds(ideaLength)}.</p> : null}
            {source === "script" && range && (lengthSec < range.lo || lengthSec > range.hi) ? (
              <p className="st-s-field__hint">It will be about {Math.round(fitTarget(lengthSec, ownWritten))} seconds.</p>
            ) : null}
          </section>

          <section className="st-s-panel st-glass" aria-labelledby="st-nv-shape">
            <h2 className="st-s-panel__title" id="st-nv-shape">
              <span className="st-s-num">4</span> Shape and size
            </h2>
            <ShapePicker value={format} usual={usualShape} onChange={setShape} usualKnown={!!workspace} picked={shape !== null} />
            <ArtPicker value={drawing} usual={usualArt} onChange={setArt} usualKnown={!!workspace} picked={art !== null} />
          </section>

          <section className="st-s-panel st-glass st-s-words" aria-labelledby="st-nv-4">
            <h2 className="st-s-panel__title" id="st-nv-4">
              <span className="st-s-num">5</span> Words and music
            </h2>
            <Switch label="Captions" line="Words on screen. The videos have no voices." checked={captionsOn} onChange={setCaptions} />
            {ownWords && !captionsOn ? <p className="st-s-field__hint">Captions are off, so your words won&apos;t show.</p> : null}
            <Pick label="Music" value={music} options={CATALOG.musicMoods.map((m) => ({ value: m.id, label: m.id === "none" ? "No music" : m.label }))} onChange={setMood} />
          </section>

          <section className="st-s-panel st-glass" aria-labelledby="st-nv-5">
            <h2 className="st-s-panel__title" id="st-nv-5">
              <span className="st-s-num">6</span> Videos to learn from <span className="st-s-panel__hint">(you can skip this)</span>
            </h2>
            <RefPicker refs={refs.data} error={refs.error} onRetry={() => void refs.reload()} picked={refIds} onChange={setRefIds} />
          </section>

          <section className="st-s-panel st-glass" aria-labelledby="st-nv-6">
            <h2 className="st-s-panel__title" id="st-nv-6">
              <span className="st-s-num">7</span> Model and effort for this video <span className="st-s-panel__hint">(you can skip this)</span>
            </h2>
            <p className="st-s-field__hint">{source === "script" ? "The AI that sets up your scenes and checks them." : "The AI that writes and checks it."}</p>
            <div className="st-s-aiwho">
              <ModelMenu
                info={info}
                usual={usualFor(info, writeTask)}
                value={ai}
                onChange={setAi}
                title="Model and effort for this video"
                note="Kept with this video. Your settings stay the same."
              />
            </div>
          </section>

          <div className="st-s-actionbar st-s-actionbar--pin">
            {/* In the pinned bar, by the button: on a phone the part to fix is far above (it comes into view too). */}
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
            {/* Save draft until there is one; then the draft saves itself and one word says so (§45.47). */}
            {saved && !saveFailed ? (
              <span className="st-s-field__hint st-vd-state" role="status">
                {saving || formJson !== savedJson ? DRAFT_WORDS.saving : DRAFT_WORDS.savedState}
              </span>
            ) : (
              <button type="button" className="st-btn st-vd-save" aria-disabled={busy || saving || undefined} onClick={() => !busy && !saving && void saveDraft(false)}>
                {saving ? DRAFT_WORDS.saving : DRAFT_WORDS.save}
              </button>
            )}
            <button type="button" className="st-btn st-btn--main st-s-big st-make" aria-disabled={busy || undefined} onClick={() => !busy && void make()}>
              {busy ? "Starting…" : "Make the video"}
            </button>
          </div>
        </div>
      )}
      {asking ? (
        <UnusableSheet
          info={info}
          ask={asking}
          onClose={() => setAsking(null)}
          onKeep={() => void make(ai, true)}
          onUse={() => {
            // The usual (which skips it): nothing kept but an effort picked here, when that model offers it.
            const keep = ai?.effort && modelOf(info, asking.instead)?.efforts.includes(ai.effort) ? { effort: ai.effort } : null;
            setAi(keep);
            void make(keep, true);
          }}
        />
      ) : null}
      {leave}
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
        Your reference videos could not load. You can still make the video.
      </Notice>
    );
  if (!refs) return <p className="st-s-field__hint">Getting your reference videos…</p>;
  if (!refs.length)
    return (
      <p className="st-s-field__hint">
        No reference videos yet. Add one in <A href={storiesHref({ name: "references" })}>References</A>.
      </p>
    );
  // Only the picks that have a tile count (one that is not in the list can never be unpicked).
  const full = picked.filter((id) => refs.some((r) => r.refId === id)).length >= 3;
  return (
    <>
      <p className="st-s-field__hint">Pick up to 3. Clips Funded borrows their timing, never their characters or footage.</p>
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
                  <span className="st-s-reftile__meta">{ready ? (r.durationSec ? seconds(r.durationSec) : "Studied") : r.status === "analyzing" ? "Being studied now" : r.status === "fetching" ? "On its way" : r.status === "fetch_failed" ? "Didn't arrive" : "Not studied yet"}</span>
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

// ---------- One video's production page ----------

function StoryProduction({ ws, storyId }: { ws: string; storyId: string }) {
  const toast = useToast();
  const loaded = useLoad(() => storiesApi().getStory(ws, storyId), `${ws}:${storyId}`);
  const jobs = useLoad(() => storiesApi().storyJobs(ws, storyId), `${ws}:${storyId}:jobs`);
  const [busy, setBusy] = useState<"none" | "cancel" | "again" | "ai">("none");
  const [problem, setProblem] = useState<string | null>(null);
  const [pick, setPick] = useState<ModelOverride | null>(null);
  const [asking, setAsking] = useState<ReturnType<typeof unusableAsk>>(null);
  /** Change my script (§45.46), open on a video made from the owner's own script. */
  const [changing, setChanging] = useState(false);
  const info = useAiInfo(ws);
  const refs = useReferenceList(ws);
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

  async function again(pickNow: ModelOverride | null = pick, sure = false) {
    if (!story) return;
    // The run starts at the first out-of-date step: its first model step's usual decides (§45.36 E12).
    const runUsual = storyUsual(info, story, runTask(null, { stale: story.stale }));
    // A model picked on purpose (or kept with this video) that the studio knows cannot be used: ask first (§45.36 E12).
    const ask = sure ? null : unusableAsk(info, runUsual, pickNow);
    if (ask) return setAsking(ask);
    setAsking(null);
    setBusy("again");
    setProblem(null);
    try {
      // "Try … anyway" sends exactly the pick (nothing for a model kept with this video).
      const override = sure ? cleanPick(pickNow) : sendPick(info, runUsual, pickNow);
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
        <Busy plate>Getting the video…</Busy>
      </section>
    );

  const canTryAgain = !live && ["draft", "failed", "review", "needs_check"].includes(story.status) && story.stale.length > 0;
  const watch = ["review", "needs_check", "approved", "published"].includes(story.status);
  // The writer of the storyboard in the video now: the latest run's, else the newest run that wrote it.
  const wrote = job?.meta.writerModel ?? (live ? null : (madeWith([job, ...(jobs.data ?? [])]).find((u) => u.step === "storyboard" && u.task !== "captions")?.model ?? null));
  const writer = wrote ? modelName(info, wrote) : null;
  const editable = !live && ["review", "needs_check", "failed"].includes(story.status);
  // What this run uses: the usual of its first model step (the writer's, or the fact check's for a run from there).
  const usual = storyUsual(info, story, runTask(null, { stale: story.stale }));

  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div className="st-plate">
          <A href={storiesHref({ name: "production" })} className="st-s-back st-s-back--orb">
            <span className="st-s-back__orb">‹</span> Production
          </A>
          <h1 className="st-s-head__title">{story.title}</h1>
          {/* The kind and length are in the preview row just below, so only the status chip here. */}
          <p className="st-s-head__lede">
            <Tag tone={STATUS_TONE[story.status]}>{statusLabel(story)}</Tag>
          </p>
        </div>
      </header>

      <Preview
        story={story}
        job={job}
        notice={problem ? <Notice tone="bad">{problem}</Notice> : null}
        actions={
          watch || live || canTryAgain ? (
            <div className="st-s-actionbar">
              {watch ? (
                // One orange main action in the row: a remake waiting to be made (Try again) wins over watching.
                <A href={storiesHref({ name: "review_story", storyId })} className={`st-btn${canTryAgain ? "" : " st-btn--main"}`}>
                  {story.status === "needs_check" ? "Check it in Review" : "Watch it in Review"}
                </A>
              ) : null}
              {live ? (
                <button type="button" className="st-btn" aria-disabled={busy !== "none" || undefined} onClick={() => busy === "none" && void cancel()}>
                  {busy === "cancel" ? "Stopping…" : "Cancel"}
                </button>
              ) : null}
              {canTryAgain ? (
                <>
                  <ModelMenu info={info} usual={usual} value={pick} onChange={setPick} note="Just for this run. Your settings stay the same." />
                  <button type="button" className="st-btn st-btn--main" aria-disabled={busy !== "none" || undefined} onClick={() => busy === "none" && void again()}>
                    {busy === "again" ? "Starting…" : story.status === "draft" && story.stale.length === STEP_ORDER.length ? "Make the video" : firstStale ? `Try again from “${stepLabel(firstStale, story.ownScript)}”` : "Try again"}
                  </button>
                  {job?.status === "failed" ? <SettingsFix sentence={job.error} /> : null}
                  {job?.status === "failed" && story.ownScript ? (
                    <button type="button" className="st-btn" onClick={() => setChanging(true)}>
                      Change my script
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null
        }
      />

      <section className="st-s-panel st-glass" aria-label="The steps">
        <StepTrack job={job} story={story} label={`Making ${story.title}`} bar={false} line={false} />
        {asking ? (
          <UnusableSheet
            info={info}
            ask={asking}
            onClose={() => setAsking(null)}
            onKeep={() => void again(pick, true)}
            onUse={() => void again(insteadPick(info, asking, pick), true)}
          />
        ) : null}
      </section>

      <section className="st-s-panel st-glass" aria-labelledby="st-board-title">
        <h2 className="st-s-panel__title" id="st-board-title">
          Storyboard
        </h2>
        {story.scenes.length ? (
          <>
            <p className="st-s-field__hint">Tap a scene to play it.</p>
            <Filmstrip script={script} scenes={story.scenes} />
          </>
        ) : (
          <p className="st-s-field__hint">{live ? (story.ownScript ? "Setting up your scenes… they show up here soon." : "Writing the story… the scenes show up here soon.") : "No storyboard yet."}</p>
        )}
      </section>

      <details className="st-s-details st-glass">
        <summary className="st-s-details__sum">Production details</summary>
        <dl className="st-s-facts">
          {story.ownScript ? (
            <>
              {/* The owner's own script (§45.46): the story is theirs, the AI only set up the scenes. */}
              <dt>Story</dt>
              <dd>By you</dd>
              {writer ? (
                <>
                  <dt>Scenes set up by</dt>
                  <dd>{writer}</dd>
                </>
              ) : null}
            </>
          ) : writer ? (
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
          <dt>Drawing style</dt>
          <dd>{artWords(storyArt(story))}</dd>
          {job ? (
            <>
              <dt>Helpers used</dt>
              <dd>{helpersLine(job.meta.providers, job.meta.writerModel, (key) => modelOf(info, key)) || "Clips Funded's own built-in helpers"}</dd>
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
        <ModelsUsed info={info} job={job} jobs={jobs.data} title={live ? "Models working on it" : "Made with"} ids={false} />
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
            {usedOf(job, jobs.data).some((u) => modelIdLine(u)) ? (
              <>
                <dt>Exact models</dt>
                <dd>
                  <ModelIdList used={usedOf(job, jobs.data)} />
                </dd>
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
                  {j.jobType === "changes" ? (j.configuration.note ? "Changes" : "New take of a scene") : j.configuration.from ? `Again from “${(j.configuration.from in STEP_LABEL ? stepLabel(j.configuration.from, story.ownScript) : null) ?? j.configuration.from}”` : "Made"} · {ago(j.createdAt)}
                  {j.meta.models.length ? <span className="st-s-jobs__models">{runModels(info, j)}</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </details>
      {changing && story.ownScript ? (
        <ChangeScriptSheet
          ws={ws}
          story={story}
          onClose={() => setChanging(false)}
          onStarted={(r) => {
            loaded.setData((d) => (d ? { ...d, story: r.story, job: r.job } : d));
            void jobs.reload();
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * The video's preview (hero glass): the render progress as the ArcDial (a big light numeral and the step it is on, or
 * the video's status), beside the video's MediaRow: its cover, what is happening now and the video's kind and length,
 * a bar (the step working through its scenes, else the whole video) with its percent, and the page's actions in the
 * row's controls (Watch it in Review, Cancel, Try again with its model and effort). A problem with them shows under the
 * row. The step track under the preview shows the steps only.
 */
function Preview({ story, job, actions, notice }: { story: Story; job: ProductionJob | null; actions: ReactNode; notice: ReactNode }) {
  const steps = stepsOf(job, story);
  const progress = job ? job.progress : steps.filter((s) => s.status === "done" || s.status === "skipped").length / steps.length;
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  const now = currentStep(steps);
  const line = nowLine(job, steps, story.status, !!story.ownScript);
  const cover = story.coverUrl ?? story.scenes.find((sc) => sc.stillUrl)?.stillUrl ?? null;
  // The step working through the scenes ("scene 3 of 6") has its own bar in the row; otherwise the row's bar is the video's.
  const sceneBar = now?.status === "running" && now.n && now.n > 1 ? Math.min(1, (now.i ?? 0) / now.n) : null;
  const bar = sceneBar ?? Math.max(0, Math.min(1, progress));
  return (
    <div className={`st-s-preview st-glass st-glass--hero st-lens${job?.status === "failed" ? " is-bad" : ""}`}>
      <ArcDial value={progress} label={`Making ${story.title}`} valueText={`${pct}% done`} className="st-s-preview__dial">
        <StatNumeral value={pct} unit="%" label={now ? now.label : statusLabel(story)} />
      </ArcDial>
      <div className="st-s-preview__main">
        <MediaRow
          className="st-s-preview__row"
          thumb={cover ?? <span className="st-s-preview__blank" />}
          title={line || statusLabel(story)}
          meta={`${CATEGORY_LABEL[story.category]} · ${seconds(story.actualDurationSec ?? story.durationSec)}`}
          progress={bar}
          progressLabel={sceneBar !== null && now ? now.label : `Making ${story.title}`}
          progressText={`${Math.round(bar * 100)}%`}
          controls={actions}
        />
        {notice}
      </div>
    </div>
  );
}

/** One run's models in a line: "Write: Opus 5.5 · High"; a step that stopped on its model: "Write: Opus 5.5 · High (stopped)". */
export function runModels(info: AiInfo, j: ProductionJob): string {
  const word: Record<string, string> = { storyboard: "Write", safety: "Check", preview: "Last look" };
  // A step's other calls have their own words (the storyboard step's post captions, §45.35 D5).
  const task: Record<string, string> = { scene_rewrite: "New take", captions: "Captions", animation_plan: "Plan" };
  return j.meta.models
    .map((m) => {
      const stopped = stoppedOn(j, m);
      return `${(m.task ? task[m.task] : undefined) ?? word[m.step] ?? m.step}: ${shortName(modelName(info, m.model))}${(m.effortApplied || stopped) && m.effort ? ` · ${effortName(m.effort)}` : ""}${stopped ? " (stopped)" : ""}`;
    })
    .join(" · ");
}
