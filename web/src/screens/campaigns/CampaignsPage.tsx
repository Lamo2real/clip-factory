// Your Content Rewards campaigns (/campaigns, docs/CONTRACTS.md §38.4): the paste box at the top, then one card per
// campaign (name, brand picture, one state chip, the next step in one line). With none yet: the three "join" steps.
// While the box is empty the screen's vermilion is "Open Content Rewards"; once a campaign link is in it, "Add campaign".
import { useState } from "react";
import type { GroupChoice } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { A, ErrorPanel, PageHeader, Skeleton } from "../../components/ui.tsx";
import { CR_SETUP_PATH, COMING_SOON, campaignPath, signedIn, useCr } from "../../lib/contentRewards.ts";
import { crPart } from "../../setup/contentrewards.ts";
import { useSetup } from "../settings/setup/useSetup.ts";
import { Rich } from "../settings/setup/bits.tsx";
import { BrandMark, CrStepCard, Note, OpenButton } from "./bits.tsx";
import { CampaignPasteBox, GroupPicker } from "./CampaignPaste.tsx";

/** "Your YouTube link" chips for the application questions, from GET /v1/setup's connected accounts (§38.4). */
export function accountLinks(platforms: { platform: string; account: { status: string; handle?: string } }[] | undefined): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const handle = (p: string) => {
    const a = platforms?.find((x) => x.platform === p)?.account;
    return a?.status === "connected" && a.handle ? a.handle.replace(/^@/, "") : null;
  };
  const yt = handle("youtube");
  if (yt) out.push({ label: "Your YouTube link", value: `https://www.youtube.com/@${yt}` });
  const ig = handle("instagram");
  if (ig) out.push({ label: "Your Instagram link", value: `https://www.instagram.com/${ig}/` });
  const x = handle("x");
  if (x) out.push({ label: "Your X link", value: `https://x.com/${x}` });
  return out;
}

export function JoinSteps({ primaryOpen }: { primaryOpen: boolean }) {
  const setup = useSetup();
  const [open, setOpen] = useState<string | null>("join-find");
  const steps = crPart("join").steps;
  return (
    <ol className="guide-steps cr-join">
      {steps.map((step, i) => (
        <CrStepCard
          key={step.id}
          step={step}
          number={i + 1}
          done={false}
          open={open === step.id}
          current={i === 0}
          primary={primaryOpen && step.id === "join-find"}
          onToggle={() => setOpen((o) => (o === step.id ? null : step.id))}
          copies={step.id === "join-join" ? accountLinks(setup.data?.platforms) : undefined}
        >
          {step.id === "join-copy" ? (
            <p className="gstep__note">
              <Icon name="share" size={18} />
              <span>This is the share icon.</span>
            </p>
          ) : null}
        </CrStepCard>
      ))}
    </ol>
  );
}

export function CampaignsPage() {
  const cr = useCr();
  const [group, setGroup] = useState<{ name: string; choices: GroupChoice[] } | null>(null);
  const [typed, setTyped] = useState(false);
  const data = cr.state === "ok" ? cr.data : cr.state === "error" ? cr.data : null;

  if (cr.state === "missing")
    return (
      <div className="page page--narrow">
        <PageHeader title="Your campaigns" />
        <Note>Content Rewards isn&apos;t in this version of Clip Factory yet.</Note>
      </div>
    );
  if (cr.state === "soon")
    return (
      <div className="page page--narrow">
        <PageHeader title="Your campaigns" />
        <Note>{COMING_SOON}</Note>
      </div>
    );

  const campaigns = data?.campaigns ?? [];
  const connected = signedIn(data?.connection);
  return (
    <div className="page page--narrow cr-campaigns">
      <PageHeader title="Your campaigns" lede="Join a campaign on Content Rewards. Paste its link here. I check the rules and if you're in." />
      <CampaignPasteBox
        onGroup={setGroup}
        onTyped={(has) => {
          setTyped(has);
          if (has) setGroup(null);
        }}
      />
      {group ? <GroupPicker name={group.name} choices={group.choices} onPicked={() => setGroup(null)} /> : null}
      {cr.state === "error" && !data ? <ErrorPanel message={cr.error} onRetry={() => void cr.reload()} /> : null}
      {!data && cr.state === "loading" ? (
        <>
          <Skeleton className="setup-skel" />
          <Skeleton className="setup-skel" />
        </>
      ) : null}
      {data && !connected ? (
        <p className="callout callout--info">
          <Icon name="info" size={18} />
          <span>
            Connect Content Rewards so I can see if you&apos;re in.{" "}
            <A href={CR_SETUP_PATH} className="text-link">
              Set it up
            </A>
          </span>
        </p>
      ) : null}
      {data && !campaigns.length ? (
        <section className="setup-part" aria-labelledby="cr-join-title">
          <h2 className="setup-part__title" id="cr-join-title">
            Join a campaign
          </h2>
          <JoinSteps primaryOpen={!typed && !group} />
        </section>
      ) : null}
      {campaigns.length ? (
        <ul className="cr-cards" aria-label="Your campaigns">
          {campaigns.map((c) => (
            <li key={c.campaignId} className="cr-card-wrap glass">
              <A href={campaignPath(c.campaignId)} className="cr-card-row" data-campaign={c.campaignId}>
                <BrandMark name={c.brand || c.name} url={c.brandPictureUrl} />
                <span className="cr-card-row__text">
                  <span className="cr-card-row__name user-text">{c.name}</span>
                  <span className="cr-card-row__brand user-text">{c.brand}</span>
                  <span className="cr-card-row__next">
                    <Rich text={c.nextStepText} />
                  </span>
                </span>
                <span className={`pill pill--${c.membership === "in" || c.membership === "manual" ? "success" : "neutral"} cr-chip`}>
                  <span className="pill__text">{c.chip}</span>
                </span>
                <Icon name="chevronRight" size={20} className="icon setup-card__go" />
              </A>
            </li>
          ))}
        </ul>
      ) : null}
      {campaigns.length ? (
        <div className="cr-below">
          <OpenButton label="Find another campaign" href="https://contentrewards.com/c/discover" icon="search" />
        </div>
      ) : null}
    </div>
  );
}
