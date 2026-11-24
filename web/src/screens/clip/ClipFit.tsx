// The clip page's fit (docs/CONTRACTS.md §39.3): while the clip waits in Review, a campaign clip shows the same fit
// block as its Review card (without the card's caption and TikTok fixes, which belong to the card), and a normal clip
// that could earn shows the same quiet "could earn" line. After it posts, the §38.6 post lines take over. A normal
// clip also has, closed by default and only when the owner is in a campaign, "Can it earn on your campaigns?" with one
// line per campaign. With no campaign, Content Rewards switched off (503) or an API before §39 (404): nothing shows.
import { useEffect, useState } from "react";
import { api, friendlyMessage } from "../../api/index.ts";
import type { CampaignFit as Fit, Clip, ClipFit as ClipFitData, Platform } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { LinkButton } from "../../components/ui.tsx";
import { useCr } from "../../lib/contentRewards.ts";
import { fitMain, reloadFit, useClipFit, useCopy } from "../../lib/crFit.ts";
import { canMacFetch } from "../../lib/macFetch.ts";
import { Rich } from "../settings/setup/bits.tsx";
import { CampaignFit, withoutSkippedNotes } from "../review/CampaignFit.tsx";
import { FitSuggestion } from "../review/FitSuggestion.tsx";

export type PageCopy = ReturnType<typeof useCopy>;

/**
 * The clip page's fit, where its campaign copy stands (read from the copy's own job), and whether its block has the
 * page's main button (then Refresh numbers steps back).
 */
export function useClipPageFit(clip: Pick<Clip, "clipId" | "status"> | null) {
  const cr = useCr();
  const load = useClipFit(clip?.clipId ?? null, !!clip && cr.state !== "missing" && cr.state !== "soon");
  const data = load.state === "ok" || load.state === "error" ? load.data : null;
  const own = data?.mode === "campaign" ? (data.fits[0] ?? null) : null;
  const waiting = clip?.status === "review";
  const copyFor = own?.campaignId ?? (data?.mode === "normal" ? (data.suggestion?.campaignId ?? null) : null);
  const copy = useCopy(clip?.clipId ?? "", copyFor ? data?.remakes[copyFor] : undefined);
  const main = waiting && own && copy.state === "none" ? fitMain(own) : null;
  return { data, own, waiting, main, copy };
}

const NO_SKIPS: readonly Platform[] = [];

/**
 * One line per campaign: its headline and first reason (the first problem, else the first thing that's right). A note
 * asking him to set up a place he skipped ("X pays too. Set it up…") is never that reason (rule S, §48.3).
 */
export function fitSummary(given: Fit, skipped: readonly Platform[] = NO_SKIPS): string {
  const f = withoutSkippedNotes(given, skipped);
  const first = f.items.find((i) => i.state !== "ok" && i.rule !== "send") ?? f.items.find((i) => i.state === "ok");
  return first ? `${f.headline}. ${first.text}` : `${f.headline}.`;
}

/** `skipped`: the places he skipped that are not set up (lib/setupTodo.ts activeSkips); their "Set it up" notes go. */
export function ClipFit({
  clip,
  data,
  primary,
  copy: pageCopy,
  skipped = NO_SKIPS,
}: {
  clip: Clip;
  data: ClipFitData | null;
  primary: boolean;
  copy: PageCopy;
  skipped?: readonly Platform[];
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const waiting = clip.status === "review";
  const own = data.mode === "campaign" ? (data.fits[0] ?? null) : null;
  const suggested = data.mode === "normal" && data.suggestion ? (data.fits.find((f) => f.campaignId === data.suggestion!.campaignId) ?? null) : null;

  async function copy(campaignId: string, campaignAnyway: string[]) {
    setBusy(true);
    try {
      const youtube = /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(clip.sourceUrlAt ?? "");
      const job = await api().crRemake(campaignId, { clipId: clip.clipId, ...(youtube && canMacFetch() ? { macFetch: true } : {}), ...(campaignAnyway.length ? { campaignAnyway } : {}) });
      pageCopy.started(job);
      reloadFit(clip.clipId);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // The copy waits in Review (its job's own clips say so): one way there. Making it, or already up: its line.
  const copyLink = (name: string) =>
    pageCopy.state === "ready" && pageCopy.jobId ? (
      <div className="cr-clip-fit__copy">
        <p className="small">{`The ${name} copy is in Review.`}</p>
        <LinkButton href={`/review?job=${encodeURIComponent(pageCopy.jobId)}`} variant="glass" icon="review" iconAfter="chevronRight">
          Go to Review
        </LinkButton>
      </div>
    ) : null;
  // The block itself says "Making…" or "uploaded"; "ready" is said by the link above (not "right below" here).
  const blockCopy = pageCopy.state === "ready" ? "unknown" : pageCopy.state;

  return (
    <>
      {waiting && own ? (
        <section className="cr-clip-fit glass" aria-label="Does this clip fit the campaign?">
          <CampaignFit
            clipId={clip.clipId}
            fit={own}
            primary={primary}
            copy={blockCopy}
            onRemake={() => copy(own.campaignId, own.softCodes)}
            remaking={busy}
            skipped={skipped}
          />
          {copyLink(own.campaignName)}
        </section>
      ) : null}
      {waiting && suggested ? (
        <section className="cr-clip-fit" aria-label="Could this clip earn money?">
          {pageCopy.state === "ready" ? (
            <section className="cr-suggest glass" data-help="cr-review-strip cr-fit-suggest" aria-label={`The ${suggested.campaignName} copy`}>
              {copyLink(suggested.campaignName)}
            </section>
          ) : (
            <FitSuggestion clipId={clip.clipId} fit={suggested} copy={pageCopy.state} onCopy={(anyway) => copy(suggested.campaignId, anyway)} busy={busy} />
          )}
        </section>
      ) : null}
    </>
  );
}

/**
 * "Can it earn on your campaigns?" (§39.3): closed by default, only for a normal clip while he is in a campaign, one
 * line per campaign (its headline and first reason). A glass panel of its own, at the end of the clip page.
 */
export function CampaignsFold({ data, skipped = NO_SKIPS }: { data: ClipFitData | null; skipped?: readonly Platform[] }) {
  const cr = useCr();
  const inCampaign = cr.state === "ok" && cr.data.campaigns.some((c) => c.membership === "in" || c.membership === "manual");
  if (!data || data.mode !== "normal" || !inCampaign || !data.fits.length) return null;
  // The campaign the "could earn" line names comes first, so the two never disagree.
  const first = data.suggestion?.campaignId;
  const fits = first ? [...data.fits.filter((f) => f.campaignId === first), ...data.fits.filter((f) => f.campaignId !== first)] : data.fits;
  return (
    <details className="cr-clip-fit__all glass" data-help="cr-fit">
      <summary className="cr-fold__q">
        <Icon name="coin" size={18} />
        <span>Can it earn on your campaigns?</span>
        <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
      </summary>
      <ul className="cr-fold__body cr-fit__lines">
        {fits.map((f) => (
          <li key={f.campaignId} className={`cr-fit__line is-${f.verdict}`} data-campaign={f.campaignId}>
            <Icon name={f.verdict === "fits" ? "checkCircle" : f.verdict === "doesnt_fit" ? "xCircle" : f.verdict === "wait" ? "clock" : "info"} size={18} />
            <span>
              <strong className="user-text">{f.campaignName}:</strong> <Rich text={fitSummary(f, skipped)} />
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The clip itself, when its page has no numbers (a clip still in Review answers 404 there). */
export function useWaitingClip(clipId: string, on: boolean): Clip | null {
  const [clip, setClip] = useState<Clip | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    api()
      .getClip(clipId)
      .then((c) => alive && setClip(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [clipId, on]);
  return on ? clip : null;
}

/**
 * A clip that waits in Review has no numbers yet (its page says so): the fit still shows above that, from the clip
 * itself, so the clip page tells him whether it can earn before he uploads it.
 */
export function WaitingClipFit({ clip, skipped = NO_SKIPS }: { clip: Clip | null; skipped?: readonly Platform[] }) {
  const page = useClipPageFit(clip?.status === "review" ? clip : null);
  if (!clip || clip.status !== "review") return null;
  return (
    <>
      <ClipFit clip={clip} data={page.data} primary={false} copy={page.copy} skipped={skipped} />
      <CampaignsFold data={page.data} skipped={skipped} />
    </>
  );
}
