// Is this from an app? (docs/CONTRACTS.md §40.5.2): one glass card per payment his bank booked that may be app money,
// newest first, at most 20, then "and 3 more". Each shows the amount large (formatted, never typed), the day and the
// bank, and the server's question. He only ever taps: a green yes, a glass "No, another app" (the sheet Where is it
// from?), a quiet "Not money from an app". No answer changes an amount. "Saved for YouTube. Undo" sends `not_this`
// and puts the question back as it was (the same words and green yes); the other answers wait for their 8 s
// "Saved: not money from an app. Undo" before they are sent. One answer's toast at a time: a newer answer's takes its
// place (an answer still waiting is sent then). "Not sure" folds a card into "Not sure yet".
import { useRef, useState } from "react";
import { api } from "../../../api/index.ts";
import { friendlyMessage } from "../../../api/errors.ts";
import type { BankAnswer, BankAsk, BankPlace, BankView } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Sheet } from "../../../components/Sheet.tsx";
import { useToast } from "../../../components/Toasts.tsx";
import { Button } from "../../../components/ui.tsx";
import { NOT_SURE, SHEET_PLACES, bankPlaceName } from "../../../getpaid/bank.ts";
import { asItWas, forgetUndone, putBank, reloadBank, rememberUndone, useHeld, type Held } from "../../../lib/bank.ts";
import { formatMoney } from "../../../lib/money.ts";
import { bankDay } from "./BankMoney.tsx";

export const WHERE_FROM = "Where is it from?";
export const NOT_APP_MONEY = "Not money from an app";
export const savedFor = (place: BankPlace) => `Saved for ${bankPlaceName(place)}.`;
/** The toast of an answer that names no place says what was saved, so the right one is undone. */
export const SAVED_AS: Record<"not_sure" | "not_income" | "own_move", string> = {
  not_sure: "Saved: not sure yet.",
  not_income: "Saved: not money from an app.",
  own_move: "Saved: you moved it.",
};

/** The places he can pick, in order; Content Rewards only while it is on. */
export function sheetPlaces(crOn: boolean) {
  return SHEET_PLACES.filter((p) => p.place !== "contentrewards" || crOn);
}

function PlaceRows({ crOn, onPick, busy }: { crOn: boolean; onPick: (a: BankAnswer) => void; busy: boolean }) {
  return (
    <ul className="bank-places" aria-label={WHERE_FROM}>
      {sheetPlaces(crOn).map((p) => (
        <li key={p.place}>
          <Button variant="glass" size="lg" className="bank-places__row" disabled={busy} onClick={() => onPick({ answer: "place", place: p.place })} data-place={p.place}>
            {p.label}
          </Button>
        </li>
      ))}
      <li>
        <Button variant="glass" size="lg" className="bank-places__row" disabled={busy} onClick={() => onPick({ answer: "not_sure" })} data-place="not_sure">
          {NOT_SURE}
        </Button>
      </li>
    </ul>
  );
}

function AskCard({ ask, crOn, onAnswer, busy }: { ask: BankAsk; crOn: boolean; onAnswer: (ask: BankAsk, a: BankAnswer) => void; busy: boolean }) {
  const [sheet, setSheet] = useState(false);
  const pick = (a: BankAnswer) => {
    setSheet(false);
    onAnswer(ask, a);
  };
  const suggested = ask.kind === "place" && ask.suggested;
  return (
    <li className="bank-ask glass" data-deposit={ask.depositId} data-kind={ask.kind} data-suggested={ask.suggested ?? "none"}>
      <p className="bank-ask__money">{formatMoney(ask.amountMicros, ask.currency)}</p>
      <p className="bank-ask__where">
        {bankDay(ask.date)} · {ask.bank}
      </p>
      <h3 className="bank-ask__title">{ask.title}</h3>
      <p className="bank-ask__line">{ask.line}</p>
      {ask.kind === "own_move" ? (
        <div className="bank-ask__actions">
          <Button variant="glass" size="lg" icon="check" className="btn--leaf" disabled={busy} onClick={() => onAnswer(ask, { answer: "own_move" })}>
            {ask.yesLabel ?? "Yes, I moved it"}
          </Button>
          <Button variant="glass" size="lg" disabled={busy} onClick={() => setSheet(true)}>
            No, it&apos;s new money
          </Button>
        </div>
      ) : suggested ? (
        <div className="bank-ask__actions">
          <Button variant="glass" size="lg" icon="check" className="btn--leaf" disabled={busy} onClick={() => onAnswer(ask, { answer: "yes" })}>
            {ask.yesLabel ?? `Yes, it's ${bankPlaceName(ask.suggested!)}`}
          </Button>
          <Button variant="glass" size="lg" disabled={busy} onClick={() => setSheet(true)}>
            No, another app
          </Button>
          <Button variant="ghost" size="md" disabled={busy} onClick={() => onAnswer(ask, { answer: "not_income" })}>
            {NOT_APP_MONEY}
          </Button>
        </div>
      ) : (
        <>
          <PlaceRows crOn={crOn} onPick={(a) => onAnswer(ask, a)} busy={busy} />
          <div className="bank-ask__actions">
            <Button variant="ghost" size="md" disabled={busy} onClick={() => onAnswer(ask, { answer: "not_income" })}>
              {NOT_APP_MONEY}
            </Button>
          </div>
        </>
      )}
      {sheet ? (
        <Sheet
          title={WHERE_FROM}
          onClose={() => setSheet(false)}
          actions={
            <Button variant="ghost" size="lg" onClick={() => setSheet(false)}>
              Cancel
            </Button>
          }
        >
          <PlaceRows crOn={crOn} onPick={pick} busy={busy} />
          {ask.kind === "own_move" ? (
            <Button variant="ghost" size="md" className="bank-places__quiet" onClick={() => pick({ answer: "not_income" })}>
              {NOT_APP_MONEY}
            </Button>
          ) : null}
        </Sheet>
      ) : null}
    </li>
  );
}

export function BankAsks({ view, crOn }: { view: BankView; crOn: boolean }) {
  const toast = useToast();
  const hold = useHeld();
  const [busy, setBusy] = useState<string | null>(null);
  /** Answers waiting for their Undo: the card is gone (or folded into Not sure yet) at once. */
  const [waiting, setWaiting] = useState<Record<string, "gone" | "not_sure">>({});
  const [openSure, setOpenSure] = useState(false);
  /** The answer toast on screen: a newer answer's replaces it (one still waiting is sent then). */
  const last = useRef<{ held?: Held; stop?: AbortController } | null>(null);
  function replaceLast() {
    const was = last.current;
    last.current = null;
    was?.held?.flush();
    was?.stop?.abort();
  }

  // A question he undid shows as it was until he answers it again (the server's copy has no suggestion any more).
  const shown = view.asks.map(asItWas).filter((a) => waiting[a.depositId] !== "gone");
  const sure = shown.filter((a) => !a.notSure && waiting[a.depositId] !== "not_sure");
  const unsure = shown.filter((a) => a.notSure || waiting[a.depositId] === "not_sure");

  async function send(id: string, a: BankAnswer): Promise<boolean> {
    try {
      putBank(await api().bankAnswer(id, a));
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      void reloadBank();
      return false;
    }
  }

  async function answer(ask: BankAsk, a: BankAnswer) {
    const place = a.answer === "yes" ? ask.suggested : a.answer === "place" ? a.place : null;
    replaceLast();
    if (place) {
      // A place is saved at once; its Undo sends not_this and the question comes back as it was. The green yes of a
      // question put back that way names its place (the server's row has no suggestion of its own any more).
      const own = view.asks.find((x) => x.depositId === ask.depositId);
      const body: BankAnswer = a.answer === "yes" && !own?.suggested ? { answer: "place", place } : a;
      setBusy(ask.depositId);
      const ok = await send(ask.depositId, body);
      setBusy(null);
      if (!ok) return;
      forgetUndone(ask.depositId);
      const stop = new AbortController();
      last.current = { stop };
      toast.undo(savedFor(place), {
        icon: "check",
        signal: stop.signal,
        onUndo: () => {
          if (last.current?.stop === stop) last.current = null;
          rememberUndone(ask);
          void send(ask.depositId, { answer: "not_this" });
        },
        onCommit: () => {
          if (last.current?.stop === stop) last.current = null;
        },
      });
      return;
    }
    // Not sure, not app money, I moved it: sent when the Undo runs out (or at once if the page goes).
    const id = ask.depositId;
    const kind = a.answer === "not_sure" || a.answer === "own_move" ? a.answer : "not_income";
    setWaiting((w) => ({ ...w, [id]: a.answer === "not_sure" ? "not_sure" : "gone" }));
    const held = hold(() => {
      forgetUndone(id);
      void send(id, a).finally(() =>
        setWaiting((w) => {
          const { [id]: _gone, ...rest } = w;
          return rest;
        }),
      );
    });
    last.current = { held };
    toast.undo(SAVED_AS[kind], {
      icon: "check",
      signal: held.signal,
      onUndo: () => {
        if (last.current?.held === held) last.current = null;
        held.drop();
        setWaiting((w) => {
          const { [id]: _gone, ...rest } = w;
          return rest;
        });
      },
      onCommit: () => {
        if (last.current?.held === held) last.current = null;
        held.send();
      },
    });
  }

  if (!shown.length && !view.asksMore) return null;
  const card = (a: BankAsk) => <AskCard key={a.depositId} ask={a} crOn={crOn} onAnswer={(x, y) => void answer(x, y)} busy={busy === a.depositId} />;
  return (
    <section className="bank-asks" id="bank-asks" data-help="bank-asks" aria-labelledby="bank-asks-title" tabIndex={-1}>
      <h2 className="setup-part__title" id="bank-asks-title">
        Is this from an app?
      </h2>
      {sure.length ? <ul className="bank-asks__list">{sure.slice(0, 20).map(card)}</ul> : null}
      {view.asksMore ? <p className="bank-asks__more">and {view.asksMore} more</p> : null}
      {unsure.length ? (
        <div className="bank-asks__unsure">
          <button type="button" className="bank-asks__fold glass" aria-expanded={openSure} onClick={() => setOpenSure((o) => !o)}>
            <Icon name="question" size={20} />
            <span>Not sure yet ({unsure.length})</span>
            <Icon name="chevronDown" size={20} className="icon act-turn" />
          </button>
          {openSure ? <ul className="bank-asks__list">{unsure.map(card)}</ul> : null}
        </div>
      ) : null}
    </section>
  );
}
