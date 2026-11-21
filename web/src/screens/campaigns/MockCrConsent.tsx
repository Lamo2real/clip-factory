// Mock mode only (docs/CONTRACTS.md §38.18): the pretend Content Rewards sign-in page the fake desktop door opens.
// Allow or Cancel leaves the answer where Playwright's fake window.__CF_CR_CONNECT__ reads it (localStorage
// `cf-mock-cr-door`), like the real door hands the one-time code to the app.
import { useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Button } from "../../components/ui.tsx";

export const MOCK_DOOR_KEY = "cf-mock-cr-door";

export function MockCrConsent() {
  const [done, setDone] = useState<"allowed" | "canceled" | null>(null);
  const state = new URLSearchParams(location.search).get("state") ?? "";
  function answer(allow: boolean) {
    const body = allow ? { status: "done", code: "mock-code-1", state } : { status: "error", error: "access_denied", state };
    try {
      localStorage.setItem(MOCK_DOOR_KEY, JSON.stringify(body));
    } catch {
      /* no storage: nothing to hand back */
    }
    setDone(allow ? "allowed" : "canceled");
    if (window.opener) setTimeout(() => window.close(), 150);
  }
  return (
    <main className="consent" id="main">
      <section className="consent__card glass" aria-labelledby="mock-cr-title">
        <span className="setup-head__mark cr-mark" aria-hidden="true">
          <Icon name="coin" size={34} />
        </span>
        <h1 className="consent__title" id="mock-cr-title">
          Pretend Content Rewards
        </h1>
        {done ? (
          <p className="consent__text" role="status">{done === "allowed" ? "Done! Go back to Clip Factory. You can close this tab." : "Content Rewards didn't connect. Go back to Clip Factory to see what to do."}</p>
        ) : (
          <>
            <p className="consent__text">Clip Factory wants to see your campaigns and send your clips.</p>
            <div className="consent__actions">
              <Button variant="primary" size="lg" icon="check" onClick={() => answer(true)}>
                Allow
              </Button>
              <Button variant="glass" size="lg" icon="x" onClick={() => answer(false)}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
