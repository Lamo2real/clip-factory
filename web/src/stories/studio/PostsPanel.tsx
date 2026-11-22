// The Posts panel of an approved or posted video (docs/CONTRACTS.md §45.14, §45.16.6, §45.34): each publishing job with
// its place, the exact Lamo Stories account it went to (its name and handle; the account id is behind "Technical
// details", §45.36 E14), its status, the link, the numbers (read 1 hour, 1 day, 3 days and 7 days after posting) and,
// when it stopped, its plain sentence and Try again; a post that stopped on an account problem also has "Open Social
// accounts" (§45.36 E9).
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { A } from "../../components/ui.tsx";
import type { PublishingJob } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { Tag, TechDetails } from "./kit.tsx";
import { accountProblem, accountShown, ago, PLATFORM_LABEL, PUBLISH_LABEL, PUBLISH_TONE, shortNumber } from "./words.ts";

/** "Open Social accounts": the way to fix an account problem, next to Try again (§45.36 E9). */
export function SocialAccountsLink({ className = "st-btn st-s-small" }: { className?: string }) {
  return (
    <A href={storiesHref({ name: "connections", platform: null, result: null, ws: null })} className={className}>
      Open Social accounts
    </A>
  );
}

export function PostRow({ job, onRetry, busy = false }: { job: PublishingJob; onRetry: (j: PublishingJob) => void; busy?: boolean }) {
  const stuck = job.publishingStatus === "failed" || job.publishingStatus === "needs_attention";
  const m = job.metrics;
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

export function PostsPanel({ jobs, onRetry, busyId }: { jobs: PublishingJob[] | null; onRetry: (j: PublishingJob) => void; busyId: string | null }) {
  return (
    <section className="st-s-panel st-s-postspanel" aria-labelledby="st-posts-title">
      <h2 className="st-s-panel__title" id="st-posts-title">
        Posts
      </h2>
      {jobs === null ? (
        <p className="st-s-field__hint">Getting the posts…</p>
      ) : jobs.length === 0 ? (
        <p className="st-s-field__hint">Not posted anywhere yet. Tap Post it to send it to your Lamo Stories accounts.</p>
      ) : (
        <ul className="st-s-posts">
          {jobs.map((j) => (
            <PostRow key={j.publishingJobId} job={j} onRetry={onRetry} busy={busyId === j.publishingJobId} />
          ))}
        </ul>
      )}
    </section>
  );
}
