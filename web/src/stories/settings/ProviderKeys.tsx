// Provider keys (docs/CONTRACTS.md §45.29 AI and Video, §45.31): a provider that needs an API key gets a key form.
// The key goes to Secrets Manager through PUT …/providers/{id}/key and never comes back: the page only ever shows
// "saved · ends 4f2a". Today's providers (the built-in makers, Claude and Nova on Amazon Bedrock) need none, so the
// card says so; the form is built and waits for the first provider that does.
import { useState } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { storiesApi } from "../api/client.ts";
import type { ProviderStatus } from "../api/types.ts";
import { Btn, cheer, Chip, Note, PROVIDER_STATE, SIcon, whenText } from "./bits.tsx";

/**
 * What the key routes add to a provider: whether it takes a key and the saved key's last four characters (never the
 * key). Not in §45.6's ProviderStatus yet (reported to the lead); read when the API sends it.
 */
export interface ProviderKeyInfo {
  saved: boolean;
  hint: string | null;
  savedAt: string | null;
}
export type ProviderWithKey = ProviderStatus & { key?: ProviderKeyInfo | null };

export function takesKey(p: ProviderStatus): p is ProviderWithKey & { key: ProviderKeyInfo } {
  const k = (p as ProviderWithKey).key;
  return !!k && typeof k === "object";
}

/** A key route's answer for a provider in the list: its new state, line and key, under the name the list shows. */
export function keepName(old: ProviderWithKey, next: ProviderWithKey): ProviderWithKey {
  return { ...old, state: next.state, line: next.line, key: next.key ?? old.key ?? null, ...(next.checkedAt ? { checkedAt: next.checkedAt } : {}) };
}

/** "saved · ends 4f2a": the only thing ever shown of a key. */
export function keyLine(k: ProviderKeyInfo): string {
  return k.saved ? `saved · ends ${k.hint ?? "····"}` : "not saved yet";
}

function KeyForm({ ws, provider, onSaved }: { ws: string; provider: ProviderWithKey & { key: ProviderKeyInfo }; onSaved: (p: ProviderWithKey) => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(!provider.key.saved);
  const [busy, setBusy] = useState(false);
  const save = async (el: HTMLElement | null) => {
    if (!text.trim()) {
      toast.error("Paste the key first.");
      return;
    }
    setBusy(true);
    try {
      const next = (await storiesApi().setProviderKey(ws, provider.id, text.trim())) as ProviderWithKey;
      setText("");
      setOpen(false);
      onSaved(next);
      cheer(el);
      toast.success(`${provider.label}'s key is saved. Only its last four characters are ever shown.`);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await storiesApi().deleteProviderKey(ws, provider.id);
      onSaved({ ...provider, key: { saved: false, hint: null, savedAt: null } });
      setOpen(true);
      toast.info(`${provider.label}'s key is removed.`);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="st-stg-keyrow">
      <div className="st-stg-keyrow__head">
        <span className="st-stg-keyrow__name">
          <SIcon name="key" size={20} />
          {provider.label}
        </span>
        <Chip tone={provider.key.saved ? "mint" : "sun"}>{keyLine(provider.key)}</Chip>
      </div>
      {provider.key.saved && provider.key.savedAt ? <p className="st-stg-small">Saved {whenText(provider.key.savedAt)}.</p> : null}
      {open ? (
        <form
          className="st-stg-keyrow__form"
          onSubmit={(e) => {
            e.preventDefault();
            void save(e.currentTarget.querySelector("button[type=submit]"));
          }}
        >
          <label className="st-stg-label" htmlFor={`key-${provider.id}`}>
            {provider.label} key
          </label>
          <input
            id={`key-${provider.id}`}
            className="st-stg-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={4096}
            value={text}
            placeholder="Paste the key here"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="st-stg-actions">
            <Btn main type="submit" off={busy ? "Saving…" : undefined}>
              Save the key
            </Btn>
            {provider.key.saved ? (
              <Btn quiet onClick={() => setOpen(false)}>
                Cancel
              </Btn>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="st-stg-actions">
          <Btn onClick={() => setOpen(true)}>Replace the key</Btn>
          <Btn quiet danger off={busy ? "Working…" : undefined} onClick={() => void remove()}>
            Remove
          </Btn>
        </div>
      )}
    </li>
  );
}

/** The providers of some kinds that take a key, each with its form; or a plain line when none does. */
export function ProviderKeys({ ws, providers, kinds, onChange }: { ws: string; providers: ProviderStatus[]; kinds?: ProviderStatus["kind"][]; onChange: (p: ProviderWithKey) => void }) {
  const list = providers.filter((p) => (!kinds || kinds.includes(p.kind)) && takesKey(p)) as (ProviderWithKey & { key: ProviderKeyInfo })[];
  if (!list.length)
    return (
      <Note tone="sky" icon="key">
        None of these providers needs a key: they run in Lamo Stories' own AWS account. A provider that needs one shows its key form here.
      </Note>
    );
  return (
    <ul className="st-stg-keys" aria-label="Provider keys">
      {list.map((p) => (
        <KeyForm key={p.id} ws={ws} provider={p} onSaved={onChange} />
      ))}
    </ul>
  );
}

/** One provider and its real state (a provider is shown as working only after a real call, §45.11.6). */
export function ProviderRow({ p, what }: { p: ProviderStatus; what?: string }) {
  const s = PROVIDER_STATE[p.state];
  return (
    <li className="st-stg-provider">
      <div className="st-stg-provider__head">
        <span className="st-stg-provider__name">{p.label}</span>
        <Chip tone={s.tone}>{s.label}</Chip>
      </div>
      {what ? <span className="st-stg-small">{what}</span> : null}
      <span className="st-stg-provider__line">{p.line}</span>
      {p.lastError ? <span className="st-stg-provider__error">Last problem: {p.lastError}</span> : null}
      {p.checkedAt ? <span className="st-stg-small">Last checked {whenText(p.checkedAt)}.</span> : null}
    </li>
  );
}
