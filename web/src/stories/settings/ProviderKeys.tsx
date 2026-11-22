// Provider keys (docs/CONTRACTS.md §45.29 AI and Video, §45.31, §45.34): a provider that needs an API key gets a key
// form. The key goes to Secrets Manager through PUT …/providers/{id}/key and never comes back: what the page shows of
// it is ProviderStatus.key (saved or not, its last four, when) and the provider's own line ("Key saved · ends 4f2a.").
// "Remove the saved key" shows only while a key is saved. ProviderStatus.key is present only for a provider that takes
// a key; for an API that does not send it yet, the contract's provider tables say which need none (§45.11.6, §45.31:
// the built-in makers, Claude, Stability AI, Luma AI, Amazon Polly and the ended Nova makers use Lamo Stories' own AWS
// access). Since §45.37 G4 the keyed hosts take one: the Anthropic API, an OpenAI-compatible API and ElevenLabs.
import { useState } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { storiesApi } from "../api/client.ts";
import type { ProviderStatus } from "../api/types.ts";
import { Btn, cheer, Chip, Note, PROVIDER_STATE, SIcon, whenText } from "./bits.tsx";

/** The providers that use Lamo Stories' own AWS access, so a key is never asked for (§45.11.6, §45.31). */
export const NO_KEY: ReadonlySet<string> = new Set([
  "bedrock-claude",
  "builtin-rig",
  "nova-canvas",
  "builtin-2d",
  "nova-reel",
  "builtin-synth",
  // §45.37: Stability AI and Luma AI on Amazon Bedrock and Amazon Polly use Lamo Stories' own AWS access; the owner's
  // own makers use the key of the host each model runs on (anthropic, openai_compatible, elevenlabs), never their own.
  "stability",
  "luma-ray",
  "polly",
  "own-images",
  "own-video",
  "own-sound",
]);

export function takesKey(p: ProviderStatus): boolean {
  if (p.key) return true;
  if (p.key === null) return false;
  return !NO_KEY.has(p.id);
}

/** A key route's answer for a provider in the list: its new state, line and key, under the name the list shows. */
export function keepName(old: ProviderStatus, next: ProviderStatus): ProviderStatus {
  const { checkedAt: _c, lastError: _e, key: _k, ...rest } = old;
  return {
    ...rest,
    state: next.state,
    line: next.line,
    ...(next.checkedAt ? { checkedAt: next.checkedAt } : {}),
    ...(next.lastError ? { lastError: next.lastError } : {}),
    ...(next.key !== undefined ? { key: next.key } : old.key !== undefined ? { key: old.key } : {}),
  };
}

/** An OpenAI-compatible key is for one address only (§45.37 G4): the one its models use, never sent anywhere else. */
export const ONE_ADDRESS_LINE =
  "This key is for one address only: the one your OpenAI-compatible models use. Lamo Stories never sends it anywhere else. Add the model first, or type its address here.";

function KeyForm({ ws, provider, onSaved }: { ws: string; provider: ProviderStatus; onSaved: (p: ProviderStatus) => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [address, setAddress] = useState("");
  const forAddress = provider.id === "openai_compatible";
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const s = PROVIDER_STATE[provider.state];
  const save = async (el: HTMLElement | null) => {
    if (busy) return;
    if (!text.trim()) {
      toast.error("Paste the key first.");
      return;
    }
    setBusy(true);
    try {
      const api = storiesApi();
      const next = forAddress && address.trim() ? await api.setProviderKey(ws, provider.id, text.trim(), address.trim()) : await api.setProviderKey(ws, provider.id, text.trim());
      setText("");
      setAddress("");
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
    if (busy) return;
    setBusy(true);
    try {
      await storiesApi().deleteProviderKey(ws, provider.id);
      onSaved({ ...provider, state: "needs_setup", line: `Paste your ${provider.label} key to use it.`, key: { saved: false, hint: null, savedAt: null } });
      toast.info(`${provider.label} has no saved key now.`);
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
        <Chip tone={s.tone}>{s.label}</Chip>
      </div>
      <p className="st-stg-small">{provider.line}</p>
      {provider.key?.saved && !provider.line.includes("Key saved") ? (
        <p className="st-stg-small">
          Key saved{provider.key.hint ? ` · ends ${provider.key.hint}` : ""}
          {provider.key.savedAt ? ` · ${whenText(provider.key.savedAt)}` : ""}.
        </p>
      ) : null}
      {provider.checkedAt ? <p className="st-stg-small">Last checked {whenText(provider.checkedAt)}.</p> : null}
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
          {forAddress ? (
            <>
              <p className="st-stg-small">{ONE_ADDRESS_LINE}</p>
              <label className="st-stg-label" htmlFor={`key-address-${provider.id}`}>
                Its address (only if you have not added its model yet)
              </label>
              <input
                id={`key-address-${provider.id}`}
                className="st-stg-input"
                type="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={300}
                value={address}
                placeholder="https://api.example.com/v1"
                onChange={(e) => setAddress(e.target.value)}
              />
            </>
          ) : null}
          <div className="st-stg-actions">
            <Btn main type="submit" off={busy ? "Saving…" : undefined}>
              Save the key
            </Btn>
            <Btn quiet onClick={() => setOpen(false)}>
              Cancel
            </Btn>
          </div>
        </form>
      ) : (
        <div className="st-stg-actions">
          <Btn main onClick={() => setOpen(true)} label={`${provider.key?.saved ? "Paste a new key" : "Paste a key"} for ${provider.label}`}>
            {provider.key?.saved ? "Paste a new key" : "Paste a key"}
          </Btn>
          {provider.key?.saved ? (
            <Btn quiet danger off={busy ? "Working…" : undefined} onClick={() => void remove()} label={`Remove the saved key of ${provider.label}`}>
              Remove the saved key
            </Btn>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** The providers of some kinds that take a key, each with its form; or a plain line when none does. */
export function ProviderKeys({
  ws,
  providers,
  kinds,
  also = [],
  onChange,
}: {
  ws: string;
  providers: ProviderStatus[];
  kinds?: ProviderStatus["kind"][];
  /** providers shown whatever their kind (the OpenAI-compatible API also makes pictures, §45.37) */
  also?: string[];
  onChange: (p: ProviderStatus) => void;
}) {
  const list = providers.filter((p) => (!kinds || kinds.includes(p.kind) || also.includes(p.id)) && takesKey(p));
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
      {p.lastError && p.lastError !== p.line ? <span className="st-stg-provider__error">Last problem: {p.lastError}</span> : null}
      {p.checkedAt ? <span className="st-stg-small">Last checked {whenText(p.checkedAt)}.</span> : null}
    </li>
  );
}
