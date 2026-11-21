// The Mac app's "send this now" banner (docs/CONTRACTS.md §38.6): there is no Web Push in the desktop window (§32.7),
// so while a campaign post waits to be sent by hand with time left, a glass banner says so on every page except the
// one already showing that line: the same line and one green "Copy and open". No sound. It sits in the page's flow,
// so it never covers a control.
import type { Route } from "../lib/router.ts";
import { reloadCr, sendGroups, useCr } from "../lib/contentRewards.ts";
import { SendLine } from "./CrPostLine.tsx";

function isDesktop(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __CF_DESKTOP__?: unknown }).__CF_DESKTOP__;
}

export function CrSendNow({ route }: { route: Route }) {
  const cr = useCr();
  if (!isDesktop() || cr.state !== "ok") return null;
  const groups = sendGroups(cr.data.waitingSends).filter((g) => {
    if (route.name === "clip" && route.clipId === g.clipId) return false;
    if (route.name === "campaign" && route.campaignId === g.campaignId) return false;
    return true;
  });
  const first = groups[0];
  if (!first) return null;
  return (
    <div className="cr-sendnow glass" role="region" aria-label="Send to Content Rewards">
      <SendLine group={first} banner onChange={() => void reloadCr()} />
    </div>
  );
}
