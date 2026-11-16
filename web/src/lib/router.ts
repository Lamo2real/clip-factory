// A tiny history router: a handful of screens do not need a routing library. Page changes use the View Transitions API
// where the browser has it (a soft cross-fade), and swap instantly elsewhere or when motion is reduced.
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./prefs.ts";
import { findBranch, findTree } from "./settingsTree.ts";

export type Route =
  | { name: "home" }
  | { name: "jobs" }
  | { name: "job"; jobId: string }
  | { name: "review"; jobId: string | null }
  | { name: "library" }
  /** Settings is a tree (docs/CONTRACTS.md §15.1): the field, a tree, or one of its branches. */
  | { name: "settings"; tree: string | null; branch: string | null }
  | { name: "get_app" }
  | { name: "not_found" };

export function match(pathname: string, search = ""): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  const query = new URLSearchParams(search);
  if (path === "/") return { name: "home" };
  if (path === "/jobs") return { name: "jobs" };
  const job = /^\/jobs\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (job) return { name: "job", jobId: job[1]! };
  if (path === "/review") return { name: "review", jobId: query.get("job") };
  if (path === "/library") return { name: "library" };
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
  if (path === "/get-app") return { name: "get_app" };
  return { name: "not_found" };
}

const listeners = new Set<() => void>();
const here = () => location.pathname + location.search + location.hash;
// The hash is part of what is watched, so a jump to `#an-apple` on the same page is noticed too.
let href = typeof location === "undefined" ? "/" : here();

function emit() {
  href = here();
  for (const fn of listeners) fn();
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => transition(emit));
  window.addEventListener("hashchange", emit);
}

function transition(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !prefersReducedMotion() && document.visibilityState === "visible") {
    doc.startViewTransition(() => flushSync(update));
  } else update();
}

export function navigate(to: string, { replace = false } = {}) {
  if (to === here()) return;
  transition(() => {
    if (replace) history.replaceState(null, "", to);
    else history.pushState(null, "", to);
    emit();
    window.scrollTo({ top: 0 });
  });
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
    case "job":
      return "jobs";
    case "not_found":
      return null;
    default:
      return route.name;
  }
}
