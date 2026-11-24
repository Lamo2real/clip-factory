// Your Content Rewards campaigns (/campaigns, docs/CONTRACTS.md §38.4, §39.1): the paste box, then one card per
// campaign (name, brand picture, one state chip, the next step in one line). With none yet: the three "join" steps
// first, then the box. In time order: while Content Rewards is not connected, "Set up Content Rewards" comes first and
// is the vermilion ("Then join a campaign" follows, its Open glass); once connected, while the box is empty the
// vermilion is "Open Content Rewards"; once a campaign link is in the box, "Add campaign". Paste itself is glass.
// With the campaign finder on (§41.1), its card sits at the top, above the box; in that same empty state its "Find
// campaigns" is the vermilion and the step's Open is glass (§41.6 change 1). "Find another campaign" opens the Find
// page then (change 2).
import { useState } from "react";
import type { GroupChoice } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { A, ErrorPanel, LinkButton, PageHeader, Skeleton } from "../../components/ui.tsx";
import { CR_SETUP_PATH, COMING_SOON, campaignPath, signedIn, useCr } from "../../lib/contentRewards.ts";
import { finderHref, useFinderSummary } from "../../lib/finder.ts";
import { CR_DISCOVER } from "../../setup/contentrewards.ts";
import { withBack } from "../../lib/backLink.ts";
import { crPart } from "../../setup/contentrewards.ts";
import { useSetup } from "../settings/setup/useSetup.ts";
import { Rich } from "../settings/setup/bits.tsx";
import { BrandMark, CrStepCard, Note, OpenButton } from "./bits.tsx";
import { CampaignPasteBox, GroupPicker } from "./CampaignPaste.tsx";
import { FinderEntry } from "./FinderEntry.tsx";

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

/** Step 3's last line when the paste box sits under the steps (Campaigns with none yet). */
export const PASTE_BELOW = "Come back to Clip Factory. Tap Paste in the box below.";

export function JoinSteps({ primaryOpen, boxBelow = false }: { primaryOpen: boolean; boxBelow?: boolean }) {
  const setup = useSetup();
  const steps = crPart("join").steps;
  // An Ask button for one of these steps opens it (`#step-join-copy`).
  const [open, setOpen] = useState<string | null>(() => {
    const id = typeof location !== "undefined" ? /^#step-([a-z0-9-]+)$/.exec(location.hash)?.[1] : undefined;
    return id && steps.some((st) => st.id === id) ? id : "join-find";
  });
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
          say={step.id === "join-copy" && boxBelow ? step.say.map((l) => (/^Come back to Clip Factory\./.test(l) ? PASTE_BELOW : l)) : undefined}
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
  const finder = useFinderSummary();

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
  // Not connected yet: setting up comes first (§39.1 change 10), and is the vermilion while the box is empty.
  const setupFirst = !!data && !connected;
  // §41.6 change 1: signed in, no campaign, the box empty, the finder on: "Find campaigns" is the vermilion.
  const findFirst = !!finder && connected && !campaigns.length && !typed && !group;
  const another = finderHref(CR_DISCOVER, !!finder);
  return (
    <div className="page page--narrow cr-campaigns">
      <PageHeader title="Your campaigns" lede="Join a campaign on Content Rewards. Paste its link here." />
      {finder ? <FinderEntry summary={finder} primary={findFirst} /> : null}
      {/* None yet: the three join steps come first, so step 1's Open Content Rewards is on the first screen. */}
      {setupFirst ? (
        <section className="cr-setup-first glass" aria-labelledby="cr-setup-first-title" data-cr="setup-first">
          <h2 className="cr-section__title" id="cr-setup-first-title">
            First, set up Content Rewards
          </h2>
          <p>Then I can see if you&apos;re in.</p>
          <LinkButton
            href={withBack(CR_SETUP_PATH, "/campaigns")}
            variant={!typed && !group ? "primary" : "glass"}
            size="lg"
            icon="link"
            data-help-clear={!typed && !group ? "" : undefined}
          >
            Set up Content Rewards
          </LinkButton>
        </section>
      ) : null}
      {data && !campaigns.length ? (
        <section className="setup-part" aria-labelledby="cr-join-title">
          <h2 className="setup-part__title" id="cr-join-title">
            {setupFirst ? "Then join a campaign" : "Join a campaign"}
          </h2>
          <JoinSteps primaryOpen={!typed && !group && !setupFirst && !findFirst} boxBelow />
        </section>
      ) : null}
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
          {another.external ? (
            <OpenButton label="Find another campaign" href={another.href} icon="search" />
          ) : (
            <LinkButton href={another.href} variant="glass" icon="search">
              Find another campaign
            </LinkButton>
          )}
        </div>
      ) : null}
    </div>
  );
}
