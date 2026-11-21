// The clip page's fit (docs/CONTRACTS.md §39.3): while the clip waits in Review, a campaign clip shows the same fit
// block as its Review card (without the card's caption and TikTok fixes, which belong to the card), and a normal clip
// that could earn shows the same quiet "could earn" line. After it posts, the §38.6 post lines take over. A normal
// clip also has, closed by default and only when the owner is in a campaign, "Can it earn on your campaigns?" with one
// line per campaign. With no campaign, Content Rewards switched off (503) or an API before §39 (404): nothing shows.
import { useEffect, useState } from "react";
import { api, friendlyMessage } from "../../api/index.ts";
import type { CampaignFit as Fit, Clip, ClipFit as ClipFitData } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { LinkButton } from "../../components/ui.tsx";
import { useCr } from "../../lib/contentRewards.ts";
import { fitMain, reloadFit, useClipFit } from "../../lib/crFit.ts";
import { canMacFetch } from "../../lib/macFetch.ts";
import { Rich } from "../settings/setup/bits.tsx";
import { CampaignFit, making, type CopyState } from "../review/CampaignFit.tsx";
import { FitSuggestion } from "../review/FitSuggestion.tsx";

const MAKING_MS = 10 * 60_000;

/** The clip page's fit, and whether its block has the page's main button (then Refresh numbers steps back). */
export function useClipPageFit(clip: Pick<Clip, "clipId" | "status"> | null) {
  const cr = useCr();
  const load = useClipFit(clip?.clipId ?? null, !!clip && cr.state !== "missing" && cr.state !== "soon");
  const data = load.state === "ok" || load.state === "error" ? load.data : null;
  const own = data?.mode === "campaign" ? (data.fits[0] ?? null) : null;
  const waiting = clip?.status === "review";
  const remade = own && data?.remakes[own.campaignId];
  const main = waiting && own && !remade ? fitMain(own) : null;
  return { data, own, waiting, main };
}

/** One line per campaign: its headline and first reason (the first problem, else the first thing that's right). */
export function fitSummary(f: Fit): string {
  const first = f.items.find((i) => i.state !== "ok" && i.rule !== "send") ?? f.items.find((i) => i.state === "ok");
  return first ? `${f.headline}. ${first.text}` : `${f.headline}.`;
}

export function ClipFit({ clip, data, primary }: { clip: Clip; data: ClipFitData | null; primary: boolean }) {
  const toast = useToast();
  const cr = useCr();
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  if (!data) return null;
  const waiting = clip.status === "review";
  const own = data.mode === "campaign" ? (data.fits[0] ?? null) : null;
  const suggested = data.mode === "normal" && data.suggestion ? (data.fits.find((f) => f.campaignId === data.suggestion!.campaignId) ?? null) : null;
  const inCampaign = cr.state === "ok" && cr.data.campaigns.some((c) => c.membership === "in" || c.membership === "manual");

  const copyOf = (campaignId: string | null): { state: CopyState; jobId?: string } => {
    const entry = campaignId ? data.remakes[campaignId] : undefined;
    if (!entry) return { state: asked && asked === campaignId ? "making" : "none" };
    return { state: Date.now() - Date.parse(entry.at) < MAKING_MS ? "making" : "ready", jobId: entry.jobId };
  };

  async function copy(campaignId: string, campaignAnyway: string[]) {
    setBusy(true);
    try {
      const youtube = /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(clip.sourceUrlAt ?? "");
      await api().crRemake(campaignId, { clipId: clip.clipId, ...(youtube && canMacFetch() ? { macFetch: true } : {}), ...(campaignAnyway.length ? { campaignAnyway } : {}) });
      setAsked(campaignId);
      reloadFit(clip.clipId);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const ownCopy = copyOf(own?.campaignId ?? null);
  const suggestedCopy = copyOf(suggested?.campaignId ?? null);
  const copyLink = (c: { state: CopyState; jobId?: string }, name: string) =>
    c.state === "ready" && c.jobId ? (
      <div className="cr-clip-fit__copy">
        <p className="small">{`The ${name} copy is in Review.`}</p>
        <LinkButton href={`/review?job=${encodeURIComponent(c.jobId)}`} variant="glass" icon="review" iconAfter="chevronRight">
          Go to Review
        </LinkButton>
      </div>
    ) : c.state === "making" ? (
      <p className="small" role="status">
        {making(name)}
      </p>
    ) : null;

  return (
    <>
      {waiting && own ? (
        <section className="cr-clip-fit glass" aria-label="Does this clip fit the campaign?">
          <CampaignFit
            clipId={clip.clipId}
            fit={own}
            primary={primary}
            copy={ownCopy.state === "none" ? "none" : "making"}
            onRemake={() => copy(own.campaignId, own.softCodes)}
            remaking={busy}
          />
          {copyLink(ownCopy, own.campaignName)}
        </section>
      ) : null}
      {waiting && suggested ? (
        <section className="cr-clip-fit" aria-label="Could this clip earn money?">
          <FitSuggestion clipId={clip.clipId} fit={suggested} copy={suggestedCopy.state === "none" ? "none" : "making"} onCopy={(anyway) => copy(suggested.campaignId, anyway)} busy={busy} />
          {copyLink(suggestedCopy, suggested.campaignName)}
        </section>
      ) : null}
      {data.mode === "normal" && inCampaign && data.fits.length ? (
        <details className="cr-fold cr-clip-fit__all" data-help="cr-fit">
          <summary className="cr-fold__q">
            <Icon name="coin" size={18} />
            <span>Can it earn on your campaigns?</span>
            <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
          </summary>
          <ul className="cr-fold__body cr-fit__lines">
            {data.fits.map((f) => (
              <li key={f.campaignId} className={`cr-fit__line is-${f.verdict}`} data-campaign={f.campaignId}>
                <Icon name={f.verdict === "fits" ? "checkCircle" : f.verdict === "doesnt_fit" ? "xCircle" : f.verdict === "wait" ? "clock" : "info"} size={18} />
                <span>
                  <strong className="user-text">{f.campaignName}:</strong> <Rich text={fitSummary(f)} />
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

/**
 * A clip that waits in Review has no numbers yet (its page says so): the fit still shows above that, from the clip
 * itself, so the clip page tells him whether it can earn before he uploads it.
 */
export function WaitingClipFit({ clipId }: { clipId: string }) {
  const [clip, setClip] = useState<Clip | null>(null);
  useEffect(() => {
    let alive = true;
    api()
      .getClip(clipId)
      .then((c) => alive && setClip(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [clipId]);
  const page = useClipPageFit(clip?.status === "review" ? clip : null);
  if (!clip || clip.status !== "review") return null;
  return <ClipFit clip={clip} data={page.data} primary={false} />;
}
