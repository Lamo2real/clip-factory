// Meta sent back several Pages or Instagram accounts: big picture cards, and tapping one connects it (§17.1).
import { useState } from "react";
import { api } from "../../../api/index.ts";
import { friendlyMessage } from "../../../api/errors.ts";
import type { AccountChoice, Platform, PlatformSetup } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { useToast } from "../../../components/Toasts.tsx";
import { ActGlyph } from "../../../components/ui.tsx";
import { useAction } from "../../../lib/motion.ts";

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
  /** Connects the account; false when it did not work (the error toast says why). */
  async function pick(c: AccountChoice): Promise<boolean> {
    setBusy(c.id);
    try {
      onChosen(await api().chooseAccount(platform, c.id), c);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
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
            <AccountCard choice={c} busy={busy === c.id} locked={busy !== null} onPick={() => pick(c)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One account card: the tap connects it (`connect`, §20.11), and the spinner shows once the motion is done. */
function AccountCard({
  choice,
  busy,
  locked,
  onPick,
}: {
  choice: AccountChoice;
  busy: boolean;
  /** Another card (or this one) is connecting: taps do nothing. */
  locked: boolean;
  onPick: () => Promise<boolean>;
}) {
  const act = useAction("connect");
  return (
    <button
      type="button"
      className="choose__card"
      data-act="connect"
      aria-busy={busy || undefined}
      onClick={() => {
        if (locked) return;
        const picking = onPick();
        act.play();
        void picking.then((ok) => {
          if (!ok) act.fail({ sound: false });
        });
      }}
    >
      {choice.avatarUrl ? <img className="choose__avatar" src={choice.avatarUrl} alt="" /> : <span className="choose__avatar" aria-hidden="true" />}
      <span className="choose__name user-text">{choice.name}</span>
      {busy && act.phase === "idle" ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <ActGlyph act={act}>
          <Icon name={busy ? "link" : "chevronRight"} size={20} />
        </ActGlyph>
      )}
    </button>
  );
}
