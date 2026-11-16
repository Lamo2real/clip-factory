// Meta sent back several Pages or Instagram accounts: big picture cards, and tapping one connects it (§17.1).
import { useState } from "react";
import { api } from "../../../api/index.ts";
import { friendlyMessage } from "../../../api/errors.ts";
import type { AccountChoice, Platform, PlatformSetup } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { useToast } from "../../../components/Toasts.tsx";

export function ChooseAccount({
  platform,
  name,
  choices,
  onChosen,
}: {
  platform: Platform;
  name: string;
  choices: AccountChoice[];
  onChosen: (setup: PlatformSetup, choice: AccountChoice) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function pick(c: AccountChoice) {
    if (busy) return;
    setBusy(c.id);
    try {
      onChosen(await api().chooseAccount(platform, c.id), c);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="choose glass" aria-labelledby="choose-title">
      <h2 className="choose__title" id="choose-title">
        Pick the account your clips go to
      </h2>
      <p className="choose__lede">{name} showed more than one. Tap the one for your clips.</p>
      <ul className="choose__list">
        {choices.map((c) => (
          <li key={c.id}>
            <button type="button" className="choose__card" onClick={() => void pick(c)} aria-busy={busy === c.id || undefined}>
              {c.avatarUrl ? <img className="choose__avatar" src={c.avatarUrl} alt="" /> : <span className="choose__avatar" aria-hidden="true" />}
              <span className="choose__name user-text">{c.name}</span>
              {busy === c.id ? <span className="spinner" aria-hidden="true" /> : <Icon name="chevronRight" size={20} />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
