// A clip's money guess on Library and This week cards, and the week total (docs/CONTRACTS.md §21): "Earned about
// $1.23" with a visible "Best guess" tag, "No money yet", or "Earned $0.00" with its plain reason.
import type { ElementType } from "react";
import { earnedLine, moneyPhrase } from "../lib/earnings.ts";
import { Icon } from "./Icon.tsx";

export function EarnedChip({
  usd,
  reason = "",
  lead,
  as: Tag = "span",
  kind = "clip",
}: {
  usd: number | null;
  /** Why the amount is exactly $0; shown under it. */
  reason?: string;
  /** "This week earned" for the week total; the clip line says "Earned". */
  lead?: string;
  as?: ElementType;
  kind?: "clip" | "week";
}) {
  const text = usd === null ? "No money yet" : lead ? moneyPhrase(lead, usd) : earnedLine(usd);
  const guess = usd !== null && usd > 0;
  return (
    <Tag className={`earned-chip${usd === null ? " is-none" : usd === 0 ? " is-zero" : ""}`} data-earned={kind}>
      <span className="earned-chip__line">
        <Icon name="coin" size={16} />
        <span>{text}</span>
        {guess ? <span className="earned-guess">Best guess</span> : null}
      </span>
      {usd === 0 && reason ? <span className="earned-chip__why">{reason}</span> : null}
    </Tag>
  );
}
