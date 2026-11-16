// Mock mode only (docs/CONTRACTS.md §17.10): a plain "Pretend {Platform}" page standing in for the platform's real
// permission screen, so the whole setup can be clicked through offline. Allow and Cancel come back the way the
// platform would (through the hooks API) to /settings/posting/setup/{platform}?result=….
import { useState } from "react";
import type { Platform } from "../../../api/types.ts";
import { PlatformMark } from "../../../components/PlatformMark.tsx";
import { Button } from "../../../components/ui.tsx";
import { GUIDES } from "../../../setup/index.ts";

export function MockConsent({ platform }: { platform: Platform }) {
  const name = GUIDES[platform].name;
  const [busy, setBusy] = useState<"allow" | "cancel" | null>(null);
  async function answer(allow: boolean) {
    setBusy(allow ? "allow" : "cancel");
    // Tested on import.meta.env directly so production builds drop the mock chunk entirely.
    if (import.meta.env.VITE_MOCK === "1") {
      const { mockAuthorize } = await import("../../../api/mock/setup.ts");
      location.assign(mockAuthorize(platform, new URLSearchParams(location.search).get("state"), allow));
    }
  }
  return (
    <main className="consent" id="main">
      <section className="consent__card glass" aria-labelledby="consent-title">
        <span className={`setup-head__mark is-${platform}`}>
          <PlatformMark platform={platform} size={34} />
        </span>
        <h1 className="consent__title" id="consent-title">
          Pretend {name}
        </h1>
        <p className="consent__text">
          This is a pretend {name} page for testing. The real one asks you to log in and let Clip Factory post for you.
        </p>
        <p className="consent__app">
          <strong>Clip Factory</strong> wants to post your kept clips and read their numbers.
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
