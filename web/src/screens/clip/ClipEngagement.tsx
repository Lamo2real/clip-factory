// Clip page › Engagement: the engagement rate the way pros count it, and "How long people watch" from start to end,
// for all apps together (weighted by views) or one app at a time. The maths is lib/engagement.ts.
import { useId, useState } from "react";
import type { ClipPerformance } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { Segmented } from "../../components/ui.tsx";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { compact, full } from "../../lib/metrics.ts";
import { engagedPlatforms, engagement, formatRate, mss, statusWord, watchView, type EngFilter, type EngParts, type WatchView } from "../../lib/engagement.ts";
import { prefersReducedMotion, usePrefs } from "../../lib/prefs.ts";

export function ClipEngagement({ perf }: { perf: ClipPerformance }) {
  const platforms = engagedPlatforms(perf);
  const [picked, setPicked] = useState<EngFilter>("all");
  const prefs = usePrefs();
  const [motion] = useState(() => !prefersReducedMotion());
  const id = useId();
  if (!platforms.length) return null;
  // A tab whose app went away falls back to All.
  const filter: EngFilter = picked === "all" || platforms.includes(picked) ? picked : "all";
  const eng = engagement(perf, filter);
  const watch = watchView(perf, filter);
  const animate = motion && !prefs.reduceMotion;
  const options = [{ value: "all" as EngFilter, label: "All" }, ...platforms.map((p) => ({ value: p as EngFilter, label: PLATFORM_LABEL[p] }))];

  return (
    <section className="perf-eng glass" aria-labelledby={`${id}-t`} data-help="clip-engagement">
      <h2 className="perf-eng__title" id={`${id}-t`}>
        Engagement
      </h2>
      {platforms.length > 1 ? (
        <div className="perf-eng__bar">
          <Segmented value={filter} options={options} onChange={setPicked} label="Show which app" />
        </div>
      ) : null}

      <Score rate={eng.rate} parts={eng.parts} />

      <h3 className="perf-eng__sub">How long people watch</h3>
      <Graph key={filter} watch={watch} durationSec={perf.clip.durationSec} animate={animate} />
    </section>
  );
}

function Score({ rate, parts }: { rate: number | null; parts: EngParts }) {
  const word = rate === null ? null : statusWord(rate);
  const rows: { label: string; value: number }[] = [
    { label: "Likes", value: parts.likes },
    { label: "Comments", value: parts.comments },
    { label: "Shares", value: parts.shares },
    { label: "Saves", value: parts.saves },
    ...(parts.commentsAndShares ? [{ label: "Comments and shares", value: parts.commentsAndShares }] : []),
    { label: "Views", value: parts.views },
  ];
  return (
    <div className="perf-eng__score">
      <p className="perf-eng__rate">
        <span className="perf-eng__num" aria-hidden="true" data-eng="rate">
          {formatRate(rate)}
        </span>
        {word ? (
          <span className="perf-eng__word" aria-hidden="true" data-word={word}>
            {word}
          </span>
        ) : null}
        <span className="sr-only">{rate === null ? "Engagement: no views yet" : `Engagement ${rate.toFixed(1)} percent: ${word}`}</span>
      </p>
      {rate === null ? <p className="perf-eng__line">No views yet</p> : null}
      <details className="cr-fold perf-eng__fold">
        <summary className="cr-fold__q">
          <Icon name="info" size={18} />
          <span>What counts</span>
          <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
        </summary>
        <div className="cr-fold__body">
          <ul className="perf-eng__parts">
            {rows.map((r) => (
              <li key={r.label} className="perf-eng__part">
                <span>{r.label}</span>
                <span className="perf-eng__part-num" aria-hidden="true">
                  {compact(r.value)}
                </span>
                <span className="sr-only">{full(r.value)}</span>
              </li>
            ))}
          </ul>
          <p className="perf-eng__fine">Likes + comments + shares + saves, divided by views. The way pros count it.</p>
          <p className="perf-eng__fine">Each app counts views its own way.</p>
        </div>
      </details>
    </div>
  );
}

function Graph({ watch, durationSec, animate }: { watch: WatchView; durationSec: number; animate: boolean }) {
  if (watch.empty) {
    return watch.note ? (
      <p className="perf-eng__line">{watch.note}</p>
    ) : (
      <p className="perf-eng__empty">
        <Icon name="clock" size={20} />
        Watch data comes in a day or two.
      </p>
    );
  }
  const H = watch.yMax;
  const y = (v: number) => H - Math.max(0, Math.min(H, v));
  const line = watch.curve.map(([px, py], i) => `${i ? "L" : "M"}${px} ${y(py).toFixed(2)}`).join(" ");
  const area = watch.curve.length ? `${line} L${watch.curve.at(-1)![0]} ${H} L${watch.curve[0]![0]} ${H} Z` : "";
  const top = (v: number) => `${(y(v) / H) * 100}%`;
  const drop = watch.drop;
  const markers = watch.markers;
  return (
    <>
      <div className={`perf-eng__graph${animate ? " is-draw" : ""}`}>
        <div className="perf-eng__yaxis" aria-hidden="true">
          <span>{H}%</span>
          <span>{Math.round(H / 2)}%</span>
          <span>0%</span>
        </div>
        <div className="perf-eng__plot">
          <svg className="perf-eng__svg" viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" role="img" aria-label={watch.summary || "How long people watch"}>
            {area ? <path className="perf-eng__area" d={area} /> : null}
            {line ? <path className="perf-eng__line-path" d={line} vectorEffect="non-scaling-stroke" /> : null}
          </svg>
          {markers.map((mk, i) =>
            mk.kind === "line" ? (
              <span key={i} className="perf-eng__vline" style={{ left: `${mk.x}%` }} aria-hidden="true" />
            ) : (
              <span key={i} className="perf-eng__dot" style={{ left: `${mk.x}%`, top: top(mk.y) }} aria-hidden="true" />
            ),
          )}
          {drop ? (
            <>
              <span className="perf-eng__dot is-drop" style={{ left: `${drop.x}%`, top: top(drop.y) }} aria-hidden="true" />
              <span className={`perf-eng__drop${drop.x > 60 ? " is-left" : ""}${drop.y > H * 0.7 ? " is-below" : ""}`} style={{ left: `${drop.x}%`, top: top(drop.y) }} aria-hidden="true">
                Most leave here · {mss(drop.sec)}
              </span>
            </>
          ) : null}
        </div>
        <div className="perf-eng__xaxis" aria-hidden="true">
          <span>0:00</span>
          <span>{mss(durationSec)}</span>
        </div>
      </div>
      {markers.length ? (
        <ul className="perf-eng__keys" aria-label="What each app shares">
          {markers.map((mk, i) => (
            <li key={i} className={`perf-eng__key is-${mk.kind}`}>
              <span className="perf-eng__key-mark" aria-hidden="true">
                <PlatformMark platform={mk.platform} size={14} />
              </span>
              <span aria-hidden="true">{mk.label}</span>
              <span className="sr-only">{mk.spoken}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {watch.curve.length ? (
        <ul className="sr-only" aria-label="Key points">
          <li>{watch.summary}</li>
          {[0, 25, 50, 75, 100].map((q) => {
            const p = watch.curve.find(([x]) => x === q);
            return p ? <li key={q}>{`At ${mss((q / 100) * durationSec)}: ${Math.round(p[1])}% still watching`}</li> : null;
          })}
        </ul>
      ) : null}
      {watch.note ? <p className="perf-eng__line">{watch.note}</p> : null}
    </>
  );
}
