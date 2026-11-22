// The campaign finder's card at the top of the Campaigns page (docs/CONTRACTS.md §41.1): "Find campaigns", one line
// from the overview's `finder` (no extra call), and a glass "Find campaigns". It is the page's vermilion only in the
// §38.4 empty state (Content Rewards signed in, no campaign, the box empty; §41.6 change 1).
import type { CrFinderSummary } from "../../api/types.ts";
import { LinkButton } from "../../components/ui.tsx";
import { FIND_PATH, entryLine } from "../../lib/finder.ts";

export function FinderEntry({ summary, primary }: { summary: CrFinderSummary; primary: boolean }) {
  const fresh = summary.on && summary.started && summary.newCount > 0;
  return (
    <section className="finder-entry glass" data-help="cr-finder-entry" aria-labelledby="finder-entry-title">
      <div className="finder-entry__text">
        <h2 className="cr-section__title" id="finder-entry-title">
          Find campaigns
          {fresh ? (
            <span className="pill pill--success finder-new">
              <span className="pill__text">New</span>
            </span>
          ) : null}
        </h2>
        <p className="finder-entry__line">{entryLine(summary)}</p>
      </div>
      <LinkButton href={FIND_PATH} variant={primary ? "primary" : "glass"} size={primary ? "lg" : "md"} icon="search" data-help-clear={primary ? "" : undefined}>
        Find campaigns
      </LinkButton>
    </section>
  );
}
