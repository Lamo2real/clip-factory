// The floating setup to-do list (docs/CONTRACTS.md §17.13): one row per platform, and when the list shows at all.
// Pure rules, so the visibility logic is tested on its own (test/setupTodo.test.ts).
import type { Platform, PlatformSetup } from "../api/types.ts";
import { GUIDES, SETUP_ORDER } from "../setup/index.ts";
import { computeReady, notStarted, progressOf } from "./setupProgress.ts";

/**
 * A row's state. `needs_you`: an account exists but wants the owner (connect again, pick an account, a gate to clear),
 * which is how a platform that was ready comes back to the list.
 */
export type TodoState = "ready" | "skipped" | "in_progress" | "not_started" | "needs_you";

export interface TodoRow {
  platform: Platform;
  state: TodoState;
  /** Steps done and steps that count (§17.1 progressOf). */
  done: number;
  total: number;
  /** The one short line under the name: "Ready", "Skipped", "In progress: 4 of 23", "Not started", "Needs you". */
  line: string;
  /** The account is connected (posting to it is tried), though a gate may still need the owner. */
  connected: boolean;
}

/** True when this platform's row is finished: ready, or skipped (and confirmed). */
export const isFinished = (row: TodoRow) => row.state === "ready" || row.state === "skipped";

/**
 * The five rows, in SETUP_ORDER. `skipped` is the server's list (Settings.setupSkipped): only confirmed skips. Ready
 * wins over a skip; any platform that is not ready can be skipped, whatever its state (not started, half done, or an
 * account that needs the owner). A skip is dropped once the platform is ready (`staleSkips`), so a platform that was
 * ready and stops being ready always comes back to the list.
 */
export function todoRows(setups: readonly PlatformSetup[] | null | undefined, skipped: readonly Platform[] = []): TodoRow[] {
  return SETUP_ORDER.map((platform) => {
    const setup = setups?.find((s) => s.platform === platform) ?? null;
    const progress = progressOf(GUIDES[platform], setup);
    const status = setup?.account.status ?? "not_connected";
    const base = { platform, done: progress.done, total: progress.total, connected: status === "connected" };
    if (setup && computeReady(setup)) return { ...base, state: "ready", line: "Ready" };
    if (skipped.includes(platform)) return { ...base, state: "skipped", line: "Skipped" };
    if (status !== "not_connected") {
      const line = status === "needs_reconnect" ? "Needs you: connect again" : status === "choose_account" ? "Needs you: pick an account" : "Needs you: one more step";
      return { ...base, state: "needs_you", line };
    }
    if (notStarted(setup)) return { ...base, state: "not_started", line: "Not started" };
    return { ...base, state: "in_progress", line: `In progress: ${progress.done} of ${progress.total}` };
  });
}

/** The list shows while any row is not finished. Without data yet (`null`) it does not show. */
export function todoVisible(rows: readonly TodoRow[] | null): boolean {
  return !!rows && rows.some((r) => !isFinished(r));
}

/** "2/5": how many rows are finished (ready or skipped). Reminders count with `listCount`, which leaves skips out. */
export function todoCount(rows: readonly TodoRow[]): { finished: number; total: number } {
  return { finished: rows.filter(isFinished).length, total: rows.length };
}

/**
 * The rows a reminder lists: every row that is not skipped. A skipped platform leaves the floating list and every
 * count and nudge; only Settings › Posting › Set up posting (and its own step page) still shows it, with Un-skip.
 */
export function listRows(rows: readonly TodoRow[]): TodoRow[] {
  return rows.filter((r) => r.state !== "skipped");
}

/** "3 of 4": the ready rows over the rows that are not skipped. All five skipped: `{ ready: 0, total: 0 }`. */
export function listCount(rows: readonly TodoRow[]): { ready: number; total: number } {
  const shown = listRows(rows);
  return { ready: shown.filter((r) => r.state === "ready").length, total: shown.length };
}

/**
 * A list of platforms without the skipped ones, in the list's own order. Pass only skips of platforms that are not
 * ready (ready wins over a skip), or a list of places that are not ready, so a stale skip never hides a ready place.
 */
export function withoutSkipped<P extends Platform>(list: readonly P[], skipped: readonly Platform[] = []): P[] {
  return list.filter((p) => !skipped.includes(p));
}

/** The skips that count now: confirmed skips of platforms that are not ready (ready wins over a skip). */
export function activeSkips(setups: readonly PlatformSetup[] | null | undefined, skipped: readonly Platform[] = []): Platform[] {
  return todoRows(setups, skipped)
    .filter((r) => r.state === "skipped")
    .map((r) => r.platform);
}

/** A confirmed skip: the platform joins the list (canonical order, no repeats). Asking alone changes nothing. */
export function withSkip(skipped: readonly Platform[], platform: Platform): Platform[] {
  return SETUP_ORDER.filter((p) => p === platform || skipped.includes(p));
}

/** Un-skip: the platform leaves the list. */
export function withoutSkip(skipped: readonly Platform[], platform: Platform): Platform[] {
  return SETUP_ORDER.filter((p) => p !== platform && skipped.includes(p));
}

/**
 * Skips that no longer mean anything: platforms that are ready now (one the owner skipped and then set up anyway).
 * They are dropped, so if it stops being ready later its row comes back instead of hiding as "skipped".
 */
export function staleSkips(rows: readonly TodoRow[], skipped: readonly Platform[]): Platform[] {
  return skipped.filter((p) => rows.find((r) => r.platform === p)?.state === "ready");
}

/**
 * The words of the skip question (kid-proof, §17.13). A connected platform is still posted to (a gate needs the
 * owner), so its text does not promise that nothing is posted.
 */
export function skipQuestion(platform: Platform, connected = false): { title: string; text: string } {
  const name = GUIDES[platform].name;
  return {
    title: `Skip ${name}?`,
    text: connected
      ? `${name} is connected but needs one more step. Skip only takes it off this list. You can finish it later in Settings.`
      : "You won't post there until you set it up. You can do it later in Settings.",
  };
}

/** The line under a skipped platform in Settings › Posting › Set up posting. */
export function skippedNote(platform: Platform, connected = false): string {
  const name = GUIDES[platform].name;
  return connected ? `${name} is connected but needs one more step.` : `You won't post to ${name} until you set it up.`;
}

/** The line under "All set!", from how the list ended: all ready, all skipped, or a mix. */
export function doneLine(rows: readonly TodoRow[]): string {
  const skipped = rows.filter((r) => r.state === "skipped").length;
  if (skipped === 0) return "Every place is ready.";
  if (skipped === rows.length) return "All skipped. Set them up any time in Settings.";
  return "Done for now. Skipped ones wait in Settings.";
}

/** How long the "All set!" card stays before it slides away (half as long with reduced motion). */
export const TODO_CELEBRATE_MS = 2600;

/** This device remembers that it showed an unfinished list, so finishing it on a later page load still celebrates. */
export const TODO_SEEN_KEY = "cf-setup-todo-open";
/** Whether the list is folded to its small pill on this device (wide screens; phones always start as the pill). */
export const TODO_COLLAPSED_KEY = "cf-setup-todo-collapsed";

/** Pages where the floating list would repeat what is already on the page: the setup list and each platform page. */
export function todoHiddenOn(pathname: string): boolean {
  return /^\/settings\/posting\/setup(\/|$)/.test(pathname);
}

/**
 * From this width the list stays open in a column of its own. The column takes 352 px from the page, so the page
 * keeps at least the room its two-column layouts were made for (they start at a 1100 px window with nothing beside
 * the page): at 1440 px the page is 786 px wide, at 1100 px without the list it is 764 px. Narrower windows get the pill.
 */
export const TODO_RAIL_MIN = 1440;
export const TODO_RAIL_QUERY = `(min-width: ${TODO_RAIL_MIN}px)`;

/**
 * Pages that need the whole width even on wide screens (a clip's page fans its five columns out from 1060 px of
 * room): there the list is the pill, never the open column.
 */
export function todoNoRailOn(pathname: string): boolean {
  return /^\/clips\//.test(pathname);
}
