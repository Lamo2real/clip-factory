// A tiny history router: a handful of screens do not need a routing library. Page changes use the View Transitions API
// where the browser has it (a soft cross-fade), and swap instantly elsewhere or when motion is reduced.
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./prefs.ts";
import type { Platform } from "../api/types.ts";
import { isMock } from "./config.ts";
import { findBranch, findTree } from "./settingsTree.ts";

const SETUP_PLATFORMS: readonly Platform[] = ["youtube", "tiktok", "instagram", "facebook", "x"];

export type Route =
  | { name: "home" }
  | { name: "jobs" }
  | { name: "job"; jobId: string }
  | { name: "review"; jobId: string | null }
  /** Library: All clips, or This week (a given ISO week, or the current one when `week` is null). §16.8 */
  | { name: "library"; view: "all" | "week"; week: string | null }
  /** One clip's performance page. */
  | { name: "clip"; clipId: string }
  /**
   * Settings is a tree (docs/CONTRACTS.md §15.1): the field, a tree, or one of its branches. Posting › Set up
   * posting has one page per platform (`platform`, §17.1).
   */
  | { name: "settings"; tree: string | null; branch: string | null; platform?: Platform }
  /**
   * A skill under Settings › Clip making › Skills (§18.7): writing a new one, reading one, or changing one.
   * `skillId` null with mode "read" is an address that cannot be a skill ("We could not find that skill").
   */
  | { name: "skill"; mode: "new" | "read" | "edit"; skillId: string | null }
  /** Mock mode only: the pretend consent page Connect goes to (§17.10). */
  | { name: "mock_oauth"; platform: Platform }
  | { name: "get_app" }
  /** Mock (e2e) mode only: one button per action motion kind (docs/CONTRACTS.md §20.10). Never in a real build. */
  | { name: "motion_gallery" }
  | { name: "not_found" };

/** The motion gallery's address (mock mode only). */
export const MOTION_GALLERY_PATH = "/__motion";

export function match(pathname: string, search = ""): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  const query = new URLSearchParams(search);
  if (path === "/") return { name: "home" };
  if (path === "/jobs") return { name: "jobs" };
  const job = /^\/jobs\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (job) return { name: "job", jobId: job[1]! };
  if (path === "/review") return { name: "review", jobId: query.get("job") };
  if (path === "/library") {
    const week = query.get("week");
    return query.get("view") === "week"
      ? { name: "library", view: "week", week: week || null }
      : { name: "library", view: "all", week: null };
  }
  const clip = /^\/clips\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (clip) return { name: "clip", clipId: clip[1]! };
  const skill = /^\/settings\/clip-making\/skills\/(.+)$/.exec(path);
  if (skill) return skillRoute(skill[1]!);
  const settings = /^\/settings(?:\/([a-z-]{1,40}))?(?:\/([a-z-]{1,40}))?$/.exec(path);
  if (settings) {
    const [, treeSlug, branchSlug] = settings;
    if (!treeSlug) return { name: "settings", tree: null, branch: null };
    const tree = findTree(treeSlug);
    if (!tree) return { name: "not_found" };
    if (!branchSlug) return { name: "settings", tree: tree.slug, branch: null };
    if (!findBranch(tree, branchSlug)) return { name: "not_found" };
    return { name: "settings", tree: tree.slug, branch: branchSlug };
  }
  const setup = /^\/settings\/posting\/setup\/([a-z]{1,20})$/.exec(path);
  if (setup) {
    const platform = setup[1] as Platform;
    return SETUP_PLATFORMS.includes(platform) ? { name: "settings", tree: "posting", branch: "setup", platform } : { name: "not_found" };
  }
  const consent = /^\/mock-oauth\/([a-z]{1,20})$/.exec(path);
  if (consent && isMock && SETUP_PLATFORMS.includes(consent[1] as Platform)) return { name: "mock_oauth", platform: consent[1] as Platform };
  if (path === "/get-app") return { name: "get_app" };
  if (isMock && path === MOTION_GALLERY_PATH) return { name: "motion_gallery" };
  return { name: "not_found" };
}

/** Owner skills have ULIDs; built-ins are `builtin-<name>` (§18.7). */
export const SKILL_ID_RE = /^(?:[0-9A-HJKMNP-TV-Z]{26}|builtin-[a-z0-9-]{1,64})$/;

/** The base of every skill page. */
export const SKILLS_PATH = "/settings/clip-making/skills";

export function skillPath(skillId: string | null, mode: "read" | "edit" = "read"): string {
  if (!skillId) return `${SKILLS_PATH}/new`;
  return `${SKILLS_PATH}/${encodeURIComponent(skillId)}${mode === "edit" ? "/edit" : ""}`;
}

function skillRoute(rest: string): Route {
  if (rest === "new") return { name: "skill", mode: "new", skillId: null };
  const parts = rest.split("/");
  let id: string;
  try {
    id = decodeURIComponent(parts[0]!);
  } catch {
    id = "";
  }
  const mode = parts.length === 1 ? "read" : parts.length === 2 && parts[1] === "edit" ? "edit" : null;
  if (!mode || !SKILL_ID_RE.test(id)) return { name: "skill", mode: "read", skillId: null };
  return { name: "skill", mode, skillId: id };
}

const listeners = new Set<() => void>();
const here = () => location.pathname + location.search + location.hash;
// The hash is part of what is watched, so a jump to `#an-apple` on the same page is noticed too.
let href = typeof location === "undefined" ? "/" : here();

function emit() {
  href = here();
  for (const fn of listeners) fn();
}

/**
 * A page with unsaved typing can stop the owner leaving (§18.7 "Leave without saving?"). The guard gets where the
 * owner wants to go and a function that goes there; it returns true when it is holding them (it shows its own
 * question and calls `proceed` on Leave).
 */
export type LeaveGuard = (to: string, proceed: () => void) => boolean;
let guard: LeaveGuard | null = null;

/** Installs a leave guard until the returned function is called. */
export function setLeaveGuard(g: LeaveGuard): () => void {
  guard = g;
  return () => {
    if (guard === g) guard = null;
  };
}

const samePage = (a: string, b: string) => a.split("#")[0] === b.split("#")[0];

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    const to = here();
    const from = href;
    if (guard && !samePage(to, from) && guard(to, () => navigate(to, { replace: true, force: true }))) {
      // Browser Back already moved the address: put this page back while the owner decides.
      history.pushState({ cfDepth: depth() + 1 }, "", from);
      return;
    }
    transition(emit);
  });
  window.addEventListener("hashchange", emit);
}

interface ViewTransitionLike {
  finished: Promise<void>;
  skipTransition(): void;
}

/**
 * The longest a page change may animate. While a View Transition runs, the browser sends every tap to the page
 * itself, not to the button under the finger. On a slow device (no GPU help with the glass) a 340 ms cross-fade can
 * take seconds, and taps in that time do nothing. So the fade is cut short after this, and at once on any tap or key.
 */
export const TRANSITION_CAP_MS = 450;

let running: ViewTransitionLike | null = null;

function transition(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => ViewTransitionLike };
  if (!doc.startViewTransition || prefersReducedMotion() || document.visibilityState !== "visible") {
    update();
    return;
  }
  // A new page change while the last one still fades: finish that one first instead of stacking them.
  running?.skipTransition();
  const vt = doc.startViewTransition(() => flushSync(update));
  running = vt;
  const skip = () => vt.skipTransition();
  const cap = window.setTimeout(skip, TRANSITION_CAP_MS);
  const opts = { capture: true, once: true } as const;
  window.addEventListener("pointerdown", skip, opts);
  window.addEventListener("keydown", skip, opts);
  const done = () => {
    window.clearTimeout(cap);
    window.removeEventListener("pointerdown", skip, opts);
    window.removeEventListener("keydown", skip, opts);
    if (running === vt) running = null;
  };
  vt.finished.then(done, done);
}

export function navigate(to: string, { replace = false, force = false } = {}) {
  if (to === here()) return;
  if (!force && guard && !samePage(to, here())) {
    const g = guard;
    if (g(to, () => navigate(to, { replace, force: true }))) return;
  }
  transition(() => {
    if (replace) history.replaceState({ cfDepth: depth() }, "", to);
    else history.pushState({ cfDepth: depth() + 1 }, "", to);
    emit();
    window.scrollTo({ top: 0 });
  });
}

/** How many in-app pages lie behind this one (0 = the owner arrived here from outside the app). */
function depth(): number {
  const d = (history.state as { cfDepth?: unknown } | null)?.cfDepth;
  return typeof d === "number" ? d : 0;
}

/** Back to where the owner came from inside the app, or to `fallback` when they arrived here from a link. */
export function goBack(fallback: string): void {
  if (depth() > 0) history.back();
  else navigate(fallback, { replace: true });
}

export function useRoute(): Route {
  const current = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => href,
    () => "/",
  );
  const [beforeHash = "/"] = current.split("#");
  const [path, search = ""] = beforeHash.split("?");
  return match(path ?? "/", search ? `?${search}` : "");
}

/** The current `#anchor` (without the #), following in-app jumps. */
export function useHash(): string {
  const current = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => href,
    () => "/",
  );
  const at = current.indexOf("#");
  return at < 0 ? "" : decodeURIComponent(current.slice(at + 1));
}

/** The nav section a route belongs to (a job detail page highlights Jobs). */
export function section(route: Route): "home" | "jobs" | "review" | "library" | "settings" | "get_app" | null {
  switch (route.name) {
    case "mock_oauth":
    case "motion_gallery":
      return null;
    case "job":
      return "jobs";
    case "clip":
      return "library";
    case "skill":
      return "settings";
    case "not_found":
      return null;
    default:
      return route.name;
  }
}
