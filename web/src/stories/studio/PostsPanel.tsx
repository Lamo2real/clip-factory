// The Posts panel of an approved or posted video (docs/CONTRACTS.md §45.14, §45.16.6, §45.34): each publishing job with
// its place, the exact Lamo Stories account it went to (its name and handle; the account id is behind "Technical
// details", §45.36 E14), its status, the link, the numbers (read 1 hour, 1 day, 3 days and 7 days after posting) and,
// when it stopped, its plain sentence and Try again; a post that stopped on an account problem also has "Open Social
// accounts" (§45.36 E9). On Clip Factory's shared developer app a post with no room left waits for the window to reset
// and then goes out by itself; its row says so with the time (§45.37 G6: "Waiting: Clip Factory's posts go first.").
// While the owner's Mac posts TikTok (§47.10) the TikTok row says what the Mac is doing (macRow), with Try again,
// It's on TikTok (its link, or none) and the way to the TikTok card.
import { useState } from "react";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { A } from "../../components/ui.tsx";
import type { PublishingJob, WsMacStatus } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { Tag, TechDetails, TextField } from "./kit.tsx";
import { macRow, TIKTOK_LINK, type MacRow } from "./macRow.ts";
import * as MW from "./macWords.ts";
import { accountProblem, accountShown, ago, PLATFORM_LABEL, PUBLISH_LABEL, PUBLISH_TONE, shortNumber } from "./words.ts";

/** The TikTok card in Social accounts, where My Mac posts TikTok is (§47.10). */
export const MAC_CARD_HREF = `${storiesHref({ name: "connections", platform: null, result: null, ws: null })}#tiktok-mac`;

/** What a post row needs to show a Mac post (§47.10); without it a Mac post reads as on, its Mac not known yet. */
export interface PostMacProps {
  /** My Mac posts TikTok is on */
  on: boolean;
  status: WsMacStatus | null;
  /** Try again on a Mac post; `notOnTikTok` after "Post it again? Only if it's not on your TikTok." */
  onRetry: (job: PublishingJob, notOnTikTok?: boolean) => void;
  /** It's on TikTok: answers the problem to show, or null once saved */
  onPosted: (job: PublishingJob, body: { link: string } | { noLink: true }) => Promise<string | null>;
  /** Post with my Mac: Post it with only TikTok ticked */
  onPostWithMac?: (job: PublishingJob) => void;
  /** Start my Mac again (a paused Mac): answers the problem to show, or null once asked */
  onResume?: () => Promise<string | null>;
}

/** "Open Social accounts": the way to fix an account problem, next to Try again (§45.36 E9). */
export function SocialAccountsLink({ className = "st-btn st-s-small" }: { className?: string }) {
  return (
    <A href={storiesHref({ name: "connections", platform: null, result: null, ws: null })} className={className}>
      Open Social accounts
    </A>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** When a waiting post goes, in the owner's own time: "Sun 15:00" within the week, else "1 Dec 00:00". */
export function waitTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "the next reset";
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.getTime() - now.getTime() < 6 * 86_400_000 ? `${DAYS[d.getDay()]} ${time}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`;
}

/**
 * The line of a post waiting on Clip Factory's shared app (§45.37 G6), or null when it is not waiting. The API keeps a
 * waiting post queued or publishing, with `waitingUntil` (shown here in the owner's own time) and its own line
 * `waiting` (in UTC), used when the time is missing.
 */
export function waitingLine(job: Pick<PublishingJob, "publishingStatus" | "waitingUntil" | "waiting">, now?: Date): string | null {
  if (job.publishingStatus !== "queued" && job.publishingStatus !== "publishing") return null;
  if (job.waitingUntil) return `Waiting: Clip Factory's posts go first. Posts at ${waitTime(job.waitingUntil, now)}.`;
  return job.waiting?.trim() || null;
}

export function PostRow({ job, onRetry, busy = false, mac }: { job: PublishingJob; onRetry: (j: PublishingJob) => void; busy?: boolean; mac?: PostMacProps }) {
  const row = macRow(job, mac ? { on: mac.on, status: mac.status } : null);
  if (row) return <MacPostRow job={job} row={row} mac={mac} onRetry={onRetry} busy={busy} />;
  const stuck = job.publishingStatus === "failed" || job.publishingStatus === "needs_attention";
  const m = job.metrics;
  const waiting = waitingLine(job);
  return (
    <li className={`st-s-post is-${job.publishingStatus}`}>
      <span className="st-s-post__mark">
        <PlatformMark platform={job.platform} size={24} />
      </span>
      <span className="st-s-post__body">
        <span className="st-s-post__top">
          <strong>{PLATFORM_LABEL[job.platform]}</strong>
          <Tag tone={PUBLISH_TONE[job.publishingStatus]}>{PUBLISH_LABEL[job.publishingStatus]}</Tag>
        </span>
        <span className="st-s-post__account">
          {accountShown({ accountName: job.accountName, handle: job.handle ?? null }) ?? "The connected account"}
        </span>
        {job.publishingStatus === "posted" ? (
          <span className="st-s-post__when">Posted {ago(job.postedAt ?? job.updatedAt)}</span>
        ) : waiting ? (
          <span className="st-s-post__when st-s-post__wait" role="status">
            {waiting}
          </span>
        ) : job.publishingStatus === "queued" || job.publishingStatus === "publishing" ? (
          <span className="st-s-post__when">{job.publishingStatus === "queued" ? "Waiting to send…" : "Sending now…"}</span>
        ) : null}
        {stuck && job.error ? <span className="st-s-post__why">{job.error}</span> : null}
        {m ? (
          <span className="st-s-post__numbers" aria-label={`Numbers from ${PLATFORM_LABEL[job.platform]}`}>
            <span>
              <strong>{shortNumber(m.views)}</strong> views
            </span>
            <span>
              <strong>{shortNumber(m.likes)}</strong> likes
            </span>
            <span>
              <strong>{shortNumber(m.comments)}</strong> comments
            </span>
            <span>
              <strong>{shortNumber(m.shares)}</strong> shares
            </span>
          </span>
        ) : job.publishingStatus === "posted" ? (
          <span className="st-s-post__when">No numbers yet. They come in until 7 days after posting.</span>
        ) : null}
        {/* The plain words first; the account's own id is one tap away (§45.36 E14). */}
        {job.externalAccountId ? (
          <TechDetails className="st-s-post__tech">
            <span className="st-s-post__id">Account id {job.externalAccountId}</span>
          </TechDetails>
        ) : null}
      </span>
      <span className="st-s-post__actions">
        {job.url ? (
          <a className="st-btn st-s-small" href={job.url} target="_blank" rel="noopener noreferrer">
            Open<span className="st-s-sr"> on {PLATFORM_LABEL[job.platform]}</span>
          </a>
        ) : null}
        {stuck && accountProblem(job) ? <SocialAccountsLink /> : null}
        {stuck ? (
          <button type="button" className="st-btn st-s-small st-btn--main" aria-disabled={busy || undefined} onClick={() => !busy && onRetry(job)}>
            {busy ? "Trying…" : "Try again"}
          </button>
        ) : null}
      </span>
    </li>
  );
}

/** A TikTok post the owner's Mac posts or posted (§47.10): the row's words, its chip and its buttons. */
function MacPostRow({ job, row, mac, onRetry, busy }: { job: PublishingJob; row: MacRow; mac?: PostMacProps; onRetry: (j: PublishingJob) => void; busy: boolean }) {
  const [open, setOpen] = useState<"none" | "again" | "link" | "no_link">("none");
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const m = job.metrics;
  const retry = (notOnTikTok?: boolean) => {
    if (busy) return;
    setOpen("none");
    if (mac) mac.onRetry(job, notOnTikTok);
    else onRetry(job);
  };
  async function save(body: { link: string } | { noLink: true }) {
    if (saving || !mac) return;
    setSaving(true);
    setProblem(null);
    try {
      const why = await mac.onPosted(job, body);
      if (why) setProblem(why);
      else setOpen("none");
    } finally {
      setSaving(false);
    }
  }
  async function resume() {
    if (saving || !mac?.onResume) return;
    setSaving(true);
    setProblem(null);
    try {
      const why = await mac.onResume();
      if (why) setProblem(why);
    } finally {
      setSaving(false);
    }
  }
  function saveLink() {
    const l = link.trim();
    if (!l) return setProblem(MW.MAC_LINK_EMPTY);
    if (!TIKTOK_LINK.test(l)) return setProblem("That isn't a TikTok video link. Copy it from the post's Share button.");
    void save({ link: l });
  }
  const small = "st-btn st-s-small";
  return (
    <li className={`st-s-post is-${row.look}`} data-mac={job.mac?.state ?? job.publishingStatus}>
      <span className="st-s-post__mark">
        <PlatformMark platform={job.platform} size={24} />
      </span>
      <span className="st-s-post__body">
        <span className="st-s-post__top">
          <strong>{PLATFORM_LABEL[job.platform]}</strong>
          <Tag tone={row.tone}>{row.chip}</Tag>
        </span>
        <span className="st-s-post__account">
          {accountShown({ accountName: job.accountName, handle: job.handle ?? null }) ?? "The connected account"}
        </span>
        {row.spinner ? (
          <span className="st-s-post__when st-s-post__mac" role="status" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="st-s-busy__dot" aria-hidden="true" />
            {row.line}
          </span>
        ) : (
          <span className={`st-s-post__when st-s-post__mac${row.look === "failed" ? " st-s-post__why" : ""}`} role="status">
            {row.line}
          </span>
        )}
        {m ? (
          <span className="st-s-post__numbers" aria-label={`Numbers from ${PLATFORM_LABEL[job.platform]}`}>
            <span>
              <strong>{shortNumber(m.views)}</strong> views
            </span>
            <span>
              <strong>{shortNumber(m.likes)}</strong> likes
            </span>
            <span>
              <strong>{shortNumber(m.comments)}</strong> comments
            </span>
            <span>
              <strong>{shortNumber(m.shares)}</strong> shares
            </span>
          </span>
        ) : null}
        {problem ? (
          <span className="st-s-post__why" role="alert">
            {problem}
          </span>
        ) : null}
        {job.externalAccountId ? (
          <TechDetails className="st-s-post__tech">
            <span className="st-s-post__id">Account id {job.externalAccountId}</span>
          </TechDetails>
        ) : null}
      </span>
      <span className="st-s-post__actions">
        {row.buttons.map((b) => {
          switch (b) {
            case "open":
              return job.url ? (
                <a key={b} className={small} href={job.url} target="_blank" rel="noopener noreferrer">
                  Open<span className="st-s-sr"> on {PLATFORM_LABEL[job.platform]}</span>
                </a>
              ) : null;
            case "turn_on":
              return (
                <A key={b} href={MAC_CARD_HREF} className={`${small} st-btn--main`}>
                  {MW.MAC_TURN_ON}
                </A>
              );
            case "set_up":
              return (
                <A key={b} href={MAC_CARD_HREF} className={`${small} st-btn--main`}>
                  {MW.MAC_SET_IT_UP}
                </A>
              );
            case "open_stopped":
              return row.stoppedStoryId ? (
                <A key={b} href={storiesHref({ name: "review_story", storyId: row.stoppedStoryId })} className={small}>
                  {MW.MAC_OPEN_STOPPED}
                </A>
              ) : null;
            case "try_again":
              return (
                <button key={b} type="button" className={`${small} st-btn--main`} aria-disabled={busy || undefined} onClick={() => retry()}>
                  {busy ? "Trying…" : MW.MAC_TRY_AGAIN}
                </button>
              );
            case "on_tiktok":
              return (
                <button key={b} type="button" className={`${small} st-btn--main`} aria-expanded={open === "link" || open === "no_link"} onClick={() => setOpen((o) => (o === "link" || o === "no_link" ? "none" : "link"))}>
                  {MW.MAC_ON_TIKTOK}
                </button>
              );
            case "again_ask":
              return (
                <button key={b} type="button" className={`${small} st-btn--quiet`} aria-disabled={busy || undefined} aria-expanded={open === "again"} onClick={() => !busy && setOpen((o) => (o === "again" ? "none" : "again"))}>
                  {busy ? "Trying…" : MW.MAC_TRY_AGAIN}
                </button>
              );
            case "social":
              return <SocialAccountsLink key={b} />;
            case "resume":
              return mac?.onResume ? (
                <button key={b} type="button" className={`${small} st-btn--main`} aria-disabled={saving || undefined} onClick={() => void resume()}>
                  {saving ? "Asking your Mac…" : MW.MAC_RESUME}
                </button>
              ) : (
                <A key={b} href={MAC_CARD_HREF} className={`${small} st-btn--main`}>
                  {MW.MAC_RESUME}
                </A>
              );
            case "post_with_mac":
              return mac?.onPostWithMac ? (
                <button key={b} type="button" className={`${small} st-btn--main`} onClick={() => mac.onPostWithMac?.(job)}>
                  {MW.MAC_POST_WITH_MAC}
                </button>
              ) : null;
            default:
              return null;
          }
        })}
      </span>
      {open === "again" ? (
        <div className="st-s-post__actions" role="group" aria-label={MW.MAC_AGAIN_ASK}>
          <span className="st-s-post__when">{MW.MAC_AGAIN_ASK}</span>
          <button type="button" className={small} onClick={() => setOpen("none")}>
            Not now
          </button>
          <button type="button" className={`${small} st-btn--main`} aria-disabled={busy || undefined} onClick={() => retry(true)}>
            {MW.MAC_AGAIN_YES}
          </button>
        </div>
      ) : null}
      {open === "link" ? (
        <div className="st-s-post__actions" role="group" aria-label={MW.MAC_ON_TIKTOK}>
          <div style={{ flex: "1 1 100%" }}>
            <TextField label={MW.MAC_LINK_LABEL} value={link} onChange={setLink} max={300} placeholder="https://www.tiktok.com/@…/video/…" />
          </div>
          <button type="button" className={small} aria-disabled={saving || undefined} onClick={() => !saving && setOpen("no_link")}>
            {MW.MAC_NO_LINK}
          </button>
          <button type="button" className={`${small} st-btn--main`} aria-disabled={saving || undefined} onClick={saveLink}>
            {saving ? "Saving…" : MW.MAC_SAVE_LINK}
          </button>
        </div>
      ) : null}
      {open === "no_link" ? (
        <div className="st-s-post__actions" role="group" aria-label={MW.MAC_NO_LINK_ASK}>
          <span className="st-s-post__when">{MW.MAC_NO_LINK_ASK}</span>
          <button type="button" className={small} onClick={() => setOpen("link")}>
            Not now
          </button>
          <button type="button" className={`${small} st-btn--main`} aria-disabled={saving || undefined} onClick={() => void save({ noLink: true })}>
            {saving ? "Saving…" : MW.MAC_NO_LINK_YES}
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function PostsPanel({ jobs, onRetry, busyId, mac }: { jobs: PublishingJob[] | null; onRetry: (j: PublishingJob) => void; busyId: string | null; mac?: PostMacProps }) {
  return (
    <section className="st-s-panel st-s-postspanel st-glass" aria-labelledby="st-posts-title">
      <h2 className="st-s-panel__title" id="st-posts-title">
        Posts
      </h2>
      {jobs === null ? (
        <p className="st-s-field__hint">Getting the posts…</p>
      ) : jobs.length === 0 ? (
        <p className="st-s-field__hint">Not posted anywhere yet. Tap Post it to send it to your Clips Funded accounts.</p>
      ) : (
        <ul className="st-s-posts">
          {jobs.map((j) => (
            <PostRow key={j.publishingJobId} job={j} onRetry={onRetry} busy={busyId === j.publishingJobId} mac={mac} />
          ))}
        </ul>
      )}
    </section>
  );
}
