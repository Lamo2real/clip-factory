// Home › Campaigns (docs/CONTRACTS.md §38.4, §39.1): one chip per Content Rewards campaign. A campaign ready for clips
// says "Make campaign clips" and opens the campaign way (`/?campaign={uuid}`) in one tap; every other chip shows its
// state and opens its card. With Content Rewards connected and no campaign yet, one chip "Add a campaign". Hidden when
// the API has no Content Rewards (404), while it is switched off (503) and when there is nothing to show. The
// campaign finder (§41.1) adds a first chip "3 new campaigns match" (the row shows for it alone too) and, when the
// row shows anyway, a last chip "Find campaigns"; both read the overview's `finder`, so Home makes no extra call.
import type { NextStepKind } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { A, LinkButton } from "../../components/ui.tsx";
import { CAMPAIGNS_PATH, campaignPath, makeClipsPath, readyForClips, signedIn, useCr } from "../../lib/contentRewards.ts";
import { FIND_PATH, newChipText, useFinderSummary } from "../../lib/finder.ts";
import { plural } from "../../lib/format.ts";
import { BrandMark } from "../campaigns/bits.tsx";

const MAX_SHOWN = 8;
export const MAKE_CAMPAIGN_CLIPS = "Make campaign clips";
/** A joined campaign that can't make clips yet says what comes first on its chip, never only "You're in". */
export const FIRST_THING: Partial<Record<NextStepKind, string>> = {
  logo: "Add the logo first",
  rules_paste: "Rules missing",
  anyway: "Check it first",
  pick_video: "Pick a video",
};

export function CampaignsRow() {
  const cr = useCr();
  const finder = useFinderSummary();
  if (cr.state !== "ok") return null;
  const { campaigns, connection } = cr.data;
  // No chip and no change while he stopped it (`on: false`) or the overview has no `finder`.
  const finderOn = !!finder && finder.on;
  const fresh = finderOn && finder.started ? finder.newCount : 0;
  if (!campaigns.length && !signedIn(connection) && !fresh) return null;
  const shown = campaigns.slice(0, MAX_SHOWN);
  const anyReady = shown.some(readyForClips);
  return (
    <section className="home-row cr-row" aria-labelledby="cr-row-title">
      <div className="home-row__intro">
        {/* No nowrap: in the narrow intro column (1100 px and up) "campaigns." takes a line of its own. */}
        <h2 className="display-2" id="cr-row-title">
          Your <em>campaigns</em>.
        </h2>
        <p className="muted">
          {anyReady ? "Tap a campaign to make clips for it." : campaigns.length ? `${plural(campaigns.length, "campaign")} on Content Rewards.` : "Get paid by brands for your clips."}
        </p>
        <LinkButton href={CAMPAIGNS_PATH} size="sm" icon="layers" iconAfter="chevronRight">
          See them all
        </LinkButton>
      </div>
      <ul className="cr-row__list" aria-label="Your campaigns">
        {fresh > 0 ? (
          <li>
            <A href={FIND_PATH} className="cr-row-chip glass is-add is-find" data-help="cr-finder-entry">
              <span className="cr-brand cr-brand--letter" aria-hidden="true" style={{ width: 40, height: 40 }}>
                <Icon name="search" size={20} />
              </span>
              <span className="cr-row-chip__text">
                <span className="cr-row-chip__name">{newChipText(fresh)}</span>
              </span>
            </A>
          </li>
        ) : null}
        {shown.map((c) => {
          const ready = readyForClips(c);
          const joined = c.membership === "in" || c.membership === "manual";
          const first = !ready && joined && c.nextStepKind ? FIRST_THING[c.nextStepKind] : undefined;
          return (
            <li key={c.campaignId}>
              <A
                href={ready ? makeClipsPath(c.campaignId) : campaignPath(c.campaignId)}
                className={`cr-row-chip glass${c.membership === "in" || c.membership === "manual" ? " is-in" : ""}${ready ? " is-ready" : ""}`}
                data-campaign={c.campaignId}
              >
                <BrandMark name={c.brand || c.name} url={c.brandPictureUrl} size={40} />
                <span className="cr-row-chip__text">
                  <span className="cr-row-chip__name user-text clamp-1">{c.name}</span>
                  <span className="cr-row-chip__state">
                    {ready ? (
                      <>
                        <Icon name="scissors" size={14} /> {MAKE_CAMPAIGN_CLIPS}
                      </>
                    ) : first ? (
                      first
                    ) : c.celebrate === "in" ? (
                      "You're in!"
                    ) : (
                      c.chip
                    )}
                  </span>
                </span>
              </A>
            </li>
          );
        })}
        {!campaigns.length && signedIn(connection) ? (
          <li>
            <A href={CAMPAIGNS_PATH} className="cr-row-chip glass is-add">
              <span className="cr-brand cr-brand--letter" aria-hidden="true" style={{ width: 40, height: 40 }}>
                <Icon name="plus" size={20} />
              </span>
              <span className="cr-row-chip__text">
                <span className="cr-row-chip__name">Add a campaign</span>
              </span>
            </A>
          </li>
        ) : null}
        {finderOn && !fresh && campaigns.length ? (
          <li>
            <A href={FIND_PATH} className="cr-row-chip glass is-add is-find">
              <span className="cr-brand cr-brand--letter" aria-hidden="true" style={{ width: 40, height: 40 }}>
                <Icon name="search" size={20} />
              </span>
              <span className="cr-row-chip__text">
                <span className="cr-row-chip__name">Find campaigns</span>
              </span>
            </A>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
