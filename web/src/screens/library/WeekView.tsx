// Library › This week (docs/CONTRACTS.md §16.8): one week's clips, most views first, each with a big "Best this
// week" star. Stars change on the spot and are saved together 800 ms after the last tap (one request); Clip Factory
// then learns from the picks and the learning appears here, live.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, friendlyMessage } from "../../api/index.ts";
import type { Platform, WeekClip, WeekView as Week } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, ActGlyph, Empty, ErrorPanel, LinkButton, Skeleton } from "../../components/ui.tsx";
import { PLATFORM_LABEL, plural } from "../../lib/format.ts";
import { useLiveEvents } from "../../lib/live.ts";
import { applyWeekEvent } from "../../lib/liveCache.ts";
import { STATS_ORDER, compact, full } from "../../lib/metrics.ts";
import { useAction } from "../../lib/motion.ts";
import { navigate } from "../../lib/router.ts";
import { useSession } from "../../app/session.tsx";
import { clipEarnings, sumUsd, zeroReason, type ClipEarnings } from "../../lib/earnings.ts";
import { EarnedChip } from "../../components/EarnedChip.tsx";
import { compareWeeks, isWeek, isoWeek, shiftWeek, weekLabel, weekRange } from "../../lib/week.ts";

/** Picks are saved this long after the last star tap, as one request. */
export const SAVE_DELAY_MS = 800;
export const MAX_PICKS = 10;

const weekHref = (week: string, current: string) =>
  week === current ? "/library?view=week" : `/library?view=week&week=${encodeURIComponent(week)}`;

export function WeekView({ week: asked }: { week: string | null }) {
  const current = isoWeek(new Date());
  const valid = asked === null || isWeek(asked);
  const week = asked && valid ? asked : current;
  const isCurrent = week === current;
  const range = weekRange(week);
  const toast = useToast();
  const { me } = useSession();

  const [data, setData] = useState<Week | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The picks the owner sees; differ from data.clipIds until saved.
  const [picks, setPicks] = useState<string[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef(false);
  const pending = useRef<string[] | null>(null);
  // Stars whose save failed (they were put back): their cards shake once per failure (§20.5).
  const [failed, setFailed] = useState<{ n: number; ids: string[] }>({ n: 0, ids: [] });
  const earlierAct = useAction("prev");
  const laterAct = useAction("next");
  // The newest week's "Later week" tap (§20.11): a 4 px nudge the way the arrow points and back (the `nudge` kind in
  // motion.css), no shake and no deny; the info toast says why. The glyph shows whichever motion was tapped last.
  const laterNudge = useAction("nudge");
  const [nudged, setNudged] = useState(false);

  const load = useCallback(async () => {
    try {
      const w = await api().getWeek(week, range.from, range.to);
      setData(w);
      setError(null);
    } catch (e) {
      setError(friendlyMessage(e));
    }
  }, [week, range.from, range.to]);

  useEffect(() => {
    if (valid) void load();
  }, [load, valid]);

  useLiveEvents(
    (e) => {
      const local = pending.current !== null || saving.current;
      setData((d) => (d ? applyWeekEvent(d, e, local) : d));
    },
    () => void load(),
  );

  // The server's picks show unless the owner has taps of their own still waiting to be saved.
  const serverPicks = data?.clipIds.join(",");
  useEffect(() => {
    if (serverPicks !== undefined && pending.current === null && !saving.current) setPicks(serverPicks ? serverPicks.split(",") : []);
  }, [serverPicks]);

  // A learning finished but its text did not come with it: fetch the week once.
  const missingText = data?.learnState === "done" && !data.learning;
  useEffect(() => {
    if (missingText) void load();
  }, [missingText, load]);

  const save = useCallback(async () => {
    const ids = pending.current;
    if (ids === null || saving.current) return;
    pending.current = null;
    saving.current = true;
    try {
      const w = await api().saveWeekBest(week, { ...range, clipIds: ids });
      setData((d) => (d ? { ...w, learning: w.learning ?? (w.learnState === "done" ? d.learning : undefined) } : w));
      toast.success("Saved. Clip Factory will learn from your picks.", { group: "picks" });
    } catch (e) {
      toast.error(`${friendlyMessage(e)} Your stars were put back.`);
      const saved = data?.clipIds ?? [];
      const changed = [...ids.filter((x) => !saved.includes(x)), ...saved.filter((x) => !ids.includes(x))];
      setFailed((f) => ({ n: f.n + 1, ids: changed }));
      setPicks(saved);
    } finally {
      saving.current = false;
      // More taps while that was saving: save the newest picks too.
      if (pending.current !== null) void save();
    }
  }, [week, range, toast, data?.clipIds]);

  // Leaving the page with unsaved stars: save them now rather than drop them.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(
    () => () => {
      if (pending.current !== null) {
        clearTimeout(timer.current);
        void saveRef.current();
      }
    },
    [],
  );

  /** Stars or unstars a clip; false when it could not (the toast says why). */
  function toggle(clipId: string): boolean {
    // The newest taps first: quick taps can come before the screen has drawn the last one.
    const now = pending.current ?? picks ?? data?.clipIds ?? [];
    const on = !now.includes(clipId);
    if (on && now.length >= MAX_PICKS) {
      toast.error(`You can star up to ${MAX_PICKS} clips a week. Take a star off another clip first.`);
      return false;
    }
    const next = on ? [...now, clipId] : now.filter((id) => id !== clipId);
    setPicks(next);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
    return true;
  }

  if (!valid) {
    return (
      <Empty icon="alert" title="That week does not look right" action={<LinkButton href="/library?view=week" variant="primary" icon="star">Go back to This week</LinkButton>}>
        The link may be old or have a typo.
      </Empty>
    );
  }

  const earlier = shiftWeek(week, -1);
  const later = shiftWeek(week, 1);
  const laterOff = isCurrent || compareWeeks(later, current) > 0;
  const shown = picks ?? data?.clipIds ?? [];
  const money = weekMoney(data, me?.settings);

  return (
    <section className="week" aria-labelledby="week-title">
      <div className="week__head">
        <A
          href={weekHref(earlier, current)}
          className="week__arrow icon-btn glass"
          aria-label="Earlier week"
          data-act="prev"
          onClick={() => earlierAct.play()}
        >
          <ActGlyph act={earlierAct}>
            <Icon name="chevronLeft" size={22} />
          </ActGlyph>
        </A>
        <h2 className="week__title display-3" id="week-title">
          {isCurrent ? (
            <>
              This week <span className="week__dates">· {weekLabel(week)}</span>
            </>
          ) : (
            <>
              Week of <span className="week__dates">{weekLabel(week)}</span>
            </>
          )}
        </h2>
        <button
          type="button"
          className="week__arrow icon-btn glass"
          aria-label="Later week"
          aria-disabled={laterOff || undefined}
          data-act="next"
          onClick={() => {
            if (laterOff) {
              setNudged(true);
              laterNudge.play();
              return;
            }
            navigate(weekHref(later, current));
            setNudged(false);
            laterAct.play();
          }}
          onClickCapture={() => {
            if (laterOff) toast.info("This is the newest week. Tap the left arrow to see earlier weeks.", { group: "week-arrow" });
          }}
        >
          <ActGlyph act={nudged ? laterNudge : laterAct}>
            <Icon name="chevronRight" size={22} />
          </ActGlyph>
        </button>
      </div>

      {/* Only above clips: on an empty week "Star the clips…" would ask for something that is not there. */}
      {data && data.clips.length > 0 ? <LearnLine week={data} current={isCurrent} /> : null}

      {error && !data ? <ErrorPanel message={error} onRetry={() => void load()} /> : null}
      {!data && !error ? <Skeleton className="review-skel" /> : null}
      {data && data.clips.length === 0 ? (
        <Empty
          icon="star"
          title={isCurrent ? "No clips this week yet" : "No clips that week"}
          action={
            <LinkButton href="/" variant="primary" icon="scissors">
              Make clips
            </LinkButton>
          }
        >
          {isCurrent ? "No clips this week yet. Make clips on Home." : "Nothing was posted that week. Tap the arrows to look at another week."}
        </Empty>
      ) : null}
      {data && data.clips.length > 0 ? (
        <>
          <div className="week__money">
            <p className="week__count" aria-live="polite">
              {plural(data.clips.length, "clip")} · {shown.length ? `${plural(shown.length, "star")}` : "no stars yet"}
            </p>
            {money.total !== null ? <EarnedChip as="p" kind="week" usd={money.total} reason={money.reason} lead={isCurrent ? "This week earned" : "That week earned"} /> : null}
          </div>
          <ol className="week-list">
            {data.clips.map((c, i) => (
              <li key={c.clip.clipId}>
                <WeekCard
                  item={c}
                  earned={money.byClip.get(c.clip.clipId) ?? null}
                  rank={i + 1}
                  on={shown.includes(c.clip.clipId)}
                  onToggle={() => toggle(c.clip.clipId)}
                  failShot={failed.ids.includes(c.clip.clipId) ? failed.n : 0}
                />
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}

function LearnLine({ week, current }: { week: Week; current: boolean }) {
  if (week.learnState === "learning")
    return (
      <p className="week__learn" role="status">
        <span className="spinner" aria-hidden="true" />
        Learning from your picks…
      </p>
    );
  if (week.learnState === "done" && week.learning)
    return (
      <figure className="week__quote glass glass--sage" role="status">
        <figcaption className="week__quote-label">
          <Icon name="sparkle" size={18} />
          Best of week
        </figcaption>
        <blockquote className="week__quote-text user-text">{week.learning.text}</blockquote>
      </figure>
    );
  if (week.learnState === "failed")
    return (
      <p className="week__learn is-failed" role="status">
        <Icon name="alert" size={18} />
        Could not learn this time. Change a pick to try again.
      </p>
    );
  return (
    <p className="week__learn" role="status">
      <Icon name="star" size={18} />
      {current ? "Star the clips that did best this week." : "Star the clips that did best that week."}
    </p>
  );
}

/** The apps a clip is on, in the usual order, with their views (null while the first numbers are on the way). */
export function weekApps(item: Pick<WeekClip, "views">): { platform: Platform; views: number | null }[] {
  return STATS_ORDER.filter((p) => p in item.views).map((p) => ({ platform: p, views: item.views[p] ?? null }));
}

/** The app with the most views (none when nothing has views yet). */
export function bestApp(apps: { platform: Platform; views: number | null }[]): Platform | null {
  let best: { platform: Platform; views: number } | null = null;
  for (const a of apps) if (a.views !== null && a.views > 0 && (!best || a.views > best.views)) best = { platform: a.platform, views: a.views };
  return best?.platform ?? null;
}

/**
 * Each clip's money guess and the week's total (§21), from the view count each app pays for (`paidViews`, falling
 * back to `views` on an older server); the order and Best this week are untouched.
 */
export function weekMoney(week: Pick<Week, "clips"> | null, settings: Parameters<typeof clipEarnings>[2]) {
  const byClip = new Map<string, ClipEarnings | null>();
  for (const c of week?.clips ?? []) {
    const views = c.paidViews ?? c.views;
    byClip.set(c.clip.clipId, Object.keys(views).length ? clipEarnings(views, c.clip.durationSec, settings) : null);
  }
  const all = [...byClip.values()];
  const total = sumUsd(all.map((e) => e?.usd));
  return { byClip, total, reason: total === 0 ? zeroReason(all.flatMap((e) => e?.platforms ?? [])) : "" };
}

function WeekCard({
  item,
  earned,
  rank,
  on,
  onToggle,
  failShot,
}: {
  item: WeekClip;
  /** The clip's money guess; null when it is on no app yet. */
  earned: ClipEarnings | null;
  rank: number;
  on: boolean;
  onToggle: () => boolean;
  /** Bumps when saving this card's star failed and it was put back. */
  failShot: number;
}) {
  const { clip } = item;
  const star = useAction("star");
  const { fail } = star;
  useEffect(() => {
    // The error toast already played the deny sound.
    if (failShot > 0) fail({ sound: false });
  }, [failShot, fail]);
  const id = `wk-${clip.clipId}`;
  const apps = weekApps(item);
  const top = bestApp(apps);
  return (
    <article className={`week-card glass${on ? " is-best" : ""}`} aria-labelledby={id}>
      {/* The list is an <ol>, so the position is already announced; the big number is for the eyes. */}
      <span className="week-card__rank" aria-hidden="true">
        {rank}
      </span>
      <A href={`/clips/${clip.clipId}`} className="week-card__cover" tabIndex={-1} aria-hidden="true">
        {clip.coverUrl ? <img src={clip.coverUrl} alt="" loading="lazy" /> : null}
      </A>
      <div className="week-card__body">
        <h3 className="week-card__hook clamp-2 user-text" id={id}>
          <A href={`/clips/${clip.clipId}`} className="week-card__link">
            {clip.hook}
          </A>
        </h3>
        <p className="week-card__views">
          {item.posted ? (
            <>
              <span className="week-card__num" aria-hidden="true">
                {compact(item.totals.views)}
              </span>
              <span className="sr-only">{full(item.totals.views)}</span> views
              {apps.length ? <span className="week-card__apps"> · on {plural(apps.length, "app")}</span> : null}
            </>
          ) : (
            "Not posted yet"
          )}
        </p>
        {apps.length ? <EarnedChip as="p" usd={earned?.usd ?? null} reason={earned?.reason} /> : null}
        {apps.length ? (
          <ul className="week-card__marks" aria-label="Views on each app">
            {apps.map(({ platform: p, views: v }) => (
              <li key={p} className={`week-card__mark${p === top ? " is-best" : ""}`} data-platform={p}>
                <PlatformMark platform={p} size={16} />
                <span className="sr-only">{PLATFORM_LABEL[p]}: </span>
                <span aria-hidden="true">{v === null ? "soon" : compact(v)}</span>
                <span className="sr-only">{v === null ? "numbers soon" : `${full(v)} views`}</span>
                {p === top ? <span className="sr-only">, best</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <button
        type="button"
        className={`star-btn star-btn--card glass glass--sage${on ? " is-on" : ""}`}
        aria-pressed={on}
        aria-label="Best this week"
        aria-describedby={id}
        data-help="best-star"
        data-help-dodge=""
        data-act="star"
        onClick={() => {
          if (onToggle()) star.play();
          else star.fail({ sound: false });
        }}
      >
        <ActGlyph act={star}>
          <Icon name="star" size={26} fill={on ? "currentColor" : "none"} />
        </ActGlyph>
        <span className="star-btn__word" aria-hidden="true">
          Best
        </span>
      </button>
    </article>
  );
}
