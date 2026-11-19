// The floating "Set up posting" to-do list (docs/CONTRACTS.md §17.13), mounted once in the signed-in shell. One row
// per platform with Set up and Skip. It stays on screen until every platform is ready or skipped (and confirmed),
// then celebrates and slides away; it comes back when a platform needs the owner again.
//
// Where it sits: wide screens (1440 px and up, where every page still has the room its layout was made for) keep it
// open in a column of its own at the top right, which the page leaves free, so it never covers anything. Smaller
// screens (and a clip's page, which needs the whole width) show a pill at the top right in a strip the page also
// leaves free. Once the page scrolls, that strip turns into a glass bar the page slides under, so the pill is always
// there and never sits on a control. Tapping it opens the list.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { Platform } from "../api/types.ts";
import { useSession } from "../app/session.tsx";
import { burst } from "../lib/confetti.ts";
import { useMedia } from "../lib/hooks.ts";
import { prefersReducedMotion } from "../lib/prefs.ts";
import { useRoute } from "../lib/router.ts";
import {
  doneLine,
  isFinished,
  staleSkips,
  TODO_CELEBRATE_MS,
  TODO_COLLAPSED_KEY,
  TODO_RAIL_QUERY,
  TODO_SEEN_KEY,
  todoCount,
  todoHiddenOn,
  todoNoRailOn,
  todoRows,
  todoVisible,
  type TodoRow,
} from "../lib/setupTodo.ts";
import { sounds } from "../lib/sounds.ts";
import { GUIDES } from "../setup/index.ts";
import { useSetup } from "../screens/settings/setup/useSetup.ts";
import { useSkips } from "../screens/settings/setup/useSkips.ts";
import { Icon } from "./Icon.tsx";
import { PlatformMark } from "./PlatformMark.tsx";
import { ProgressRing } from "./ProgressRing.tsx";
import { trapTab } from "./Sheet.tsx";
import { SkipConfirm } from "./SkipConfirm.tsx";
import { Button, LinkButton } from "./ui.tsx";

/** How long the "All set!" card takes to slide away. */
const LEAVE_MS = 520;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* private mode: this device forgets */
    }
  },
};

type Phase = "list" | "celebrate" | "leaving" | "gone";

/** Focus is on something of the list (a row's button, the pill, the panel), which is about to go away with it. */
const inTodo = (el: Element | null) => !!el?.closest(".setup-todo, .setup-todo-scrim");

export function SetupTodo() {
  const { data, error, reload } = useSetup();
  const { me } = useSession();
  const { skipped, skip, unskip, drop } = useSkips();
  const route = useRoute();
  const wide = useMedia(TODO_RAIL_QUERY);
  // Only once both the setups and the settings are known: deciding early would flash the list or celebrate wrongly.
  const ready = !!data && !!me;
  const rows = useMemo(() => (ready && data ? todoRows(data.platforms, skipped) : null), [ready, data, skipped]);
  const visible = todoVisible(rows);
  const [collapsed, setCollapsed] = useState(() => store.get(TODO_COLLAPSED_KEY) === "1");
  // The page the panel was opened on. It is open only there, so a page change closes it in that same render
  // (Set up just went to the platform's page) and the page's own focus move is not held back.
  const page = JSON.stringify(route);
  const [openOn, setOpenOn] = useState<string | null>(null);
  const [asking, setAsking] = useState<Platform | null>(null);
  const [phase, setPhase] = useState<Phase>("gone");
  // The list was on this device's screen the last time it looked, so it very likely still is: its room is kept from
  // the first paint (`decided` turns true once the setups are in), and the page does not jump when it arrives.
  const [expected] = useState(() => store.get(TODO_SEEN_KEY) === "1");
  const [decided, setDecided] = useState(false);
  const shown = useRef(false);
  const keepFocus = useRef(false);
  const card = useRef<HTMLElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const path = typeof location === "undefined" ? "" : location.pathname;
  const hiddenHere = todoHiddenOn(path);
  // The open column is for wide screens, except on pages that need the whole width (a clip's five columns).
  const railHere = wide && !todoNoRailOn(path);
  const rail = railHere && !collapsed;
  const mode = rail ? "rail" : "pill";
  const open = !railHere && openOn === page;
  const scrolled = useScrolled(phase !== "gone" && mode === "pill" && !hiddenHere);
  usePillRoom(pill, phase !== "gone" && mode === "pill" && !hiddenHere);

  // Open → shown; finished after being shown (here, or on an earlier visit on this device) → celebrate, then leave.
  useEffect(() => {
    if (!rows) return;
    setDecided(true);
    if (visible) {
      shown.current = true;
      store.set(TODO_SEEN_KEY, "1");
      setPhase("list");
      return;
    }
    if (shown.current || store.get(TODO_SEEN_KEY) === "1") {
      shown.current = false;
      store.set(TODO_SEEN_KEY, null);
      keepFocus.current = inTodo(document.activeElement);
      setOpenOn(null);
      setAsking(null);
      setPhase("celebrate");
      sounds.play("success");
      requestAnimationFrame(() => {
        const r = card.current?.getBoundingClientRect();
        burst(r ? { x: r.left + r.width / 2, y: r.top + Math.min(r.height, 80) } : undefined, 110);
      });
      return;
    }
    setPhase("gone");
    // `rows` changes identity with the data; what matters is whether the list is open and that data is in.
  }, [visible, rows === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // The keyboard's place was on the list (the last Skip, the panel) and went away with it: it moves to the page, so
  // the next Tab starts there instead of at the top of the document. The "All set!" card is a status, read out anyway.
  useLayoutEffect(() => {
    if (phase !== "celebrate" || !keepFocus.current) return;
    keepFocus.current = false;
    const now = document.activeElement;
    if (!now || now === document.body || !now.isConnected || inTodo(now)) document.getElementById("main")?.focus({ preventScroll: true });
  }, [phase]);

  useEffect(() => {
    if (phase !== "celebrate" && phase !== "leaving") return;
    const t = setTimeout(
      () => setPhase(phase === "celebrate" ? "leaving" : "gone"),
      phase === "celebrate" ? (prefersReducedMotion() ? TODO_CELEBRATE_MS / 2 : TODO_CELEBRATE_MS) : prefersReducedMotion() ? 0 : LEAVE_MS,
    );
    return () => clearTimeout(t);
  }, [phase]);

  // A skipped platform that is ready now is no longer skipped (so if it stops being ready, its row comes back).
  const stale = rows ? staleSkips(rows, skipped).join(",") : "";
  useEffect(() => {
    if (stale) void drop(stale.split(",") as Platform[]);
  }, [stale, drop]);

  // The list lives for the whole visit, so it asks again on every page change: what the owner just did on a setup
  // page shows here even when no live update arrives (live `setup` events are the fast path, §17.4). The panel that
  // was open on the page before is forgotten, so coming back to that page does not open it again.
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) {
      firstPage.current = false;
      return;
    }
    setOpenOn(null);
    void reload();
  }, [page, reload]);

  const toggleCollapsed = useCallback((next: boolean) => {
    setCollapsed(next);
    store.set(TODO_COLLAPSED_KEY, next ? "1" : null);
  }, []);

  const closePanel = useCallback(() => {
    setOpenOn(null);
    requestAnimationFrame(() => pill.current?.focus({ preventScroll: true }));
  }, []);

  // Only the confirmed answer saves; asking changes nothing.
  const confirmSkip = useCallback(
    (p: Platform) => {
      setAsking(null);
      return skip(p);
    },
    [skip],
  );

  if (!rows || !decided) {
    // Still loading: only the room. (If the setups could not be read, the page takes its room back.)
    return expected && !hiddenHere && !error ? <aside className="setup-todo setup-todo--hold" data-mode={mode} aria-hidden="true" /> : null;
  }
  if (phase === "gone") return null;
  if (phase === "list" && hiddenHere) return null;

  const { finished, total } = todoCount(rows);
  // The bar is the strip that takes the taps; its glass is a child that runs on a little below it and melts into the
  // page there, so the soft edge never takes a tap meant for what shows through it.
  const bar = (
    <div className={`setup-todo-bar${scrolled ? " is-scrolled" : ""}`} aria-hidden="true">
      <div className="setup-todo-bar__glass glass" />
    </div>
  );

  if (phase !== "list") {
    // Where the list was on screen its room stays until the card has left (the page moves once, afterwards); on the
    // setup pages, which had no list, the card floats over the page and takes no room, so the page does not jump.
    const doneMode = hiddenHere ? "done" : mode;
    return (
      <>
        {doneMode === "pill" ? bar : null}
        <aside
          ref={card}
          className={`setup-todo setup-todo--done glass glass--green${phase === "leaving" ? " is-leaving" : ""}`}
          data-mode={doneMode}
          aria-label="Set up posting"
          role="status"
        >
          <span className="setup-todo__done-icon" aria-hidden="true">
            <Icon name="checkCircle" size={26} />
          </span>
          <span className="setup-todo__done-text">
            <strong>All set!</strong>
            <span>{doneLine(rows)}</span>
          </span>
        </aside>
      </>
    );
  }

  const list = <TodoList rows={rows} onSkip={setAsking} onUnskip={unskip} />;
  const askingRow = asking ? rows.find((r) => r.platform === asking) : undefined;
  const confirm = asking ? (
    <SkipConfirm platform={asking} connected={!!askingRow?.connected} onKeep={() => setAsking(null)} onSkip={() => confirmSkip(asking)} />
  ) : null;

  if (rail) {
    return (
      <>
        <aside ref={card} className="setup-todo setup-todo--rail glass glass--refract" data-mode="rail" aria-labelledby="setup-todo-title">
          <TodoHead finished={finished} total={total} titleId="setup-todo-title">
            <button type="button" className="icon-btn setup-todo__fold" aria-label="Make the setup list small" onClick={() => toggleCollapsed(true)}>
              <Icon name="minus" size={20} />
            </button>
          </TodoHead>
          <TodoScroll>
            {list}
            <p className="setup-todo__foot">It goes away when each one is done or skipped.</p>
          </TodoScroll>
        </aside>
        {confirm}
      </>
    );
  }

  return (
    <>
      {bar}
      <aside ref={card} className="setup-todo setup-todo--pill" data-mode="pill" aria-label="Set up posting">
        <button
          ref={pill}
          type="button"
          className="setup-todo__pill glass"
          aria-label={`Set up posting: ${finished} of ${total} done`}
          aria-expanded={railHere ? false : open}
          aria-controls={open ? "setup-todo-panel" : undefined}
          onClick={() => {
            if (railHere) return toggleCollapsed(false);
            setOpenOn((on) => (on === page ? null : page));
          }}
        >
          <span aria-hidden="true" className="setup-todo__pill-ring">
            <ProgressRing value={finished / total} size={30} stroke={4} label={`${finished} of ${total} done`} />
          </span>
          <span className="setup-todo__pill-word" aria-hidden="true">
            Set up posting
          </span>
          <span className="setup-todo__pill-count" aria-hidden="true">
            {finished}/{total}
          </span>
        </button>
      </aside>
      {open ? (
        <TodoPanel onClose={closePanel} finished={finished} total={total}>
          {list}
        </TodoPanel>
      ) : null}
      {confirm}
    </>
  );
}

function TodoHead({ finished, total, titleId, children }: { finished: number; total: number; titleId: string; children?: ReactNode }) {
  return (
    <div className="setup-todo__head">
      <ProgressRing value={finished / total} size={46} stroke={6} label={`${finished} of ${total} done`}>
        {finished}/{total}
      </ProgressRing>
      <div className="setup-todo__titles">
        <h2 className="setup-todo__title" id={titleId}>
          Set up posting
        </h2>
        <p className="setup-todo__lede">Connect each place once. Then clips post by themselves.</p>
      </div>
      {children}
    </div>
  );
}

/**
 * The rows' own scroller (the head stays put). When more is below than fits, its bottom fades out, so a short screen
 * shows that the list goes on.
 */
function TodoScroll({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const sized = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    sized?.observe(el);
    for (const child of Array.from(el.children)) sized?.observe(child);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      sized?.disconnect();
    };
  }, []);
  return (
    <div ref={box} className={`setup-todo__scroll${more ? " has-more" : ""}`}>
      {children}
    </div>
  );
}

/**
 * The list over the page on smaller screens: a glass panel dropping from the pill, closed by ×, Escape or a tap
 * outside. It is a real dialog, like Ask's sheet on a phone (§19.8): the page behind it is inert and Tab goes round
 * inside it until it closes.
 */
function TodoPanel({ onClose, finished, total, children }: { onClose: () => void; finished: number; total: number; children: ReactNode }) {
  const id = useId();
  const scrim = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // A layout effect, so the page is usable again in the same commit that closes the panel: whoever moves focus to
  // the page next (a page change, "All set!") finds it ready.
  useLayoutEffect(() => {
    const changed: HTMLElement[] = [];
    // Everything beside the panel and beside each of its ancestors; messages stay tappable (they sit above it).
    for (let el: HTMLElement | null = scrim.current; el && el !== document.body; el = el.parentElement) {
      for (const sib of Array.from(el.parentElement?.children ?? [])) {
        if (sib === el || !(sib instanceof HTMLElement) || sib.hasAttribute("inert")) continue;
        if (sib.matches("script, style, .toasts, .sheet-scrim, .confetti")) continue;
        sib.setAttribute("inert", "");
        changed.push(sib);
      }
    }
    return () => {
      for (const el of changed) el.removeAttribute("inert");
    };
  }, []);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>(".setup-todo__close")?.focus({ preventScroll: true });
  }, []);
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    trapTab(e, box.current);
  };
  return (
    <div ref={scrim} className="setup-todo-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} id="setup-todo-panel" className="setup-todo-panel glass" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} onKeyDown={keys}>
        <TodoHead finished={finished} total={total} titleId={`${id}-t`}>
          <button type="button" className="icon-btn setup-todo__close" aria-label="Close the setup list" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </TodoHead>
        <TodoScroll>
          {children}
          <p className="setup-todo__foot">It goes away when each one is done or skipped. It is always in Settings › Posting.</p>
        </TodoScroll>
      </div>
    </div>
  );
}

function TodoList({ rows, onSkip, onUnskip }: { rows: TodoRow[]; onSkip: (p: Platform) => void; onUnskip: (p: Platform) => Promise<boolean> }) {
  return (
    <ul className="setup-todo__rows" aria-label="Places to set up">
      {rows.map((row) => {
        const name = GUIDES[row.platform].name;
        const finished = isFinished(row);
        return (
          <li key={row.platform} className={`todo-row is-${row.state}`} data-platform={row.platform} data-state={row.state}>
            <span className={`todo-row__mark is-${row.platform}`} aria-hidden="true">
              <PlatformMark platform={row.platform} size={20} />
              {row.state === "ready" ? (
                <span className="todo-row__tick">
                  <Icon name="check" size={12} />
                </span>
              ) : null}
            </span>
            <span className="todo-row__text">
              <span className="todo-row__name">{name}</span>
              <span className="todo-row__state">{row.line}</span>
            </span>
            {row.state === "ready" ? null : (
              <span className="todo-row__actions">
                <LinkButton href={`/settings/posting/setup/${row.platform}`} size="sm" variant="action" className="todo-row__go" aria-label={`Set up ${name}`}>
                  Set up
                </LinkButton>
                {finished ? (
                  <Button size="sm" variant="ghost" act="undo" className="todo-row__unskip" aria-label={`Un-skip ${name}`} onClick={() => onUnskip(row.platform)}>
                    Un-skip
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" className="todo-row__skip" aria-label={`Skip ${name}`} onClick={() => onSkip(row.platform)}>
                    Skip
                  </Button>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * True once the page has scrolled at all: the pill's strip then shows its glass bar, so whatever slides up the page
 * passes under the bar instead of under the bare pill (it never has to step aside).
 */
/**
 * Tells the page how wide the pill is (`--todo-pill-w` on <html>), so the title row the pill shares from 940 px leaves
 * it room (docs/CONTRACTS.md §11.1). Runs before paint, so the title never draws under the pill first.
 */
function usePillRoom(pill: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const el = pill.current;
    if (!active || !el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const set = () => root.style.setProperty("--todo-pill-w", `${Math.ceil(el.getBoundingClientRect().width)}px`);
    set();
    const watch = new ResizeObserver(set);
    watch.observe(el);
    return () => {
      watch.disconnect();
      root.style.removeProperty("--todo-pill-w");
    };
  });
}

function useScrolled(active: boolean): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!active) {
      setScrolled(false);
      return;
    }
    const check = () => setScrolled(window.scrollY > 0);
    check();
    window.addEventListener("scroll", check, { passive: true });
    return () => window.removeEventListener("scroll", check);
  }, [active]);
  return scrolled;
}
