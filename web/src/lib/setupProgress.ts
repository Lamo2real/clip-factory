// How far each platform's setup is (docs/CONTRACTS.md §17.1): which steps are done, the ring, the current step and
// the one state line on the platform card.
import type { Gate, PlatformSetup } from "../api/types.ts";
import { allSteps, type GuideStep, type SetupGuide } from "../setup/index.ts";

/** Auto steps tick themselves from what the server knows; the rest are ticked with "I did this". */
export function stepDone(step: GuideStep, setup: PlatformSetup | null | undefined): boolean {
  if (!setup) return false;
  switch (step.auto) {
    case "keys":
      return setup.keys.saved;
    case "connected":
      return setup.account.status === "connected";
    case "checked":
      return setup.keys.check?.ok === true;
    case "files":
      return (setup.files?.length ?? 0) > 0;
    default:
      return setup.stepsDone.includes(step.id);
  }
}

/** Ready = connected, and no gate needs the owner (§17.4). */
export function computeReady(setup: Pick<PlatformSetup, "account" | "gates">): boolean {
  return setup.account.status === "connected" && !setup.gates.some((g: Gate) => g.state === "action");
}

export interface Progress {
  /** Steps that count (not optional) and are done. */
  done: number;
  /** Steps that count. */
  total: number;
  /** For the ring: 1 once the platform is ready. */
  fraction: number;
  /** The first step that counts and is not done: it opens by itself. */
  current: GuideStep | null;
  /** Its number, 1…N across all parts (0 when none). */
  currentNumber: number;
  /** Every step, optional ones too. */
  steps: number;
  ready: boolean;
}

export function progressOf(guide: SetupGuide, setup: PlatformSetup | null | undefined): Progress {
  const list = allSteps(guide);
  const counted = list.filter((s) => !s.optional);
  const done = counted.filter((s) => stepDone(s, setup)).length;
  const ready = !!setup?.ready;
  const currentIndex = list.findIndex((s) => !s.optional && !stepDone(s, setup));
  const current = currentIndex >= 0 ? list[currentIndex]! : null;
  return {
    done,
    total: counted.length,
    fraction: ready ? 1 : counted.length ? done / counted.length : 0,
    current,
    currentNumber: currentIndex + 1,
    steps: list.length,
    ready,
  };
}

/** True when nothing was done yet: no step ticked, no keys. */
export function notStarted(setup: PlatformSetup | null | undefined): boolean {
  return !setup || (setup.stepsDone.length === 0 && !setup.keys.saved && setup.account.status === "not_connected");
}

/** Posting works, but what is posted stays private (TikTok before its audit, Facebook before Live). */
export function postsPrivate(setup: PlatformSetup | null | undefined): boolean {
  if (!setup?.ready) return false;
  return setup.gates.some(
    (g) => (g.key === "posting_audit" && g.state === "limited") || (g.key === "app_live" && g.state === "limited"),
  );
}

/** The one line on a platform card: "Ready" / "Step 7 of 23" / "Needs you: connect again" / "Not started" / … */
export function stateLine(guide: SetupGuide, setup: PlatformSetup | null | undefined): string {
  if (!setup) return "Checking…";
  if (setup.account.status === "needs_reconnect") return "Needs you: connect again";
  if (setup.account.status === "choose_account") return "Needs you: pick an account";
  if (setup.ready) return postsPrivate(setup) ? "Works now, posts stay private" : "Ready";
  if (setup.account.status === "connected") return "Needs you: one more step";
  if (notStarted(setup)) return "Not started";
  const p = progressOf(guide, setup);
  return p.current ? `Step ${p.currentNumber} of ${p.steps}` : "Almost there";
}

/** When it's done's state line under the account, in step with the platform card's own line (stateLine). */
export function doneLine(
  name: string,
  setup: PlatformSetup,
  { leaving = false, macOn = false }: { leaving?: boolean; macOn?: boolean } = {},
): string {
  if (leaving) return "Disconnecting…";
  if (setup.account.status === "needs_reconnect") return `${name} logged Clip Factory out. Press Connect again.`;
  if (!setup.ready) return "Connected.";
  if (!postsPrivate(setup)) return "Ready. Clip Factory posts here by itself.";
  // TikTok before its audit: only the owner's Mac posts for everyone (§47).
  if (setup.platform === "tiktok")
    return macOn ? "Works now, posts stay private. Your Mac posts TikTok for everyone." : "Works now, posts stay private. To post for everyone, turn on Your Mac posts TikTok.";
  return "Works now, posts stay private.";
}

/** After a Connect again that was cancelled or failed while the account still works: nothing changed. */
export function stillConnectedLine(name: string): string {
  return `Still connected as ${name}. Nothing changed.`;
}
