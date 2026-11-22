// The way back from BankID (docs/CONTRACTS.md §40.5.2 Connect, step 4): the public page /bank-done?result={code}.
// App.tsx shows it for that path before the sign-in gate. It needs no sign-in, makes no API call and shows no data,
// so BankID's return can never land on a sign-in page. Once the boot has finished: signed in on this browser, it
// goes on to the bank page with the result; not signed in (the Mac app's system browser, or BankID brought him back
// in another browser), it says one sentence, with no button and no link.
//
// The pretend bank page (mock builds only) lives here too: it stands in for Enable Banking's and his bank's pages.
import "../../../styles/bank.css";
import { useEffect, useState } from "react";
import { Icon } from "../../../components/Icon.tsx";
import { Button } from "../../../components/ui.tsx";
import { BANK_PATH, DONE_NOT, DONE_OK, isBankResult } from "../../../getpaid/bank.ts";

/** Where a signed-in browser goes: the bank page with the result (any other code is read there as an error). */
export function bankDoneForward(search: string): string {
  const code = new URLSearchParams(search).get("result") ?? "";
  return `${BANK_PATH}?result=${encodeURIComponent(isBankResult(code) ? code : "bank_error")}`;
}

/** The sentence a browser that isn't signed in sees: bank_connected's, else the calm one (unknown is an error). */
export function bankDoneSentence(search: string): string {
  return new URLSearchParams(search).get("result") === "bank_connected" ? DONE_OK : DONE_NOT;
}

/** Mock builds only: `?mockBankDone=signedout` shows the page as a browser that isn't signed in. */
function pretendSignedOut(): boolean {
  return import.meta.env.VITE_MOCK === "1" && typeof location !== "undefined" && new URLSearchParams(location.search).get("mockBankDone") === "signedout";
}

export function BankDone({ boot }: { boot: "loading" | "ready" | "signed_out" | "broken" }) {
  const signedIn = boot === "ready" && !pretendSignedOut();
  useEffect(() => {
    if (signedIn) location.replace(bankDoneForward(location.search));
  }, [signedIn]);
  if (boot === "loading" || signedIn)
    return (
      <div className="boot" role="status" aria-label="Loading Clip Factory">
        <span className="brand__mark brand__mark--boot" aria-hidden="true">
          C<span className="brand__dot" />
        </span>
      </div>
    );
  const ok = new URLSearchParams(location.search).get("result") === "bank_connected";
  return (
    <main className="bank-done" id="main">
      <section className="bank-done__card glass" aria-labelledby="bank-done-title" data-result={ok ? "ok" : "not"}>
        <span className={`bank-done__mark${ok ? " is-ok" : ""}`} aria-hidden="true">
          <Icon name={ok ? "checkCircle" : "info"} size={34} />
        </span>
        <h1 className="bank-done__title" id="bank-done-title">
          Your bank
        </h1>
        <p className="bank-done__text" role="status">
          {bankDoneSentence(location.search)}
        </p>
      </section>
    </main>
  );
}

/**
 * Mock mode only: a plain pretend page standing in for Enable Banking's page, his bank's page and BankID, so Connect
 * can be clicked through offline. Allow and Cancel come back the way the callback would: through /bank-done.
 */
export function MockBankPage() {
  const [busy, setBusy] = useState<"allow" | "cancel" | null>(null);
  const [bank, setBank] = useState<string | null>(null);
  useEffect(() => {
    if (import.meta.env.VITE_MOCK === "1") void import("../../../api/mock/bank.ts").then((m) => setBank(m.mockBankPending()));
  }, []);
  async function answer(allow: boolean) {
    setBusy(allow ? "allow" : "cancel");
    if (import.meta.env.VITE_MOCK === "1") {
      const { mockBankAuthorize } = await import("../../../api/mock/bank.ts");
      const to = mockBankAuthorize(new URLSearchParams(location.search).get("state"), allow);
      const extra = new URLSearchParams(location.search).get("mockBankDone");
      location.assign(extra ? `${to}&mockBankDone=${encodeURIComponent(extra)}` : to);
    }
  }
  return (
    <main className="consent" id="main">
      <section className="consent__card glass" aria-labelledby="mock-bank-title">
        <span className="bank-done__mark" aria-hidden="true">
          <Icon name="card" size={34} />
        </span>
        <h1 className="consent__title" id="mock-bank-title">
          Pretend {bank ?? "bank"}
        </h1>
        <p className="consent__text">This is a pretend bank page. Tap Allow.</p>
        <p className="consent__app">
          The real one is Enable Banking&apos;s page, then your bank&apos;s, then BankID. <strong>Clip Factory</strong> never sees your bank login.
        </p>
        <div className="consent__actions">
          <Button variant="ghost" size="lg" loading={busy === "cancel"} disabled={busy !== null} onClick={() => void answer(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" icon="check" act="connect" loading={busy === "allow"} disabled={busy !== null} onClick={() => void answer(true)}>
            Allow
          </Button>
        </div>
      </section>
    </main>
  );
}
