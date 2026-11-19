// Money per clip (docs/CONTRACTS.md §27.4): the owner's posted clips for the picked apps and days, the biggest
// earner first, each a whole-row link to its clip page. Only YouTube reports money per video; every other app says
// "Not shared", never a guess. Views are each post's views so far.
import { useEffect, useRef, useState } from "react";
import { api, friendlyMessage } from "../../api/index.ts";
import type { MoneyClip, MoneyClipLine, MoneyClips, MoneyClipSort } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { A, Button, ErrorPanel, Segmented, Skeleton } from "../../components/ui.tsx";
import { count, PLATFORM_LABEL } from "../../lib/format.ts";
import { formatMoney } from "../../lib/money.ts";
import { clipPeriod, plainShort, SORT_LABEL, type DashChoice } from "../../lib/moneyDash.ts";

const PAGE = 20;
const cache = new Map<string, MoneyClips>();

/** Tests only. */
export function forgetClipCache(): void {
  cache.clear();
}

function views(n: number | null): string {
  return n === null ? "Views not counted yet" : `${count(n)} ${n === 1 ? "view" : "views"} so far`;
}

function Line({ line }: { line: MoneyClipLine }) {
  return (
    <li className="mclip__app" data-app={line.platform} data-money-state={line.moneyState}>
      <span className="mclip__mark" aria-hidden="true">
        <PlatformMark platform={line.platform} size={16} />
      </span>
      <span className="sr-only">{PLATFORM_LABEL[line.platform]}: </span>
      {line.money ? (
        <strong className="mclip__app-money">{formatMoney(line.money.amountMicros, line.money.currency)}</strong>
      ) : (
        <span className="mclip__none">{line.moneyState === "coming_soon" ? "Coming soon" : line.moneyState === "not_reported_yet" ? "None yet" : "Not shared"}</span>
      )}
      <span className="mclip__app-views">{views(line.views)}</span>
    </li>
  );
}

/** The apps that never share money per video, on one line: their marks and "Not shared" (views stay per app). */
function NotShared({ lines }: { lines: MoneyClipLine[] }) {
  if (!lines.length) return null;
  return (
    <li className="mclip__app mclip__app--none" data-money-state="not_shared">
      <span className="mclip__marks" aria-hidden="true">
        {lines.map((l) => (
          <span key={l.platform} className="mclip__mark" data-app={l.platform}>
            <PlatformMark platform={l.platform} size={16} />
          </span>
        ))}
      </span>
      <span className="sr-only">{lines.map((l) => PLATFORM_LABEL[l.platform]).join(", ")}: </span>
      <span className="mclip__none">Not shared</span>
      <span className="mclip__app-views">{lines.map((l) => `${PLATFORM_LABEL[l.platform]} ${l.views === null ? "–" : count(l.views)}`).join(" · ")}</span>
    </li>
  );
}

function Row({ clip }: { clip: MoneyClip }) {
  const total = clip.totals[0];
  const per = clip.platforms.find((l) => l.per1000Views)?.per1000Views;
  return (
    <li className="mclip-item">
      <A href={`/clips/${encodeURIComponent(clip.clipId)}`} className="mclip" data-clip={clip.clipId}>
        <span className="mclip__thumb">
          {clip.coverUrl ? <img src={clip.coverUrl} alt="" loading="lazy" decoding="async" /> : <Icon name="film" size={22} />}
        </span>
        <span className="mclip__mid">
          <span className="mclip__title">{clip.title}</span>
          <ul className="mclip__apps">
            {clip.platforms
              .filter((l) => l.moneyState !== "not_shared")
              .map((l) => (
                <Line key={l.platform} line={l} />
              ))}
            <NotShared lines={clip.platforms.filter((l) => l.moneyState === "not_shared")} />
          </ul>
          <span className="mclip__views">{views(clip.views)}</span>
          {per ? (
            <span className="mclip__per">
              {formatMoney(per.amountMicros, per.currency)} per 1,000 views · {per.tag}
            </span>
          ) : null}
        </span>
        <span className="mclip__total">
          {total ? (
            <>
              <strong className="mclip__total-num">{formatMoney(total.amountMicros, total.currency)}</strong>
              {clip.totals.slice(1).map((t) => (
                <strong key={t.currency} className="mclip__total-more">
                  {formatMoney(t.amountMicros, t.currency)}
                </strong>
              ))}
            </>
          ) : (
            <span className="mclip__none">{clip.platforms.some((l) => l.moneyState === "not_reported_yet" || l.moneyState === "coming_soon") ? "None yet" : "Not shared"}</span>
          )}
          <Icon name="chevronRight" size={18} />
        </span>
      </A>
    </li>
  );
}

export function MoneyClipList({ choice, onSort }: { choice: DashChoice; onSort: (sort: MoneyClipSort) => void }) {
  const period = clipPeriod(choice.period);
  const key = `${choice.apps.join(",")}|${period}|${choice.sort}`;
  const [data, setData] = useState<MoneyClips | null>(() => cache.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    const hit = cache.get(key);
    if (hit) setData(hit);
    setError(null);
    setMoreError(null);
    api()
      .getMoneyClips({ platforms: choice.apps, period, sort: choice.sort, limit: PAGE })
      .then((d) => {
        cache.set(key, d);
        if (mine === seq.current) setData(d);
      })
      .catch((e: unknown) => {
        if (mine === seq.current) setError(friendlyMessage(e));
      });
    // `choice.apps` and `choice.sort` are in `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  async function more() {
    if (!data?.nextCursor) return false;
    setBusy(true);
    setMoreError(null);
    const mine = seq.current;
    try {
      const next = await api().getMoneyClips({ platforms: choice.apps, period, sort: choice.sort, cursor: data.nextCursor, limit: PAGE });
      if (mine !== seq.current) return true;
      const merged = { ...next, clips: [...data.clips, ...next.clips] };
      cache.set(key, merged);
      setData(merged);
      return true;
    } catch (e) {
      setMoreError(friendlyMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const range = period === "all" ? "All time" : `From ${plainShort(data?.from ?? "")}`;
  const sub = data?.to
    ? `${period === "all" ? "Since each clip was posted" : range}, up to ${plainShort(data.to)}. YouTube's estimate.`
    : "Only YouTube shares money per video.";
  return (
    <section className="dash-clips glass" aria-labelledby="dash-clips-title" data-help="money-dash-clips">
      <div className="dash-section-head dash-clips__head">
        <div>
          <h2 className="dash-section-title" id="dash-clips-title">
            Money per clip
          </h2>
          <p className="dash-grey">{data?.note ?? (data ? sub : " ")}</p>
        </div>
        <span className="dash-sort">
          <Segmented label="Sort clips" value={choice.sort} options={(["money", "views"] as const).map((s) => ({ value: s, label: SORT_LABEL[s] }))} onChange={onSort} />
        </span>
      </div>
      {error && !data ? <ErrorPanel message={error} onRetry={() => setNonce((n) => n + 1)} /> : null}
      {!data && !error ? (
        <ul className="mclip-list" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="mclip-item">
              <Skeleton className="mclip-skel" />
            </li>
          ))}
        </ul>
      ) : null}
      {data && !data.clips.length ? <p className="dash-empty-list glass">No posted clips for these apps yet. Clips show here once they're posted.</p> : null}
      {data?.clips.length ? (
        <ul className="mclip-list" aria-label="Clips">
          {data.clips.map((c) => (
            <Row key={c.clipId} clip={c} />
          ))}
        </ul>
      ) : null}
      {moreError ? <ErrorPanel message={moreError} onRetry={() => void more()} /> : null}
      {data?.nextCursor && !moreError ? (
        <div className="dash-more">
          <Button icon="plus" act="add" loading={busy} onClick={more}>
            Show more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
