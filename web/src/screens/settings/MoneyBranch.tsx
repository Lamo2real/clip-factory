// Settings › Posting › Money (docs/CONTRACTS.md §25): only money an app reports. The old per-1,000-view guesses (§21)
// are gone; the real cards arrive with the money collector.
import { Panel, Apple } from "./parts.tsx";

export function MoneyBranch() {
  return (
    <Panel>
      <Apple id="money-soon" wide>
        <p className="muted">No guesses here any more. Real money from each app shows up here soon.</p>
      </Apple>
    </Panel>
  );
}
