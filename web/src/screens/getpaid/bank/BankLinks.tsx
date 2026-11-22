// Your banks (docs/CONTRACTS.md §40.5.2): one glass card per bank link, newest first: the bank's name, how many
// accounts, the pill and line, when Clip Factory last looked, and a small ring of the days left out of the link's
// length (warn at 14 days or less, red once ended). A glass "Reconnect Swedbank" when the link needs it (always glass
// here: when it is the page's next step, the vermilion copy is the one in the status block) and a quiet "Stop
// reading Swedbank" with the 8 s Undo. No Check now here: the one in When it's done reads every bank. A stopped link
// stays as a quiet row with a glass "Connect Swedbank again".
import { useState } from "react";
import { api } from "../../../api/index.ts";
import { friendlyMessage } from "../../../api/errors.ts";
import type { BankLink, BankView } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { ProgressRing } from "../../../components/ProgressRing.tsx";
import { useToast } from "../../../components/Toasts.tsx";
import { Button } from "../../../components/ui.tsx";
import { BANK_STATUS_ICON } from "../../../getpaid/bank.ts";
import { reloadBank, useHeld } from "../../../lib/bank.ts";
import { plural, relative } from "../../../lib/format.ts";

/** A Your bank pill: the server's words, its tone and an icon, never colour alone. */
export function BankPill({ status, tone, pill }: Pick<BankLink, "tone" | "pill"> & { status: BankView["status"] }) {
  return (
    <span className={`gp-pill gp-pill--${tone}`} data-status={status} data-tone={tone}>
      <Icon name={BANK_STATUS_ICON[status]} size={16} />
      <span className="gp-pill__text">{pill}</span>
    </span>
  );
}

/** The ring of a link's days: `daysLeft` out of `totalDays`, warn at 14 days or less, red once ended. */
export function DaysRing({ link, size = 76 }: { link: Pick<BankLink, "daysLeft" | "totalDays" | "status" | "bank">; size?: number }) {
  const left = link.daysLeft ?? 0;
  const total = link.totalDays || 1;
  const ended = link.status === "ended" || link.status === "stopped_at_bank" || link.status === "stopped";
  const tone = ended ? "is-ended" : left <= 14 ? "is-warn" : "";
  return (
    <ProgressRing value={ended ? 0 : left / total} size={size} stroke={6} label={`${link.bank}: ${plural(left, "day")} left of ${plural(total, "day")}`} className={`bank-ring ${tone}`}>
      <span className="bank-ring__words" aria-hidden="true">
        <span className="bank-ring__n">{ended ? 0 : left}</span>
        {/* "143 days left" inside; a small ring (the Your bank card's) has room for the number only. */}
        {size >= 64 ? <span className="bank-ring__unit">days left</span> : null}
      </span>
    </ProgressRing>
  );
}

/** The link that ends first (not stopped), for the header's ring once a bank is connected. */
export function firstEnding(view: BankView) {
  return view.links.filter((l) => l.status !== "stopped" && l.daysLeft !== undefined && l.totalDays).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))[0] ?? null;
}

/** The Your bank ring: the setup steps while he is setting up; once a bank is connected, the days left of the first to end. */
export function BankRing({ view, size }: { view: BankView; size: number }) {
  const link = firstEnding(view);
  if (link) return <DaysRing link={link} size={size} />;
  return (
    <ProgressRing value={view.ring.done / view.ring.total} size={size} label={`Your bank: ${view.ring.done} of ${view.ring.total} steps done`}>
      {view.ring.done === view.ring.total ? <Icon name="check" size={size > 60 ? 26 : 18} /> : `${view.ring.done}/${view.ring.total}`}
    </ProgressRing>
  );
}

export function BankLinks({ view, onReconnect, connecting }: { view: BankView; onReconnect: (linkId: string) => void; connecting: string | null }) {
  const toast = useToast();
  const hold = useHeld();
  const [stopping, setStopping] = useState<string[]>([]);

  function stop(link: BankLink) {
    setStopping((s) => [...s, link.linkId]);
    const held = hold(() => {
      api()
        .bankStopLink(link.linkId)
        .then(() => reloadBank())
        .catch((e) => toast.error(friendlyMessage(e)))
        .finally(() => setStopping((s) => s.filter((x) => x !== link.linkId)));
    });
    toast.undo(`Stopping ${link.bank}…`, {
      icon: "stop",
      signal: held.signal,
      onUndo: () => {
        held.drop();
        setStopping((s) => s.filter((x) => x !== link.linkId));
      },
      onCommit: held.send,
    });
  }

  return (
    <section className="bank-links" data-help="bank-links" aria-labelledby="bank-links-title">
      <h2 className="setup-part__title" id="bank-links-title">
        Your banks
      </h2>
      <ul className="bank-links__list">
        {view.links.map((link) =>
          link.status === "stopped" ? (
            <li key={link.linkId} className="bank-link is-stopped" data-link={link.linkId} data-status="stopped">
              <Icon name="card" size={22} />
              <p className="bank-link__line">{link.line}</p>
              <Button variant="glass" size="md" icon="link" act="connect" loading={connecting === link.linkId} onClick={() => onReconnect(link.linkId)}>
                Connect {link.bank} again
              </Button>
            </li>
          ) : (
            <li key={link.linkId} className={`bank-link glass${stopping.includes(link.linkId) ? " is-stopping" : ""}`} data-link={link.linkId} data-status={link.status}>
              <div className="bank-link__head">
                <span className="gp-bank__icon" aria-hidden="true">
                  <Icon name="card" size={24} />
                </span>
                <div className="bank-link__title">
                  <h3 className="bank-link__name">{link.bank}</h3>
                  <p className="bank-link__small">{plural(link.accounts, "account")}</p>
                </div>
                {link.daysLeft !== undefined && link.totalDays ? <DaysRing link={link} /> : null}
              </div>
              <div className="bank-link__text">
                <BankPill status={link.status} tone={link.tone} pill={link.pill} />
                <p className="bank-link__line">{link.line}</p>
                {link.lastError ? <p className="bank-link__error">{link.lastError}</p> : null}
                {link.checkedAt ? <p className="bank-link__small">Checked {relative(link.checkedAt)}</p> : null}
              </div>
              <div className="bank-link__actions">
                {link.reconnect ? (
                  <Button variant="glass" size="md" icon="retry" act="connect" loading={connecting === link.linkId} onClick={() => onReconnect(link.linkId)} data-bank="reconnect-card">
                    Reconnect {link.bank}
                  </Button>
                ) : null}
                {link.canStop ? (
                  <Button variant="ghost" size="md" icon="stop" disabled={stopping.includes(link.linkId)} onClick={() => stop(link)}>
                    Stop reading {link.bank}
                  </Button>
                ) : null}
              </div>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
