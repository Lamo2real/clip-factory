// One match of the campaign finder (docs/CONTRACTS.md §41.1): its head (a round letter, the name, the brand, "New",
// open or apply), and once open, the pay per place, the money left (Content Rewards' numbers), why it matched, the
// server's notes, heads-ups and can't-tell lines, then the buttons. Every match has "Open on Content Rewards"; only
// the open match's main button is vermilion, and only when the page gives it the vermilion. After Open, the steps on
// Content Rewards and "I joined: add it" (an application: "I applied: add it") lead for 2 hours.
import { useId, useState } from "react";
import type { FinderMatch } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { Button, Progress } from "../../components/ui.tsx";
import { budgetChip, safeHref } from "../../lib/contentRewards.ts";
import { IF_YOU_SEE, STEPS_APPLY, STEPS_OPEN_BY_HAND, STEPS_OPEN_SIGNED_IN, clockTime, openedRecently } from "../../lib/finder.ts";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { CopyChip, Rich } from "../settings/setup/bits.tsx";
import { BrandMark, Hints, OpenButton } from "./bits.tsx";
import { RulesBox } from "./NextStep.tsx";

export function FinderMatchCard({
  match,
  open,
  isNew,
  openedAt,
  signedIn,
  main,
  pinned,
  adding,
  error,
  copies,
  now,
  onToggle,
  onOpen,
  onAdd,
  onNotForMe,
}: {
  match: FinderMatch;
  open: boolean;
  /** From the page's frozen "New" set (it never vanishes while he reads). */
  isNew: boolean;
  /** When he tapped Open on Content Rewards (this visit's tap, else the server's). */
  openedAt?: string;
  signedIn: boolean;
  /** This match holds the screen's vermilion. */
  main: boolean;
  pinned: boolean;
  adding: boolean;
  error: string | null;
  /** "Your YouTube link" chips for an application's questions. */
  copies: { label: string; value: string }[];
  now: number;
  onToggle: () => void;
  onOpen: () => void;
  /** I joined: add it, with the pasted rules (or "" for There are no rules to copy). */
  onAdd: (rules: string) => unknown;
  onNotForMe: () => void;
}) {
  const id = useId();
  const [rules, setRules] = useState("");
  const href = safeHref(match.url, "https://contentrewards.com/c/discover");
  const apply = match.access === "application";
  const fresh = openedRecently(openedAt, now);
  const wasOpened = !!openedAt;
  // Open leads until he opened it; then I joined: add it leads for 2 hours, and Open again after that.
  const addLeads = wasOpened && fresh;
  const addLabel = apply ? "I applied: add it" : "I joined: add it";
  const byHand = !apply && !signedIn;
  const steps = apply ? STEPS_APPLY : byHand ? STEPS_OPEN_BY_HAND : STEPS_OPEN_SIGNED_IN;
  const chip = budgetChip(match.budget.usedPct);

  const openBtn = (primary: boolean) => <OpenButton label="Open on Content Rewards" href={href} primary={primary} size={primary ? "lg" : "md"} onOpen={onOpen} />;
  const addBtn = (primary: boolean) => (
    <Button
      variant={primary ? "primary" : "glass"}
      size={primary ? "lg" : "md"}
      icon="plus"
      act="add"
      loading={adding}
      data-help-clear={primary ? "" : undefined}
      onClick={() => onAdd(byHand ? rules : "")}
    >
      {adding ? "Adding…" : addLabel}
    </Button>
  );

  const head = (
    <button type="button" className="finder-match__head" aria-expanded={open} aria-controls={open ? `${id}-body` : undefined} onClick={onToggle}>
      <BrandMark name={match.brand || match.name} />
      <span className="finder-match__title">
        <span className="finder-match__name user-text clamp-2">{match.name.slice(0, 300)}</span>
        <span className="finder-match__brand user-text">{match.brand.slice(0, 300)}</span>
        <span className="finder-match__chips">
          {isNew ? (
            <span className="pill pill--success finder-new">
              <span className="pill__text">New</span>
            </span>
          ) : null}
          <span className="pill pill--neutral">
            <span className="pill__text">{apply ? "You apply first" : "Open to join"}</span>
          </span>
        </span>
      </span>
      <Icon name="chevronRight" size={20} className="icon finder-match__chev act-turn" />
    </button>
  );

  if (!open)
    return (
      <li className="finder-match glass" data-help="cr-finder-match" data-campaign={match.campaignId}>
        {head}
        <div className="finder-match__folded">{openBtn(false)}</div>
      </li>
    );

  const mainBtn = addLeads ? addBtn(main) : openBtn(main);
  return (
    <li className={`finder-match glass is-open${pinned && main ? " has-pin" : ""}`} data-help="cr-finder-match" data-campaign={match.campaignId}>
      {head}
      <div className="finder-match__body" id={`${id}-body`}>
        {match.pay.length ? (
          <ul className="cr-pay__rows finder-match__pay" aria-label="Pay">
            {match.pay.map((p) => (
              <li key={p.platform} className="cr-pay__row">
                <PlatformMark platform={p.platform} size={20} />
                <span>
                  <span className="cr-pay__place">{PLATFORM_LABEL[p.platform]}</span> · {p.line}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {match.budget.line ? (
          <div className="cr-budget finder-match__money">
            <p>{match.budget.line}</p>
            {match.budget.usedPct !== null ? <Progress value={1 - match.budget.usedPct / 100} label="Money left" tone="success" /> : null}
            {chip ? (
              <span className={`pill pill--${chip === "Half used" ? "neutral" : "success"}`}>
                <span className="pill__text">{chip}</span>
              </span>
            ) : null}
            <span className="finder-match__tag">
              {match.budget.tag}
              {clockTime(match.budget.asOf) ? `, ${clockTime(match.budget.asOf)}` : ""}
            </span>
          </div>
        ) : null}
        <p className="finder-match__why">
          <span className="finder-match__why-label">Why it matched</span>
          <span>{match.why}</span>
        </p>
        {match.notes.length || match.headsUp.length || match.cantTell.length ? (
          <ul className="finder-match__lines">
            {match.notes.slice(0, 3).map((n) => (
              <li key={n} className="finder-line">
                <Icon name="info" size={18} />
                <span>{n}</span>
              </li>
            ))}
            {match.headsUp.slice(0, 3).map((n) => (
              <li key={n} className="finder-line is-heads">
                <Icon name="alert" size={18} />
                <span>{n}</span>
              </li>
            ))}
            {match.cantTell.slice(0, 3).map((n) => (
              <li key={n} className="finder-line is-cant">
                <Icon name="question" size={18} />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {wasOpened ? (
          <div className="finder-steps">
            <ol className="cr-next__lines">
              {steps.map((l, i) => (
                <li key={l}>
                  <span className="cr-next__n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span>
                    <Rich text={l} />
                  </span>
                </li>
              ))}
            </ol>
            {apply && copies.length ? (
              <div className="gstep__copies">
                {copies.map((c) => (
                  <CopyChip key={c.label} label={c.label} value={c.value} quiet />
                ))}
              </div>
            ) : null}
            <details className="cr-fold">
              <summary className="cr-fold__q">
                <Icon name="info" size={18} />
                <span>If you see…</span>
                <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
              </summary>
              <div className="cr-fold__body">
                <Hints list={IF_YOU_SEE} />
              </div>
            </details>
            {byHand ? (
              <>
                <RulesBox value={rules} onChange={setRules} />
                <Button variant="ghost" size="sm" onClick={() => onAdd("")}>
                  There are no rules to copy
                </Button>
              </>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="field__status is-bad" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
          </p>
        ) : null}

        {/* The main button first; on phones it is the card's last thing, pinned at the bottom right (§38.1). */}
        {pinned && main ? null : <div className="finder-match__main">{mainBtn}</div>}
        <div className="finder-match__actions">
          {wasOpened ? (addLeads ? openBtn(false) : addBtn(false)) : null}
          <Button variant="ghost" size="sm" icon="x" onClick={onNotForMe}>
            Not for me
          </Button>
        </div>
        {pinned && main ? <div className="finder-match__main cr-pin">{mainBtn}</div> : null}
      </div>
    </li>
  );
}
