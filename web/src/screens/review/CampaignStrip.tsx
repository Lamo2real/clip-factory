// Review › a campaign clip (docs/CONTRACTS.md §38.5): the strip at the top of the card, "For FaZe Clips · Content
// Rewards" with three ticks, and the line above Upload that says who sends it to Content Rewards.
import type { Campaign } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { A } from "../../components/ui.tsx";
import { campaignPath } from "../../lib/contentRewards.ts";

export function CampaignStrip({ campaign }: { campaign: Pick<Campaign, "campaignId" | "name" | "logo"> }) {
  const ticks = ["Paid partnership", "#Ad at the start", ...(campaign.logo.needed ? ["Logo on"] : [])];
  return (
    <div className="cr-strip" data-help="cr-review-strip">
      <p className="cr-strip__for">
        <Icon name="coin" size={18} />
        <span>
          For{" "}
          <A href={campaignPath(campaign.campaignId)} className="text-link">
            <strong className="user-text">{campaign.name}</strong>
          </A>{" "}
          · Content Rewards
        </span>
      </p>
      <ul className="cr-strip__ticks" aria-label="This clip follows the campaign">
        {ticks.map((t) => (
          <li key={t}>
            <Icon name="check" size={16} />
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
