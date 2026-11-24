// Lamo Stories › Review (docs/CONTRACTS.md §45.9, §45.14, §45.16.6; spec §5.E). Its own queue (videos to watch and
// videos whose facts need checking; never Lamo Clips' Review), and each video's review page: the player (the MP4, else
// the live preview), Approve (only when the approve rule holds; the fact problems and the sources shown), Reject, Ask
// for changes, Remake this scene, Remake the whole video, Remake and Check again (each with the "Model and effort for
// this one" menu: this job only, never saved), "Next run: {model} · {effort}", the captions editor (with "Write them
// again") and the sound effects editor, which model and effort made each step, Download (the MP4 and each extra copy
// the video has), Post it (the publish sheet, with the exact account each platform sends to) and the Posts panel,
// whose Try again asks "Post to {name}?" when the API names a changed account (§45.34). Each queue group has Show more.
// Series (§45.44): the queue's "All ▾" switch asks each group for one series (`?series=`); a video's page shows its
// series with Move, and approving an episode says which episode it became.
// While My Mac posts TikTok is on (§47.10) the TikTok row says what the owner's Mac is doing: the page reads the posts
// every 10 seconds while the Mac has one waiting or working, and the Mac's status every minute while one is shown.
// Facts to fix have "Fix the words", which opens the caption to change; Reject asks first; saving the captions keeps
// the sounds' changes not saved yet (and the other way round).
// A video made from the owner's own script (§45.46) shows "Your script" (the scenes as written), Change my script in
// place of Ask for changes (no note: the AI never changes what happens), and a fact about "Your scene N" opens Change
// my script at that scene.
import "../styles/studio.css";
import { useEffect, useRef, useState } from "react";
import { A } from "../../components/ui.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { useAppActive } from "../pane.tsx";
import { useLoad, usePoll } from "../../lib/hooks.ts";
import { storiesSound } from "../prefs.ts";
import { starBurst, StTech } from "../ui.tsx";
import { storiesApi } from "../api/client.ts";
import type { DownloadFormat, ErrorAccount, ModelOverride, Platform, PublishingJob, SocialAccount, StepKey, StoriesConfig, Story, StoryPatch, StoryStatus, TaskKind } from "../api/types.ts";
import { navigate } from "../../lib/router.ts";
import { storiesHref } from "../routes.ts";
import { cleanPick, insteadPick, madeWith, ModelMenu, ModelsUsed, NextRun, runTask, sendPick, SettingsFix, StoryAi, storyUsual, UnusableSheet, unusableAsk, useAiInfo } from "../studio/ai.tsx";
import { artWords, storyArt } from "../studio/art.tsx";
import { CaptionEditor, type CaptionTab } from "../studio/CaptionEditor.tsx";
import { Filmstrip } from "../studio/Filmstrip.tsx";
import { usePaged, useSameScript, useWidth, useWorkspace } from "../studio/hooks.ts";
import { storiesReduceMotion } from "../prefs.ts";
import { Busy, celebrate, Chip, Notice, ShowMore, StSheet, Tag, TextField } from "../studio/kit.tsx";
import { Player } from "../studio/Player.tsx";
import { macInFlight } from "../studio/macRow.ts";
import { PostsPanel, type PostMacProps } from "../studio/PostsPanel.tsx";
import { filterOf, MoveToSeries, SeriesSwitch, seriesChanged, seriesQuery, useSeriesList, type SeriesFilter } from "../studio/SeriesSwitch.tsx";
import { AccountCard, claimPostCheer, postToTitle, postYes, PublishSheet } from "../studio/PublishSheet.tsx";
import { useMacStatus } from "../studio/TikTokMac.tsx";
import { SfxEditor } from "../studio/SfxEditor.tsx";
import { sceneOfProblem } from "../studio/ownScript.ts";
import { ChangeScriptSheet, OwnChip, ScriptPanel } from "../studio/ScriptEditor.tsx";
import { StepTrack } from "../studio/StepTrack.tsx";
import { accountOf, CATEGORY_LABEL, isConflict, PLATFORM_LABEL, say, seconds, STATUS_LABEL, STATUS_TONE, thisAccount } from "../studio/words.ts";
import type { StoriesScreenProps } from "./types.ts";

export function ReviewScreen({ ws, page }: StoriesScreenProps) {
  if (page.name === "review_story") return <ReviewStory ws={ws} storyId={page.storyId} />;
  return <ReviewQueue ws={ws} series={page.name === "review" ? filterOf(page) : "all"} />;
}

/** True when the facts check holds for the storyboard as it is now ("skipped" only outside driving safety). */
function checkHolds(story: Story): boolean {
  const s = story.safety;
  if (!s) return true;
  const passed = s.status === "ok" || (s.status === "skipped" && story.category !== "driving_safety");
  return passed && s.checkedScriptVersion === story.scriptVersion;
}

/**
 * The video waits for review with every change in it, but the facts were checked on an older storyboard (or the
 * check never finished): nothing is marked to make again, so only Check again (from the check on) fixes it.
 */
export function checkOutdated(story: Story): boolean {
  if (story.status !== "review" || story.stale.length || story.safety?.status === "problems") return false;
  return !checkHolds(story);
}

export const OUTDATED_CHECK = "The facts were checked on an older version of the words. Tap Check again.";

/** Only the words posted with the video changed: they are not in the video, so only the fact check is out of date. */
export const POST_WORDS_CHECK = "Your new post words need a quick check. Tap Check again.";

/**
 * True when the only thing out of date is the fact check because the post words changed (§45.36 E10: the API marks
 * only "safety" for a postCaptions edit, STALE_POST), while the video waits for review or for its check (the API's
 * only_check_stale). Check again is the fix: a produce with no `from`, which runs exactly the stale steps, so only the
 * fact check (a `from: "safety"` would make every step after it again). Never a remake.
 */
export function onlyPostWords(story: Pick<Story, "stale" | "status">): boolean {
  return (story.status === "review" || story.status === "needs_check") && story.stale.length === 1 && story.stale[0] === "safety";
}

/**
 * Why Approve cannot be tapped yet, or null when it can (the approve rule, §45.9): the video waits for review, every
 * change is in it, and the facts were checked on this very storyboard.
 */
export function approveBlock(story: Story): string | null {
  if (story.safety?.status === "problems") return "Fix the facts first: tap Fix the words.";
  if (onlyPostWords(story)) return POST_WORDS_CHECK;
  if (story.status === "needs_check") return "Check the facts first.";
  if (story.status !== "review") return null;
  if (story.stale.length) return "Your changes aren't in the video yet. Tap Remake first.";
  if (checkOutdated(story)) return OUTDATED_CHECK;
  return null;
}

/** The words to fix for a fact problem: the caption (or a scene's words) whose words the problem quotes, else the first. */
export function fieldToFix(box: ParentNode, problems: string[]): HTMLInputElement | HTMLTextAreaElement | null {
  const fields = Array.from(box.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input.st-s-input, textarea.st-s-input"));
  const quoted = (v: string) => v.trim().length > 0 && problems.some((p) => p.includes(`“${v.trim()}”`) || p.includes(v.trim()));
  return fields.find((f) => quoted(f.value)) ?? fields[0] ?? null;
}

/**
 * True when a publishing 409 is about the account (it now sends to another one, or Lamo Stories cannot tell it from
 * Clip Factory's own): the server's sentence names the account, so the owner is asked before it is sent there. Every
 * other 409 (already retried, not stuck, the story changed) is only shown.
 */
export function accountQuestion(sentence: string, account: SocialAccount): boolean {
  const names = [account.accountName, account.handle, account.externalAccountId].filter((n): n is string => !!n && n.length > 1);
  return names.some((n) => sentence.includes(n)) || /different account|cannot tell if/i.test(sentence);
}

// ---------- The queue ----------

const QUEUE: { title: string; statuses: StoryStatus[]; empty: string }[] = [
  { title: "Waiting for you", statuses: ["needs_check", "review"], empty: "Nothing to watch yet. New videos show up here." },
  { title: "Approved, ready to post", statuses: ["approved"], empty: "" },
  { title: "Posted", statuses: ["published"], empty: "" },
];

/** One page of a queue group: each of its statuses has its own cursor, kept together as one ("Show more", §45.34). */
async function groupPage(ws: string, statuses: StoryStatus[], cursor?: string, series?: string): Promise<{ items: Story[]; nextCursor: string | null }> {
  const cursors: Partial<Record<StoryStatus, string | null>> = cursor ? (JSON.parse(cursor) as Partial<Record<StoryStatus, string | null>>) : {};
  const asked = cursor ? statuses.filter((st) => cursors[st]) : statuses;
  const inSeries = series ? { seriesId: series } : {};
  const pages = await Promise.all(asked.map((status) => storiesApi().listStories(ws, cursors[status] ? { status, limit: 50, cursor: cursors[status]!, ...inSeries } : { status, limit: 50, ...inSeries })));
  const next: Partial<Record<StoryStatus, string | null>> = {};
  asked.forEach((status, i) => {
    next[status] = pages[i]!.nextCursor;
  });
  const items = pages.flatMap((p) => p.stories).sort((a, b) => statuses.indexOf(a.status) - statuses.indexOf(b.status));
  return { items, nextCursor: Object.values(next).some(Boolean) ? JSON.stringify(next) : null };
}

function ReviewQueue({ ws, series }: { ws: string; series: SeriesFilter }) {
  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div className="st-plate">
          <h1 className="st-s-head__title">Review</h1>
          <p className="st-s-head__lede">Watch each new video, then approve it or fix it.</p>
        </div>
        <div className="st-s-head__actions">
          <SeriesSwitch ws={ws} value={series} onChange={(v) => navigate(storiesHref({ name: "review", ...(seriesQuery(v) ? { seriesId: seriesQuery(v) } : {}) }))} />
        </div>
      </header>
      {QUEUE.map((group) => (
        <QueueGroup key={`${group.title}|${series}`} ws={ws} group={group} series={seriesQuery(series)} />
      ))}
    </section>
  );
}

function QueueGroup({ ws, group, series }: { ws: string; group: (typeof QUEUE)[number]; series?: string }) {
  const list = usePaged(
    (cursor) => groupPage(ws, group.statuses, cursor, series),
    `${ws}|${group.statuses.join(",")}${series ? `|${series}` : ""}`,
    "st-s-review-group",
    (s) => s.storyId,
  );
  if (list.error && !list.data)
    return (
      <section aria-label={group.title}>
        <h2 className="st-s-section st-plate">{group.title}</h2>
        <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void list.reload()}>Try again</button>}>
          {list.error}
        </Notice>
      </section>
    );
  if (!list.data)
    return group.empty ? (
      <section aria-label={group.title}>
        <h2 className="st-s-section st-plate">{group.title}</h2>
        <Busy plate>Getting the videos to review…</Busy>
      </section>
    ) : null;
  const items = list.data.filter((s) => group.statuses.includes(s.status));
  if (!items.length && !group.empty) return null;
  return (
    <section aria-label={group.title}>
      <h2 className="st-s-section st-plate">{group.title}</h2>
      {items.length ? (
        <ul className="st-s-queue">
          {items.map((s) => (
            <li key={s.storyId}>
              <A href={storiesHref({ name: "review_story", storyId: s.storyId })} className="st-s-qcard st-glass">
                {s.coverUrl ? <img className="st-s-qcard__cover" src={s.coverUrl} alt="" width={90} height={160} /> : <span className="st-s-qcard__cover is-blank" aria-hidden="true" />}
                <span className="st-s-qcard__text">
                  <Tag tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Tag>
                  <span className="st-s-qcard__title">{s.title}</span>
                  <span className="st-s-qcard__meta">
                    {CATEGORY_LABEL[s.category]} · {seconds(s.actualDurationSec ?? s.durationSec)}
                  </span>
                  {s.status === "needs_check" && s.safety?.problems.length ? <span className="st-s-qcard__why">{s.safety.problems.length === 1 ? "1 fact to fix" : `${s.safety.problems.length} facts to fix`}</span> : null}
                  {s.posted.length ? <span className="st-s-qcard__meta">On {s.posted.map((p) => PLATFORM_LABEL[p.platform]).join(", ")}</span> : null}
                </span>
              </A>
            </li>
          ))}
        </ul>
      ) : (
        <p className="st-s-field__hint st-plate">{group.empty}</p>
      )}
      <ShowMore list={list} what="videos" />
    </section>
  );
}

// ---------- One video ----------

/** "Added to {name} as episode {n}." after an approval in a series (§45.44), else null (no series, or not read). */
async function episodeWords(ws: string, story: Story): Promise<string | null> {
  if (!story.seriesId) return null;
  try {
    const s = await storiesApi().getSeries(ws, story.seriesId);
    void seriesChanged(ws);
    const n = s.episodes.find((e) => e.storyId === story.storyId)?.number;
    return n ? `Added to ${s.name} as episode ${n}.` : null;
  } catch {
    return null;
  }
}

/** "Series: {name}" and Move, under a video's title (nothing while the workspace has no series). */
function SeriesChip({ ws, story, onMoved }: { ws: string; story: Story; onMoved: (seriesId: string | null) => void }) {
  const { list } = useSeriesList(ws);
  const s = story.seriesId ? list?.find((x) => x.seriesId === story.seriesId) : undefined;
  if (!list?.length && !story.seriesId) return null;
  return (
    <p className="st-series-chip">
      {s ? (
        <A href={storiesHref({ name: "series_one", seriesId: s.seriesId })} className="st-btn st-s-small">
          Series: {s.name}
        </A>
      ) : null}
      <MoveToSeries ws={ws} kind="story" id={story.storyId} title={story.title} current={story.seriesId ?? null} onMoved={onMoved} />
    </p>
  );
}

/** `notOnTikTok`: a Mac post's Try again after "Post it again?" (§47.10), sent again with the yes. */
type Confirm = { job: PublishingJob; account: ErrorAccount; message: string; notOnTikTok?: boolean };

const FORMAT_NAME: Record<DownloadFormat, string> = { mp4: "MP4", webm: "WebM", mov: "MOV" };

/**
 * The extra copies this video has now (CONTRACTS §45.34: ASSET# items of kind `video` with meta.format, made beside the
 * MP4; a `final_video` with meta.format counts too). The Library is asked for the story's newest files, where the
 * copies of the last assembly are.
 */
async function copiesOf(ws: string, storyId: string): Promise<DownloadFormat[]> {
  const { items } = await storiesApi().library(ws, { storyId, limit: 100 });
  const found = new Set<DownloadFormat>();
  for (const i of items)
    if ((i.kind === "video" || i.kind === "final_video") && i.meta.current !== 0 && (i.meta.format === "webm" || i.meta.format === "mov")) found.add(i.meta.format);
  return (["webm", "mov"] as DownloadFormat[]).filter((f) => found.has(f));
}

function ReviewStory({ ws, storyId }: { ws: string; storyId: string }) {
  const toast = useToast();
  const loaded = useLoad(() => storiesApi().getStory(ws, storyId), `${ws}:${storyId}`);
  const pubs = useLoad(() => storiesApi().listPublishing(ws, storyId), `${ws}:${storyId}:pubs`);
  const workspace = useWorkspace(ws);
  const cfg = (workspace?.configuration ?? {}) as Partial<StoriesConfig>;
  const [form, setForm] = useState<"none" | "reject" | "changes">("none");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [asking, setAsking] = useState<"none" | "whole">("none");
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [posting, setPosting] = useState(false);
  /** Post it opened by a row's Post with my Mac: only that place ticked. */
  const [postOnly, setPostOnly] = useState<Platform | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  /** The model and effort for the next remake only (never saved). */
  const [pick, setPick] = useState<ModelOverride | null>(null);
  /** The question before a remake with a model the studio knows cannot be used (§45.36 E12), and the remake it holds. */
  const [unusable, setUnusable] = useState<{ ask: NonNullable<ReturnType<typeof unusableAsk>>; name: string; run: (extra: { override?: ModelOverride }) => Promise<void> } | null>(null);
  /** The captions box's tab, kept here so it stays where the owner was after Use these or Save (§45.36 E10). */
  const [captionTab, setCaptionTab] = useState<CaptionTab>("video");
  /** Each box starts again only after its own save (or a Reload): the other box keeps its changes not saved yet. */
  const [saves, setSaves] = useState({ captions: 0, sounds: 0, reloads: 0 });
  /** Ask for changes with nothing said: its own line, in the form. */
  const [changesProblem, setChangesProblem] = useState<string | null>(null);
  /** Reject asks first: it can't be undone. */
  const [sureReject, setSureReject] = useState(false);
  /** Change my script (§45.46): open (at a scene, from 1, for Fix the words), or false. */
  const [changing, setChanging] = useState<number | null | false>(false);
  const info = useAiInfo(ws);
  const [col, colWidth] = useWidth<HTMLDivElement>(300);
  const seen = useRef<Map<string, PublishingJob["publishingStatus"]> | null>(null);
  const wasLive = useRef(false);

  const story = loaded.data?.story ?? null;
  const approvedNow = story?.status === "approved" || story?.status === "published";
  // The copies the video has besides its MP4 (read once it can be downloaded, again after a new version).
  const copies = useLoad(async () => (approvedNow ? await copiesOf(ws, storyId) : []), `${ws}:${storyId}:copies:${approvedNow ? (story?.scriptVersion ?? 0) : "no"}`);
  const job = loaded.data?.job ?? null;
  // Every run of this video, read again whenever the latest one changes: "How it was made" names the model of each
  // step as it is in the video now, even after a later run of only some steps.
  const runs = useLoad(() => storiesApi().storyJobs(ws, storyId), `${ws}:${storyId}:runs:${job?.jobId ?? ""}:${job?.status ?? ""}`);
  const script = useSameScript(loaded.data?.script ?? null);
  const live = (!!job && (job.status === "queued" || job.status === "running")) || story?.status === "producing";
  const inFlight = (pubs.data ?? []).some((j) => j.publishingStatus === "queued" || j.publishingStatus === "publishing" || macInFlight(j));
  // My Mac posts TikTok (§47.10): the Mac's status, read every minute while a Mac post is shown.
  const macOn = cfg.tiktokMac?.on === true;
  const macShown = (pubs.data ?? []).some((j) => j.publishingStatus === "mac");
  const macStatus = useMacStatus(ws, macOn && macShown);

  // Not while Clip Factory is on screen: a remake or a post that finished meanwhile is noticed, and celebrated, once
  // this page is back on screen (never confetti, a toast or the cheer over Clip Factory).
  const active = useAppActive();
  usePoll(() => loaded.reload(), live && active, 2000);
  usePoll(() => pubs.reload(), inFlight && active, 10_000);

  // A remake that finishes while the owner watches.
  useEffect(() => {
    if (live) {
      wasLive.current = true;
      return;
    }
    if (!wasLive.current || !story) return;
    wasLive.current = false;
    if (story.status === "review") toast.success("The new version is ready to watch.");
    else if (story.status === "needs_check") toast.info("Made. Some facts still need checking.");
    else if (story.status === "failed") toast.error(job?.error ?? "Making the video stopped. Tap Try again.");
    // Only when the run state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, story?.status]);

  // A post that goes up while the owner watches gets its celebration.
  useEffect(() => {
    const list = pubs.data;
    if (!list) return;
    const before = seen.current;
    seen.current = new Map(list.map((j) => [j.publishingJobId, j.publishingStatus]));
    if (!before) return;
    const up = list.filter((j) => j.publishingStatus === "posted" && before.get(j.publishingJobId) !== "posted");
    if (!up.length) return;
    // One star burst and one cheer per post (§45.36 E11): the Post it sheet celebrates the places it sent itself, and
    // this page every other one (one that went up while the sheet was still on its form, or after it closed).
    if (up.filter((j) => claimPostCheer(j.publishingJobId)).length) {
      starBurst(undefined, 140);
      storiesSound("success", { onNextTap: true });
    }
    toast.success(`Posted to ${up.map((j) => PLATFORM_LABEL[j.platform]).join(" and ")}!`);
    void loaded.reload();
    // Reacts to new publishing results only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubs.data]);

  const setStory = (s: Story) => loaded.setData((d) => (d ? { ...d, story: s } : d));

  async function act(name: string, run: () => Promise<void>) {
    if (busy) return;
    setBusy(name);
    setProblem(null);
    try {
      await run();
    } catch (e) {
      setProblem(say(e));
    } finally {
      setBusy(null);
    }
  }

  const startRun = (r: { story: Story; job: typeof job }) => {
    loaded.setData((d) => (d ? { ...d, story: r.story, job: r.job } : d));
    setForm("none");
    setPick(null);
  };

  /**
   * Runs a remake (`name` is its busy name). Its own model and effort: the owner's pick, or, when the usual of the run's
   * first model step (`task`) cannot be used, the model the menu shows instead (§45.36 E12). A model picked on purpose,
   * or kept with this video, that the studio knows cannot be used is asked about first, never swapped by itself.
   */
  function remake(name: string, task: TaskKind, run: (extra: { override?: ModelOverride }) => Promise<void>) {
    if (!story || busy) return;
    const usual = storyUsual(info, story, task);
    const ask = unusableAsk(info, usual, pick);
    if (ask) {
      setAsking("none");
      return setUnusable({ ask, name, run });
    }
    const o = sendPick(info, usual, pick);
    void act(name, () => run(o ? { override: o } : {}));
  }

  /** A produce call that carries a body only when there is something in it. */
  const produceNow = (body: { from?: StepKey }, extra: { override?: ModelOverride }) => {
    const b = { ...body, ...extra };
    return Object.keys(b).length ? storiesApi().produce(ws, storyId, b) : storiesApi().produce(ws, storyId);
  };

  async function keepAi(next: ModelOverride | null) {
    await act("ai", async () => {
      if (!story) return;
      const r = await storiesApi().patchStory(ws, storyId, { version: story.version, ai: { model: next?.model ?? null, effort: next?.effort ?? null } });
      loaded.setData((d) => (d ? { ...d, story: r.story, script: r.script ?? d.script } : d));
      toast.success(next ? "Kept with this video. Its next remake uses it." : "This video uses your usual settings again.");
    });
  }

  async function save(edit: Omit<StoryPatch, "version">, box: "captions" | "sounds") {
    if (!story) return;
    setSaving(true);
    setProblem(null);
    setStale(false);
    try {
      const r = await storiesApi().patchStory(ws, storyId, { version: story.version, ...edit });
      loaded.setData((d) => (d ? { ...d, story: r.story, script: r.script } : d));
      setSaves((n) => ({ ...n, [box]: n[box] + 1 }));
      // New post words are not in the video: they only need the quick fact check (§45.36 E10), never a remake. A video
      // waiting for its check says the page's own button, Check again.
      toast.success(
        onlyPostWords(r.story)
          ? `Saved. ${POST_WORDS_CHECK}`
          : r.story.status === "needs_check"
            ? "Saved. Tap Check again."
            : "Saved. Tap Remake to put it in the video.",
      );
    } catch (e) {
      if (isConflict(e) && /changed|reload/i.test(say(e))) setStale(true);
      else setProblem(say(e));
    } finally {
      setSaving(false);
    }
  }

  async function retry(j: PublishingJob, confirmAccount?: string, notOnTikTok?: boolean) {
    setRetrying(j.publishingJobId);
    try {
      // A Mac post waits for the Mac again (§47.10); any other post is sent again.
      const mac = j.publishingStatus === "mac";
      const next = mac
        ? await storiesApi().macRetry(ws, j.publishingJobId, { ...(notOnTikTok ? { notOnTikTok: true as const } : {}), ...(confirmAccount ? { confirmAccount } : {}) })
        : await storiesApi().retryPublishing(ws, j.publishingJobId, confirmAccount ? { confirmAccount } : undefined);
      pubs.setData((list) => (list ? list.map((x) => (x.publishingJobId === next.publishingJobId ? next : x)) : [next]));
      setConfirm(null);
      if (mac) void macStatus.reload();
    } catch (e) {
      // The API names the account it would send to now (error.account, §45.34): ask before sending there.
      const named = accountOf(e);
      if (named && named.externalAccountId !== confirmAccount) {
        setConfirm({ job: j, account: named, message: say(e), notOnTikTok });
        return;
      }
      if (isConflict(e) && !confirmAccount) {
        // An answer without the account: the account is read here, and asked about only when the sentence names it.
        try {
          const { accounts } = await storiesApi().social(ws);
          const account = accounts.find((a) => a.platform === j.platform);
          if (account && account.connectionStatus === "connected" && account.externalAccountId && accountQuestion(say(e), account)) {
            setConfirm({ job: j, account: { externalAccountId: account.externalAccountId, accountName: account.accountName, handle: account.handle }, message: say(e), notOnTikTok });
            return;
          }
        } catch {
          // fall through to the server's own sentence
        }
      }
      toast.error(say(e));
    } finally {
      setRetrying(null);
    }
  }

  /** It's on TikTok on a Mac post (§47.10): its link, or none. Answers the problem to show, or null once saved. */
  async function macPosted(j: PublishingJob, body: { link: string } | { noLink: true }): Promise<string | null> {
    try {
      const next = await storiesApi().macPosted(ws, j.publishingJobId, body);
      pubs.setData((list) => (list ? list.map((x) => (x.publishingJobId === next.publishingJobId ? next : x)) : [next]));
      void macStatus.reload();
      return null;
    } catch (e) {
      return say(e);
    }
  }

  const macRows: PostMacProps = {
    on: macOn,
    status: macStatus.data ?? null,
    onRetry: (j, notOnTikTok) => void retry(j, undefined, notOnTikTok),
    onPosted: macPosted,
    onPostWithMac: (j) => {
      setPostOnly(j.platform);
      setPosting(true);
    },
    onResume: async () => {
      try {
        await storiesApi().macResume(ws);
        void macStatus.reload();
        return null;
      } catch (e) {
        return say(e);
      }
    },
  };

  async function download(format?: DownloadFormat) {
    await act(format ? `download:${format}` : "download", async () => {
      const { url, filename } = format ? await storiesApi().download(ws, storyId, { format }) : await storiesApi().download(ws, storyId);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success(format ? `Downloading the ${FORMAT_NAME[format]} copy.` : "Downloading your video.");
    });
  }

  /** "Fix the words": the captions box on the words on the video, at the caption the fact problem quotes. */
  function fixWords(problems: string[]) {
    setCaptionTab("video");
    requestAnimationFrame(() => {
      const box = document.getElementById("st-captions-title")?.closest("section");
      if (!box) return;
      const f = fieldToFix(box, problems);
      (f ?? box).scrollIntoView?.({ block: "center", behavior: storiesReduceMotion() ? "auto" : "smooth" });
      f?.focus({ preventScroll: true });
    });
  }

  if (loaded.error && !story)
    return (
      <section className="st-page st-studio">
        <Notice tone="bad" action={<A href={storiesHref({ name: "review" })} className="st-btn">Back to Review</A>}>
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

  const deciding = !live && (story.status === "review" || story.status === "needs_check");
  const editable = !live && !!script && ["review", "needs_check", "failed"].includes(story.status);
  const block = approveBlock(story);
  const done = story.status === "approved" || story.status === "published";
  const problems = story.safety?.status === "problems" ? story.safety.problems : [];
  // A fact about the owner's own words ("Your scene 2 …"): Fix the words opens Change my script at that scene.
  const ownFix = story.ownScript ? (problems.map(sceneOfProblem).find((n): n is number => n !== null) ?? null) : null;
  const citations = story.safety?.citations ?? [];
  const checkAgain = story.status === "needs_check";
  const outdated = !live && checkOutdated(story);
  const postWords = !live && onlyPostWords(story);
  const stopped = story.status === "failed" ? (job?.status === "failed" && job.error ? job.error : "Making this video stopped.") : null;
  const used = live ? (job?.meta.models ?? []) : madeWith([job, ...(runs.data ?? [])]);
  // Each menu shows the usual of the run its button starts, so what it shows is what is sent (§45.36 E12): the page's
  // next remake starts at the first out-of-date step (the fact check after new post words or an outdated check), the
  // whole-video remake and Ask for changes at the storyboard.
  const nextTask = story.stale.length ? runTask(null, { stale: story.stale }) : outdated ? "fact_check" : "storyboard";
  const menuFor = (task: TaskKind) => <ModelMenu info={info} usual={storyUsual(info, story, task)} value={pick} onChange={setPick} note="Just for the next remake. Your settings stay the same." />;
  const remakeMenu = menuFor(nextTask);
  const changesTask = runTask("storyboard", { sceneIds: !note.trim() && picked.length > 0 });
  // Phones get a smaller player, so the decision is close below it.
  const width = colWidth < 500 ? Math.max(180, Math.min(250, colWidth - 40)) : Math.max(200, Math.min(340, colWidth));

  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div className="st-plate">
          <A href={storiesHref({ name: "review" })} className="st-s-back st-s-back--orb">
            <span className="st-s-back__orb">‹</span> Review
          </A>
          <h1 className="st-s-head__title">{story.title}</h1>
          <p className="st-s-head__lede">
            <Tag tone={STATUS_TONE[story.status]}>{STATUS_LABEL[story.status]}</Tag> {CATEGORY_LABEL[story.category]} · {seconds(story.actualDurationSec ?? story.durationSec)}
          </p>
          <SeriesChip ws={ws} story={story} onMoved={(seriesId) => setStory({ ...story, seriesId: seriesId ?? undefined, version: story.version + 1 })} />
          {story.ownScript ? <OwnChip /> : null}
        </div>
      </header>

      <div className="st-s-review">
        <div className="st-s-review__player" ref={col}>
          <Player story={story} script={script} width={width} />
          {done ? (
            <div className="st-s-downloads" role="group" aria-label="Download">
              <button type="button" className="st-btn" aria-disabled={busy !== null || undefined} onClick={() => void download()}>
                {busy === "download" ? "Getting the file…" : copies.data?.length ? "Download MP4" : "Download"}
              </button>
              {(copies.data ?? []).map((f) => (
                <button key={f} type="button" className="st-btn" aria-disabled={busy !== null || undefined} onClick={() => void download(f)}>
                  {busy === `download:${f}` ? "Getting the file…" : `Download ${FORMAT_NAME[f]}`}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="st-s-review__side">
          {live ? (
            <section className="st-s-panel st-glass" aria-label="Being made again">
              <StepTrack job={job} story={story} label={`Making ${story.title}`} />
              <A href={storiesHref({ name: "production_story", storyId })} className="st-btn">
                Watch it being made
              </A>
            </section>
          ) : null}

          {problems.length ? (
            <Notice
              tone="bad"
              action={
                editable ? (
                  <button type="button" className="st-btn st-btn--main" onClick={() => (ownFix !== null ? setChanging(ownFix) : fixWords(problems))}>
                    Fix the words
                  </button>
                ) : undefined
              }
            >
              <strong>Fix the facts first.</strong>
              <ul className="st-s-problems">
                {problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
              {ownFix !== null ? (editable ? "Tap Fix the words, change your words, then tap Make it again." : "Change your words, then make it again.") : editable ? "Tap Fix the words, change them, then tap Save captions." : "Change the words, then save them."}
            </Notice>
          ) : null}


          {postWords ? (
            <Notice
              tone="info"
              action={
                <button
                  type="button"
                  className="st-btn st-btn--main"
                  aria-disabled={busy !== null || undefined}
                  onClick={() => remake("check", "fact_check", async (x) => startRun(await produceNow({}, x)))}
                >
                  {busy === "check" ? "Starting…" : "Check again"}
                </button>
              }
            >
              {POST_WORDS_CHECK}
            </Notice>
          ) : !live && story.stale.length && story.status !== "draft" ? (
            <Notice
              tone={stopped ? "bad" : "info"}
              action={
                <span className="st-s-ai-fix">
                  {!deciding ? remakeMenu : null}
                  <button
                    type="button"
                    className="st-btn st-btn--main"
                    aria-disabled={busy !== null || undefined}
                    onClick={() => remake("remake", runTask(null, { stale: story.stale }), async (x) => startRun(await produceNow({}, x)))}
                  >
                    {busy === "remake" ? "Starting…" : checkAgain ? "Check again" : stopped ? "Try again" : "Remake"}
                  </button>
                  {stopped ? <SettingsFix sentence={stopped} /> : null}
                </span>
              }
            >
              {/* Its button is right beside it, and the reason under Approve says Tap Remake first. */}
              {stopped ?? (checkAgain ? "Your fixes are saved. Tap Check again." : "Your changes aren't in the video yet.")}
            </Notice>
          ) : null}
          {outdated ? (
            <Notice
              tone="info"
              action={
                <button
                  type="button"
                  className="st-btn st-btn--main"
                  aria-disabled={busy !== null || undefined}
                  onClick={() => remake("check", "fact_check", async (x) => startRun(await produceNow({ from: "safety" }, x)))}
                >
                  {busy === "check" ? "Starting…" : "Check again"}
                </button>
              }
            >
              {/* The whole reason (OUTDATED_CHECK) is under Approve, so it is not said twice. */}
              The facts need checking again.
            </Notice>
          ) : null}

          {story.status === "rejected" ? <Notice tone="info">Not used.{story.reviewNote ? ` The reason: ${story.reviewNote}` : ""}</Notice> : null}
          {problem ? <Notice tone="bad">{problem}</Notice> : null}

          {deciding ? (
            <section className="st-s-panel st-s-decide st-glass" aria-label="Your decision">
              <div className="st-s-decide__main">
                <button
                  type="button"
                  className="st-btn st-btn--main st-s-big st-approve"
                  aria-disabled={!!block || busy !== null || undefined}
                  aria-describedby={block ? "st-approve-why" : undefined}
                  onClick={(e) => {
                    if (block || busy) return;
                    const btn = e.currentTarget;
                    void act("approve", async () => {
                      const s = await storiesApi().approve(ws, storyId, story.version);
                      setStory(s);
                      celebrate(btn, 150);
                      toast.success((await episodeWords(ws, s)) ?? "Approved! Now you can post it.");
                    });
                  }}
                >
                  {busy === "approve" ? "Approving…" : "Approve"}
                </button>
                {block ? (
                  <p className="st-s-field__hint" id="st-approve-why">
                    {block}
                  </p>
                ) : null}
              </div>
              <div className="st-s-decide__ai">
                <span className="st-s-field__hint">Remakes use</span>
                {remakeMenu}
              </div>
              {/* "Remakes use" above already names the model and effort: "Next run" is in How it was made. */}
              <div className="st-s-decide__more">
                {story.ownScript ? (
                  // The owner's own script: they change their own words; no note lets the AI change what happens.
                  <button type="button" className="st-btn" aria-haspopup="dialog" onClick={() => setChanging(null)}>
                    Change my script
                  </button>
                ) : (
                  <button
                    type="button"
                    className="st-btn"
                    aria-expanded={form === "changes"}
                    onClick={() => {
                      setChangesProblem(null);
                      setForm((f) => (f === "changes" ? "none" : "changes"));
                    }}
                  >
                    Ask for changes
                  </button>
                )}
                <button type="button" className="st-btn" onClick={() => setAsking("whole")}>
                  Remake the whole video
                </button>
                <button type="button" className="st-btn st-s-quiet" aria-expanded={form === "reject"} onClick={() => setForm((f) => (f === "reject" ? "none" : "reject"))}>
                  Reject
                </button>
              </div>
              {form === "changes" && !story.ownScript ? (
                <form
                  className="st-s-form"
                  aria-label="Ask for changes"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!note.trim() && !picked.length) {
                      // Said here, by the box to fill in (the page's own notice is far above on a phone).
                      setChangesProblem("Say what to change, or pick a scene.");
                      document.getElementById("st-changes-note")?.focus();
                      return;
                    }
                    setChangesProblem(null);
                    remake("changes", changesTask, async (x) => {
                      const body: { note?: string; sceneIds?: string[]; override?: ModelOverride } = { ...x };
                      if (note.trim()) body.note = note.trim();
                      if (picked.length) body.sceneIds = picked;
                      startRun(await storiesApi().requestChanges(ws, storyId, body));
                      setNote("");
                      setPicked([]);
                      toast.success("Got it. Making the changes now.");
                    });
                  }}
                >
                  <TextField
                    id="st-changes-note"
                    label="What should change?"
                    multiline
                    rows={3}
                    value={note}
                    onChange={(v) => {
                      setNote(v);
                      setChangesProblem(null);
                    }}
                    max={500}
                    problem={changesProblem}
                    placeholder="For example: make Pip look more surprised when the car slides"
                  />
                  <div className="st-s-field">
                    <span className="st-s-field__label">Only these scenes (you can skip this)</span>
                    <div className="st-s-chips">
                      {story.scenes.map((sc, i) => (
                        <Chip
                          key={sc.sceneId}
                          on={picked.includes(sc.sceneId)}
                          onToggle={() => {
                            setChangesProblem(null);
                            setPicked((p) => (p.includes(sc.sceneId) ? p.filter((x) => x !== sc.sceneId) : [...p, sc.sceneId]));
                          }}
                        >
                          {i + 1}. {sc.title}
                        </Chip>
                      ))}
                    </div>
                  </div>
                  {changesTask !== nextTask ? (
                    <div className="st-s-decide__ai st-s-changes__ai">
                      <span className="st-s-field__hint">These changes use</span>
                      {menuFor(changesTask)}
                    </div>
                  ) : null}
                  <div className="st-s-actionbar">
                    <button type="submit" className="st-btn st-btn--main" aria-disabled={busy !== null || (!note.trim() && !picked.length) || undefined}>
                      {busy === "changes" ? "Sending…" : "Send the changes"}
                    </button>
                  </div>
                </form>
              ) : null}
              {form === "reject" ? (
                <form
                  className="st-s-form"
                  aria-label="Reject"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!busy) setSureReject(true);
                  }}
                >
                  <TextField label="Why? (you can skip this)" multiline rows={2} value={reason} onChange={setReason} max={500} placeholder="For example: the ending was flat" />
                  <div className="st-s-actionbar">
                    <button type="submit" className="st-btn st-s-danger" aria-disabled={busy !== null || undefined}>
                      {busy === "reject" ? "Rejecting…" : "Reject the video"}
                    </button>
                  </div>
                </form>
              ) : null}
            </section>
          ) : null}

          {done ? (
            <section className="st-s-panel st-s-decide st-glass" aria-label="Post it">
              <button
                type="button"
                className="st-btn st-btn--main st-s-big st-postit"
                onClick={() => {
                  setPostOnly(null);
                  setPosting(true);
                }}
              >
                Post it
              </button>
              <p className="st-s-field__hint">Only to Clips Funded&apos;s own accounts. You pick each one.</p>
            </section>
          ) : null}
          {done ? <PostsPanel jobs={pubs.data} onRetry={(j) => void retry(j)} busyId={retrying} mac={macRows} /> : null}
          {citations.length ? (
            <section className="st-s-sources" aria-label="Where the advice comes from">
              <h2 className="st-s-sources__title">Based on</h2>
              {/* The sources by name, each a link; the rules they say are one tap away (the owner, 23 Nov: less text). */}
              <ul>
                {citations
                  .filter((c, i) => citations.findIndex((d) => d.publisher === c.publisher) === i)
                  .map((c) => (
                    <li key={c.url + (c.section ?? "")}>
                      <a href={c.url} target="_blank" rel="noopener noreferrer">
                        {c.publisher}
                      </a>
                    </li>
                  ))}
              </ul>
              <StTech label="The rules">
                <ul>
                  {citations.map((c) => (
                    <li key={c.url + (c.section ?? "")}>
                      {c.title}
                      {c.section ? ` (${c.section})` : ""}
                    </li>
                  ))}
                </ul>
              </StTech>
              <p className="st-s-field__hint">The video ends with “Check your local road rules.”</p>
            </section>
          ) : null}
          <details className="st-s-details st-s-made st-glass">
            <summary className="st-s-details__sum">How it was made</summary>
            <dl className="st-s-facts">
              <dt>Model and effort for this video</dt>
              <dd>
                <StoryAi info={info} story={story} editable={editable && busy === null} onChange={(v) => void keepAi(v)} />
                <NextRun info={info} story={story} />
              </dd>
              <dt>Drawing style</dt>
              <dd>{artWords(storyArt(story))}</dd>
            </dl>
            <ModelsUsed info={info} job={job} jobs={runs.data} title={live ? "Models working on it" : "Made with"} />
            {!used.length ? <p className="st-s-field__hint">No model notes for this version.</p> : null}
          </details>
        </div>
      </div>

      {story.ownScript ? <ScriptPanel ws={ws} own={story.ownScript} script={script} /> : null}

      {story.scenes.length ? (
        <section className="st-s-panel st-glass" aria-labelledby="st-scenes-title">
          <h2 className="st-s-panel__title" id="st-scenes-title">
            Scenes
          </h2>
          <Filmstrip
            script={script}
            scenes={story.scenes}
            actions={
              editable && story.status !== "failed"
                ? (sceneId) => (
                    <button
                      type="button"
                      className="st-btn st-s-small"
                      aria-disabled={busy !== null || undefined}
                      onClick={() =>
                        remake(`scene:${sceneId}`, "scene_rewrite", async (x) => {
                          startRun(await storiesApi().requestChanges(ws, storyId, { sceneIds: [sceneId], ...x }));
                          toast.success("Making a new take of that scene.");
                        })
                      }
                    >
                      {busy === `scene:${sceneId}` ? "Starting…" : "Remake this scene"}
                    </button>
                  )
                : undefined
            }
          />
        </section>
      ) : null}

      {stale ? (
        <Notice
          tone="bad"
          action={
            <button
              type="button"
              className="st-btn"
              onClick={() =>
                void loaded.reload().then(() => {
                  setStale(false);
                  setSaves((n) => ({ ...n, reloads: n.reloads + 1 }));
                })
              }
            >
              Reload
            </button>
          }
        >
          This video changed while you were editing. Tap Reload, then make your change again.
        </Notice>
      ) : null}

      {editable && script ? (
        <>
          <section className="st-s-panel st-glass" aria-labelledby="st-captions-title">
            <h2 className="st-s-panel__title" id="st-captions-title">
              Captions
            </h2>
            <CaptionEditor key={`c:${storyId}:${saves.reloads}:${saves.captions}`} ws={ws} info={info} story={story} script={script} saving={saving} onSave={(e) => void save(e, "captions")} tab={captionTab} onTab={setCaptionTab} />
          </section>
          <section className="st-s-panel st-glass" aria-labelledby="st-sfx-title">
            <h2 className="st-s-panel__title" id="st-sfx-title">
              Sound effects and music
            </h2>
            <SfxEditor key={`s:${storyId}:${saves.reloads}:${saves.sounds}`} story={story} script={script} saving={saving} onSave={(e) => void save(e, "sounds")} />
          </section>
        </>
      ) : done ? (
        <p className="st-s-field__hint st-plate">An approved video can&apos;t be changed.</p>
      ) : null}

      {unusable ? (
        <UnusableSheet
          info={info}
          ask={unusable.ask}
          onClose={() => setUnusable(null)}
          onKeep={() => {
            // Exactly the pick (nothing for a model kept with this video): the run tries it.
            const u = unusable;
            const o = cleanPick(pick);
            setUnusable(null);
            void act(u.name, () => u.run(o ? { override: o } : {}));
          }}
          onUse={() => {
            const u = unusable;
            setUnusable(null);
            void act(u.name, () => u.run({ override: insteadPick(info, u.ask, pick) }));
          }}
        />
      ) : null}
      {changing !== false && story.ownScript ? (
        <ChangeScriptSheet
          ws={ws}
          story={story}
          focus={changing}
          why={changing ? problems.filter((p) => sceneOfProblem(p) === changing) : undefined}
          onClose={() => setChanging(false)}
          onStarted={(r) => {
            startRun(r);
            setStale(false);
          }}
        />
      ) : null}
      {sureReject ? (
        <StSheet
          title="Reject this video?"
          onClose={() => setSureReject(false)}
          actions={
            <>
              <button type="button" className="st-btn" onClick={() => setSureReject(false)}>
                Keep it
              </button>
              <button
                type="button"
                className="st-btn st-s-danger"
                aria-disabled={busy !== null || undefined}
                onClick={() =>
                  !busy &&
                  void act("reject", async () => {
                    setStory(await storiesApi().reject(ws, storyId, reason.trim() || undefined));
                    setSureReject(false);
                    setForm("none");
                    toast.info("Rejected. It won't be posted.");
                  })
                }
              >
                {busy === "reject" ? "Rejecting…" : "Reject it"}
              </button>
            </>
          }
        >
          <p>It won&apos;t be posted. You can&apos;t undo this.</p>
        </StSheet>
      ) : null}
      {asking === "whole" ? (
        <StSheet
          title="Remake the whole video?"
          onClose={() => setAsking("none")}
          actions={
            <>
              <button type="button" className="st-btn" onClick={() => setAsking("none")}>
                Keep this one
              </button>
              <button
                type="button"
                className="st-btn st-btn--main"
                aria-disabled={busy !== null || undefined}
                onClick={() =>
                  remake("whole", "storyboard", async (x) => {
                    startRun(await produceNow({ from: "storyboard" }, x));
                    setAsking("none");
                    toast.success("Making the whole video again.");
                  })
                }
              >
                {busy === "whole" ? "Starting…" : "Remake it"}
              </button>
            </>
          }
        >
          <p>{story.ownScript ? "Clips Funded sets up your scenes again. Your words stay." : "It starts over with your characters as they look now. The old one stays in the Library."}</p>
          <div className="st-s-decide__ai">
            <span className="st-s-field__hint">This remake uses</span>
            {menuFor("storyboard")}
          </div>
        </StSheet>
      ) : null}

      {posting ? (
        <PublishSheet
          ws={ws}
          story={story}
          config={cfg}
          jobs={pubs.data ?? []}
          mac={macRows}
          only={postOnly ?? undefined}
          onClose={() => setPosting(false)}
          onRetry={(j) => void retry(j)}
          onSent={(made) => {
            pubs.setData((list) => [...made, ...(list ?? []).filter((x) => !made.some((m) => m.publishingJobId === x.publishingJobId))]);
            toast.success("Sending your video now.");
          }}
        />
      ) : null}

      {confirm ? (
        <StSheet
          title={postToTitle(confirm.job.platform, confirm.account)}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button type="button" className="st-btn" onClick={() => setConfirm(null)}>
                Not now
              </button>
              <button
                type="button"
                className="st-btn st-btn--main"
                aria-disabled={retrying !== null || undefined}
                onClick={() => retrying === null && void retry(confirm.job, confirm.account.externalAccountId, confirm.notOnTikTok)}
              >
                {retrying ? "Trying…" : postYes(confirm.message)}
              </button>
            </>
          }
        >
          <p>{confirm.message}</p>
          <AccountCard platform={confirm.job.platform} account={confirm.account} />
          {confirm.job.accountName && confirm.job.accountName !== confirm.account.accountName ? <p className="st-s-field__hint">It was {thisAccount(confirm.job.platform, confirm.job.accountName)} when you tapped Post it.</p> : null}
        </StSheet>
      ) : null}
    </section>
  );
}
