// The sheet Pick your bank (docs/CONTRACTS.md §40.5.2 Connect, step 1), filled from GET /v1/getpaid/bank/banks: its
// lead lines, a search box that only filters, then one big row per bank, the banks most used in Sweden first, then
// A to Z. A bank he already has says "Already here: tap to reconnect". Without a Money country, or with no linked
// account from it, the sheet says so and offers the one way on (glass, never the vermilion).
import { useEffect, useId, useMemo, useState } from "react";
import { api } from "../../../api/index.ts";
import { friendlyMessage } from "../../../api/errors.ts";
import type { BankChoice, BankView } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Sheet } from "../../../components/Sheet.tsx";
import { Button, LinkButton } from "../../../components/ui.tsx";
import { NO_COUNTRY_HREF, OPEN_APPS, PICKER_AGAIN, PICKER_LEAD, PICKER_NEW, filterBanks, sortBanks, type BankError } from "../../../getpaid/bank.ts";
import { OpenButton } from "../../campaigns/bits.tsx";
import { Rich } from "../../settings/setup/bits.tsx";

export type PickedBank = { bank: string } | { linkId: string; bank: string };

type BanksLoad = { state: "loading" } | { state: "ok"; banks: BankChoice[] } | { state: "error"; code?: string; message: string };

export function BankPicker({ view, onClose, onPick }: { view: BankView; onClose: () => void; onPick: (b: PickedBank) => Promise<unknown> }) {
  const id = useId();
  const [load, setLoad] = useState<BanksLoad>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    api()
      .bankBanks()
      .then((r) => live && setLoad({ state: "ok", banks: sortBanks(r.banks) }))
      .catch((e: unknown) => live && setLoad({ state: "error", code: (e as BankError).bankCode, message: friendlyMessage(e) }));
    return () => {
      live = false;
    };
  }, [tries]);
  const shown = useMemo(() => (load.state === "ok" ? filterBanks(load.banks, query) : []), [load, query]);
  const already = (name: string) => view.links.find((l) => l.bank.toLowerCase() === name.toLowerCase());

  async function pick(b: BankChoice) {
    setBusy(b.name);
    const have = already(b.name);
    try {
      await onPick(have ? { linkId: have.linkId, bank: have.bank } : { bank: b.name });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet
      title="Pick your bank"
      onClose={onClose}
      actions={
        <Button variant="ghost" size="lg" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="bank-picker" data-help="bank-picker">
        <p className="bank-picker__lead">{PICKER_LEAD}</p>
        {view.links.length ? (
          <div className="bank-picker__new">
            <p>
              <Rich text={PICKER_NEW} />
            </p>
            <OpenButton label={OPEN_APPS.label} href={OPEN_APPS.url} size="md" />
          </div>
        ) : null}
        {load.state === "error" ? (
          <div className="bank-picker__error" role="alert" data-code={load.code ?? ""}>
            <p>{load.message}</p>
            {load.code === "no_country" ? (
              <LinkButton href={NO_COUNTRY_HREF} variant="glass" size="md" icon="globe">
                Pick my country
              </LinkButton>
            ) : load.code === "country_not_linked" ? (
              <OpenButton label={OPEN_APPS.label} href={OPEN_APPS.url} size="md" />
            ) : (
              <Button variant="glass" size="md" icon="retry" act="retry" onClick={() => setTries((n) => n + 1)}>
                Try again
              </Button>
            )}
          </div>
        ) : (
          <>
            <label className="bank-picker__label" htmlFor={`${id}-q`}>
              Find your bank
            </label>
            <div className="find__box bank-picker__box">
              <Icon name="search" size={20} />
              <input id={`${id}-q`} className="find__input" type="search" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} aria-controls={`${id}-list`} />
            </div>
            {load.state === "loading" ? (
              <p className="bank-picker__small" role="status">
                Loading the banks…
              </p>
            ) : (
              <ul className="bank-picker__list" id={`${id}-list`} aria-label="Banks">
                {shown.map((b) => {
                  const have = already(b.name);
                  return (
                    <li key={b.name}>
                      <button type="button" className="bank-pick" data-bank={b.name} disabled={busy !== null} aria-busy={busy === b.name || undefined} onClick={() => void pick(b)}>
                        <Icon name="card" size={22} />
                        <span className="bank-pick__text">
                          <span className="bank-pick__name">{b.name}</span>
                          {have ? <span className="bank-pick__again">{PICKER_AGAIN}</span> : null}
                        </span>
                        <Icon name={busy === b.name ? "retry" : "chevronRight"} size={20} className="icon bank-pick__go" />
                      </button>
                    </li>
                  );
                })}
                {!shown.length ? <li className="bank-picker__small">No bank has that name. Try fewer letters.</li> : null}
              </ul>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
