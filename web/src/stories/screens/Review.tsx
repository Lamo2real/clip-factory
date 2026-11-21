// Lamo Stories › Review (docs/CONTRACTS.md §45.9, §45.14, §45.16.6; spec §5.E). Its own queue (videos to watch and
// videos whose facts need checking; never Lamo Clips' Review), and each video's review page: the player (the MP4, else
// the live preview), Approve (only when the approve rule holds; the fact problems and the sources shown), Reject, Ask
// for changes, Remake this scene, Remake the whole video, Remake and Check again, the captions and sound effects
// editors, Download, Post it (the publish sheet) and the Posts panel.
import "../styles/studio.css";
import { useEffect, useRef, useState } from "react";
import { A } from "../../components/ui.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { burst } from "../../lib/confetti.ts";
import { useLoad, usePoll } from "../../lib/hooks.ts";
import { cheerOnNextTap } from "../../lib/sound.ts";
import { sounds } from "../../lib/sounds.ts";
import { storiesApi } from "../api/client.ts";
import type { PublishingJob, SocialAccount, StoriesConfig, Story, StoryPatch, StoryStatus } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { CaptionEditor } from "../studio/CaptionEditor.tsx";
import { Filmstrip } from "../studio/Filmstrip.tsx";
import { useSameScript, useWidth, useWorkspace } from "../studio/hooks.ts";
import { Busy, celebrate, Chip, Notice, StSheet, Tag, TextField } from "../studio/kit.tsx";
import { Player } from "../studio/Player.tsx";
import { PostsPanel } from "../studio/PostsPanel.tsx";
import { PublishSheet } from "../studio/PublishSheet.tsx";
import { SfxEditor } from "../studio/SfxEditor.tsx";
import { StepTrack } from "../studio/StepTrack.tsx";
import { CATEGORY_LABEL, isConflict, PLATFORM_LABEL, say, seconds, STATUS_LABEL, STATUS_TONE } from "../studio/words.ts";
import type { StoriesScreenProps } from "./types.ts";

export function ReviewScreen({ ws, page }: StoriesScreenProps) {
  if (page.name === "review_story") return <ReviewStory ws={ws} storyId={page.storyId} />;
  return <ReviewQueue ws={ws} />;
}

/**
 * Why Approve cannot be tapped yet, or null when it can (the approve rule, §45.9): the video waits for review, every
 * change is in it, and the facts were checked on this very storyboard.
 */
export function approveBlock(story: Story): string | null {
  if (story.safety?.status === "problems") return "Fix the facts first, then tap Check again.";
  if (story.status === "needs_check") return "Check the facts first.";
  if (story.status !== "review") return null;
  if (story.stale.length) return "Your changes aren't in the video yet. Tap Remake first.";
  if (story.safety && (story.safety.status !== "ok" || story.safety.checkedScriptVersion !== story.scriptVersion)) return "Your changes aren't in the video yet. Tap Remake first.";
  return null;
}

// ---------- The queue ----------

const QUEUE: { title: string; statuses: StoryStatus[]; empty: string }[] = [
  { title: "Waiting for you", statuses: ["needs_check", "review"], empty: "Nothing to watch right now. New videos show here when they are made." },
  { title: "Approved, ready to post", statuses: ["approved"], empty: "" },
  { title: "Posted", statuses: ["published"], empty: "" },
];

function ReviewQueue({ ws }: { ws: string }) {
  const lists = useLoad(
    async () => {
      const statuses: StoryStatus[] = ["needs_check", "review", "approved", "published"];
      const pages = await Promise.all(statuses.map((status) => storiesApi().listStories(ws, { status, limit: 50 })));
      return pages.flatMap((p) => p.stories);
    },
    ws,
    "st-s-review",
  );
  const all = lists.data ?? [];
  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div>
          <h1 className="st-s-head__title">Review</h1>
          <p className="st-s-head__lede">Watch each new video. Approve it, ask for changes, or make a scene again.</p>
        </div>
      </header>
      {lists.error && !lists.data ? (
        <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void lists.reload()}>Try again</button>}>
          {lists.error}
        </Notice>
      ) : !lists.data ? (
        <Busy>Getting the videos to review…</Busy>
      ) : (
        QUEUE.map((group) => {
          const items = all.filter((s) => group.statuses.includes(s.status)).sort((a, b) => group.statuses.indexOf(a.status) - group.statuses.indexOf(b.status));
          if (!items.length && !group.empty) return null;
          return (
            <section key={group.title} aria-label={group.title}>
              <h2 className="st-s-section">{group.title}</h2>
              {items.length ? (
                <ul className="st-s-queue">
                  {items.map((s) => (
                    <li key={s.storyId}>
                      <A href={storiesHref({ name: "review_story", storyId: s.storyId })} className="st-s-qcard">
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
                <p className="st-s-field__hint">{group.empty}</p>
              )}
            </section>
          );
        })
      )}
    </section>
  );
}

// ---------- One video ----------

type Confirm = { job: PublishingJob; account: SocialAccount; message: string };

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
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [col, colWidth] = useWidth<HTMLDivElement>(300);
  const seen = useRef<Map<string, PublishingJob["publishingStatus"]> | null>(null);
  const wasLive = useRef(false);

  const story = loaded.data?.story ?? null;
  const job = loaded.data?.job ?? null;
  const script = useSameScript(loaded.data?.script ?? null);
  const live = (!!job && (job.status === "queued" || job.status === "running")) || story?.status === "producing";
  const inFlight = (pubs.data ?? []).some((j) => j.publishingStatus === "queued" || j.publishingStatus === "publishing");

  usePoll(() => loaded.reload(), live, 2000);
  usePoll(() => pubs.reload(), inFlight, 10_000);

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
    burst(undefined, 140);
    cheerOnNextTap(sounds);
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
  };

  async function save(edit: Omit<StoryPatch, "version">) {
    if (!story) return;
    setSaving(true);
    setProblem(null);
    setStale(false);
    try {
      const r = await storiesApi().patchStory(ws, storyId, { version: story.version, ...edit });
      loaded.setData((d) => (d ? { ...d, story: r.story, script: r.script } : d));
      toast.success("Saved. Tap Remake to put it in the video.");
    } catch (e) {
      if (isConflict(e) && /changed|reload/i.test(say(e))) setStale(true);
      else setProblem(say(e));
    } finally {
      setSaving(false);
    }
  }

  async function retry(j: PublishingJob, confirmAccount?: string) {
    setRetrying(j.publishingJobId);
    try {
      const next = await storiesApi().retryPublishing(ws, j.publishingJobId, confirmAccount ? { confirmAccount } : undefined);
      pubs.setData((list) => (list ? list.map((x) => (x.publishingJobId === next.publishingJobId ? next : x)) : [next]));
      setConfirm(null);
    } catch (e) {
      if (isConflict(e) && !confirmAccount) {
        try {
          const { accounts } = await storiesApi().social(ws);
          const account = accounts.find((a) => a.platform === j.platform);
          if (account && account.connectionStatus === "connected" && account.externalAccountId) {
            setConfirm({ job: j, account, message: say(e) });
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

  async function download() {
    await act("download", async () => {
      const { url, filename } = await storiesApi().download(ws, storyId);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success("Downloading your video.");
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
        <Busy>Getting the video…</Busy>
      </section>
    );

  const deciding = !live && (story.status === "review" || story.status === "needs_check");
  const editable = !live && !!script && ["review", "needs_check", "failed"].includes(story.status);
  const block = approveBlock(story);
  const done = story.status === "approved" || story.status === "published";
  const problems = story.safety?.status === "problems" ? story.safety.problems : [];
  const citations = story.safety?.citations ?? [];
  const checkAgain = story.status === "needs_check";
  // Phones get a smaller player, so the decision is close below it.
  const width = colWidth < 500 ? Math.max(180, Math.min(250, colWidth - 40)) : Math.max(200, Math.min(340, colWidth));

  return (
    <section className="st-page st-studio">
      <header className="st-s-head">
        <div>
          <A href={storiesHref({ name: "review" })} className="st-s-back">
            ‹ Review
          </A>
          <h1 className="st-s-head__title">{story.title}</h1>
          <p className="st-s-head__lede">
            <Tag tone={STATUS_TONE[story.status]}>{STATUS_LABEL[story.status]}</Tag> {CATEGORY_LABEL[story.category]} · {seconds(story.actualDurationSec ?? story.durationSec)}
          </p>
        </div>
      </header>

      <div className="st-s-review">
        <div className="st-s-review__player" ref={col}>
          <Player story={story} script={script} width={width} />
          {done ? (
            <button type="button" className="st-btn" aria-disabled={busy !== null || undefined} onClick={() => void download()}>
              {busy === "download" ? "Getting the file…" : "Download"}
            </button>
          ) : null}
        </div>

        <div className="st-s-review__side">
          {live ? (
            <section className="st-s-panel" aria-label="Being made again">
              <StepTrack job={job} story={story} label={`Making ${story.title}`} />
              <A href={storiesHref({ name: "production_story", storyId })} className="st-btn">
                Watch it being made
              </A>
            </section>
          ) : null}

          {problems.length ? (
            <Notice tone="bad">
              <strong>Fix the facts first.</strong>
              <ul className="st-s-problems">
                {problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
              Change the words below, then tap Check again.
            </Notice>
          ) : null}


          {!live && story.stale.length && story.status !== "draft" ? (
            <Notice
              tone="info"
              action={
                <button
                  type="button"
                  className="st-btn st-btn--main"
                  aria-disabled={busy !== null || undefined}
                  onClick={() => void act("remake", async () => startRun(await storiesApi().produce(ws, storyId)))}
                >
                  {busy === "remake" ? "Starting…" : checkAgain ? "Check again" : story.status === "failed" ? "Try again" : "Remake"}
                </button>
              }
            >
              {story.status === "failed" ? "Making this video stopped." : checkAgain ? "Your fixes are saved. Tap Check again to check the facts and update the video." : "Your changes aren't in the video yet. Tap Remake to put them in."}
            </Notice>
          ) : null}
          {!live && checkAgain && !story.stale.length ? (
            <Notice
              tone="info"
              action={
                <button
                  type="button"
                  className="st-btn"
                  aria-disabled={busy !== null || undefined}
                  onClick={() => void act("check", async () => startRun(await storiesApi().produce(ws, storyId, { from: "safety" })))}
                >
                  {busy === "check" ? "Starting…" : "Check again"}
                </button>
              }
            >
              Changed the words? Tap Check again.
            </Notice>
          ) : null}

          {story.status === "rejected" ? <Notice tone="info">Not used.{story.reviewNote ? ` The reason: ${story.reviewNote}` : ""}</Notice> : null}
          {problem ? <Notice tone="bad">{problem}</Notice> : null}

          {deciding ? (
            <section className="st-s-panel st-s-decide" aria-label="Your decision">
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
                      toast.success("Approved! Now you can post it.");
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
              <div className="st-s-decide__more">
                <button type="button" className="st-btn" aria-expanded={form === "changes"} onClick={() => setForm((f) => (f === "changes" ? "none" : "changes"))}>
                  Ask for changes
                </button>
                <button type="button" className="st-btn" onClick={() => setAsking("whole")}>
                  Remake the whole video
                </button>
                <button type="button" className="st-btn st-s-quiet" aria-expanded={form === "reject"} onClick={() => setForm((f) => (f === "reject" ? "none" : "reject"))}>
                  Reject
                </button>
              </div>
              {form === "changes" ? (
                <form
                  className="st-s-form"
                  aria-label="Ask for changes"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!note.trim() && !picked.length) return setProblem("Say what to change, or pick a scene.");
                    void act("changes", async () => {
                      const body: { note?: string; sceneIds?: string[] } = {};
                      if (note.trim()) body.note = note.trim();
                      if (picked.length) body.sceneIds = picked;
                      startRun(await storiesApi().requestChanges(ws, storyId, body));
                      setNote("");
                      setPicked([]);
                      toast.success("Got it. Making the changes now.");
                    });
                  }}
                >
                  <TextField label="What should change?" multiline rows={3} value={note} onChange={setNote} max={500} placeholder="For example: make Pip look more surprised when the car slides" />
                  <div className="st-s-field">
                    <span className="st-s-field__label">Only these scenes (you can skip this)</span>
                    <div className="st-s-chips">
                      {story.scenes.map((sc, i) => (
                        <Chip key={sc.sceneId} on={picked.includes(sc.sceneId)} onToggle={() => setPicked((p) => (p.includes(sc.sceneId) ? p.filter((x) => x !== sc.sceneId) : [...p, sc.sceneId]))}>
                          {i + 1}. {sc.title}
                        </Chip>
                      ))}
                    </div>
                  </div>
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
                    void act("reject", async () => {
                      setStory(await storiesApi().reject(ws, storyId, reason.trim() || undefined));
                      setForm("none");
                      toast.info("Rejected. It won't be posted.");
                    });
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
            <section className="st-s-panel st-s-decide" aria-label="Post it">
              <button type="button" className="st-btn st-btn--main st-s-big st-postit" onClick={() => setPosting(true)}>
                Post it
              </button>
              <p className="st-s-field__hint">Only to Lamo Stories&apos; own accounts. You pick each one.</p>
            </section>
          ) : null}
          {done ? <PostsPanel jobs={pubs.data} onRetry={(j) => void retry(j)} busyId={retrying} /> : null}
          {citations.length ? (
            <section className="st-s-sources" aria-label="Where the advice comes from">
              <h2 className="st-s-sources__title">Based on</h2>
              <ul>
                {citations.map((c) => (
                  <li key={c.url + (c.section ?? "")}>
                    <a href={c.url} target="_blank" rel="noopener noreferrer">
                      {c.publisher}
                    </a>
                    <span>
                      {" "}
                      · {c.title}
                      {c.section ? ` (${c.section})` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="st-s-field__hint">The video ends with “Check your local road rules.”</p>
            </section>
          ) : null}
        </div>
      </div>

      {story.scenes.length ? (
        <section className="st-s-panel" aria-labelledby="st-scenes-title">
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
                        void act(`scene:${sceneId}`, async () => {
                          startRun(await storiesApi().requestChanges(ws, storyId, { sceneIds: [sceneId] }));
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
        <Notice tone="bad" action={<button type="button" className="st-btn" onClick={() => void loaded.reload().then(() => setStale(false))}>Reload</button>}>
          This video changed while you were editing. Tap Reload to get the newest version, then make your change again.
        </Notice>
      ) : null}

      {editable && script ? (
        <>
          <section className="st-s-panel" aria-labelledby="st-captions-title">
            <h2 className="st-s-panel__title" id="st-captions-title">
              Captions
            </h2>
            <CaptionEditor key={`c:${story.scriptVersion}:${story.version}`} story={story} script={script} saving={saving} onSave={(e) => void save(e)} />
          </section>
          <section className="st-s-panel" aria-labelledby="st-sfx-title">
            <h2 className="st-s-panel__title" id="st-sfx-title">
              Sound effects and music
            </h2>
            <SfxEditor key={`s:${story.scriptVersion}:${story.version}`} story={story} script={script} saving={saving} onSave={(e) => void save(e)} />
          </section>
        </>
      ) : done ? (
        <p className="st-s-field__hint">An approved video can&apos;t be changed. Its captions and sounds stay as they are.</p>
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
                  void act("whole", async () => {
                    startRun(await storiesApi().produce(ws, storyId, { from: "storyboard" }));
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
          <p>Lamo Stories writes a new storyboard with your characters as they look now, then makes every step again. This one is kept in the Library.</p>
        </StSheet>
      ) : null}

      {posting ? (
        <PublishSheet
          ws={ws}
          story={story}
          config={cfg}
          jobs={pubs.data ?? []}
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
          title={`Post to ${confirm.account.accountName ?? "the new account"}?`}
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
                onClick={() => retrying === null && void retry(confirm.job, confirm.account.externalAccountId ?? undefined)}
              >
                {retrying ? "Trying…" : `Yes, post to ${confirm.account.accountName ?? "it"}`}
              </button>
            </>
          }
        >
          <p>{confirm.message}</p>
          <p>
            Lamo Stories&apos; {PLATFORM_LABEL[confirm.job.platform]} is now <strong>{confirm.account.accountName ?? "another account"}</strong>
            {confirm.account.handle ? ` (${confirm.account.handle})` : ""}, id {confirm.account.externalAccountId}. It was {confirm.job.accountName ?? "a different account"} when you tapped Post it.
          </p>
        </StSheet>
      ) : null}
    </section>
  );
}
