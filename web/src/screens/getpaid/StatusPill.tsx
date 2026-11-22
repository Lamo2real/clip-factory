// A Get paid status pill (docs/CONTRACTS.md §40.2): the server's words, its tone and an icon, never colour alone.
// Tones are success, neutral, warn and error at AA contrast, never the vermilion of a button. "Not set up yet" (his
// own steps) is warn, never red; "Can get paid (you said it's done)" has an outline icon and no ✓.
import type { GetPaidCard } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { STATUS_ICON } from "../../lib/getPaid.ts";

export function StatusPill({ card }: { card: Pick<GetPaidCard, "status" | "tone" | "pill"> }) {
  return (
    <span className={`gp-pill gp-pill--${card.tone}`} data-status={card.status} data-tone={card.tone}>
      <Icon name={STATUS_ICON[card.status]} size={16} />
      <span className="gp-pill__text">{card.pill}</span>
    </span>
  );
}
