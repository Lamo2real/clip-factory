// Clips Funded › Social accounts, organized like Clip Factory's Set up posting (docs/CONTRACTS.md §45.13, §45.16.7; the
// owner, 24 Nov: "can you make the social account page to look organized like this"): a progress card ("4 of 4 ready"
// with a ring) and one glass row per platform (its logo on a tile, its name, one status word and one short line, a
// check or an empty circle, and the way in), each opening that platform's own page (/stories/connections/<p>), which
// holds everything its card holds. Under each row, the way to skip it (asked first) or to bring it back (one tap). A
// skipped platform is never counted (the owner, 24 Nov: "if i skip on a platform setup then i dont want to see it
// anywhere except in settings or social accounts tab"): it shows here, and only here and on its own page, as Skipped.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { A } from "../../components/ui.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import type { Platform, SocialAccount } from "../api/types.ts";
import { ArcDial } from "../glass/index.ts";
import { storiesDeniedSound } from "../prefs.ts";
import { skippedLine, skipQuestion, socialHref } from "../skips.ts";
import { PLATFORM_NAME, StButton, StIcon, type StTone } from "../ui.tsx";

/** The rows' order, as Clip Factory's Set up posting lists them. */
export const ROW_ORDER: readonly Platform[] = ["youtube", "tiktok", "instagram", "facebook", "x"];

/**
 * Connect waits for the developer app (§45.30: never a fallback): Clip Factory's app on purpose, or Clips Funded's own
 * with its keys saved. The same test the platform's card uses (Connections.tsx exports it).
 */
export function appReady(a: Pick<SocialAccount, "app">): boolean {
  return a.app.choice === "clips" || (a.app.choice === "own" && a.app.saved);
}

/**
 * How long setting a platform up takes, the longest way (with an app of Clips Funded's own), and what it costs:
 * Clips Funded's own copy of the minutes in Clip Factory's guides.
 */
export const SETUP_TIME: Record<Platform, string> = {
  youtube: "About 20 minutes · Free",
  tiktok: "About 40 minutes · Free",
  instagram: "About 25 minutes · Free",
  facebook: "About 25 minutes · Free",
  x: "About 15 minutes · Costs a little",
};

export type RowState = "skipped" | "ready" | "needs_you" | "in_progress" | "not_started";

/** One platform's row: its state, the status word and its tone (none: the plain chip), and its one short line. */
export interface SocialRow {
  platform: Platform;
  state: RowState;
  chip: string;
  tone: StTone | null;
  line: string;
}

/** "Clips Funded · @fundedclips": the account's name, and its handle when it says more; "Connected" with neither. */
function whoLine(a: Pick<SocialAccount, "accountName" | "handle">): string {
  const name = a.accountName ?? null;
  if (name && a.handle && a.handle !== name) return `${name} · ${a.handle}`;
  return name ?? a.handle ?? "Connected";
}

/** A platform's row (the first rule that matches wins). */
export function rowOf(a: SocialAccount): SocialRow {
  const row = (state: RowState, chip: string, tone: StTone | null, line: string): SocialRow => ({ platform: a.platform, state, chip, tone, line });
  if (a.skipped) return row("skipped", "Skipped", null, "You won't post here.");
  switch (a.connectionStatus) {
    case "connected":
      return row("ready", "Ready", "mint", a.reason === "expires_soon" ? "Connect again soon." : whoLine(a));
    case "needs_reconnect":
      return row("needs_you", "Needs you", "coral", "Connect again.");
    case "same_as_clips":
      return row("needs_you", "Needs you", "coral", "That's Clip Factory's account.");
    case "choose_account":
      return row("needs_you", "Needs you", "sun", "Pick where to post.");
    default:
      break;
  }
  if (a.connectionStatus === "not_connected" && appReady(a)) return row("in_progress", "In progress", "sky", a.reason === "expired" ? "Connect again." : "Next: connect it.");
  return row("not_started", "Not started", "sky", SETUP_TIME[a.platform]);
}

/** The accounts in the rows' order (YouTube, TikTok, Instagram, Facebook, X). */
export function inRowOrder<T extends Pick<SocialAccount, "platform">>(accounts: readonly T[]): T[] {
  return [...accounts].sort((a, b) => ROW_ORDER.indexOf(a.platform) - ROW_ORDER.indexOf(b.platform));
}

/**
 * The progress card: how many of the places not skipped are ready ("3 of 4 ready"), and one line: every place is
 * ready, the first that needs the owner, or tap one to set it up. With all five skipped there is no count.
 */
export function socialProgress(accounts: readonly SocialAccount[]): { ready: number; total: number; title: string; line: string } {
  const rows = inRowOrder(accounts)
    .map(rowOf)
    .filter((r) => r.state !== "skipped");
  const ready = rows.filter((r) => r.state === "ready").length;
  const total = rows.length;
  if (total === 0) return { ready, total, title: "All skipped", line: "Tap one to bring it back." };
  const title = `${ready} of ${total} ready`;
  if (ready === total) return { ready, total, title, line: "Every place is ready." };
  const needs = rows.find((r) => r.state === "needs_you");
  if (needs) return { ready, total, title, line: `${PLATFORM_NAME[needs.platform]} needs you.` };
  return { ready, total, title, line: "Tap one to set it up." };
}

/** The list page's header card: a round glass puck with the plug, the title and one line. */
export function SocialHead() {
  return (
    <header className="st-social-head st-glass st-glass--hero st-lens">
      <span className="st-round-btn st-round-btn--lg st-social-head__puck" aria-hidden="true">
        <StIcon name="plug" size={26} />
      </span>
      <div className="st-social-head__text">
        <h1 className="st-social-head__title st-display">Social accounts</h1>
        <p className="st-social-head__lede">Clips Funded's own accounts. Clip Factory's stay as they are.</p>
      </div>
    </header>
  );
}

/** "3 of 4 ready" with its ring and one line (the places skipped are not counted). */
export function SocialProgress({ accounts }: { accounts: readonly SocialAccount[] }) {
  const id = useId();
  const pr = socialProgress(accounts);
  return (
    <section className="st-social-progress st-glass" aria-labelledby={id} data-ready={pr.ready} data-total={pr.total}>
      {pr.total > 0 ? (
        <ArcDial className="st-social-progress__dial" value={pr.ready} max={Math.max(1, pr.total)} label={pr.title} valueText={pr.title}>
          <span className="st-social-progress__num st-num">{pr.ready}</span>
          <span className="st-social-progress__of">of {pr.total}</span>
        </ArcDial>
      ) : null}
      <div className="st-social-progress__text">
        <h2 className="st-social-progress__title st-display" id={id}>
          {pr.title}
        </h2>
        <p className="st-social-progress__line">{pr.line}</p>
      </div>
    </section>
  );
}

/** A tap while something is still saving: nothing happens but the deny sound (kid-proof: never `disabled`). */
function whileBusy(busy: boolean, go: () => void): (e: MouseEvent<HTMLButtonElement>) => void {
  return (e) => {
    if (busy) {
      e.preventDefault();
      storiesDeniedSound();
      return;
    }
    go();
  };
}

/** One platform's row: the link to its page, and under a hairline its Skip (asked first) or Un-skip line. */
function RowItem({ a, busy, onSkip, onUnskip }: { a: SocialAccount; busy: boolean; onSkip: (p: Platform) => Promise<boolean>; onUnskip: (p: Platform) => Promise<boolean> }) {
  const p = a.platform;
  const name = PLATFORM_NAME[p];
  const row = rowOf(a);
  const question = skipQuestion(p);
  const [asking, setAsking] = useState(false);
  const sure = useRef<HTMLDivElement>(null);
  const skipLine = useRef<HTMLParagraphElement>(null);
  // Where focus goes when the question closes: back to the row's own line (its Skip, or its Un-skip once skipped).
  const back = useRef(false);
  useEffect(() => {
    if (asking) sure.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else if (back.current) {
      back.current = false;
      skipLine.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [asking]);
  // A skip that is no longer possible (it got ready meanwhile) closes the question.
  if (asking && (row.state === "ready" || row.state === "skipped")) setAsking(false);
  const keep = () => {
    back.current = true;
    setAsking(false);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    keep();
  };
  return (
    <li className="st-social-row-wrap st-glass" data-platform={p} data-state={row.state}>
      <A href={socialHref(p)} className={`st-social-row is-${row.state}`}>
        <span className={`st-social-row__mark st-conn__mark st-conn__mark--${p}`} aria-hidden="true">
          <PlatformMark platform={p} size={28} />
        </span>
        <span className="st-social-row__text">
          <span className="st-social-row__head">
            <span className="st-social-row__name st-display">{name}</span>
            <span className={`st-chip${row.tone ? ` st-chip--${row.tone}` : ""}`}>{row.chip}</span>
          </span>
          <span className="st-social-row__line">{row.line}</span>
        </span>
        {row.state === "ready" ? (
          <span className="st-social-row__done" aria-hidden="true">
            <StIcon name="check" size={18} />
          </span>
        ) : (
          <span className="st-social-row__todo" aria-hidden="true" />
        )}
        <span className="st-round-btn st-social-row__go" aria-hidden="true">
          <StIcon name="chevron" size={18} />
        </span>
      </A>
      {asking ? (
        // Skip asks first, right here (Keep it is the main answer, and Escape means Keep it); only Skip saves.
        <div className="st-sure st-social-row__sure" role="group" aria-label={question.title} ref={sure} onKeyDown={onKey}>
          <p className="st-sure__ask">
            <strong>{question.title}</strong> {question.text}
          </p>
          <div className="st-sure__buttons">
            <StButton main onClick={keep}>
              Keep it
            </StButton>
            <StButton
              quiet
              aria-disabled={busy || undefined}
              onClick={whileBusy(busy, () => {
                back.current = true;
                void onSkip(p).then((ok) => {
                  if (ok) setAsking(false);
                });
              })}
            >
              Skip {name}
            </StButton>
          </div>
        </div>
      ) : row.state === "skipped" ? (
        <p className="st-social-row__skip" data-skipped={p} ref={skipLine}>
          <span>{skippedLine(p)}</span>
          <StButton quiet aria-label={`Un-skip ${name}`} aria-disabled={busy || undefined} onClick={whileBusy(busy, () => void onUnskip(p))}>
            Un-skip
          </StButton>
        </p>
      ) : row.state !== "ready" ? (
        <p className="st-social-row__skip" data-skip={p} ref={skipLine}>
          <span>Want to do it later?</span>
          <StButton quiet aria-label={`Skip ${name}`} aria-disabled={busy || undefined} onClick={whileBusy(busy, () => setAsking(true))}>
            Skip
          </StButton>
        </p>
      ) : null}
    </li>
  );
}

/** The five rows, in order; two columns from about 700 px, one on phones. */
export function SocialRowList({
  accounts,
  busy,
  onSkip,
  onUnskip,
}: {
  accounts: readonly SocialAccount[];
  busy: boolean;
  onSkip: (p: Platform) => Promise<boolean>;
  onUnskip: (p: Platform) => Promise<boolean>;
}) {
  return (
    <ul className="st-social-rows" aria-label="Your five places">
      {inRowOrder(accounts).map((a) => (
        <RowItem key={a.platform} a={a} busy={busy} onSkip={onSkip} onUnskip={onUnskip} />
      ))}
    </ul>
  );
}
