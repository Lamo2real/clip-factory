// Settings › App & account › Ask (docs/CONTRACTS.md §27.3): turn on web search with a free Brave Search API key, take
// the key away again, and see what Ask can do. The key goes once to the API, which keeps it in AWS Secrets Manager:
// it is never shown again, never stored in the browser and never logged.
import { useId, useState, type FormEvent } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Button, Pill } from "../../components/ui.tsx";
import { sounds } from "../../lib/sounds.ts";
import { defaultAskApi } from "../../features/help/askApi.ts";
import { defaultHelpClient } from "../../features/help/helpApi.ts";
import { checkHelpStatus, setAssistantStatus, useAssistant } from "../../features/help/status.ts";
import { Apple, Panel } from "./parts.tsx";

export const SEARCH_KEY_URL = "https://brave.com/search/api/";
export const KEY_SAVED_TEXT = "Web search is on.";
export const KEY_GONE_TEXT = "Web search is off. Ask answers from what it knows.";
export const KEY_BAD_TEXT = "That key didn't work. Check you copied all of it.";
export const KEY_TROUBLE_TEXT = "That didn't work this time. Try again in a minute.";

export function AskBranch() {
  const st = useAssistant();
  const keyId = useId();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const webOn = st.web === "on";

  async function refresh() {
    try {
      await checkHelpStatus(await defaultHelpClient());
    } catch {
      /* the status check runs again by itself */
    }
  }

  async function save(e?: FormEvent) {
    e?.preventDefault();
    const value = key.trim();
    if (!value || busy) return;
    setBusy("save");
    setMessage(null);
    const result = await (await defaultAskApi()).putSearchKey(value);
    setBusy(null);
    if (result === "ok") {
      setKey("");
      setMessage({ tone: "ok", text: KEY_SAVED_TEXT });
      setAssistantStatus({ ...st, web: "on" });
      void refresh();
      return;
    }
    sounds.play("deny");
    setMessage({ tone: "bad", text: result === "bad" ? KEY_BAD_TEXT : KEY_TROUBLE_TEXT });
  }

  async function remove() {
    if (busy) return;
    setBusy("remove");
    setMessage(null);
    const ok = await (await defaultAskApi()).deleteSearchKey();
    setBusy(null);
    if (ok) {
      setMessage({ tone: "ok", text: KEY_GONE_TEXT });
      setAssistantStatus({ ...st, web: "no_key" });
      void refresh();
    } else {
      sounds.play("deny");
      setMessage({ tone: "bad", text: KEY_TROUBLE_TEXT });
    }
  }

  return (
    <Panel>
      <Apple
        id="ask-web-setup"
        wide
        aside={
          <Pill tone={webOn ? "success" : "neutral"} icon={webOn ? "check" : "globe"}>
            {!st.on ? "Off" : webOn ? "On" : "Not yet"}
          </Pill>
        }
      >
        <div className="ask-key">
          {webOn ? (
            <p className="ask-key__state">
              <Icon name="checkCircle" size={20} />
              <span>{KEY_SAVED_TEXT} Ask can read today's web pages and shows where it found things.</span>
            </p>
          ) : (
            <ol className="ask-key__steps">
              <li>
                Tap <strong>Get a search key</strong> below.
              </li>
              <li>
                Make a free account and pick the <strong>Search</strong> plan.
              </li>
              <li>Copy your key.</li>
              <li>
                Paste it here and tap <strong>Save key</strong>.
              </li>
            </ol>
          )}
          {!webOn ? (
            // The card's first step is a real button (a big target), not a link inside a sentence.
            <a className="btn btn--glass ask-key__get" href={SEARCH_KEY_URL} target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={20} />
              <span>Get a search key</span>
            </a>
          ) : null}
          {!webOn ? (
            <form className="ask-key__form" onSubmit={(e) => void save(e)}>
              <label className="ask-key__label" htmlFor={keyId}>
                Your search key
              </label>
              <div className="ask-key__row">
                <input
                  id={keyId}
                  className="input ask-key__input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={200}
                  value={key}
                  placeholder="Paste your key"
                  onChange={(e) => setKey(e.target.value)}
                  disabled={!st.on}
                />
                <Button type="submit" size="md" variant="primary" icon="key" loading={busy === "save"} disabled={!key.trim() || !st.on}>
                  Save key
                </Button>
              </div>
            </form>
          ) : (
            <div className="ask-key__row">
              <a className="btn btn--glass btn--sm" href={SEARCH_KEY_URL} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={18} />
                <span>Brave Search API</span>
              </a>
              <Button size="sm" variant="glass" icon="x" loading={busy === "remove"} onClick={() => void remove()}>
                Take key away
              </Button>
            </div>
          )}
          <p className={`ask-key__msg${message ? ` is-${message.tone}` : ""}`} role="status">
            {message ? (
              <>
                <Icon name={message.tone === "ok" ? "checkCircle" : "info"} size={18} />
                <span>{message.text}</span>
              </>
            ) : null}
          </p>
        </div>
      </Apple>
      <Apple id="ask-status" wide>
        <ul className="ask-can">
          <li>
            <Icon name="sparkle" size={18} /> Answers any question: Clip Factory, Terraform, food, anything.
          </li>
          <li>
            <Icon name="compass" size={18} /> Knows every page and setting, and your own setup.
          </li>
          <li>
            <Icon name="paperclip" size={18} /> Reads pictures, PDFs, text and Office files. Tap a picture to mark it red.
          </li>
          <li>
            <Icon name="lock" size={18} /> Never keeps your files, and never shows your keys.
          </li>
        </ul>
        {!st.on ? <p className="ask-key__msg is-bad">Smart answers need one step. Ask gives plain answers until then.</p> : null}
      </Apple>
    </Panel>
  );
}
