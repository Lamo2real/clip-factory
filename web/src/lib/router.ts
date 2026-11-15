// A tiny history router: five screens do not need a routing library. Page changes use the View Transitions API
// where the browser has it (a soft cross-fade), and swap instantly elsewhere or when motion is reduced.
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./prefs.ts";

export type Route =
  | { name: "home" }
  | { name: "jobs" }
  | { name: "job"; jobId: string }
  | { name: "review"; jobId: string | null }
  | { name: "library" }
  | { name: "settings" }
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
  if (path === "/settings") return { name: "settings" };
  if (path === "/get-app") return { name: "get_app" };
  return { name: "not_found" };
}

const listeners = new Set<() => void>();
let href = typeof location === "undefined" ? "/" : location.pathname + location.search;

function emit() {
  href = location.pathname + location.search;
  for (const fn of listeners) fn();
}

if (typeof window !== "undefined") window.addEventListener("popstate", () => transition(emit));

function transition(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !prefersReducedMotion() && document.visibilityState === "visible") {
    doc.startViewTransition(() => flushSync(update));
  } else update();
}

export function navigate(to: string, { replace = false } = {}) {
  if (to === location.pathname + location.search) return;
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
  const [path, search = ""] = current.split("?");
  return match(path ?? "/", search ? `?${search}` : "");
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
