// Settings › Posting › Set up posting (docs/CONTRACTS.md §17.1): a big "2 of 5 ready" ring and a card per platform
// with its own ring and one state line. Tapping a card opens that platform's steps. It is also the setup to-do list's
// home (§17.13): every platform is always here, with Skip (asked first) or Un-skip inside its card.
import { useState } from "react";
import type { Platform } from "../../../api/types.ts";
import { useSession } from "../../../app/session.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { PlatformMark } from "../../../components/PlatformMark.tsx";
import { ProgressRing } from "../../../components/ProgressRing.tsx";
import { SkipConfirm } from "../../../components/SkipConfirm.tsx";
import { A, Button, ErrorPanel, Skeleton } from "../../../components/ui.tsx";
import { progressOf, stateLine } from "../../../lib/setupProgress.ts";
import { isFinished, skippedNote, todoCount, todoRows, todoVisible } from "../../../lib/setupTodo.ts";
import { GUIDES, SETUP_ORDER, timeLine } from "../../../setup/index.ts";
import { Apple, Panel } from "../parts.tsx";
import { CR_SETUP_PATH, crCardLine, crSetupCount, useCr } from "../../../lib/contentRewards.ts";
import { crBridge } from "../../../lib/crConnect.ts";
import { useSetup } from "./useSetup.ts";
import { useSkips } from "./useSkips.ts";

export const setupPath = (p: Platform) => `/settings/posting/setup/${p}`;

export function SetupList() {
  const { data, error, reload } = useSetup();
  const { me } = useSession();
  const { skipped, skip, unskip } = useSkips();
  const [asking, setAsking] = useState<Platform | null>(null);
  const ready = data?.ready ?? 0;
  // The same rows as the floating list (§17.13), so both always agree on what is skipped and what is done.
  const rows = data && me ? todoRows(data.platforms, skipped) : null;
  const count = rows ? todoCount(rows) : null;
  const askingRow = asking ? rows?.find((r) => r.platform === asking) : undefined;
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
      <Panel className="setup-todo-apple">
        <Apple
          id="setup-todo"
          wide
          title={
            !rows || !count
              ? "Checking…"
              : todoVisible(rows)
                ? `On your screen: ${count.finished} of ${count.total} done`
                : "All done: the list is gone"
          }
        />
      </Panel>
      {error && !data ? <ErrorPanel message={error} onRetry={() => void reload()} /> : null}
      <ul className="setup-cards" aria-label="The five platforms">
        {SETUP_ORDER.map((p) => {
          const guide = GUIDES[p];
          const setup = data?.platforms.find((x) => x.platform === p);
          const progress = progressOf(guide, setup);
          const row = rows?.find((r) => r.platform === p);
          const isSkipped = row?.state === "skipped";
          return (
            // One glass card per platform: the link, and under a hairline its Skip or Un-skip line (§17.13).
            <li key={p} className={`setup-card-wrap${data ? " glass" : ""}`}>
              {data ? (
                <A href={setupPath(p)} className={`setup-card${setup?.ready ? " is-ready" : ""}${isSkipped ? " is-skipped" : ""}`} data-platform={p} data-help={`setup-${p}`}>
                  <span className={`setup-card__mark is-${p}`}>
                    <PlatformMark platform={p} size={28} />
                  </span>
                  <span className="setup-card__text">
                    <span className="setup-card__name">{guide.name}</span>
                    {/* Skipped says so here too, the same word as the floating list. */}
                    <span className="setup-card__state">{isSkipped && row ? row.line : stateLine(guide, setup)}</span>
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
              {row && isSkipped ? (
                <p className="setup-card__skip" data-skipped={p}>
                  <span>{skippedNote(p, row.connected)}</span>
                  <Button size="sm" variant="glass" act="undo" aria-label={`Un-skip ${guide.name}`} onClick={() => unskip(p)}>
                    Un-skip
                  </Button>
                </p>
              ) : row && !isFinished(row) ? (
                <p className="setup-card__skip" data-skip={p}>
                  <span>Want to do it later?</span>
                  <Button size="sm" variant="ghost" aria-label={`Skip ${guide.name}`} onClick={() => setAsking(p)}>
                    Skip
                  </Button>
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <CrCardPart />
      {asking ? (
        <SkipConfirm
          platform={asking}
          connected={!!askingRow?.connected}
          onKeep={() => setAsking(null)}
          onSkip={() => {
            setAsking(null);
            return skip(asking);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * "Get paid by brands" (§38.3): one glass card for Content Rewards, apart from the five platforms. It never joins the
 * "2 of 5 ready" ring, the count or the floating setup list. An API from before §38 (404): nothing here at all.
 */
function CrCardPart() {
  const cr = useCr();
  if (cr.state === "missing" || cr.state === "loading") return null;
  const conn = cr.state === "ok" ? cr.data.connection : (cr.data?.connection ?? null);
  const n = crSetupCount(conn);
  const soon = cr.state === "soon";
  return (
    <section className="cr-part" aria-labelledby="cr-part-title">
      <h2 className="setup-part__title cr-part__title" id="cr-part-title">
        Get paid by brands
      </h2>
      <ul className="setup-cards" aria-label="Get paid by brands">
        <li className="setup-card-wrap glass">
          {soon ? (
            <div className="setup-card is-soon" data-help="cr-setup-card">
              <span className="setup-card__mark cr-mark" aria-hidden="true">
                <Icon name="coin" size={28} />
              </span>
              <span className="setup-card__text">
                <span className="setup-card__name">Content Rewards</span>
                <span className="setup-card__state">Coming soon</span>
              </span>
            </div>
          ) : (
            <A href={CR_SETUP_PATH} className={`setup-card cr-card${n === 3 ? " is-cr-ready" : ""}`} data-cr="card" data-help="cr-setup-card">
              <span className="setup-card__mark cr-mark" aria-hidden="true">
                <Icon name="coin" size={28} />
              </span>
              <span className="setup-card__text">
                <span className="setup-card__name">Content Rewards</span>
                <span className="setup-card__state">{crCardLine(conn, !!crBridge())}</span>
                <span className="setup-card__time">About 10 minutes · Free</span>
              </span>
              <ProgressRing value={n / 3} size={48} stroke={6} label="Content Rewards progress">
                {n === 3 ? <Icon name="check" size={18} /> : null}
              </ProgressRing>
              <Icon name="chevronRight" size={20} className="icon setup-card__go" />
            </A>
          )}
        </li>
      </ul>
    </section>
  );
}
