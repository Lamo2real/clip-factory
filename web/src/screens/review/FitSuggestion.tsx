// Review › a normal clip that could earn (docs/CONTRACTS.md §39.3): one quiet glass line under Checks before posting,
// "This clip could earn money on FaZe Clips.", with "Make a FaZe Clips copy" and "Not now". Both are optional: Upload
// stays the vermilion and the two-tap upload of the normal way is untouched. Shown only when the API names a
// suggestion (a campaign he is in whose fit can be copied and whose source is fine), and only while it waits in Review.
import { useState } from "react";
import type { CampaignFit } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { Button } from "../../components/ui.tsx";
import { isNotNow, saveNotNow, softText } from "../../lib/crFit.ts";
import { copyReady, making, type CopyState } from "./CampaignFit.tsx";

export const couldEarn = (name: string) => `This clip could earn money on ${name}.`;

/** "I'd make a copy with its logo, “Paid partnership” and #Ad. This one stays as it is." (no logo: without it). */
export function copyWords(fit: Pick<CampaignFit, "items" | "required">): string {
  const logo = fit.items.some((i) => i.rule === "logo");
  const disclosure = fit.required.disclosure || "#Ad";
  return `I'd make a copy with ${logo ? "its logo, " : ""}“Paid partnership” and ${disclosure}. This one stays as it is.`;
}

export function FitSuggestion({
  clipId,
  fit,
  copy = "none",
  onCopy,
  busy = false,
}: {
  clipId: string;
  fit: CampaignFit;
  copy?: CopyState;
  /** Sends the copy with the soft stops shown (that tap is his acceptance, like "Make clips anyway"). */
  onCopy: (campaignAnyway: string[]) => unknown;
  busy?: boolean;
}) {
  const [hidden, setHidden] = useState(() => isNotNow(clipId));
  if (hidden && copy === "none") return null;
  const name = fit.campaignName;
  const soft = softText(fit);
  return (
    <section className="cr-suggest glass" data-help="cr-review-strip cr-fit-suggest" aria-label={couldEarn(name)}>
      <p className="cr-suggest__title">
        <Icon name="coin" size={18} />
        <span>{couldEarn(name)}</span>
      </p>
      {copy === "making" ? (
        <p className="cr-suggest__line" role="status">
          {making(name)}
        </p>
      ) : copy === "ready" ? (
        <p className="cr-suggest__line is-ok" role="status">
          {copyReady(name)}
        </p>
      ) : (
        <>
          <p className="cr-suggest__line">{copyWords(fit)}</p>
          {soft ? <p className="cr-suggest__line">{soft}</p> : null}
          <div className="cr-suggest__actions">
            <Button variant="glass" icon="scissors" loading={busy} onClick={() => onCopy(fit.softCodes)}>
              {`Make a ${name} copy`}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                saveNotNow(clipId);
                setHidden(true);
              }}
            >
              Not now
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
