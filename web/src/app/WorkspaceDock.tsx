// The workspace switch and the Live chip under it: ONE element of the application shell that both apps show, at
// exactly the same place, size and look whichever app is open (docs/CONTRACTS.md §45.38; the owner, 22 Nov: "keep
// that for both when I switch to Lamo Stories and back to Clip Factory", "That should be in the same place no matter
// what"). Only while Lamo Stories is switched on (App.tsx's BothApps renders it); while it is off Clip Factory draws
// its own Live chip exactly as before and there is no switch at all.
//
// On a computer it is WorkspaceDock: rendered by the shell outside both panes, laid over the left column, where it has
// always been in Clip Factory (the sidebar's foot: the switch, then the Live chip, with Get the app and the jobs line
// under them). Its place is worked out from the window and from Clip Factory's sidebar (dockLayout below), never from
// whichever app happens to be on screen, so the two apps always agree; Clip Factory's sidebar leaves those rows where
// they are, and Lamo Stories' rail and its pages leave that box free (stories.css reads --ws-dock-room). It stays
// mounted across the workspace change, so the bar's highlight slides from one choice to the other: the slide starts
// on the tap's own frame, and the page changes once it has landed (no layout work, no new page, during the slide).
//
// On a phone it is TopBarSwitch: the round toggle with the Live chip beside it, at the right end of each app's own top
// bar (both apps' top bars have the same height and the same side padding, so it is the same box in both). The top
// bar scrolls with its page, so each app draws it in its own bar; it is this one component in both.
//
// The workspace list, where a switch lands and what is remembered on the device are stories/workspace.ts (§45.16.1).
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { Glide, GLIDE_ANIMATION_ID, GLIDE_MS, GlideCalm } from "../components/Glide.tsx";
import { LiveDot } from "../components/LiveDot.tsx";
import { useFootRows } from "../components/Nav.tsx";
import { WorkspaceMark } from "../components/WorkspaceMark.tsx";
import { prefersReducedMotion, usePrefs } from "../lib/prefs.ts";
import { leaveGuarded, navigate, useHash, useRoute } from "../lib/router.ts";
import type { Workspace } from "../stories/api/types.ts";
import { CLIPS_WORKSPACE_ID, FIRST_STORIES_WORKSPACE_ID } from "../stories/api/types.ts";
import { prefetchStoriesApp, preloadStoriesApp } from "../stories/pane.tsx";
import { storiesReduceMotion } from "../stories/prefs.ts";
import {
  currentChoice,
  followReading,
  knownWorkspaces,
  onWorkspacesChange,
  readingPlace,
  rememberClipsPath,
  saveClipsScroll,
  saveStoriesScroll,
  setKnownWorkspaces,
  settleSwitch,
  switcherName,
  switchTarget,
  wantedStoriesWorkspace,
} from "../stories/workspace.ts";
import { storiesOnScreen, useAppActive, useStoriesWorkspaceShown } from "./shell.ts";

// ---------- Where it sits on a computer: Clip Factory's sidebar, measured once into numbers ----------

/**
 * Clip Factory's sidebar, as layout.css, components.css and system.css draw it (an e2e measures both apps against it,
 * stories-switch-place.spec.ts): its 1 px glass rim and 14/12 px padding, the fold button's row (44 px) and the six
 * menu items (48 px, 4 px apart) 18 px below it, then the foot pinned to the bottom with 4 px between its rows: the
 * Live chip's row (8 px under the chip, 10 px each side), Get the app (48 px) and the jobs line (44 px).
 */
export const SIDEBAR = {
  open: 252,
  folded: 80,
  rim: 1,
  padX: 12,
  padY: 14,
  head: 44,
  gap: 18,
  menu: 6 * 48 + 5 * 4,
  footGap: 4,
  getApp: 48,
  jobs: 44,
  livePadX: 10,
  /** The fold button's left margin in its row, and its size. */
  foldLeft: 6,
  fold: 44,
  /** Between the sidebar and the page column (the shell's padding is the sidebar, 14 px, then the gutter). */
  beside: 14,
} as const;

/** The bar's choices are 44 px tall inside 4 px of padding; a round toggle is 44 px. */
const OPT_H = 44;
const BAR_PAD = 4;
const ROUND = 44;
/** Air the switch keeps from whatever is next to it, so nothing ever touches. */
const AIR = 4;
/** The slim toggle's least size across (WCAG's 24 px target, with room to spare). */
const SLIM_MIN = 28;

/**
 * bar: the pick bar above the Live chip; corner: a round toggle beside the Live chip; round: a round toggle above it;
 * slim: a slim toggle in the gap between the menu and the foot; top: a slim toggle beside the fold button (a folded
 * sidebar in a short window, §45.35 D19); edge: a slim toggle in the strip between the open sidebar and the page, at
 * the foot's height (an open sidebar in a short window); none: no room anywhere (never in practice).
 */
export type DockMode = "bar" | "corner" | "round" | "slim" | "top" | "edge" | "none";

export type DockBox = { top: number; left: number; width: number; height: number };

export interface DockInput {
  /** The column's height: from the top line to 14 px above the window's bottom (the sidebar's own box). */
  frameH: number;
  /** The column's left edge in the window (14 px, or the safe area). */
  left: number;
  /** The window's width (the gutter between the sidebar and the page is 3.2 % of it, 16 to 36 px). */
  vw: number;
  folded: boolean;
  /** The Live chip's row (the chip and 8 px under it); 0 while the chip is not shown (not connected). */
  liveH: number;
  liveDotW: number;
  liveDotH: number;
  getApp: boolean;
  jobs: boolean;
  /** How many workspaces the bar lists, and whether its choices stand one above the other. */
  count: number;
  stacked: boolean;
}

export interface DockLayout {
  mode: DockMode;
  /** The switch's box in the column (from its top left corner), or null. */
  sw: DockBox | null;
  /** The Live chip's row in the column. */
  live: { top: number; left: number; width: number };
  /** How far up from the window's bottom the dock reaches in the foot, with 4 px of air: Lamo Stories' rail leaves it free. */
  room: number;
}

/** The bar's height for `count` choices, side by side (two) or one above the other. */
export function barHeight(count: number, stacked: boolean): number {
  return BAR_PAD * 2 + (stacked || count > 2 ? count * OPT_H + (count - 1) * 2 : OPT_H);
}

/**
 * Where the switch and the Live chip go in the left column (the numbers of Clip Factory's sidebar, SIDEBAR): the bar
 * right above the Live chip when the free space above the foot holds it (the foot is pinned to the bottom, so it grows
 * up into that space); else a round toggle beside the Live chip (sidebar open) or above it; else a slim toggle over
 * the empty gap between the menu and the foot; else, folded, a slim toggle beside the fold button, and open, one in
 * the strip between the sidebar and the page at the foot's height. Nothing it covers, in either app.
 */
export function dockLayout(i: DockInput): DockLayout {
  const S = SIDEBAR;
  const width = i.folded ? S.folded : S.open;
  const x0 = S.rim + S.padX;
  const cw = width - 2 * (S.rim + S.padX);
  const bottom = i.frameH - S.rim - S.padY;
  const listBottom = S.rim + S.padY + S.head + S.gap + S.menu;
  const parts = [...(i.liveH > 0 ? [i.liveH] : []), ...(i.getApp ? [S.getApp] : []), ...(i.jobs ? [S.jobs] : [])];
  const footH = parts.reduce((a, b) => a + b, 0) + S.footGap * Math.max(0, parts.length - 1);
  // Pinned to the bottom; in a window too short for the menu and the foot, right under the menu (and past the bottom).
  const footTop = Math.max(bottom - footH, listBottom + S.gap);
  const above = parts.length ? S.footGap : 0;
  const live = { top: footTop, left: x0, width: cw };
  const free = footTop - (listBottom + S.gap);
  const gutter = Math.min(36, Math.max(16, i.vw * 0.032));
  // The page column's left edge, in the column's own coordinates.
  const pageLeft = width + S.beside + gutter - i.left;
  const done = (mode: DockMode, sw: DockBox | null): DockLayout => {
    const inFoot = sw && (mode === "bar" || mode === "corner" || mode === "round" || mode === "slim") ? sw.top : Infinity;
    const top = Math.min(inFoot, i.liveH > 0 ? footTop : Infinity);
    return { mode, sw, live, room: Number.isFinite(top) ? Math.max(0, Math.ceil(i.frameH + 14 - top + AIR)) : 0 };
  };
  const barH = barHeight(i.count, i.stacked);
  if (!i.folded && free >= barH + S.footGap + AIR) return done("bar", { top: footTop - above - barH, left: x0, width: cw, height: barH });
  if (!i.folded && i.liveH > 0) {
    // Beside the Live chip: its row is wide and the chip is short, so a round toggle fits on its right.
    const top = footTop + i.liveDotH / 2 - ROUND / 2;
    const roomRight = cw - 2 * S.livePadX - i.liveDotW;
    const below = parts.length > 1 ? footTop + i.liveH : bottom;
    if (roomRight >= ROUND + 12 && top >= listBottom + AIR && top + ROUND <= below)
      return done("corner", { top, left: x0 + cw - S.livePadX - ROUND, width: ROUND, height: ROUND });
  }
  if (free >= ROUND + S.footGap + AIR) return done("round", { top: footTop - above - ROUND, left: i.folded ? x0 + (cw - ROUND) / 2 : x0 + S.livePadX, width: ROUND, height: ROUND });
  // The empty gap between the last menu item and the foot.
  const gap = footTop - listBottom;
  const h = Math.floor(Math.min(ROUND, gap - 2 * AIR));
  const w = Math.min(ROUND, Math.floor(cw));
  if (h >= SLIM_MIN && w >= SLIM_MIN) return done("slim", { top: Math.round(listBottom + (gap - h) / 2), left: Math.round(x0 + (cw - w) / 2), width: w, height: h });
  if (i.folded) {
    // Right of the fold button with 4 px of air, short of the page with 4 px of air, as tall as the fold button.
    const left = x0 + S.foldLeft + S.fold + AIR;
    const sw = Math.floor(Math.min(ROUND, pageLeft - AIR - left));
    if (sw >= SLIM_MIN) return done("top", { top: S.rim + S.padY, left, width: sw, height: S.fold });
    return done("none", null);
  }
  // Right of the open sidebar, in the strip before the page, at the foot's height.
  const left = width + AIR;
  const sw = Math.floor(Math.min(ROUND, pageLeft - AIR - left));
  if (sw >= SLIM_MIN) return done("edge", { top: bottom - ROUND, left, width: sw, height: ROUND });
  return done("none", null);
}

// ---------- The workspaces, which one is on screen, and a switch ----------

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

const here = () => location.pathname + location.search + location.hash;

/** The workspace on screen: Clip Factory, or the Lamo Stories workspace StoriesApp shows (else the one it will open). */
function useCurrent(list: Workspace[]): string {
  const route = useRoute();
  const shown = useStoriesWorkspaceShown();
  if (route.name !== "stories") return CLIPS_WORKSPACE_ID;
  const stories = list.filter((w) => w.workspaceType === "stories");
  const want = shown ?? wantedStoriesWorkspace();
  return stories.find((w) => w.workspaceId === want)?.workspaceId ?? stories[0]?.workspaceId ?? FIRST_STORIES_WORKSPACE_ID;
}

/** A plain left click (not a new tab, not a modified click). */
function plainClick(e: MouseEvent): boolean {
  return !(e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);
}

/** Where a choice's link goes (a new tab, or the address a screen reader reads out). */
function hrefFor(w: Workspace): string {
  const c = currentChoice();
  if (w.workspaceType === "clips") return c.lastClipsPath;
  return c.lastStoriesWorkspaceId === null || c.lastStoriesWorkspaceId === w.workspaceId ? c.lastStoriesPath : "/stories";
}

/** A switch a page's "Leave without saving?" is holding: recorded only if the page then really changes to it. */
let held: { w: Workspace; to: string } | null = null;

/** Where the owner was, taken at the tap: the way back opens that page where he left it. */
interface Leaving {
  from: string;
  y: number;
  clips: boolean;
}

function leaving(phone: boolean): Leaving {
  const from = here();
  const clips = !storiesOnScreen();
  // On a phone the top bar scrolls away with the page: the place he scrolled up from to reach it is where he was.
  return { from, clips, y: clips && phone ? readingPlace(from, window.scrollY) : window.scrollY };
}

/**
 * The switch itself: the page being left is remembered (Clip Factory's at its scroll position, kept for the way back;
 * Lamo Stories' own, which StoriesApp puts back), then the other app's last page opens. The choice is recorded only
 * once the page really changed: a page with unsaved typing may be asking "Leave without saving?", and when the owner
 * stays the stored choice must still say where he is.
 */
function switchTo(w: Workspace, at: Leaving): void {
  if (at.clips) {
    saveClipsScroll(at.from, at.y);
    rememberClipsPath(at.from);
  } else saveStoriesScroll(at.from, at.y);
  const to = switchTarget(w);
  navigate(to);
  if (here() === to) settleSwitch(w);
  else held = { w, to };
}

/** Calm motion of the app on screen: Lamo Stories' own switch on its pages, Clip Factory's everywhere else. */
function dockCalm(): boolean {
  return storiesOnScreen() ? storiesReduceMotion() : prefersReducedMotion();
}

/** The Lamo Stories chunk, fetched the moment the pointer or the keyboard comes to a way there. */
const warm = (w: Workspace | null) => (w && w.workspaceType === "stories" ? preloadStoriesApp : undefined);

/**
 * The little picture of a workspace on its round toggle: Clip Factory's real mark (its italic serif "C" on the bone
 * tile with the vermilion dot, as .brand__mark draws it), and for Funded Clips the same mark in Funded Clips' warm
 * colours (its logo). Both are components/WorkspaceMark.tsx's small mark, in either app.
 */
export function ToggleMark({ type, size = 24 }: { type: Workspace["workspaceType"]; size?: number }) {
  return <WorkspaceMark workspace={type === "clips" ? "clips" : "stories"} size={Math.round(size * 0.875)} className="ws-round__mark" />;
}

/**
 * One toggle: straight to the other workspace (its picture on it), or a short list when there are more than two.
 * `below` opens the list under the toggle (at the top of the window, or a phone's top bar), else above it.
 */
function Toggle({ list, current, kind, markSize, below, tip }: { list: Workspace[]; current: string; kind: string; markSize: number; below: boolean; tip: boolean }) {
  const [menu, setMenu] = useState(false);
  const others = list.filter((w) => w.workspaceId !== current);
  const target = others.length === 1 ? others[0]! : null;
  const here_ = list.find((w) => w.workspaceId === current) ?? list[0]!;
  const phone = kind.includes("ws-round--phone");
  const go = (w: Workspace) => (e: MouseEvent) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    setMenu(false);
    if (w.workspaceId === current) return;
    switchTo(w, leaving(phone));
  };
  if (target) {
    const name = switcherName(target);
    return (
      <a
        href={hrefFor(target)}
        className={kind}
        aria-label={`Go to ${name}`}
        data-tip={tip ? name : undefined}
        title={tip ? undefined : name}
        onClick={go(target)}
        onPointerEnter={warm(target)}
        onFocus={warm(target)}
      >
        <ToggleMark type={target.workspaceType} size={markSize} />
      </a>
    );
  }
  return (
    <>
      <button type="button" className={kind} aria-label={`Pick a workspace (now ${switcherName(here_)})`} aria-expanded={menu} onClick={() => setMenu((m) => !m)} onPointerEnter={preloadStoriesApp}>
        <ToggleMark type={here_.workspaceType} size={markSize} />
      </button>
      {menu ? <WorkspaceMenu list={list} current={current} go={go} close={() => setMenu(false)} below={below} /> : null}
    </>
  );
}

/** Where the list opens below its toggle, left-aligned with it. */
const BELOW = { top: "calc(100% + 8px)", bottom: "auto" } as const;

/** The short list a toggle opens when there are more than two workspaces. */
function WorkspaceMenu({ list, current, go, close, below }: { list: Workspace[]; current: string; go: (w: Workspace) => (e: MouseEvent) => void; close: () => void; below: boolean }) {
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
          <a key={w.workspaceId} href={hrefFor(w)} className={`ws-switch__opt${w.workspaceId === current ? " is-on" : ""}`} aria-current={w.workspaceId === current ? "true" : undefined} onClick={go(w)} onPointerEnter={warm(w)} onFocus={warm(w)}>
            {switcherName(w)}
          </a>
        ))}
      </div>
    </div>
  );
}

// ---------- The bar, whose highlight slides ----------

/**
 * The pick bar (§20.13): the highlight slides to the tapped choice on the tap's own frame (the bar is the shell's,
 * mounted across the change, so nothing cuts the slide short), and the page changes once it has landed, so the slide
 * shares no frame with a new page being laid out. Calm motion moves it at once and changes the page at once. A page
 * asking "Leave without saving?" asks first: the highlight moves only if the page really changes.
 */
function Bar({ list, current, stacked, barRef }: { list: Workspace[]; current: string; stacked: boolean; barRef: { current: HTMLDivElement | null } }) {
  const [pending, setPending] = useState<string | null>(null);
  const token = useRef(0);
  const shown = pending ?? current;
  // The page changed (the switch landed, or Back went there): the highlight shows where the owner is now.
  useEffect(() => setPending(null), [current]);
  useEffect(
    () => () => {
      token.current++;
    },
    [],
  );

  const tap = (w: Workspace) => (e: MouseEvent) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    if (w.workspaceId === shown) return;
    const run = ++token.current;
    if (w.workspaceId === current) {
      // Tapped back during the slide: it slides back, and nothing changes.
      setPending(null);
      return;
    }
    const at = leaving(false);
    if (dockCalm() || leaveGuarded()) {
      switchTo(w, at);
      return;
    }
    // The class moves in this task, so Glide (its MutationObserver) starts the slide before the next frame.
    flushSync(() => setPending(w.workspaceId));
    let gone = false;
    const land = () => {
      if (gone || run !== token.current) return;
      gone = true;
      switchTo(w, at);
      // Held by "Leave without saving?" (the page did not change): the highlight goes back to where he still is.
      if (here() === at.from) setPending(null);
    };
    // After Glide's own observer has run (a microtask queued before this one): its slide exists now.
    queueMicrotask(() => {
      const glide = barRef.current?.querySelector<HTMLElement>(":scope > .glide");
      const slide = glide?.getAnimations?.().find((a) => a.id === GLIDE_ANIMATION_ID);
      if (slide) slide.finished.then(land, land);
      // A browser that starts no slide switches at once; one whose slide never says it ended (a window hidden mid-way)
      // switches well after it would have.
      setTimeout(land, slide ? GLIDE_MS + 2000 : 0);
    });
  };

  return (
    <GlideCalm.Provider value={dockCalm}>
      <div ref={barRef} className={`ws-switch${stacked || list.length > 2 ? " ws-switch--stack" : ""}`} role="group" aria-label="Workspace">
        <Glide active=".ws-switch__opt.is-on" className="glide--ws" />
        {list.map((w) => (
          <a
            key={w.workspaceId}
            href={hrefFor(w)}
            className={`ws-switch__opt${w.workspaceId === shown ? " is-on" : ""}`}
            aria-current={w.workspaceId === shown ? "true" : undefined}
            onClick={tap(w)}
            onPointerEnter={warm(w)}
            onFocus={warm(w)}
          >
            {switcherName(w)}
          </a>
        ))}
      </div>
    </GlideCalm.Provider>
  );
}

// ---------- On a computer: the dock ----------

/**
 * A dialog of either app is open (outside the dock): the dock takes no tap and no key, as the page under the dialog.
 * "covered": the dialog's dim is drawn over the dock already (Clip Factory's sheets and lists, on the page itself);
 * "over": the dock is drawn over it (Lamo Stories' sheets dim inside its own app's box), so the dock dims with them
 * (glide.css .is-under) and lets taps through to the dim, which closes the sheet as it does everywhere else.
 */
function useUnderDialog(frame: { current: HTMLDivElement | null }): "no" | "covered" | "over" {
  const [under, setUnder] = useState<"no" | "covered" | "over">("no");
  useEffect(() => {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    let now: "no" | "covered" | "over" = "no";
    const check = () => {
      const dock = frame.current;
      if (!dock) return;
      const open = Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => !dock.contains(el) && !el.closest("[hidden]"));
      if (!open) {
        if (now !== "no") setUnder((now = "no"));
        return;
      }
      if (now !== "no") return;
      // Which is drawn on top at the switch's middle: the dock, or the dialog's dim.
      const part = dock.querySelector<HTMLElement>(":scope > .ws-switch-host, :scope > .ws-dock__live > .live-dot");
      const r = part?.getBoundingClientRect();
      const hit = r && r.width > 0 && typeof document.elementFromPoint === "function" ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
      setUnder((now = hit && dock.contains(hit) ? "over" : "covered"));
    };
    check();
    const watch = new MutationObserver(check);
    watch.observe(document.body, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [frame]);
  return under;
}

const TABBABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';

/** What Tab stops at inside `root`, in the page's order (not disabled, not inert, shown). */
function tabStops(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el as HTMLButtonElement).disabled &&
      !el.closest("[inert]") &&
      (typeof el.checkVisibility === "function" ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0),
  );
}

/**
 * For the keyboard the dock comes where it is drawn, not after both apps (where the page has it): right after the
 * app's menu (Clip Factory's sidebar list, Lamo Stories' rail list: each marks it data-ws-tab-after), before what is
 * under it (Get the app, the jobs line, the page). Tab from the menu's last item goes to the switch, Tab from the
 * switch to what follows the menu, and Shift+Tab back the same way; anywhere else Tab goes past the dock. A page with
 * no mark (Lamo Stories' first Setup, on its own) keeps the page's own order.
 */
function useDockTabPlace(frame: { current: HTMLDivElement | null }): void {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
      const dock = frame.current;
      if (!dock || dock.hidden || dock.inert || !wide()) return;
      const mark = document.querySelector<HTMLElement>("[data-app-pane]:not([hidden]) [data-ws-tab-after]");
      const own = mark ? tabStops(dock) : [];
      if (!mark || !own.length) return;
      const page = tabStops(mark.closest("[data-app-pane]") ?? document.body);
      const past = (el: Element) => !mark.contains(el) && !!(mark.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      const next = page.find(past);
      const before = page.filter((el) => !past(el)).at(-1);
      const at = document.activeElement;
      const i = at instanceof HTMLElement ? own.indexOf(at) : -1;
      let to: HTMLElement | undefined;
      if (i >= 0) to = e.shiftKey ? (own[i - 1] ?? before) : (own[i + 1] ?? next);
      else if (at === before && !e.shiftKey) to = own[0];
      else if (at === next && e.shiftKey) to = own.at(-1);
      else {
        // Anywhere else the browser's own order goes on, past the dock (taken out of it for this one key).
        for (const el of own) el.tabIndex = -1;
        setTimeout(() => {
          for (const el of own) el.removeAttribute("tabindex");
        }, 0);
        return;
      }
      if (!to) return;
      e.preventDefault();
      to.focus();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [frame]);
}

const NO_LAYOUT: DockLayout = { mode: "none", sw: null, live: { top: 0, left: 0, width: 0 }, room: 0 };
const WIDE = "(min-width: 768px)";
/** A computer's layout (the left column), else a phone's (the top bar). */
const wide = () => typeof matchMedia === "function" && matchMedia(WIDE).matches;

function px(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The shell's dock (computers): the switch and the Live chip, fixed over the left column in both apps. It also keeps
 * the device's memory of the switch (every Clip Factory page is where switching back lands; a switch "Leave without
 * saving?" held is recorded once it went through), asks for the workspace list and fetches Lamo Stories' chunk while
 * the browser is idle, once per visit.
 */
export function WorkspaceDock() {
  const list = useWorkspaces();
  const current = useCurrent(list);
  const route = useRoute();
  const hash = useHash();
  const { sidebarCollapsed: folded } = usePrefs();
  // The rows of Clip Factory's foot under the dock (Get the app, the jobs line) as they were when Clip Factory was last
  // on screen: while Lamo Stories is, a Clip Factory job starting or ending, or the app being installed, never moves
  // the switch there (the owner cannot see why it would). They are followed until the session's first answer is in.
  const rows = useFootRows();
  const kept = useRef(rows);
  if (route.name !== "stories" || !kept.current.known) kept.current = rows;
  const { getApp, jobs } = kept.current;
  const frame = useRef<HTMLDivElement>(null);
  const liveRow = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<DockLayout>(NO_LAYOUT);
  const [stacked, setStacked] = useState(false);
  const page = JSON.stringify(route);
  const search = typeof location === "undefined" ? "" : location.search;
  const names = list.map((w) => switcherName(w)).join("|");

  useEffect(() => {
    askWorkspaces();
    prefetchStoriesApp();
  }, []);

  // Every Clip Factory page the owner opens is where switching back lands. The query counts too: Home at
  // /?campaign=… and Home at / are two ways of the same page.
  useEffect(() => {
    if (route.name !== "stories") rememberClipsPath(here());
  }, [page, search, hash, route.name]);

  // A held switch: the owner chose Leave (the page is the switch's target now), or went somewhere else.
  useEffect(() => {
    const h = held;
    if (!h) return;
    held = null;
    if (here() === h.to) settleSwitch(h.w);
  }, [page, hash]);

  // Measure the column and the Live chip, and place the switch (again on a resize, a font that arrived, the chip
  // coming or going, a fold, a row of the foot that came or went).
  useLayoutEffect(() => {
    const el = frame.current;
    const row = liveRow.current;
    if (!el || !row) return;
    let frameId = 0;
    const measure = () => {
      if (!wide()) {
        setLayout((l) => (l.mode === "none" ? l : NO_LAYOUT));
        return;
      }
      const r = el.getBoundingClientRect();
      const dot = row.querySelector<HTMLElement>(".live-dot");
      // The row's own box, to the browser's own 1/64 px (the computed style rounds 36.71875 to 36.7188, which put the
      // chip 1/64 px off its place in the sidebar and drew its light a little differently). The row is never scaled;
      // only the chip in it pops in.
      const rowH = row.getBoundingClientRect().height;
      // Clip Factory's sidebar keeps the room of this row in its foot (Nav.tsx), so the rows under it stay put.
      document.documentElement.style.setProperty("--ws-live-row", `${rowH}px`);
      const next = dockLayout({
        frameH: r.height,
        left: r.left,
        vw: window.innerWidth,
        folded,
        // Layout sizes to the fraction (a font's line can be 28.72 px tall), never the painted box (the chip pops in
        // with a little scale).
        liveH: dot ? rowH : 0,
        liveDotW: dot ? px(getComputedStyle(dot).width) : 0,
        liveDotH: dot ? px(getComputedStyle(dot).height) : 0,
        getApp,
        jobs,
        count: list.length,
        stacked,
      });
      setLayout((l) => (JSON.stringify(l) === JSON.stringify(next) ? l : next));
    };
    // At once (a resize, a font, a row that came) and again on the next frame: a late font or a child that just
    // arrived settles its size only after layout.
    const soon = () => {
      measure();
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
    ro?.observe(el);
    ro?.observe(row);
    window.addEventListener("resize", soon);
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.addEventListener?.("loadingdone", soon);
    void fonts?.ready?.then(soon);
    return () => {
      cancelAnimationFrame(frameId);
      ro?.disconnect();
      window.removeEventListener("resize", soon);
      fonts?.removeEventListener?.("loadingdone", soon);
    };
  }, [folded, getApp, jobs, list.length, stacked]);

  // Two names that do not fit side by side (a longer workspace name) stand one above the other; they go back side by
  // side once they fit again. Each name's own width (its words, unwrapped) against half the bar.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (layout.mode !== "bar" || !bar || list.length !== 2) return;
    let on = true;
    const check = () => {
      if (!on) return;
      const opts = Array.from(bar.querySelectorAll<HTMLElement>(".ws-switch__opt"));
      const s = getComputedStyle(bar);
      const column = (bar.clientWidth - px(s.paddingLeft) - px(s.paddingRight) - px(s.columnGap) * (opts.length - 1)) / opts.length;
      const words = (o: HTMLElement) => {
        const r = document.createRange();
        r.selectNodeContents(o);
        const os = getComputedStyle(o);
        return r.getBoundingClientRect().width + px(os.paddingLeft) + px(os.paddingRight);
      };
      setStacked(opts.some((o) => words(o) > column + 0.5));
    };
    check();
    // Measured again once a web font is in: a computer without Inter installed (Linux, Windows, most Macs) draws the
    // names in its own, wider font until Inter arrives, and that first measure must not keep the switch stacked, 46 px
    // higher than on a page where Inter was in when it was measured (§45.38: one place in both apps).
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.addEventListener?.("loadingdone", check);
    void fonts?.ready?.then(check);
    return () => {
      on = false;
      fonts?.removeEventListener?.("loadingdone", check);
    };
  }, [layout.mode, layout.sw?.width, stacked, names, list.length]);

  // Lamo Stories' rail and its pages leave the dock's box free (stories.css reads these).
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.wsDock = layout.mode;
    root.style.setProperty("--ws-dock-room", `${layout.room}px`);
    // Beside the fold button (a folded sidebar in a short window) it is over the brand's name in Lamo Stories' rail.
    if (layout.mode === "top") root.style.setProperty("--ws-dock-name", "hidden");
    else root.style.removeProperty("--ws-dock-name");
  }, [layout.mode, layout.room]);
  useEffect(
    () => () => {
      const root = document.documentElement;
      delete root.dataset.wsDock;
      root.style.removeProperty("--ws-dock-room");
      root.style.removeProperty("--ws-dock-name");
      root.style.removeProperty("--ws-live-row");
    },
    [],
  );

  // Unfolding: the sidebar grows over 520 ms, the dock is laid out for the open sidebar at once, so its parts are
  // shown only as far as the sidebar has grown (a clip that follows the sidebar's own curve, glide.css), never past it.
  const [unfolding, setUnfolding] = useState(false);
  const wasFolded = useRef(folded);
  useLayoutEffect(() => {
    const was = wasFolded.current;
    wasFolded.current = folded;
    if (was === folded) return;
    setUnfolding(!folded);
    if (folded) return;
    const t = setTimeout(() => setUnfolding(false), 1000);
    return () => clearTimeout(t);
  }, [folded]);

  const under = useUnderDialog(frame);
  useDockTabPlace(frame);

  // Clip Factory's own pages that stand alone (mock builds' pretend sign-in pages) have no left column.
  const alone = route.name === "mock_oauth" || route.name === "mock_cr_consent" || (typeof location !== "undefined" && location.pathname === "/mock-bank");
  const { mode, sw, live } = layout;
  const reveal = (right: number) => `${Math.max(0, Math.ceil(right - (SIDEBAR.folded - SIDEBAR.rim - SIDEBAR.padX)))}px`;
  const box = (b: DockBox) => ({ top: b.top, left: b.left, width: b.width, height: b.height, "--ws-unfold": reveal(b.left + b.width) }) as CSSProperties;
  const form = mode === "bar" ? "bar" : mode === "corner" || mode === "round" ? mode : "slim";
  return (
    <div
      ref={frame}
      className={`ws-dock${folded ? " is-folded" : ""}${unfolding ? " is-unfolding" : ""}${under === "over" ? " is-under" : ""}`}
      data-ws-dock={mode}
      hidden={alone}
      inert={under !== "no"}
      onAnimationEnd={(e) => {
        if (e.animationName === "ws-dock-unfold") setUnfolding(false);
      }}
    >
      {sw ? (
        <div className={`ws-switch-host ws-switch-host--dock${folded ? " is-collapsed" : ""}`} data-ws-switch={form} style={box(sw)}>
          {mode === "bar" ? (
            <Bar list={list} current={current} stacked={stacked} barRef={barRef} />
          ) : (
            <Toggle list={list} current={current} kind={`ws-round${form === "slim" ? " ws-round--slim" : ""}`} markSize={form === "slim" ? 20 : 24} below={mode === "top"} tip={folded} />
          )}
        </div>
      ) : null}
      <span ref={liveRow} className="sidebar__live ws-dock__live" style={{ top: live.top, left: live.left, width: live.width, "--ws-unfold": reveal(live.left + live.width) } as CSSProperties}>
        <LiveDot compact={folded} />
      </span>
    </div>
  );
}

// ---------- On a phone: the toggle at the right end of each app's top bar ----------

/**
 * The phone's switch (below 768 px): the round toggle and the Live chip beside it with 4 px of air, at the right end of
 * the app's own top bar. Each app puts this one component in its top bar (Clip Factory's in App.tsx, Lamo Stories' in
 * StoriesApp.tsx); both bars are 48 px tall with the same side padding, so it is the same box in both. The toggle is
 * 48 px round (44 by 48 below 360 px), whichever app is open; an app's brand drops its name only when it would come
 * closer than 4 px to it (the smallest phones, §45.36 E16).
 */
export function TopBarSwitch() {
  const list = useWorkspaces();
  const current = useCurrent(list);
  const active = useAppActive();
  const ref = useRef<HTMLDivElement>(null);
  const [squeeze, setSqueeze] = useState(false);

  // On a phone the top bar scrolls away with the page: where the owner was reading is followed (Clip Factory's only),
  // so a switch he scrolled up to reach keeps that place (§45.36 E1).
  const inClips = current === CLIPS_WORKSPACE_ID;
  const topZone = () => {
    const bar = ref.current?.parentElement ?? ref.current;
    return bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom + window.scrollY)) : 0;
  };
  useEffect(() => (active && inClips && !wide() ? followReading(here, topZone) : undefined), [active, inClips]);

  // Does the brand keep its name? Measured without the squeeze (the answer must never depend on itself).
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || !active) return;
    let frameId = 0;
    const measure = () => {
      const bar = host.parentElement;
      const brand = bar?.querySelector<HTMLElement>(":scope > .brand, :scope > .st-brand");
      if (!bar || !brand || getComputedStyle(bar).display === "none") return;
      const had = host.hasAttribute("data-ws-squeeze");
      if (had) host.removeAttribute("data-ws-squeeze");
      const s = getComputedStyle(bar);
      const room = bar.clientWidth - px(s.paddingLeft) - px(s.paddingRight);
      const kids = Array.from(host.children).filter((c): c is HTMLElement => c instanceof HTMLElement && getComputedStyle(c).display !== "none");
      const own = kids.reduce((n, c) => n + c.offsetWidth, 0) + AIR * Math.max(0, kids.length - 1);
      // offsetWidth is rounded: half a pixel more for the brand, to be safe.
      const fits = brand.offsetWidth + 0.5 + AIR + own <= room;
      if (had) host.setAttribute("data-ws-squeeze", "");
      setSqueeze(!fits);
    };
    // At once (a resize, a font, a row that came) and again on the next frame: a late font or a child that just
    // arrived settles its size only after layout.
    const soon = () => {
      measure();
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
    if (host.parentElement) ro?.observe(host.parentElement);
    for (const c of Array.from(host.children)) ro?.observe(c);
    const mo = new MutationObserver(() => {
      for (const c of Array.from(host.children)) ro?.observe(c);
      soon();
    });
    mo.observe(host, { childList: true, subtree: true });
    window.addEventListener("resize", soon);
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.addEventListener?.("loadingdone", soon);
    void fonts?.ready?.then(soon);
    return () => {
      cancelAnimationFrame(frameId);
      ro?.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", soon);
      fonts?.removeEventListener?.("loadingdone", soon);
    };
  }, [active, list.length]);

  return (
    <div ref={ref} className="ws-switch-host ws-switch-host--topbar" data-ws-switch="round" data-ws-squeeze={squeeze ? "" : undefined}>
      <Toggle list={list} current={current} kind="ws-round ws-round--phone" markSize={26} below tip={false} />
      <LiveDot />
    </div>
  );
}
