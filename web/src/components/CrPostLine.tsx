// One line per campaign post on Content Rewards (docs/CONTRACTS.md §38.6), next to the post's own row: on the clip
// page, in Library, on the job page and on the campaign card. Several posts of one clip that wait to be sent by hand
// for the same campaign show as one line, whose copy is their links, one per line. Buttons are glass unless said.
import { useState } from "react";
import { api } from "../api/index.ts";
import { friendlyMessage } from "../api/errors.ts";
import type { CrSubmission } from "../api/types.ts";
import {
  APPEAL_HINTS,
  APPEAL_HREF,
  CAMPAIGN_REASONS,
  CR_SETTINGS,
  RECORD_SCREEN,
  SEND_STEPS,
  appealSteps,
  canSend,
  copyAndOpen,
  crCampaignUrl,
  minutesLeftOf,
  patchCr,
  reasonText,
  rejectHint,
  richLine,
  safeHref,
  sendGroups,
  sendHints,
  subLineFor,
  useCr,
  useNow,
  type SendGroup,
} from "../lib/contentRewards.ts";
import { finderHref, useFinderSummary } from "../lib/finder.ts";
import { PLATFORM_LABEL } from "../lib/format.ts";
import { CR_DISCOVER } from "../setup/contentrewards.ts";
import { copyText, Rich } from "../screens/settings/setup/bits.tsx";
import { Fold, GreenButton, Hints, Lines, OpenButton } from "../screens/campaigns/bits.tsx";
import { Icon } from "./Icon.tsx";
import { PlatformMark } from "./PlatformMark.tsx";
import { useToast } from "./Toasts.tsx";
import { Button, LinkButton } from "./ui.tsx";

/** The lines for a list of submissions: send-by-hand posts of one clip and campaign grouped into one line. */
export function CrPostLines({
  subs,
  onChange,
  openSend = false,
  compact = false,
  primary = false,
}: {
  subs: readonly CrSubmission[];
  /** A newer copy of one submission (after an answer), or null to read them all again. */
  onChange: (next: CrSubmission | null) => void;
  /** Arrived from the "send now" notification (`?cr={postId}`): the steps fold open. */
  openSend?: boolean;
  compact?: boolean;
  /** The first waiting send's "Copy and open" is the screen's vermilion button (the page has none of its own then). */
  primary?: boolean;
}) {
  // The minutes left count down on screen (a send whose time is up leaves the group and reads "Too late").
  const now = useNow(subs.some((s) => s.state === "send_by_hand"));
  const groups = sendGroups(subs, now);
  const grouped = new Set(groups.flatMap((g) => g.postIds));
  const rest = subs.filter((s) => !grouped.has(s.postId));
  if (!subs.length) return null;
  return (
    <ul className={`cr-lines${compact ? " is-compact" : ""}`}>
      {groups.map((g, i) => (
        <li key={g.key}>
          <SendLine group={g} open={openSend} onChange={onChange} primary={primary && i === 0} />
        </li>
      ))}
      {rest.map((s) => (
        <li key={s.postId}>
          <CrPostLine sub={s} onChange={onChange} compact={compact} now={now} />
        </li>
      ))}
    </ul>
  );
}

/** "Copy and open" (vermilion), "Copy link" and the green "I sent it", with the four steps. */
export function SendLine({
  group,
  open,
  onChange,
  banner = false,
  primary = false,
}: {
  group: SendGroup;
  open?: boolean;
  onChange: (next: CrSubmission | null) => void;
  banner?: boolean;
  primary?: boolean;
}) {
  const toast = useToast();
  const cr = useCr();
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  // "Try sending again" (§38.8): only while Clip Factory may send clips itself and there is time left.
  const canTry = !banner && cr.state === "ok" && canSend(cr.data.connection) && group.minutesLeft > 0;
  async function tryAgain() {
    setSending(true);
    try {
      let last: CrSubmission | null = null;
      for (const id of group.postIds) last = await api().crSendSubmission(id);
      onChange(last);
      if (group.postIds.length > 1) onChange(null);
      toast.success(last && last.state !== "send_by_hand" ? "Sent to Content Rewards." : "It didn't go yet. Copy and open, then paste it.");
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setSending(false);
    }
  }
  async function sentIt() {
    setBusy(true);
    try {
      let last: CrSubmission | null = null;
      for (const id of group.postIds) last = await api().crPatchSubmission(id, "sent_by_hand");
      onChange(last);
      toast.undo("Saved: you sent it.", {
        onUndo: () => {
          void Promise.all(group.postIds.map((id) => api().crPatchSubmission(id, null)))
            .then(() => onChange(null))
            .catch(() => undefined);
        },
        onCommit: () => undefined,
      });
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`cr-line cr-line--send${banner ? " is-banner" : ""}`} data-help="cr-post-line" data-state="send_by_hand">
      <p className="cr-line__text">
        <Icon name="clock" size={18} />
        <span>
          {banner ? (
            <>
              Send “<span className="user-text">{group.clipTitle}</span>” to Content Rewards now ({group.minutesLeft} min left)
            </>
          ) : (
            group.line
          )}
        </span>
      </p>
      <div className="cr-line__actions" data-help="cr-send-now">
        <Button
          variant={primary && !banner ? "primary" : "glass"}
          className={banner ? "btn--leaf" : undefined}
          icon="copy"
          act="copy"
          data-help-clear={primary ? "" : undefined}
          onClick={() =>
            copyAndOpen(group.copy, group.openHref, copyText, crCampaignUrl(group.campaignId)).then((ok) => {
              toast.success(ok ? "Link copied. Paste it on Content Rewards." : "Copy did not work. Tap Copy link, then paste it.");
              return ok;
            })
          }
        >
          Copy and open
        </Button>
        {!banner ? (
          <>
            <Button
              variant="glass"
              icon="copy"
              act="copy"
              onClick={() =>
                copyText(group.copy).then((ok) => {
                  toast.success(ok ? "Link copied." : "Copy did not work. Press and hold the link to copy it.");
                  return ok;
                })
              }
            >
              Copy link
            </Button>
            <GreenButton onClick={sentIt} loading={busy}>
              I sent it
            </GreenButton>
            {canTry ? (
              <Button variant="glass" icon="retry" act="retry" loading={sending} onClick={tryAgain}>
                Try sending again
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {!banner ? (
        <details className="cr-fold" open={open}>
          <summary className="cr-fold__q">
            <Icon name="info" size={18} />
            <span>How do I send it?</span>
            <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
          </summary>
          <div className="cr-fold__body">
            <Lines lines={SEND_STEPS} />
            <Hints list={sendHints(group.platforms)} />
            <div className="cr-line__actions">
              <OpenButton label="Open Content Rewards settings" href={CR_SETTINGS} />
              <OpenButton label="Open campaign" href={safeHref(group.openHref, crCampaignUrl(group.campaignId))} />
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** One campaign post's line (every state of §38.6 but a waiting send, which SendLine draws). */
/** "Find another campaign": the Find page in the same tab while the finder is on (§41.6 change 2), else Discover. */
export function FindAnother() {
  const to = finderHref(CR_DISCOVER, !!useFinderSummary());
  return to.external ? (
    <OpenButton label="Find another campaign" href={to.href} />
  ) : (
    <LinkButton href={to.href} variant="glass" icon="search">
      Find another campaign
    </LinkButton>
  );
}

export function CrPostLine({ sub, onChange, compact = false, now = Date.now() }: { sub: CrSubmission; onChange: (next: CrSubmission | null) => void; compact?: boolean; now?: number }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  // "Ask again" tapped on this visit: then "Copy the words again" and "I asked" make sense.
  const [askTapped, setAskTapped] = useState(false);
  // A send whose 30 minutes ran out since the last read says so now, not "(12 min left)".
  const late = sub.state === "send_by_hand" && minutesLeftOf(sub, now) <= 0;
  const line = late ? subLineFor({ ...sub, state: "missed" }) : sub.line || subLineFor(sub);
  const hint = sub.state === "rejected" && !sub.appeal?.askedAt ? rejectHint(sub.reason?.brandSaid) : null;

  async function say(said: "appealed" | "proof_sent") {
    setBusy(said);
    try {
      const next = await api().crPatchSubmission(sub.postId, said);
      onChange(next);
      toast.undo(said === "appealed" ? "Saved: you asked again." : "Saved: you sent the proof.", {
        onUndo: () => {
          void api()
            .crPatchSubmission(sub.postId, null)
            .then((back) => onChange(back))
            .catch(() => undefined);
        },
        onCommit: () => undefined,
      });
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function relinked() {
    setBusy("relink");
    try {
      const connection = await api().crPatchConnection({ relinked: sub.platform });
      patchCr((d) => ({ ...d, connection }));
      toast.success("Thanks. The next clip will go.");
      onChange(null);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const ok = sub.state === "approved" || sub.state === "sent" || sub.state === "sent_by_hand";
  const bad = late || sub.state === "rejected" || sub.state === "missed" || sub.state === "not_sent" || sub.removed || sub.postGone;
  const appealOpen = sub.state === "rejected" && !!sub.appeal && !sub.appeal.askedAt;
  // After "The brand kept its answer. This one can't be asked again." nothing more can be done.
  const asked = sub.appeal?.askedAt ? Date.parse(sub.appeal.askedAt) : NaN;
  const appealOver = Number.isFinite(asked) && now - asked > 10 * 86_400_000;
  const showCopyAgain = !appealOver && (askTapped || !!sub.appeal?.askedAt);
  return (
    <div className={`cr-line${ok ? " is-ok" : bad ? " is-bad" : ""}`} data-help="cr-post-line" data-state={sub.state} data-post={sub.postId} data-clip={sub.clipId}>
      <p className="cr-line__text">
        <PlatformMark platform={sub.platform} size={18} />
        <span>
          {compact ? <span className="cr-line__campaign user-text">{sub.campaignName}: </span> : null}
          <span className="user-text">
            <Rich text={richLine(line)} />
          </span>
        </span>
      </p>
      {hint ? <p className="cr-line__hint">{hint}</p> : null}
      {sub.paidLabel === "not_set" ? (
        <p className="cr-line__hint">
          {PLATFORM_LABEL[sub.platform]} didn&apos;t take the {sub.platform === "youtube" ? "Paid promotion" : "Paid partnership"} switch. #Ad and the words on the video still tell viewers.
        </p>
      ) : null}

      {sub.state === "not_sent" && sub.reason ? (
        <div className="cr-line__actions">
          {sub.reason.code === "not_linked" || sub.reason.code === "relink" ? (
            <>
              <OpenButton label="Open Content Rewards settings" href={CR_SETTINGS} />
              <GreenButton onClick={relinked} loading={busy === "relink"}>
                I added it
              </GreenButton>
            </>
          ) : sub.reason.code === "not_on_application" ? (
            <OpenButton label="Open campaign" href={safeHref(sub.openCampaignHref, crCampaignUrl(sub.campaignId))} />
          ) : CAMPAIGN_REASONS.includes(sub.reason.code) ? (
            <FindAnother />
          ) : null}
        </div>
      ) : null}

      {sub.state === "rejected" && sub.appeal && !appealOver ? (
        <div className="cr-line__appeal">
          <div className="cr-line__actions">
            {appealOpen ? (
              <Button
                variant="glass"
                icon="retry"
                act="copy"
                onClick={() => {
                  setAskTapped(true);
                  return copyAndOpen(sub.appeal!.words, sub.appeal!.href || APPEAL_HREF, copyText, APPEAL_HREF).then((done) => {
                    toast.success(done ? "Words copied." : "Copy did not work. Tap Copy the words again.");
                    return done;
                  });
                }}
              >
                Ask again
              </Button>
            ) : null}
            {showCopyAgain ? (
              <Button
                variant="glass"
                size="sm"
                icon="copy"
                act="copy"
                onClick={() =>
                  copyText(sub.appeal!.words).then((done) => {
                    toast.success(done ? "Words copied." : "Copy did not work.");
                    return done;
                  })
                }
              >
                Copy the words again
              </Button>
            ) : null}
            {appealOpen && askTapped ? (
              <GreenButton size="sm" onClick={() => say("appealed")} loading={busy === "appealed"}>
                I asked
              </GreenButton>
            ) : null}
          </div>
          {appealOpen ? (
            <details className="cr-fold">
              <summary className="cr-fold__q">
                <Icon name="info" size={18} />
                <span>How do I ask again?</span>
                <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
              </summary>
              <div className="cr-fold__body">
                <Lines lines={appealSteps(sub.clipTitle, sub.postedAt)} />
                <Hints list={APPEAL_HINTS} />
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      {sub.proof?.due && !sub.proof.doneAt ? (
        <div className="cr-line__proof">
          <p className="cr-line__text">
            <Icon name="video" size={18} />
            <span>
              <Rich text={sub.proof.text} />
            </span>
          </p>
          <div className="cr-line__actions">
            {sub.proof.open ? <OpenButton label={sub.proof.open.label} href={sub.proof.open.href} /> : null}
            <GreenButton onClick={() => say("proof_sent")} loading={busy === "proof_sent"}>
              I sent it
            </GreenButton>
          </div>
          <Lines lines={sub.proof.steps} />
          <div className="cr-line__actions">
            <OpenButton label="Open campaign" href={safeHref(sub.openCampaignHref, crCampaignUrl(sub.campaignId))} />
          </div>
          <Fold fold={{ id: `proof-${sub.postId}`, question: "How do I record my screen?", say: RECORD_SCREEN }} />
        </div>
      ) : null}
      {sub.state === "not_sent" && sub.reason && !line.includes(reasonText(sub.reason.code, sub.platform).slice(0, 20)) ? (
        <p className="cr-line__hint">
          <Rich text={richLine(reasonText(sub.reason.code, sub.platform, sub.reason.brandSaid))} />
        </p>
      ) : null}
    </div>
  );
}
