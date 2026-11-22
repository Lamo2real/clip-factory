import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent } from "react";
import { useSession } from "../app/session.tsx";
import { Glide } from "./Glide.tsx";
import { setPrefs, usePrefs } from "../lib/prefs.ts";
import { navigate, section, useHash, useRoute } from "../lib/router.ts";
import { storiesEnabled } from "../stories/flag.ts";
import type { Workspace } from "../stories/api/types.ts";
import { prefetchStoriesApp, useAppActive } from "../stories/pane.tsx";
import {
  currentChoice,
  followReading,
  knownWorkspaces,
  onWorkspacesChange,
  readingPlace,
  rememberClipsPath,
  restoreScroll,
  saveClipsScroll,
  saveStoriesScroll,
  setKnownWorkspaces,
  settleSwitch,
  switcherName,
  switchTarget,
  takeClipsScroll,
} from "../stories/workspace.ts";
import { plural } from "../lib/format.ts";
import { useDeletedJobs } from "../lib/jobDeletes.ts";
import { useInstall } from "../lib/pwa.ts";
import { LiveDot } from "./LiveDot.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { A } from "./ui.tsx";

interface Item {
  key: "home" | "jobs" | "review" | "library" | "money" | "settings";
  href: string;
  label: string;
  icon: IconName;
}

const ITEMS: Item[] = [
  { key: "home", href: "/", label: "Home", icon: "home" },
  { key: "jobs", href: "/jobs", label: "Jobs", icon: "layers" },
  { key: "review", href: "/review", label: "Review", icon: "review" },
  { key: "library", href: "/library", label: "Library", icon: "library" },
  { key: "money", href: "/money", label: "Money", icon: "coin" },
  { key: "settings", href: "/settings", label: "Settings", icon: "settings" },
];

function useNavState() {
  const route = useRoute();
  const { me } = useSession();
  const active = section(route);
  // A job deleted here comes off the counts at once, until the server's own counts include it (§34.5).
  const gone = useDeletedJobs();
  const review = Math.max(0, (me?.counts.review ?? 0) - gone.reviewClips);
  const running = Math.max(0, (me?.counts.running ?? 0) - gone.working);
  const accessible = (item: Item) =>
    item.key === "review" && review > 0 ? `${item.label}, ${plural(review, "clip")} waiting` : item.label;
  return { active, review, running, accessible };
}

function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="badge" aria-hidden="true">
      {n > 99 ? "99+" : n}
    </span>
  );
}

// .act-turn gives the span its own box (motion.css); only the angle is set here.
const TURN = { "--act-turn": "180deg" } as CSSProperties;
const FLIP: CSSProperties = { display: "inline-grid", transform: "rotate(180deg)" };

/** Larger screens: a glass sidebar that folds down to icons. The choice is remembered on this device. */
export function Sidebar() {
  const { active, review, running, accessible } = useNavState();
  const { sidebarCollapsed } = usePrefs();
  const { installed } = useInstall();
  return (
    <nav className={`sidebar glass glass--refract${sidebarCollapsed ? " is-collapsed" : ""}`} aria-label="Main">
      <div className="sidebar__top">
        <button
          type="button"
          className="icon-btn sidebar__toggle"
          aria-expanded={!sidebarCollapsed}
          aria-controls="sidebar-list"
          aria-label={sidebarCollapsed ? "Expand menu" : "Collapse menu"}
          data-tip={sidebarCollapsed ? "Expand menu" : undefined}
          onClick={() => setPrefs({ sidebarCollapsed: !sidebarCollapsed })}
        >
          {/* §20.11: state-driven, no shot. The wrapper turns 180° with aria-expanded (240 ms, instant under reduced
              motion); the panel glyph is drawn pre-turned so it still reads the right way round when open. */}
          <span className="act-turn sidebar__turn" style={TURN} aria-hidden="true">
            {sidebarCollapsed ? (
              <Icon name="menu" />
            ) : (
              <span style={FLIP}>
                <Icon name="sidebar" />
              </span>
            )}
          </span>
        </button>
        <A href="/" className="brand" aria-label="Clip Factory home">
          <span className="brand__mark" aria-hidden="true">
            C<span className="brand__dot" />
          </span>
          <span className="brand__name">
            Clip <em>Factory</em>
          </span>
        </A>
        <WorkspaceSwitch place="sidebar-top" collapsed={sidebarCollapsed} />
      </div>
      <ul className="sidebar__list" id="sidebar-list">
        <Glide active=".sidebar__item.is-active" className="glide--menu" as="li" />
        {ITEMS.map((item) => (
          <li key={item.key}>
            <A
              href={item.href}
              className={`sidebar__item${active === item.key ? " is-active" : ""}`}
              data-help={`nav-${item.key}`}
              aria-current={active === item.key ? "page" : undefined}
              aria-label={sidebarCollapsed ? accessible(item) : undefined}
              data-tip={sidebarCollapsed ? item.label : undefined}
            >
              <span className="sidebar__icon">
                <Icon name={item.icon} />
                {sidebarCollapsed && item.key === "review" ? <Badge n={review} /> : null}
              </span>
              <span className="sidebar__label">{item.label}</span>
              {!sidebarCollapsed && item.key === "review" && review > 0 ? (
                <span className="sidebar__count" aria-label={`${plural(review, "clip")} waiting`}>
                  {review}
                </span>
              ) : null}
            </A>
          </li>
        ))}
      </ul>
      <div className="sidebar__foot">
        <WorkspaceSwitch place="sidebar" collapsed={sidebarCollapsed} />
        <span className="sidebar__live">
          <LiveDot compact={sidebarCollapsed} />
        </span>
        {!installed ? (
          <A
            href="/get-app"
            className={`sidebar__item sidebar__getapp${active === "get_app" ? " is-active" : ""}`}
            aria-current={active === "get_app" ? "page" : undefined}
            aria-label={sidebarCollapsed ? "Get the app" : undefined}
            data-tip={sidebarCollapsed ? "Get the app" : undefined}
          >
            <span className="sidebar__icon">
              <Icon name="download" />
            </span>
            <span className="sidebar__label">Get the app</span>
          </A>
        ) : null}
        {running > 0 ? (
          <A href="/jobs" className="sidebar__status" data-tip={sidebarCollapsed ? `${plural(running, "job")} working` : undefined} aria-label={`${plural(running, "job")} working`}>
            <span className="pulse-dot" aria-hidden="true" />
            <span className="sidebar__label">{plural(running, "job")} working</span>
          </A>
        ) : null}
      </div>
    </nav>
  );
}

/** Phones: a floating glass tab bar with icons only. Names are announced to screen readers and shown on hover. */
export function TabBar() {
  const { active, review, accessible } = useNavState();
  return (
    <nav className="tabbar glass glass--refract" aria-label="Main">
      <ul className="tabbar__list">
        <Glide active=".tabbar__item.is-active" className="glide--tabbar" as="li" />
        {ITEMS.map((item) => (
          <li key={item.key} className="tabbar__cell">
            <A
              href={item.href}
              className={`tabbar__item${active === item.key ? " is-active" : ""}`}
              data-help={`nav-${item.key}`}
              aria-current={active === item.key ? "page" : undefined}
              aria-label={accessible(item)}
              title={item.label}
            >
              <Icon name={item.icon} size={24} />
              {item.key === "review" ? <Badge n={review} /> : null}
            </A>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ---------- The workspace switcher (docs/CONTRACTS.md §45.16.1) ----------
// Clip Factory | Lamo Stories, one choice per workspace the server lists (Lamo Clips goes by the app's own name).
// Hidden (nothing in the page at all) while Lamo Stories is switched off. In Lamo Clips it only ever takes space that
// is empty today: the sidebar foot grows up into the free space above it (the live dot, Get the app and the jobs line
// stay put), and the phone top bar uses the room between the brand and the live dot. Where there is not enough room
// it shrinks to one round toggle, and where even that does not fit it becomes a slim toggle that fills the empty gap
// with 4 px of air on each side (it is measured, never guessed), so there is a way across at every size.

/**
 * Where a switcher sits: Lamo Clips' sidebar foot or phone top bar, or Lamo Stories' own rail or top bar. In a folded
 * sidebar too short for the foot's toggle (a window under about 570 px tall), "sidebar-top": a slim toggle beside the
 * fold button, laid over the empty strip on its right (§45.35 D19), so there is one click across at every size.
 */
export type SwitchPlace = "sidebar" | "topbar" | "stories-rail" | "stories-top" | "sidebar-top";

/**
 * bar: the pick bar; corner: a round toggle beside the live dot; round: a round toggle; label: a pill with the
 * icon and the short name; stack: the icon over the short name; slim: an icon-only toggle cut to the empty gap.
 */
type Mode = "bar" | "round" | "corner" | "label" | "stack" | "slim" | "none";
/** squeeze: the phone top bar's brand drops its name so the toggle keeps its full 48 px (§45.36 E16). */
type Measured = { mode: Mode; style?: CSSProperties; squeeze?: boolean };

/** The bar's choices are 44 px tall inside 4 px of padding; the round toggle is 44 px (48 px on phones). */
const OPT_H = 44;
const BAR_PAD = 4;
const ROUND = 44;
const PHONE = 48;
/** Air the switcher keeps from whatever is next to it, so nothing ever touches. */
const AIR = 4;
/** The slim toggle's least size across (WCAG's 24 px target, with room to spare). */
const SLIM_MIN = 28;
/** The name on the phone pill and under the stacked icon (--fs-xs, as glide.css sets it), and their paddings. */
const LABEL_REM = 0.78;
const LABEL_SIDES = 10 + 24 + 6 + 12;
const STACK_SIDES = 12;

let listAsked = false;

/** The server's workspace list, asked once per visit (it also makes the first Lamo Stories workspace). */
function askWorkspaces(): void {
  if (listAsked) return;
  listAsked = true;
  void import("../stories/api/client.ts")
    .then(({ loadStoriesApi }) => loadStoriesApi())
    .then((api) => api.listWorkspaces())
    .then(setKnownWorkspaces)
    .catch(() => {
      // Offline or not built yet: the two default choices stay, and the next visit asks again.
      listAsked = false;
    });
}

function useWorkspaces(): Workspace[] {
  return useSyncExternalStore(onWorkspacesChange, knownWorkspaces, knownWorkspaces);
}

/** "Lamo Stories" → "Stories": the short name the phone control has room for. */
function shortName(w: Workspace): string {
  const name = switcherName(w);
  return name.replace(/^Lamo\s+/i, "") || name;
}

const here = () => location.pathname + location.search + location.hash;

/** The little picture of a workspace on its round toggle: Lamo Stories' sunny face, Lamo Clips' "C". */
function WorkspaceMark({ type, size = 24 }: { type: Workspace["workspaceType"]; size?: number }) {
  if (type === "clips")
    return (
      <svg className="ws-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#EFE7DA" />
        <path d="M15.6 8.2a4.6 4.6 0 1 0 0 7.6" fill="none" stroke="#0F372B" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="17.4" cy="6.2" r="1.6" fill="#E8392B" />
      </svg>
    );
  return (
    <svg className="ws-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="21" height="21" rx="8" fill="#1C1842" />
      <circle cx="8.6" cy="10.4" r="1.7" fill="#FFF6E5" />
      <circle cx="15.4" cy="10.4" r="1.7" fill="#FFF6E5" />
      <path d="M7.8 14.6c2.3 2.4 6.1 2.4 8.4 0" fill="none" stroke="#FFC94A" strokeWidth="2" strokeLinecap="round" />
      <circle cx="18.6" cy="5.4" r="1.6" fill="#FFC94A" />
    </svg>
  );
}

/** A plain left click (not a new tab, not a modified click). */
function plainClick(e: MouseEvent): boolean {
  return !(e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);
}

/**
 * The workspace switcher. `current` is the workspace on screen ("clips" in Lamo Clips' shell, the checked Lamo
 * Stories workspace in Lamo Stories). Renders nothing at all while Lamo Stories is switched off.
 */
export function WorkspaceSwitch({ place, collapsed = false, current = "clips" }: { place: SwitchPlace; collapsed?: boolean; current?: string }) {
  if (!storiesEnabled()) return null;
  return <Switcher place={place} collapsed={collapsed} current={current} />;
}

function Switcher({ place, collapsed, current }: { place: SwitchPlace; collapsed: boolean; current: string }) {
  const list = useWorkspaces();
  // Its app is on screen (Clip Factory's shell stays mounted behind Lamo Stories, §45.34).
  const active = useAppActive();
  const route = useRoute();
  const hash = useHash();
  const inClips = place === "sidebar" || place === "topbar" || place === "sidebar-top";
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<Measured>({ mode: place === "stories-rail" ? "bar" : place === "stories-top" ? "round" : "none" });
  const [menu, setMenu] = useState(false);
  /** A switch a page's "Leave without saving?" is holding: recorded only if the page then really changes to it. */
  const held = useRef<{ w: Workspace; to: string } | null>(null);
  const page = JSON.stringify(route);
  const others = list.filter((w) => w.workspaceId !== current);
  const target = others.length === 1 ? others[0]! : null;
  const nameOnPhone = target ? shortName(target) : "";

  // The workspace list, and Lamo Stories' own chunk while the browser is idle: the first switch waits for neither.
  useEffect(() => {
    if (!inClips) return;
    askWorkspaces();
    prefetchStoriesApp();
  }, [inClips]);

  // Every Lamo Clips page the owner opens is where switching back lands (one tracker: the sidebar's, always mounted).
  // The query counts too: Home at /?campaign=… and Home at / are two ways of the same page.
  const search = typeof location === "undefined" ? "" : location.search;
  useEffect(() => {
    if (place === "sidebar" && route.name !== "stories") rememberClipsPath(here());
  }, [place, page, search, hash, route.name]);

  // A held switch: the owner chose Leave (the page is the switch's target now), or went somewhere else.
  useEffect(() => {
    const h = held.current;
    if (!h) return;
    held.current = null;
    if (here() === h.to) settleSwitch(h.w);
  }, [page, hash]);

  // Back from Lamo Stories: the Clip Factory page opens where the owner left it (its lists may still be loading, so
  // it waits for the page to grow, and lets go as soon as the owner scrolls himself). Also when Clip Factory stayed
  // mounted behind Lamo Stories and comes back on screen. From whichever of Clip Factory's switchers is mounted (the
  // sidebar's and the phone top bar's; the kept place is read once, so only the first one restores it, §45.36 E1).
  useEffect(() => {
    if ((place !== "sidebar" && place !== "topbar") || !active) return;
    const y = takeClipsScroll(here());
    return y === null ? undefined : restoreScroll(y);
  }, [place, active]);

  // On a phone the top bar scrolls away with the page: where the owner was reading is followed, so a switch he
  // scrolled up to reach keeps that place (§45.36 E1).
  const shownInTopbar = place === "topbar" && measured.mode !== "none";
  useEffect(() => (shownInTopbar && active ? followReading(here) : undefined), [shownInTopbar, active]);

  // Measure the room in Lamo Clips' shell and pick the largest form that fits without moving or covering anything.
  useLayoutEffect(() => {
    // Not while its app is hidden (nothing there has a size): it measures again the moment it is back on screen.
    if (!inClips || !active) return;
    const anchor = ref.current;
    if (!anchor) return;
    const count = list.length;
    let frame = 0;
    const measure = () => {
      const next = place === "sidebar" ? sidebarMode(anchor, collapsed, count) : place === "sidebar-top" ? sidebarTopMode(anchor, collapsed, count) : topbarMode(anchor, nameOnPhone);
      setMeasured((m) => (m.mode === next.mode && m.squeeze === next.squeeze && JSON.stringify(m.style) === JSON.stringify(next.style) ? m : next));
    };
    // Again on the next frame too: a late font or a child that just arrived settles its size only after layout.
    const soon = () => {
      measure();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const host = anchor.closest<HTMLElement>(place === "topbar" ? ".topbar" : ".sidebar");
    if (!host) return;
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
    const watch = () => {
      if (!ro) return;
      ro.disconnect();
      ro.observe(host);
      for (const el of Array.from(host.querySelectorAll<HTMLElement>(":scope > *, .sidebar__foot > *, .brand__name, .live-dot"))) if (!anchor.contains(el) && el !== anchor) ro.observe(el);
    };
    watch();
    // The live dot comes and goes, Get the app and the jobs line too: measure again when the children change.
    const mo = new MutationObserver(() => {
      watch();
      soon();
    });
    mo.observe(host, { childList: true, subtree: true });
    window.addEventListener("resize", soon);
    // The brand's and the live dot's own fonts arrive after the first paint and change their widths.
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.addEventListener?.("loadingdone", soon);
    void fonts?.ready?.then(soon);
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", soon);
      fonts?.removeEventListener?.("loadingdone", soon);
    };
  }, [inClips, active, place, collapsed, list.length, nameOnPhone]);

  const go = (w: Workspace) => (e: MouseEvent) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    setMenu(false);
    if (w.workspaceId === current) return;
    const from = here();
    // Leaving Clip Factory: its page's scroll position is kept for the way back (this tab only), and its address as it
    // is right now (a page may have moved it without a page change, as Home's "Which campaign" does), so the way back
    // opens the page the kept screen shows. Leaving Lamo Stories: its own, which StoriesApp puts back when it is on
    // screen again.
    if (inClips) {
      saveClipsScroll(from, place === "topbar" ? readingPlace(from, window.scrollY, Date.now()) : window.scrollY);
      rememberClipsPath(from);
    } else saveStoriesScroll(from, window.scrollY);
    const to = switchTarget(w);
    navigate(to);
    // The choice is recorded only once the page really changed: a page with unsaved typing may be asking "Leave
    // without saving?", and when the owner stays the stored choice must still say where he is.
    if (here() === to) settleSwitch(w);
    else held.current = { w, to };
  };
  const hrefFor = (w: Workspace) => {
    const c = currentChoice();
    if (w.workspaceType === "clips") return c.lastClipsPath;
    return c.lastStoriesWorkspaceId === null || c.lastStoriesWorkspaceId === w.workspaceId ? c.lastStoriesPath : "/stories";
  };
  const here_ = list.find((w) => w.workspaceId === current) ?? list[0]!;
  const { mode, style, squeeze } = measured;
  // The toggle beside the fold button is a slim toggle of the sidebar's (glide.css styles it as the foot's slim one).
  const cls = `ws-switch-host ${place === "sidebar-top" ? "ws-switch-host--sidebar ws-switch-host--sidebar-top" : `ws-switch-host--${place}`}${collapsed ? " is-collapsed" : ""}`;

  if (mode === "none") return <div ref={ref} className={cls} data-ws-switch="none" hidden />;

  if (mode === "bar")
    return (
      <div ref={ref} className={cls} data-ws-switch="bar">
        <div className={`ws-switch${list.length > 2 ? " ws-switch--stack" : ""}`} role="group" aria-label="Workspace">
          <Glide active=".ws-switch__opt.is-on" className="glide--ws" />
          {list.map((w) => (
            <a
              key={w.workspaceId}
              href={hrefFor(w)}
              className={`ws-switch__opt${w.workspaceId === current ? " is-on" : ""}`}
              aria-current={w.workspaceId === current ? "true" : undefined}
              onClick={go(w)}
            >
              {switcherName(w)}
            </a>
          ))}
        </div>
      </div>
    );

  // One toggle (a round one, a pill or a stacked icon with the short name on a roomy phone, or a slim one cut to a
  // narrow gap): straight to the other workspace, or a short list when there are more than two.
  const name = target ? switcherName(target) : "another workspace";
  const label = target ? `Go to ${switcherName(target)}` : `Pick a workspace (now ${switcherName(here_)})`;
  const big = place === "topbar" || place === "stories-top";
  const words = mode === "label" || mode === "stack";
  const kind = `ws-round${big ? " ws-round--phone" : ""}${mode === "label" ? " ws-round--label" : ""}${mode === "stack" ? " ws-round--stack" : ""}${mode === "slim" ? " ws-round--slim" : ""}`;
  const markSize = mode === "slim" ? 20 : mode === "stack" ? 22 : mode === "label" ? 24 : big ? 26 : 24;
  return (
    <div ref={ref} className={cls} data-ws-switch={mode} data-ws-squeeze={squeeze ? "" : undefined} style={style}>
      {target ? (
        <a
          href={hrefFor(target)}
          className={kind}
          aria-label={label}
          data-tip={collapsed ? name : undefined}
          title={collapsed || words ? undefined : name}
          onClick={go(target)}
        >
          <WorkspaceMark type={target.workspaceType} size={markSize} />
          {words ? (
            <span className="ws-round__name" aria-hidden="true">
              {nameOnPhone}
            </span>
          ) : null}
        </a>
      ) : (
        <button type="button" className={kind} aria-label={label} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <WorkspaceMark type={here_.workspaceType} size={markSize} />
        </button>
      )}
      {menu && !target ? (
        <WorkspaceMenu list={list} current={current} hrefFor={hrefFor} go={go} close={() => setMenu(false)} below={place === "sidebar-top"} />
      ) : null}
    </div>
  );
}

/** Where the list opens below its toggle (as glide.css's `.topbar .ws-menu`), left-aligned with it. */
const BELOW = { top: "calc(100% + 8px)", bottom: "auto" } as const;

/**
 * The short list a round toggle opens when there are more than two workspaces: above the toggle, or below it for the
 * toggle beside the fold button (`below`, at the top of the window, where there is no room above).
 */
function WorkspaceMenu({
  list,
  current,
  hrefFor,
  go,
  close,
  below = false,
}: {
  list: Workspace[];
  current: string;
  hrefFor: (w: Workspace) => string;
  go: (w: Workspace) => (e: MouseEvent) => void;
  close: () => void;
  below?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.parentElement?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [close]);
  return (
    <div ref={box} className="ws-menu" role="dialog" aria-label="Pick a workspace" style={below ? BELOW : undefined}>
      <div className="ws-switch ws-switch--stack" role="group" aria-label="Workspace">
        <Glide active=".ws-switch__opt.is-on" className="glide--ws" />
        {list.map((w) => (
          <a key={w.workspaceId} href={hrefFor(w)} className={`ws-switch__opt${w.workspaceId === current ? " is-on" : ""}`} aria-current={w.workspaceId === current ? "true" : undefined} onClick={go(w)}>
            {switcherName(w)}
          </a>
        ))}
      </div>
    </div>
  );
}

function px(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The sidebar foot: the bar when the free space above the foot holds it (the foot is pinned to the bottom, so it grows
 * upwards into that space); else a round toggle beside the live dot (open sidebar) or in the free space (folded);
 * else a slim toggle laid over the empty gap between the menu and the foot (the folded sidebar of a short window);
 * else nothing. Measured without the switcher's own size, so the answer never depends on itself.
 */
export function sidebarMode(anchor: HTMLElement, collapsed: boolean, count: number): Measured {
  const sidebar = anchor.closest<HTMLElement>(".sidebar");
  const foot = anchor.closest<HTMLElement>(".sidebar__foot");
  const list = sidebar?.querySelector<HTMLElement>(".sidebar__list");
  if (!sidebar || !foot || !list || getComputedStyle(sidebar).display === "none") return { mode: "none" };
  const sb = sidebar.getBoundingClientRect();
  if (sb.height === 0) return { mode: "none" };
  const s = getComputedStyle(sidebar);
  const fs = getComputedStyle(foot);
  const footGap = px(fs.rowGap) || 4;
  const inFlow = !anchor.hidden && getComputedStyle(anchor).position !== "absolute";
  const own = inFlow ? anchor.getBoundingClientRect().height + footGap : 0;
  const footRect = foot.getBoundingClientRect();
  const footH = footRect.height - own;
  const bottom = sb.bottom - px(s.paddingBottom);
  const listRect = list.getBoundingClientRect();
  const free = bottom - footH - (listRect.bottom + (px(s.rowGap) || 18));
  const barH = BAR_PAD * 2 + (count > 2 ? count * OPT_H + (count - 1) * 2 : OPT_H);
  if (!collapsed && free >= barH + footGap + AIR) return { mode: "bar" };
  if (!collapsed) {
    // Beside the live dot: its row is wide and the dot is short, so a round toggle fits on its right.
    const row = foot.querySelector<HTMLElement>(".sidebar__live");
    const dot = row?.querySelector<HTMLElement>(".live-dot");
    if (row && dot && getComputedStyle(row).display !== "none") {
      const r = row.getBoundingClientRect();
      const d = dot.getBoundingClientRect();
      const top = d.top + d.height / 2 - ROUND / 2;
      const next = row.nextElementSibling?.getBoundingClientRect();
      const roomRight = r.right - px(getComputedStyle(row).paddingRight) - d.right;
      const above = listRect.bottom + AIR;
      const below = next ? next.top - AIR : bottom;
      if (roomRight >= ROUND + 12 && top >= above && top + ROUND <= below)
        return { mode: "corner", style: { position: "absolute", top: Math.round(top - sb.top), right: Math.round(sb.right - (r.right - px(getComputedStyle(row).paddingRight))) } };
    }
  }
  if (free >= ROUND + footGap + AIR) return { mode: "round" };
  // The empty gap between the last menu item and the foot as it stands (the foot's own top, without the switcher).
  const gap = footRect.bottom - footH - listRect.bottom;
  const h = Math.floor(Math.min(ROUND, gap - 2 * AIR));
  const w = Math.min(ROUND, Math.floor(listRect.width));
  if (h >= SLIM_MIN && w >= SLIM_MIN)
    return {
      mode: "slim",
      style: {
        position: "absolute",
        top: Math.round(listRect.bottom + (gap - h) / 2 - sb.top),
        left: Math.round(listRect.left + (listRect.width - w) / 2 - sb.left),
        width: w,
        height: h,
      },
    };
  return { mode: "none" };
}

/**
 * Beside the fold button (§45.35 D19): only in a folded sidebar whose foot has no room for any toggle (sidebarMode
 * says none, a window under about 570 px tall). Then a slim toggle sits on the right of the fold button, over the
 * empty strip between it and the page (4 px of air on each side, at most 44 px wide, as tall as the fold button),
 * laid over the page so the fold button and everything else stay exactly where they are; else nothing.
 */
export function sidebarTopMode(anchor: HTMLElement, collapsed: boolean, count: number): Measured {
  if (!collapsed) return { mode: "none" };
  const sidebar = anchor.closest<HTMLElement>(".sidebar");
  const foot = sidebar?.querySelector<HTMLElement>(".sidebar__foot .ws-switch-host");
  const toggle = sidebar?.querySelector<HTMLElement>(".sidebar__toggle");
  if (!sidebar || !foot || !toggle || getComputedStyle(sidebar).display === "none") return { mode: "none" };
  if (sidebarMode(foot, collapsed, count).mode !== "none") return { mode: "none" };
  const sb = sidebar.getBoundingClientRect();
  const t = toggle.getBoundingClientRect();
  if (sb.height === 0 || t.height === 0) return { mode: "none" };
  // What is to the right on the fold button's row: the page's own box when it reaches up there, else the window.
  const page = sidebar.parentElement?.querySelector<HTMLElement>(".shell > .main");
  const p = page?.getBoundingClientRect();
  const right = p && p.width > 0 && p.top < t.bottom && p.bottom > t.top && p.left >= t.right ? p.left : window.innerWidth;
  const left = t.right + AIR;
  const w = Math.floor(Math.min(ROUND, right - AIR - left));
  const h = Math.floor(Math.min(ROUND, t.height));
  if (w < SLIM_MIN || h < SLIM_MIN) return { mode: "none" };
  // Placed from the sidebar's padding box (inside its 1 px edge), where an absolute child starts.
  return {
    mode: "slim",
    style: {
      position: "absolute",
      top: t.top + (t.height - h) / 2 - (sb.top + sidebar.clientTop),
      left: left - (sb.left + sidebar.clientLeft),
      width: w,
      height: h,
      zIndex: 1,
    },
  };
}

let ruler: CanvasRenderingContext2D | null | undefined;

/** How wide `text` is in the page's own font at `rem` (600 weight), or null when the browser cannot say. */
function textWidth(text: string, rem: number, family: string): number | null {
  if (ruler === undefined) {
    try {
      ruler = document.createElement("canvas").getContext("2d");
    } catch {
      ruler = null;
    }
  }
  if (!ruler) return null;
  const root = px(getComputedStyle(document.documentElement).fontSize) || 16;
  ruler.font = `600 ${rem * root}px ${family}`;
  return Math.ceil(ruler.measureText(text).width);
}

/**
 * The phone top bar: the room left between the brand and the live dot. A pill with the icon and the short name when
 * it fits, else the icon over the name, else the round toggle (48 px), each with the bar's gap on its left and 4 px of
 * air on its right (glide.css pulls it 8 px towards the live dot); else a slim icon-only toggle cut to that gap, with
 * 4 px of air on each side, while it is at least 44 px across. Narrower than that (320 px, where the brand and the live
 * dot leave about 38 px) the brand drops its name (its mark stays) so the toggle is a full 48 px round one (§45.36
 * E16). Nothing else moves or shrinks.
 */
export function topbarMode(anchor: HTMLElement, name = ""): Measured {
  const bar = anchor.closest<HTMLElement>(".topbar");
  if (!bar || getComputedStyle(bar).display === "none") return { mode: "none" };
  const s = getComputedStyle(bar);
  const gap = px(s.columnGap) || 12;
  // Measured without the toggle in the row: the brand may shrink to make room, so its width with the toggle there
  // is not its own (the answer must never depend on itself). Hidden and shown again before anything is painted.
  const shown = anchor.style.display;
  anchor.style.display = "none";
  // The brand's name too, as it is without this toggle (a squeeze drops it, which must not count as room).
  const squeezed = anchor.hasAttribute("data-ws-squeeze");
  if (squeezed) anchor.removeAttribute("data-ws-squeeze");
  const kids = Array.from(bar.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el !== anchor && getComputedStyle(el).display !== "none");
  // Layout widths, never the painted box: the live dot and the brand pop in with a little scale, which a measured
  // box would count as room (offsetWidth is rounded, so half a pixel more each, to be safe).
  const used = kids.reduce((n, el) => n + el.offsetWidth + 0.5, 0) + gap * Math.max(0, kids.length - 1);
  const free = bar.clientWidth - px(s.paddingLeft) - px(s.paddingRight) - used;
  // What dropping the brand's name gives back: its width and the gap before it, less what the brand keeps to stay a
  // 44 px target (glide.css).
  const brandName = bar.querySelector<HTMLElement>(".brand .brand__name");
  const brand = brandName?.parentElement;
  const nameRoom =
    brandName && brand && getComputedStyle(brandName).display !== "none"
      ? brand.offsetWidth - Math.max(ROUND, brand.offsetWidth - brandName.offsetWidth - (px(getComputedStyle(brand).columnGap) || 0))
      : 0;
  anchor.style.display = shown;
  if (squeezed) anchor.setAttribute("data-ws-squeeze", "");
  const before = kids.some((el) => el.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING);
  const after = kids.some((el) => anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  // What the toggle adds to the row: its width and a gap on each side that has a neighbour (the right one pulled in
  // to `right`), less the one gap between the brand and the live dot it now sits in.
  const takes = (w: number, left: number, right: number) => w + (before ? left : 0) + (after ? right : 0) - (before && after ? gap : 0);
  const fits = (w: number, room = free) => room >= takes(w, gap, after ? Math.max(AIR, gap - 8) : 0);
  const family = getComputedStyle(bar).fontFamily;
  const text = name ? textWidth(name, LABEL_REM, family) : null;
  if (text !== null && fits(text + LABEL_SIDES)) return { mode: "label" };
  if (text !== null && fits(Math.max(PHONE, text + STACK_SIDES))) return { mode: "stack" };
  if (fits(PHONE)) return { mode: "round" };
  // Slim: the whole gap less 4 px of air on each side (its margins pull it into the bar's gaps), while that is still a
  // full finger's width (44 px, the owner's phone minimum).
  const slim = (room: number) => Math.floor(Math.min(PHONE, room - takes(0, AIR, AIR)));
  const margins = { marginLeft: before ? AIR - gap : 0, marginRight: after ? AIR - gap : 0 };
  if (slim(free) >= ROUND) return { mode: "slim", style: { width: slim(free), ...margins } };
  // The smallest phones (320 px): the brand keeps its mark and drops its name before the toggle gets any narrower
  // than that (§45.36 E16).
  if (nameRoom > 0 && fits(PHONE, free + nameRoom)) return { mode: "round", squeeze: true };
  const w = slim(free + nameRoom);
  if (w >= SLIM_MIN) return { mode: "slim", squeeze: nameRoom > 0 ? true : undefined, style: { width: w, ...margins } };
  return { mode: "none" };
}
