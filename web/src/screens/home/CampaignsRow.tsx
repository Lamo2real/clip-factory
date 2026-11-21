// Home › Campaigns (docs/CONTRACTS.md §38.4): one chip per Content Rewards campaign with its state; tapping opens it.
// With Content Rewards connected and no campaign yet, one chip "Add a campaign". Hidden when the API has no
// Content Rewards (404), while it is switched off (503) and when there is nothing to show.
import { Icon } from "../../components/Icon.tsx";
import { A, LinkButton } from "../../components/ui.tsx";
import { CAMPAIGNS_PATH, campaignPath, signedIn, useCr } from "../../lib/contentRewards.ts";
import { plural } from "../../lib/format.ts";
import { BrandMark } from "../campaigns/bits.tsx";

const MAX_SHOWN = 8;

export function CampaignsRow() {
  const cr = useCr();
  if (cr.state !== "ok") return null;
  const { campaigns, connection } = cr.data;
  if (!campaigns.length && !signedIn(connection)) return null;
  const shown = campaigns.slice(0, MAX_SHOWN);
  return (
    <section className="home-row cr-row" aria-labelledby="cr-row-title">
      <div className="home-row__intro">
        {/* No nowrap: in the narrow intro column (1100 px and up) "campaigns." takes a line of its own. */}
        <h2 className="display-2" id="cr-row-title">
          Your <em>campaigns</em>.
        </h2>
        <p className="muted">{campaigns.length ? `${plural(campaigns.length, "campaign")} on Content Rewards.` : "Get paid by brands for your clips."}</p>
        <LinkButton href={CAMPAIGNS_PATH} size="sm" icon="layers" iconAfter="chevronRight">
          See them all
        </LinkButton>
      </div>
      <ul className="cr-row__list" aria-label="Your campaigns">
        {shown.map((c) => (
          <li key={c.campaignId}>
            <A href={campaignPath(c.campaignId)} className={`cr-row-chip glass${c.membership === "in" || c.membership === "manual" ? " is-in" : ""}`} data-campaign={c.campaignId}>
              <BrandMark name={c.brand || c.name} url={c.brandPictureUrl} size={40} />
              <span className="cr-row-chip__text">
                <span className="cr-row-chip__name user-text clamp-1">{c.name}</span>
                <span className="cr-row-chip__state">{c.celebrate === "in" ? "You're in!" : c.chip}</span>
              </span>
            </A>
          </li>
        ))}
        {!campaigns.length ? (
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
      </ul>
    </section>
  );
}
