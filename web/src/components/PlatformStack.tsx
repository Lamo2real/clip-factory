// One platform's numbers for a clip (docs/CONTRACTS.md §16.8): its mark and name, a status chip, the big number,
// only the fields that platform really gives, a sparkline, how fresh the numbers are, and a link to the post.
// A platform with nothing to show gets one calm line and one link instead of a wall of dashes. TikTok's stack says what
// the owner's Mac is doing (§47.4) when the page passes its row: its one button sits in the page's actions.
import type { ReactNode, Ref } from "react";
import type { PlatformPerformance, SeriesPoint } from "../api/types.ts";
import { PLATFORM_LABEL } from "../lib/format.ts";
import { STATUS_LABEL, ago, calmCopy, metricGroups, reactionParts, until, zeroViewsNote, type CalmContext, type MetricRow } from "../lib/metrics.ts";
import type { FacebookExtra } from "../api/types.ts";
import { Icon } from "./Icon.tsx";
import { PlatformMark } from "./PlatformMark.tsx";
import { Sparkline } from "./Sparkline.tsx";
import { LinkButton, Pill, type Tone } from "./ui.tsx";
import { formatMoney } from "../lib/money.ts";
import { autoPerfLabel, isPrivateTest } from "../lib/autopost.ts";
import { macChip, type TikTokRow } from "../lib/tiktokMac.ts";
import type { Clip } from "../api/types.ts";

const CHIP_TONE: Record<PlatformPerformance["status"], Tone> = {
  posted: "success",
  posted_private: "neutral",
  waiting_for_connection: "neutral",
  posting: "neutral",
  failed: "vermilion",
  not_posted: "neutral",
  mac: "neutral",
};

function Rows({ rows, reactions }: { rows: MetricRow[]; reactions?: Record<string, number> }) {
  const parts = reactionParts(reactions);
  return (
    <ul className="pstack__rows">
      {rows.map((r) => (
        <li key={r.key} className="pstack__row">
          <Icon name={r.icon} size={16} />
          <span className="pstack__label">{r.label}</span>
          <span className="pstack__value">{r.value}</span>
          {r.key === "reactions" && parts.length ? (
            <span className="pstack__reactions">{parts.map((p) => `${p.name} ${p.count}`).join(" · ")}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const insightsAgo = (iso: string, now: number) => {
  const a = ago(iso, now);
  return a === "just now" ? "Insights just in" : `Insights from ${a}`;
};

export function PlatformStack({
  perf,
  series,
  best,
  index,
  now,
  ref,
  auto,
  row,
  context,
  action,
}: {
  perf: PlatformPerformance;
  series?: SeriesPoint[];
  best: boolean;
  index: number;
  now: number;
  ref?: Ref<HTMLElement>;
  /** The clip's `auto` (§46.9): its posts say "· by auto-posting"; a Private test one has no numbers (§46.8). */
  auto?: Clip["auto"];
  /** TikTok's row (lib/tiktokMac.ts tiktokRow): the calm line says its words; its button is on the page. */
  row?: TikTokRow | null;
  /** What the clip page knows around this stack (Where clips go, a start that never happened, Try again here). */
  context?: CalmContext;
  /** This place's own button under its calm line (the clip page's Try again for a post that didn't work). */
  action?: ReactNode;
}) {
  const name = PLATFORM_LABEL[perf.platform];
  const id = `stack-${perf.platform}`;
  const privateTest = isPrivateTest(perf.status, auto, perf.by);
  const calm = privateTest ? null : calmCopy(perf, perf.platform === "tiktok" ? row : null, { ...context, now });
  const groups = !privateTest && !calm && perf.metrics ? metricGroups(perf.platform, perf.metrics) : null;
  const reactions = (perf.metrics?.extra as FacebookExtra | undefined)?.reactions;
  const wait = until(perf.nextAllowedAt, now);
  const zero = groups ? zeroViewsNote(perf, now) : null;

  return (
    <section
      ref={ref}
      className={`pstack is-${perf.platform}`}
      aria-labelledby={id}
      data-stack={perf.platform}
      style={{ ["--i" as string]: index }}
    >
      <div className={`pstack__card glass is-${perf.status}${best ? " is-best" : ""}`}>
        <header className="pstack__head">
          <span className={`pstack__mark is-${perf.platform}`}>
            <PlatformMark platform={perf.platform} size={20} />
          </span>
          <h2 className="pstack__name" id={id} tabIndex={-1} title={name} aria-label={best ? `${name}, best` : undefined}>
            {name}
          </h2>
          {best ? (
            <span className="pstack__crown" title="Best" aria-hidden="true">
              <Icon name="crown" size={18} />
            </span>
          ) : null}
        </header>
        <div className="pstack__chip">
          <Pill tone={CHIP_TONE[perf.status]} icon={perf.status === "failed" ? "alert" : perf.status === "posted" ? "checkCircle" : undefined}>
            {perf.status === "mac" && perf.mac
              ? macChip(perf.mac, perf.platform === "tiktok" ? row : null)
              : perf.via === "mac"
                ? "Posted by your Mac"
                : autoPerfLabel(perf.status, perf.platform, auto, perf.by, STATUS_LABEL[perf.status])}
          </Pill>
        </div>

        {calm ? (
          <div className="pstack__calm">
            <p className="pstack__calm-text">
              {calm.spinner ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
              <span className="user-text">{calm.text}</span>
            </p>
            {calm.link ? (
              <LinkButton href={calm.link.href} size="sm" iconAfter="chevronRight" className="pstack__calm-link">
                {calm.link.label}
              </LinkButton>
            ) : null}
            {action}
          </div>
        ) : groups ? (
          <>
            <p className="pstack__top">
              <span className="pstack__big" aria-hidden="true" data-metric="top">
                {groups.top.value}
              </span>
              <span className="pstack__toplabel" aria-hidden="true">
                {groups.top.label}
              </span>
              <span className="sr-only">{groups.top.spoken}</span>
            </p>
            {zero ? <p className="pstack__hint">{zero}</p> : null}
            {groups.fast.length ? <Rows rows={groups.fast} /> : null}
            {groups.slow ? (
              <div className="pstack__slow">
                <p className="pstack__note">
                  <Icon name="clock" size={14} />
                  <span>{groups.slow.note}</span>
                </p>
                {groups.slow.rows.length ? <Rows rows={groups.slow.rows} reactions={reactions} /> : null}
                {perf.insightsUpdatedAt ? <p className="pstack__ago">{insightsAgo(perf.insightsUpdatedAt, now)}</p> : null}
              </div>
            ) : null}
            {perf.revenue ? (
              // §25.3: only money the platform itself reported, with its estimate tag. Hidden otherwise.
              <p className="pstack__money" data-reported-money={perf.platform}>
                <Icon name="coin" size={16} />
                <span>
                  {perf.revenue.tag} for this clip: <strong>{formatMoney(perf.revenue.amountMicros, perf.revenue.currency)}</strong>
                </span>
              </p>
            ) : null}
            <Sparkline series={series} best={best} />
          </>
        ) : null}

        <div className="pstack__foot">
          {perf.refreshing ? (
            <p className="pstack__ago" role="status">
              <span className="spinner spinner--sm" aria-hidden="true" /> Checking now…
            </p>
          ) : perf.updatedAt ? (
            <p className="pstack__ago">Updated {ago(perf.updatedAt, now)}</p>
          ) : null}
          {wait && !perf.refreshing && perf.status === "posted" ? <p className="pstack__ago">Next check in {wait}</p> : null}
          {perf.final ? <p className="pstack__ago">Final numbers (30 days)</p> : null}
          {perf.url ? (
            <a className="pstack__open text-link" href={perf.url} target="_blank" rel="noopener noreferrer">
              Open on {name}
              <Icon name="external" size={15} />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}
