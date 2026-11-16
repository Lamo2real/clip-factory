// Settings › Posting › Set up posting (docs/CONTRACTS.md §17.1): a big "2 of 5 ready" ring and a card per platform
// with its own ring and one state line. Tapping a card opens that platform's steps.
import type { Platform } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { PlatformMark } from "../../../components/PlatformMark.tsx";
import { ProgressRing } from "../../../components/ProgressRing.tsx";
import { A, ErrorPanel, Skeleton } from "../../../components/ui.tsx";
import { progressOf, stateLine } from "../../../lib/setupProgress.ts";
import { GUIDES, SETUP_ORDER, timeLine } from "../../../setup/index.ts";
import { Apple, Panel } from "../parts.tsx";
import { useSetup } from "./useSetup.ts";

export const setupPath = (p: Platform) => `/settings/posting/setup/${p}`;

export function SetupList() {
  const { data, error, reload } = useSetup();
  const ready = data?.ready ?? 0;
  return (
    <>
      <Panel className="setup-summary">
        <Apple
          id="setup-posting"
          wide
          title={data ? `${ready} of 5 ready` : "Checking…"}
          aside={
            <ProgressRing value={ready / 5} size={58} label={`${ready} of 5 platforms ready`} className="setup-summary__ring">
              {ready}/5
            </ProgressRing>
          }
        />
      </Panel>
      {error && !data ? <ErrorPanel message={error} onRetry={() => void reload()} /> : null}
      <ul className="setup-cards" aria-label="The five platforms">
        {SETUP_ORDER.map((p) => {
          const guide = GUIDES[p];
          const setup = data?.platforms.find((x) => x.platform === p);
          const progress = progressOf(guide, setup);
          return (
            <li key={p}>
              {data ? (
                <A href={setupPath(p)} className={`setup-card glass${setup?.ready ? " is-ready" : ""}`} data-platform={p} data-help={`setup-${p}`}>
                  <span className={`setup-card__mark is-${p}`}>
                    <PlatformMark platform={p} size={28} />
                  </span>
                  <span className="setup-card__text">
                    <span className="setup-card__name">{guide.name}</span>
                    <span className="setup-card__state">{stateLine(guide, setup)}</span>
                    <span className="setup-card__time">{timeLine(guide)}</span>
                  </span>
                  <ProgressRing value={progress.fraction} size={48} stroke={6} label={`${guide.name} progress`}>
                    {setup?.ready ? <Icon name="check" size={18} /> : null}
                  </ProgressRing>
                  <Icon name="chevronRight" size={20} className="icon setup-card__go" />
                </A>
              ) : (
                <Skeleton className="setup-card-skel" />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
