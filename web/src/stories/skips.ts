// Clips Funded's platform skips (the owner, 24 Nov: "if i skip on a platform setup then i dont want to see it
// anywhere except in settings or social accounts tab"). A platform the owner skipped (ONBOARD.skipped, saved with the
// setup's own PATCH …/onboarding {step, skipped}) that is not connected is left out of every reminder, count, "N left"
// list and "connect X" nudge. It shows only on Social accounts (its row says Skipped, with Un-skip), on its own page and
// in the setup, which Clips Funded's nav counts as Settings. Connected wins: the API drops the skip on its next read.
// Clip Factory's skips (its Settings.setupSkipped) are its own: nothing here reads or writes them.
import { useRef, useState } from "react";
import { friendlyMessage } from "../api/errors.ts";
import { useToast } from "../components/Toasts.tsx";
import { storiesApi } from "./api/client.ts";
import type { Onboarding, OnboardStep, Platform } from "./api/types.ts";
import { PLATFORM_NAME, refreshDashboard, setOnboarding } from "./ui.tsx";

/** The setup's five platform steps, in the setup's order. */
export const PLATFORM_STEPS: readonly Platform[] = ["instagram", "tiktok", "youtube", "facebook", "x"];

const isPlatformStep = (step: OnboardStep): step is Platform => (PLATFORM_STEPS as readonly string[]).includes(step);

/** A platform step the owner skipped (and that is not connected: a connected one is "done"). */
export function isSkippedPlatform(s: Onboarding["steps"][number]): boolean {
  return s.state === "skipped" && isPlatformStep(s.step);
}

/** What is left: every step not done, in order, without Done itself and without a skipped platform. */
export function leftOf(o: Onboarding): Onboarding["steps"] {
  return o.steps.filter((s) => s.state !== "done" && s.step !== "done" && !isSkippedPlatform(s));
}

/** The platform's own page under Social accounts. */
export const socialHref = (p: Platform) => `/stories/connections/${p}`;

const SOCIAL_PATH = /^\/stories\/connections(?:\/(?:youtube|tiktok|instagram|facebook|x))?$/;

/** Social accounts or one platform's page there (its query, hash and a last slash aside). */
export function isSocialHref(href: string): boolean {
  const path = href.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return SOCIAL_PATH.test(path);
}

/** Skip asks first: its question and its one line. */
export function skipQuestion(p: Platform): { title: string; text: string } {
  return { title: `Skip ${PLATFORM_NAME[p]}?`, text: "You won't post there until you set it up. You can come back here any time." };
}

/** A skipped platform's line beside its Un-skip. */
export function skippedLine(p: Platform): string {
  return `You won't post to ${PLATFORM_NAME[p]} until you set it up.`;
}

/**
 * Skip and Un-skip a platform: the setup's own PATCH, then the setup, the dashboard (and the Needs you bar) and `after`
 * (the page's own reload) follow. A second tap while one is on its way does nothing (false). An error is a toast in
 * plain words, and false.
 */
export function useSkip(
  ws: string,
  after?: () => unknown,
): { busy: Platform | null; skip: (p: Platform) => Promise<boolean>; unskip: (p: Platform) => Promise<boolean> } {
  const toast = useToast();
  const [busy, setBusy] = useState<Platform | null>(null);
  const flying = useRef(false);
  const change = async (p: Platform, skipped: boolean): Promise<boolean> => {
    if (flying.current) return false;
    flying.current = true;
    setBusy(p);
    try {
      const next = await storiesApi().patchOnboarding(ws, { step: p, skipped });
      setOnboarding(ws, next);
      toast.success(skipped ? "Skipped. You can un-skip it here." : `${PLATFORM_NAME[p]} is back.`);
      await Promise.all([refreshDashboard(ws).catch(() => undefined), Promise.resolve().then(() => after?.()).catch(() => undefined)]);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      flying.current = false;
      setBusy(null);
    }
  };
  return { busy, skip: (p) => change(p, true), unskip: (p) => change(p, false) };
}
