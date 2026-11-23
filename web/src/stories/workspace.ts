// Which workspace the owner is in, on this device (docs/CONTRACTS.md §45.16.1). The choice lives in localStorage
// `cf.workspace` as { workspaceId, lastStoriesWorkspaceId, lastClipsPath, lastStoriesPath, lastConversationId,
// lastProject }, and the address carries it too: every /stories page is Lamo Stories, every other page is Clip
// Factory. Switching goes back to the exact page the owner left in the other app (Clip Factory's at its scroll
// position, kept in sessionStorage), and opening the app at "/" when the last choice was Lamo Stories goes to the
// last Lamo Stories page. Lamo Stories' own device preferences live apart, in `cf.stories.prefs` (never in Clip
// Factory's `cf.prefs`).
//
// This file is small and has no React and no API code on purpose: Lamo Clips' shell imports it (the switcher, the
// redirect at app start) and nothing of Lamo Stories' screens comes with it.
import { navigate } from "../lib/router.ts";
import { storiesEnabled } from "./flag.ts";
import { isStoriesPath, matchStories, STORIES_ROOT, type StoriesPage } from "./routes.ts";
import { CLIPS_WORKSPACE_ID, FIRST_STORIES_WORKSPACE_ID, type ProjectRef, type Workspace } from "./api/types.ts";

export const WORKSPACE_KEY = "cf.workspace";

export interface WorkspaceChoice {
  /** "clips", or the id of the Lamo Stories workspace the owner was in last. */
  workspaceId: string;
  /** The Lamo Stories workspace to open (checked against the server's list by StoriesApp). */
  lastStoriesWorkspaceId: string | null;
  lastClipsPath: string;
  lastStoriesPath: string;
  /** The Lamo Stories chat conversation open last (its Chat page opens it again). */
  lastConversationId: string | null;
  /** The Lamo Stories project open last: an idea, a story, a character or a reference video. */
  lastProject: ProjectRef | null;
}

export const DEFAULT_CHOICE: WorkspaceChoice = {
  workspaceId: CLIPS_WORKSPACE_ID,
  lastStoriesWorkspaceId: null,
  lastClipsPath: "/",
  lastStoriesPath: STORIES_ROOT,
  lastConversationId: null,
  lastProject: null,
};

const WS_ID = /^(clips|stories|[0-9A-HJKMNP-TV-Z]{26})$/;
/** The ids the Lamo Stories router accepts (routes.ts). */
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROJECT_KINDS: ProjectRef["kind"][] = ["idea", "story", "character", "reference"];

function projectRef(v: unknown): ProjectRef | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<Record<keyof ProjectRef, unknown>>;
  return typeof r.kind === "string" && (PROJECT_KINDS as string[]).includes(r.kind) && typeof r.id === "string" && ITEM_ID.test(r.id)
    ? { kind: r.kind as ProjectRef["kind"], id: r.id }
    : null;
}

/** Query words that only make sense once (a connect's result, an OAuth return), never kept for a later visit. */
const ONCE = ["result", "ws", "state", "code", "platform"];

/** A same-app path ("/jobs?x=1#y"), never another site ("//evil.example", "https://…", "/\\evil"). */
function appPath(p: unknown): p is string {
  return typeof p === "string" && p.length <= 600 && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") && !/[\s\0]/.test(p);
}

/** The path without the words that are only for one visit (a connect's `?result=`, the OAuth return's `?ws=`). */
export function cleanPath(path: string): string {
  const hashAt = path.indexOf("#");
  const hash = hashAt >= 0 ? path.slice(hashAt) : "";
  const beforeHash = hashAt >= 0 ? path.slice(0, hashAt) : path;
  const [pathname = "/", search = ""] = beforeHash.split("?");
  if (!search) return pathname + hash;
  const q = new URLSearchParams(search);
  for (const k of ONCE) q.delete(k);
  const rest = q.toString();
  return `${pathname}${rest ? `?${rest}` : ""}${hash}`;
}

function pathOf(p: string): string {
  return p.split(/[?#]/)[0] ?? "/";
}

/** Reads the stored choice; anything missing, broken or unsafe falls back to the defaults. */
export function readChoice(): WorkspaceChoice {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? "null");
  } catch {
    raw = null;
  }
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof WorkspaceChoice, unknown>>;
  const workspaceId = typeof r.workspaceId === "string" && WS_ID.test(r.workspaceId) ? r.workspaceId : DEFAULT_CHOICE.workspaceId;
  const lastStoriesWorkspaceId =
    typeof r.lastStoriesWorkspaceId === "string" && WS_ID.test(r.lastStoriesWorkspaceId) && r.lastStoriesWorkspaceId !== CLIPS_WORKSPACE_ID
      ? r.lastStoriesWorkspaceId
      : null;
  const lastClipsPath = appPath(r.lastClipsPath) && !isStoriesPath(pathOf(r.lastClipsPath)) ? r.lastClipsPath : DEFAULT_CHOICE.lastClipsPath;
  const lastStoriesPath = appPath(r.lastStoriesPath) && isStoriesPath(pathOf(r.lastStoriesPath)) ? r.lastStoriesPath : DEFAULT_CHOICE.lastStoriesPath;
  const lastConversationId = typeof r.lastConversationId === "string" && ITEM_ID.test(r.lastConversationId) ? r.lastConversationId : null;
  return { workspaceId, lastStoriesWorkspaceId, lastClipsPath, lastStoriesPath, lastConversationId, lastProject: projectRef(r.lastProject) };
}

const listeners = new Set<() => void>();
let cached: WorkspaceChoice | null = null;

function write(next: WorkspaceChoice): WorkspaceChoice {
  const before = cached ?? readChoice();
  cached = next;
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or a full disk: the choice still holds for this visit.
  }
  if (before.workspaceId !== next.workspaceId || before.lastStoriesWorkspaceId !== next.lastStoriesWorkspaceId) for (const fn of listeners) fn();
  return next;
}

/** The current choice (read once, then kept in step with every change made here). */
export function currentChoice(): WorkspaceChoice {
  return (cached ??= readChoice());
}

/** Calls `fn` when the workspace or the Lamo Stories workspace to open changes. */
export function onChoiceChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The owner is on a Lamo Clips page: that page is where switching back lands. */
export function rememberClipsPath(path: string): void {
  if (!appPath(path) || isStoriesPath(pathOf(path))) return;
  pendingStories = null;
  const c = currentChoice();
  const clean = cleanPath(path);
  if (c.workspaceId === CLIPS_WORKSPACE_ID && c.lastClipsPath === clean) return;
  write({ ...c, workspaceId: CLIPS_WORKSPACE_ID, lastClipsPath: clean });
}

/** The conversation or project a Lamo Stories page is about (its address says it), else null. */
export function openedOn(page: StoriesPage): { conversation: string | null; project: ProjectRef | null } {
  switch (page.name) {
    case "chat_conv":
      return { conversation: page.convId, project: null };
    case "production_story":
    case "review_story":
      return { conversation: null, project: { kind: "story", id: page.storyId } };
    case "character":
      return { conversation: null, project: { kind: "character", id: page.characterId } };
    case "reference":
      return { conversation: null, project: { kind: "reference", id: page.refId } };
    case "production_new":
      return { conversation: null, project: page.ideaId && ITEM_ID.test(page.ideaId) ? { kind: "idea", id: page.ideaId } : null };
    default:
      return { conversation: null, project: null };
  }
}

/** The owner is on a Lamo Stories page of workspace `ws` (its conversation or project, if any, is remembered too). */
export function rememberStoriesPath(path: string, ws: string | null): void {
  if (!appPath(path) || !isStoriesPath(pathOf(path))) return;
  const c = currentChoice();
  const id = ws && WS_ID.test(ws) && ws !== CLIPS_WORKSPACE_ID ? ws : (c.lastStoriesWorkspaceId ?? FIRST_STORIES_WORKSPACE_ID);
  if (pendingStories === id) pendingStories = null;
  const clean = cleanPath(path);
  const [pathname = "/", search = ""] = clean.split("#")[0]!.split("?");
  const opened = openedOn(matchStories(pathname, search ? `?${search}` : ""));
  // Another Lamo Stories workspace has its own conversations and projects: they are not carried over.
  const sameWs = c.lastStoriesWorkspaceId === null || c.lastStoriesWorkspaceId === id;
  const lastConversationId = opened.conversation ?? (sameWs ? c.lastConversationId : null);
  const lastProject = opened.project ?? (sameWs ? c.lastProject : null);
  if (
    c.workspaceId === id &&
    c.lastStoriesWorkspaceId === id &&
    c.lastStoriesPath === clean &&
    c.lastConversationId === lastConversationId &&
    JSON.stringify(c.lastProject) === JSON.stringify(lastProject)
  )
    return;
  write({ ...c, workspaceId: id, lastStoriesWorkspaceId: id, lastStoriesPath: clean, lastConversationId, lastProject });
}

/** For Lamo Stories screens: the conversation open last (null after it was deleted: pass `forget`). */
export function rememberConversation(convId: string | null): void {
  const c = currentChoice();
  const next = convId && ITEM_ID.test(convId) ? convId : null;
  if (c.lastConversationId !== next) write({ ...c, lastConversationId: next });
}

/** For Lamo Stories screens: the project open last (null to forget it). */
export function rememberProject(ref: ProjectRef | null): void {
  const c = currentChoice();
  const next = projectRef(ref);
  if (JSON.stringify(c.lastProject) !== JSON.stringify(next)) write({ ...c, lastProject: next });
}

/**
 * The Lamo Stories workspace a tap in the switcher is on its way to (this visit only, never stored). The choice is
 * written to `cf.workspace` only once the page really changed: a page with unsaved typing can ask "Leave without
 * saving?", and when the owner stays, the stored choice must still say where he is. StoriesApp opens this one.
 */
let pendingStories: string | null = null;

/**
 * Where a tap on a workspace in the switcher goes: Lamo Clips' last page, or the last Lamo Stories page (the
 * dashboard of a different Lamo Stories workspace, whose pages are its own). Writes nothing: settleSwitch() does,
 * once the page changed.
 */
export function switchTarget(ws: Pick<Workspace, "workspaceId" | "workspaceType">): string {
  const c = currentChoice();
  if (ws.workspaceType === "clips") {
    pendingStories = null;
    return c.lastClipsPath;
  }
  pendingStories = ws.workspaceId;
  const same = c.lastStoriesWorkspaceId === null || c.lastStoriesWorkspaceId === ws.workspaceId;
  return same ? c.lastStoriesPath : STORIES_ROOT;
}

/**
 * The switch happened (the page is the one switchTarget gave): the choice is recorded. Back in Lamo Clips there is
 * nothing to write here: its first page records itself (rememberClipsPath), so a switch that never happened never
 * reaches a listener.
 */
export function settleSwitch(ws: Pick<Workspace, "workspaceId" | "workspaceType">): void {
  pendingStories = null;
  if (ws.workspaceType === "clips") return;
  const c = currentChoice();
  const same = c.lastStoriesWorkspaceId === null || c.lastStoriesWorkspaceId === ws.workspaceId;
  write({
    ...c,
    workspaceId: ws.workspaceId,
    lastStoriesWorkspaceId: ws.workspaceId,
    lastStoriesPath: same ? c.lastStoriesPath : STORIES_ROOT,
    lastConversationId: same ? c.lastConversationId : null,
    lastProject: same ? c.lastProject : null,
  });
}

/**
 * Back to Clip Factory without the switcher (Lamo Stories' error card, §45.35 D16): the stored choice says Clip
 * Factory at once (a reload then opens Clip Factory, never the Lamo Stories page that broke), and the page to open is
 * Clip Factory's last one.
 */
export function chooseClips(): string {
  pendingStories = null;
  const c = currentChoice();
  if (c.workspaceId !== CLIPS_WORKSPACE_ID) write({ ...c, workspaceId: CLIPS_WORKSPACE_ID });
  return c.lastClipsPath;
}

/** The Lamo Stories workspace StoriesApp should open: the one a switch is on its way to, else the last one used. */
export function wantedStoriesWorkspace(): string | null {
  return pendingStories ?? currentChoice().lastStoriesWorkspaceId;
}

/** The first Stories workspace's first default name (until 22 Nov 2026). */
export const OLD_STORIES_NAME = "Lamo Stories";
/** Every earlier default name of the first Stories workspace: "Lamo Stories", then "Clip Factory Stories" and "Clip Stories" (22-23 Nov 2026). */
export const OLD_STORIES_NAMES: readonly string[] = [OLD_STORIES_NAME, "Clip Factory Stories", "Clip Stories"];
/** Today's: the app's name, "Funded Clips". */
export const STORIES_NAME = "Funded Clips";

/**
 * The name a person sees for a stored Stories workspace name: a workspace still stored with an old default name
 * reads as today's. Only what is shown changes; the stored record is never rewritten.
 */
export function shownWorkspaceName(name: string): string {
  return OLD_STORIES_NAMES.includes(name) ? STORIES_NAME : name;
}

/** The name a workspace goes by in the switcher: Lamo Clips is the app itself, "Clip Factory" (§45.16.1). */
export function switcherName(w: Pick<Workspace, "workspaceType" | "workspaceName">): string {
  return w.workspaceType === "clips" ? "Clip Factory" : shownWorkspaceName(w.workspaceName);
}

// ---------- Clip Factory's scroll position across a switch (sessionStorage, this tab only) ----------

export const SCROLL_KEY = "cf.workspace.scroll";

/** Kept when the owner switches away from a Clip Factory page; read once when he comes back to that page. */
export function saveClipsScroll(path: string, y: number): void {
  if (!appPath(path) || isStoriesPath(pathOf(path)) || !Number.isFinite(y)) return;
  try {
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ path: cleanPath(path), y: Math.max(0, Math.round(y)) }));
  } catch {
    // Private mode: the page opens at the top, as any page change does.
  }
}

/** The scroll position kept for `path` (once: it is forgotten as it is read), else null. */
export function takeClipsScroll(path: string): number | null {
  let raw: unknown;
  try {
    raw = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? "null");
    sessionStorage.removeItem(SCROLL_KEY);
  } catch {
    return null;
  }
  const r = raw && typeof raw === "object" ? (raw as { path?: unknown; y?: unknown }) : null;
  if (!r || r.path !== cleanPath(path) || typeof r.y !== "number" || !Number.isFinite(r.y) || r.y < 0) return null;
  return r.y;
}

// ---------- Where the owner was reading on a phone (§45.36 E1) ----------
// On a phone Clip Factory's switch is in the top bar, which scrolls away with the page: to tap it the owner first
// scrolls (or taps the status bar) up to the top. The place to come back to is where he was reading before that, not
// the top he only passed through to reach the switch.

/** How long the page rests at one place below the top bar before that place counts as where the owner is reading. */
export const READ_REST_MS = 1500;
/**
 * At the top, where the top bar's switch is in view, the page counts as read only after this long: until then he is
 * only finding the switch (a slow scroll up in several flicks, a status-bar tap and a look for the switch).
 */
export const TOP_REST_MS = 10_000;

let reading: { path: string; y: number } | null = null;

/**
 * The page `path` has rested at `y` for `restedMs`; `topZone` is how far down the top bar's switch still shows. A rest
 * below the top bar is a reading place after READ_REST_MS, a rest where the switch shows only after TOP_REST_MS. The
 * first rest on a page is its place whatever it is.
 */
export function noteReading(path: string, y: number, restedMs: number, topZone: number): void {
  const p = cleanPath(path);
  const at = Math.max(0, Math.round(y));
  if (reading && reading.path === p && restedMs < (at <= topZone ? TOP_REST_MS : READ_REST_MS)) return;
  reading = { path: p, y: at };
}

/** The scroll position to keep for a switch from the phone top bar at `y`: the reading place when he scrolled up to reach it. */
export function readingPlace(path: string, y: number): number {
  const r = reading;
  return r && r.path === cleanPath(path) && r.y > y ? r.y : y;
}

/**
 * Follows the window's scroll on the Clip Factory page `path()` while the phone top bar's switch is shown; `topZone()`
 * is how far down the switch still shows (the bottom of the top bar on the page).
 */
export function followReading(path: () => string, topZone: () => number = () => 0): () => void {
  if (typeof window === "undefined") return () => undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const clear = () => {
    for (const t of timers.splice(0)) clearTimeout(t);
  };
  // Each scroll starts the count again: a rest is counted from the last move. A page he only just opened (no rest
  // on it yet) is where he is.
  const moved = () => {
    noteReading(path(), window.scrollY, 0, topZone());
    clear();
    for (const ms of [READ_REST_MS, TOP_REST_MS]) timers.push(setTimeout(() => noteReading(path(), window.scrollY, ms, topZone()), ms));
  };
  // A page seen for the first time is where it is; back on the same page (its place being put back) the place it was
  // read at stays until the page rests somewhere else.
  noteReading(path(), window.scrollY, 0, topZone());
  window.addEventListener("scroll", moved, { passive: true });
  return () => {
    clear();
    window.removeEventListener("scroll", moved);
  };
}

// ---------- Lamo Stories' scroll position across a switch (this visit only) ----------

/** Lamo Stories' pages stay mounted behind Clip Factory (stories/pane.tsx); only where the window was is kept here. */
let storiesScroll: { path: string; y: number } | null = null;

/** Kept when the owner switches away from a Lamo Stories page; read once when that page is back on screen. */
export function saveStoriesScroll(path: string, y: number): void {
  if (!appPath(path) || !isStoriesPath(pathOf(path)) || !Number.isFinite(y)) return;
  storiesScroll = { path: cleanPath(path), y: Math.max(0, Math.round(y)) };
}

/** The scroll position kept for the Lamo Stories page `path` (once: it is forgotten as it is read), else null. */
export function takeStoriesScroll(path: string): number | null {
  const kept = storiesScroll;
  storiesScroll = null;
  return kept && kept.path === cleanPath(path) ? kept.y : null;
}

/**
 * Scrolls the window back to `y` once the page is tall enough (its lists load after it opens), for up to `ms`;
 * stops at once if the owner scrolls, taps or types first. Returns a stop function.
 */
export function restoreScroll(y: number, ms = 4000): () => void {
  if (typeof window === "undefined" || y <= 0) return () => undefined;
  const until = Date.now() + ms;
  let frame = 0;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) window.removeEventListener(e, stop, true);
  };
  const tick = () => {
    if (done) return;
    const room = document.documentElement.scrollHeight - window.innerHeight;
    if (room >= y - 1) {
      window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
      if (Math.abs(window.scrollY - y) <= 1) return stop();
    }
    if (Date.now() > until) {
      // The page never grew that tall (fewer items now): go as far down as it goes.
      window.scrollTo({ top: Math.min(y, Math.max(0, room)), behavior: "instant" as ScrollBehavior });
      return stop();
    }
    frame = requestAnimationFrame(tick);
  };
  for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) window.addEventListener(e, stop, { capture: true, passive: true });
  frame = requestAnimationFrame(tick);
  return stop;
}

// ---------- Lamo Stories' own device preferences (localStorage cf.stories.prefs) ----------

export const STORIES_PREFS_KEY = "cf.stories.prefs";

export interface StoriesPrefs {
  /** Lamo Stories workspaces whose first-time setup already opened by itself on this device. */
  setupShown: string[];
  /**
   * Any Lamo Stories screen's own device preference, by its own key ("chat.enterSends", …): JSON values only, at
   * most 4 KB in all. Read with storiesPref(), written with setStoriesPref().
   */
  more: Record<string, unknown>;
}

const DEFAULT_PREFS: StoriesPrefs = { setupShown: [], more: {} };
const PREF_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$/;
const prefListeners = new Set<() => void>();
let prefsCache: StoriesPrefs | null = null;

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && WS_ID.test(x)).slice(0, 20) : [];
}

export function storiesPrefs(): StoriesPrefs {
  if (prefsCache) return prefsCache;
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(STORIES_PREFS_KEY) ?? "null");
  } catch {
    raw = null;
  }
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof StoriesPrefs, unknown>>;
  const more = r.more && typeof r.more === "object" && !Array.isArray(r.more) ? Object.fromEntries(Object.entries(r.more as Record<string, unknown>).filter(([k]) => PREF_KEY.test(k))) : {};
  prefsCache = { ...DEFAULT_PREFS, setupShown: ids(r.setupShown), more };
  return prefsCache;
}

/** One screen's own device preference (`fallback` when it was never set or is not the same kind of value). */
export function storiesPref<T>(key: string, fallback: T): T {
  const v = storiesPrefs().more[key];
  return v === undefined || typeof v !== typeof fallback || Array.isArray(v) !== Array.isArray(fallback) ? fallback : (v as T);
}

/** Keeps one screen's own device preference (null forgets it); refused beyond 4 KB, so the store stays small. */
export function setStoriesPref(key: string, value: unknown): void {
  if (!PREF_KEY.test(key)) return;
  const more = { ...storiesPrefs().more };
  if (value === null || value === undefined) delete more[key];
  else more[key] = value;
  if (JSON.stringify(more).length > 4096) return;
  setStoriesPrefs({ more });
}

export function setStoriesPrefs(patch: Partial<StoriesPrefs>): StoriesPrefs {
  const next = { ...storiesPrefs(), ...patch };
  prefsCache = next;
  try {
    localStorage.setItem(STORIES_PREFS_KEY, JSON.stringify(next));
  } catch {
    // Private mode: it holds for this visit.
  }
  for (const fn of prefListeners) fn();
  return next;
}

export function onStoriesPrefs(fn: () => void): () => void {
  prefListeners.add(fn);
  return () => prefListeners.delete(fn);
}

/**
 * The redirect when the app opens (§45.16.1): at "/" (nothing else in the address) with Lamo Stories as the last
 * choice, the last Lamo Stories page. Null: stay where the address says.
 */
export function startPath(pathname: string, search: string, hash: string, enabled = storiesEnabled()): string | null {
  if (!enabled || pathname !== "/" || search || hash) return null;
  const c = currentChoice();
  if (c.workspaceId === CLIPS_WORKSPACE_ID) return null;
  return c.lastStoriesPath;
}

/** Runs the start redirect once, before the first screen draws (App.tsx calls it as it loads). */
let started = false;
export function redirectAtStart(): void {
  if (started || typeof location === "undefined") return;
  started = true;
  const to = startPath(location.pathname, location.search, location.hash);
  if (to) navigate(to, { replace: true });
}

// ---------- The workspace list (shared by every switcher on the page) ----------

/** What the switcher shows before the server answers: Lamo Clips and the first Lamo Stories workspace. */
export const DEFAULT_WORKSPACES: Workspace[] = [
  { workspaceId: CLIPS_WORKSPACE_ID, workspaceName: "Clip Factory", workspaceType: "clips", builtin: true, configuration: {}, version: 0 },
  { workspaceId: FIRST_STORIES_WORKSPACE_ID, workspaceName: STORIES_NAME, workspaceType: "stories", builtin: false, configuration: {}, version: 0 },
];

let known: Workspace[] | null = null;
/** The list exactly as the server gave it this visit (null until it answered). */
let fromServer: Workspace[] | null = null;
const listListeners = new Set<() => void>();

/** The server's list once it answered (GET /v1/workspaces), else the default two. */
export function knownWorkspaces(): Workspace[] {
  return known ?? DEFAULT_WORKSPACES;
}

/**
 * The server's own list once it answered this visit (the switcher asks for it when it first shows), else null.
 * StoriesApp opens its workspace from it at once and checks again in the background (§45.34).
 */
export function serverWorkspaces(): Workspace[] | null {
  return fromServer;
}

/** StoriesApp and the switcher put the server's list here; every switcher then shows it. */
export function setKnownWorkspaces(list: Workspace[]): void {
  fromServer = list;
  const clips = list.filter((w) => w.workspaceType === "clips");
  const stories = list.filter((w) => w.workspaceType === "stories");
  // Lamo Clips first (the API's order too), never a second one, and at least one Lamo Stories workspace to go to.
  const next = [clips[0] ?? DEFAULT_WORKSPACES[0]!, ...(stories.length ? stories : [DEFAULT_WORKSPACES[1]!])];
  if (known && JSON.stringify(known.map(slim)) === JSON.stringify(next.map(slim))) return;
  known = next;
  for (const fn of listListeners) fn();
}

const slim = (w: Workspace) => [w.workspaceId, w.workspaceName, w.workspaceType];

export function onWorkspacesChange(fn: () => void): () => void {
  listListeners.add(fn);
  return () => listListeners.delete(fn);
}

// ---------- Page titles ----------

const TITLES: Record<StoriesPage["name"], string> = {
  dashboard: "Dashboard",
  ideas: "Ideas",
  characters: "Characters",
  character_new: "New character",
  character: "Character",
  production: "Production",
  production_new: "Make a video",
  production_story: "Making a video",
  review: "Review",
  review_story: "Review a video",
  library: "Library",
  connections: "Social accounts",
  settings: "Settings",
  chat: "Chat",
  chat_conv: "Chat",
  references: "References",
  reference: "Reference video",
  setup: "Set up",
  not_found: "Not found",
};

/** The tab title of a Lamo Stories page ("Ideas · Lamo Stories"). */
export function storiesTitle(page: StoriesPage): string {
  return `${TITLES[page.name]} · ${STORIES_NAME}`;
}

/** Test hook: forget what this module remembered (each test starts from localStorage). */
export function resetWorkspaceMemory(): void {
  cached = null;
  known = null;
  fromServer = null;
  started = false;
  prefsCache = null;
  pendingStories = null;
  storiesScroll = null;
  reading = null;
}
