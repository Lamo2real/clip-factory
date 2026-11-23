// Clips Funded › series pieces the screens share (docs/CONTRACTS.md §45.43): the "All ▾" switch at the head of Ideas,
// Production, Review and Library (which series a page shows: the address holds it, `?series=`, so nothing is ever
// hidden by a remembered filter), the "Series:" field of Make a new video, and the Move button (a sheet with each
// series and No series, then one confirm). The list of series is read once per workspace and shared by every piece on
// the page (useSeriesList); with no series in the workspace the switch and the field are not shown at all.
import "../styles/sd-series.css";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useToast } from "../../components/Toasts.tsx";
import { storiesApi } from "../api/client.ts";
import type { Series } from "../api/types.ts";
import { StIcon } from "../ui.tsx";
import { StSheet } from "./kit.tsx";
import { say } from "./words.ts";

/** Which videos a page shows: every one, the ones in no series, or one series' (its id). */
export type SeriesFilter = "all" | "none" | string;

// ---------- The shared list ----------

const lists = new Map<string, Series[]>();
const reading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function told(): void {
  for (const f of listeners) f();
}

function read(ws: string): Promise<void> {
  const busy = reading.get(ws);
  if (busy) return busy;
  const p = Promise.resolve()
    .then(() => storiesApi().listSeries(ws))
    .then((list) => {
      if (Array.isArray(list)) lists.set(ws, list);
      told();
    })
    .catch(() => undefined) // no list: the switch is simply not shown
    .finally(() => reading.delete(ws));
  reading.set(ws, p);
  return p;
}

/** Tells every switch, field and page that the series changed (made, renamed, deleted, an item moved). */
export function seriesChanged(ws: string): Promise<void> {
  reading.delete(ws);
  return read(ws);
}

/** Puts one series as it is now into the shared list (after a create or a change), without a read. */
export function rememberSeries(s: Series): void {
  const now = lists.get(s.workspaceId) ?? [];
  lists.set(s.workspaceId, now.some((x) => x.seriesId === s.seriesId) ? now.map((x) => (x.seriesId === s.seriesId ? s : x)) : [s, ...now]);
  told();
}

/** Takes a deleted series out of the shared list. */
export function forgetSeries(ws: string, seriesId: string): void {
  lists.set(
    ws,
    (lists.get(ws) ?? []).filter((x) => x.seriesId !== seriesId),
  );
  told();
}

/** Test hook: forget every list read so far. */
export function resetSeriesLists(): void {
  lists.clear();
  reading.clear();
}

/** The workspace's series (newest first), read when the first piece mounts and again on each mount. */
export function useSeriesList(ws: string): { list: Series[] | null; reload: () => void } {
  const list = useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => lists.get(ws) ?? null,
  );
  useEffect(() => {
    void read(ws);
  }, [ws]);
  return { list, reload: () => void seriesChanged(ws) };
}

/** The API's `seriesId` query for a filter: all → none sent, "none" → "none", an id → that id. */
export function seriesQuery(v: SeriesFilter): string | undefined {
  return v === "all" ? undefined : v;
}

/** The page's filter: no `seriesId` in the address is All. */
export function filterOf(page: { seriesId?: string }): SeriesFilter {
  return page.seriesId ?? "all";
}

/** Whether an item (its `seriesId`) is shown under a filter: "none" also catches a series that is gone. */
export function inFilter(item: { seriesId?: string | null }, v: SeriesFilter, list: Series[] | null): boolean {
  if (v === "all") return true;
  if (v === "none") return !item.seriesId || (list !== null && !list.some((s) => s.seriesId === item.seriesId));
  return item.seriesId === v;
}

function nameOf(v: SeriesFilter, list: Series[]): string {
  if (v === "all") return "All";
  if (v === "none") return "No series";
  return list.find((s) => s.seriesId === v)?.name ?? "All";
}

function Caret() {
  return (
    <svg className="st-series-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** One big choice in a series sheet: the chosen one is marked. */
function Choice({ on, label, line, onPick }: { on: boolean; label: string; line?: string; onPick: () => void }) {
  return (
    <li>
      <button type="button" className={`st-series-choice${on ? " is-on" : ""}`} aria-pressed={on} onClick={onPick}>
        <span className="st-series-choice__name">{label}</span>
        {line ? <span className="st-series-choice__line">{line}</span> : null}
      </button>
    </li>
  );
}

function episodesLine(s: Series): string {
  const n = s.episodes.length;
  return n === 0 ? "No episodes yet" : n === 1 ? "1 episode" : `${n} episodes`;
}

// ---------- The switch ----------

/** "All ▾": which series this page shows. Not shown while the workspace has no series. */
export function SeriesSwitch({ ws, value, onChange }: { ws: string; value: SeriesFilter; onChange: (v: SeriesFilter) => void }) {
  const { list } = useSeriesList(ws);
  const [open, setOpen] = useState(false);
  if (!list || list.length === 0) return null;
  const pick = (v: SeriesFilter) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };
  return (
    <>
      <button type="button" className={`st-pill st-series-switch${value !== "all" ? " is-set" : ""}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span className="st-pill__icon" aria-hidden="true">
          <StIcon name="folder" size={18} />
        </span>
        <span className="st-s-sr">Show series: </span>
        <span className="st-series-switch__name">{nameOf(value, list)}</span>
        <Caret />
      </button>
      {open ? (
        <StSheet title="Show series" onClose={() => setOpen(false)} className="st-series-sheet">
          <ul className="st-series-choices">
            <Choice on={value === "all"} label="All" onPick={() => pick("all")} />
            {list.map((s) => (
              <Choice key={s.seriesId} on={value === s.seriesId} label={s.name} line={episodesLine(s)} onPick={() => pick(s.seriesId)} />
            ))}
            <Choice on={value === "none"} label="No series" onPick={() => pick("none")} />
          </ul>
        </StSheet>
      ) : null}
    </>
  );
}

// ---------- The field on Make a new video ----------

/** "Series: [No series ▾]": the series a new video goes in. Not shown while the workspace has no series. */
export function SeriesField({ ws, value, onChange }: { ws: string; value: string | null; onChange: (id: string | null, s: Series | null) => void }) {
  const { list } = useSeriesList(ws);
  const [open, setOpen] = useState(false);
  if (!list || list.length === 0) return null;
  const chosen = value ? (list.find((s) => s.seriesId === value) ?? null) : null;
  const pick = (s: Series | null) => {
    setOpen(false);
    if ((s?.seriesId ?? null) !== value) onChange(s?.seriesId ?? null, s);
  };
  return (
    <div className="st-series-field">
      <span className="st-series-field__label" id={`st-series-field-${ws}`}>
        Series:
      </span>
      <button type="button" className={`st-pill st-series-switch${chosen ? " is-set" : ""}`} aria-haspopup="dialog" aria-describedby={`st-series-field-${ws}`} onClick={() => setOpen(true)}>
        <span className="st-pill__icon" aria-hidden="true">
          <StIcon name="folder" size={18} />
        </span>
        <span className="st-s-sr">Series: </span>
        <span className="st-series-switch__name">{chosen?.name ?? "No series"}</span>
        <Caret />
      </button>
      {open ? (
        <StSheet title="Which series?" onClose={() => setOpen(false)} className="st-series-sheet">
          <ul className="st-series-choices">
            {list.map((s) => (
              <Choice key={s.seriesId} on={value === s.seriesId} label={s.name} line={episodesLine(s)} onPick={() => pick(s)} />
            ))}
            <Choice on={!chosen} label="No series" line="Just this one video" onPick={() => pick(null)} />
          </ul>
        </StSheet>
      ) : null}
    </div>
  );
}

// ---------- Move ----------

/**
 * "Move": a sheet with each series and No series, then one confirm. An idea moves with PATCH …/ideas/{id}, a video with
 * PUT …/stories/{id}/series. Not shown while there is no series to move it to and it is in none.
 */
export function MoveToSeries({
  ws,
  kind,
  id,
  title,
  current,
  onMoved,
}: {
  ws: string;
  kind: "idea" | "story";
  id: string;
  title: string;
  current: string | null;
  onMoved: (seriesId: string | null) => void;
}) {
  const toast = useToast();
  const { list } = useSeriesList(ws);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Series | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!list || (list.length === 0 && !current)) return null;

  const close = () => {
    setOpen(false);
    setTarget(undefined);
    setProblem(null);
  };

  async function move() {
    if (busy || target === undefined) return;
    setBusy(true);
    setProblem(null);
    const to = target?.seriesId ?? null;
    try {
      if (kind === "idea") await storiesApi().patchIdea(ws, id, { seriesId: to });
      else await storiesApi().moveStoryToSeries(ws, id, to);
      onMoved(to);
      toast.success(target ? `Moved to ${target.name}.` : "Moved out of the series.");
      close();
      void seriesChanged(ws);
    } catch (e) {
      setProblem(say(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="st-btn st-s-small st-series-move" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <StIcon name="folder" size={18} />
        Move<span className="st-s-sr">{` “${title}”`}</span>
      </button>
      {open ? (
        <StSheet
          title={target === undefined ? "Move to" : "Move?"}
          onClose={close}
          className="st-series-sheet"
          actions={
            target === undefined ? undefined : (
              <>
                <button type="button" className="st-btn" onClick={() => setTarget(undefined)}>
                  Cancel
                </button>
                <button type="button" className="st-btn st-btn--main" aria-disabled={busy || undefined} onClick={() => void move()}>
                  {busy ? "Moving…" : "Move"}
                </button>
              </>
            )
          }
        >
          {target === undefined ? (
            <ul className="st-series-choices">
              {list
                .filter((s) => s.seriesId !== current)
                .map((s) => (
                  <Choice key={s.seriesId} on={false} label={s.name} line={episodesLine(s)} onPick={() => setTarget(s)} />
                ))}
              {current ? <Choice on={false} label="No series" onPick={() => setTarget(null)} /> : null}
            </ul>
          ) : (
            <>
              <p className="st-series-confirm">{target ? `Move “${title}” to ${target.name}?` : "Move it out of the series?"}</p>
              {problem ? (
                <p className="st-series-problem" role="alert">
                  {problem}
                </p>
              ) : null}
            </>
          )}
        </StSheet>
      ) : null}
    </>
  );
}
