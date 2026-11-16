// The Ask Clip Factory panel (docs/CONTRACTS.md §19.8): a non-modal glass dialog above the launcher on wide
// screens, a full-screen sheet on phones. Short answers, numbered steps and up to two buttons that take you there.
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type FormEvent, type KeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { api } from "../../api/index.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { PaperPlaneButton, useLaunch } from "../../components/PaperPlane.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button } from "../../components/ui.tsx";
import { useMedia } from "../../lib/hooks.ts";
import { getPrefs, prefersReducedMotion } from "../../lib/prefs.ts";
import { navigate, type Route } from "../../lib/router.ts";
import { sounds } from "../../lib/sounds.ts";
import { entryId, historyOf, newestAnswerId, type ChatEvent, type ChatState, type Entry, type LiveState } from "./chatState.ts";
import { boldParts, fill, GO_HOME, GREETING, hasPlaceholder, LIVE_FAILED_TEXT, OFF_TEXT, suggestionsFor, withoutLive } from "./compose.ts";
import { helpContext } from "./context.ts";
import type { HelpClient } from "./helpApi.ts";
import { answerLocally, loadCorpus, routeOk, safeActions } from "./kb.ts";
import { readLive } from "./live.ts";
import { spotlight } from "./spotlight.ts";
import { checkHelpStatus, helpSwitch } from "./status.ts";
import { QUESTION_MAX, type HelpAction, type HelpAnswer } from "./types.ts";
import { hasUnsaved } from "./unsaved.ts";

export const COUNTER_FROM = 250;
export const STILL_LOOKING_MS = 6000;
export const COPIED_TEXT = "Copied. Send this code to whoever helps you with Clip Factory.";
export const UNSAVED_TEXT = "You have a change that isn't saved yet. Leave anyway?";
export const AGAIN_TEXT = "You can ask again now.";
/** How often, and how many times, to check that the open panel does not cover a control that just lit up. */
const TUCK_EVERY_MS = 120;
const TUCK_CHECKS = 10;

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

const busyText = (seconds: number) => `Let's take a short break. You can ask again in ${seconds} seconds.`;

function iconFor(to: string): IconName {
  if (to === "/" || to.startsWith("/?") || to.startsWith("/#")) return "home";
  if (to.startsWith("/jobs")) return "layers";
  if (to.startsWith("/review")) return "review";
  if (to.startsWith("/library") || to.startsWith("/clips")) return "library";
  if (to.includes("get-app") || to.includes("get-the-app")) return "download";
  return "settings";
}

/** Text with **bold** button names. */
function Bold({ text }: { text: string }) {
  return (
    <>
      {boldParts(text).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <Fragment key={i}>{p.text}</Fragment>))}
    </>
  );
}

/** The answer's text with its live number: a shimmer while it loads, then the value. */
function AnswerText({ text, live }: { text: string; live: LiveState | null }) {
  if (!hasPlaceholder(text) || !live) return <Bold text={text} />;
  if (live.kind === "failed") return <Bold text={withoutLive(text)} />;
  if (live.kind === "done") {
    const r = live.result;
    if (r.kind === "values") return <Bold text={fill(text, r.values)} />;
    if (r.kind === "text") return <Bold text={`${r.text} ${withoutLive(text)}`.trim()} />;
    return <Bold text={withoutLive(text)} />;
  }
  const parts = text.split(/(\{\w+\})/);
  return (
    <>
      {parts.map((p, i) =>
        /^\{\w+\}$/.test(p) ? (
          <span key={i} className="help-shimmer" aria-hidden="true" />
        ) : (
          <Bold key={i} text={p} />
        ),
      )}
      <span className="sr-only"> Getting the number…</span>
    </>
  );
}

export function HelpPanel({
  client,
  route,
  phone,
  off,
  question,
  onQuestionTaken,
  onClose,
  chat: state,
  dispatch,
  generation,
}: {
  client: HelpClient;
  route: Route;
  phone: boolean;
  /** The kill switch turned it off: say so once, then the launcher closes the panel. */
  off: boolean;
  /** A question to ask right away (from openHelp("…")). */
  question: string | null;
  onQuestionTaken: () => void;
  onClose: (opts?: { returnFocus?: boolean }) => void;
  /** The conversation, kept by the launcher so it outlives the panel (memory only). */
  chat: ChatState;
  dispatch: Dispatch<ChatEvent>;
  /** Bumped by Start over, so answers still on their way are dropped. */
  generation: MutableRefObject<number>;
}) {
  const titleId = useId();
  const inputId = useId();
  const toast = useToast();
  const [text, setText] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [slow, setSlow] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const routeRef = useRef(route);
  routeRef.current = route;
  const askedOff = useRef(false);
  const self = useRef<HTMLElement>(null);
  // Narrow screens: Start over shows its icon only, so the title keeps its room.
  const narrow = useMedia("(max-width: 479px)");
  // The paper plane on the send button (components/PaperPlane.tsx).
  const flight = useLaunch();

  // The field grows with the question, up to four lines (CSS max-height), then scrolls.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [text]);

  // Phones: the sheet follows the visible part of the screen, so the field and the plane stay above the keyboard.
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const el = self.current;
    if (!phone || !vv || !el) return;
    const fit = () => {
      el.style.setProperty("--help-vh", `${Math.round(vv.height)}px`);
      el.style.setProperty("--help-vtop", `${Math.round(vv.offsetTop)}px`);
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    };
  }, [phone]);

  // The corpus arrives with the panel, so a local answer is ready if the server is not.
  useEffect(() => {
    void loadCorpus().catch(() => undefined);
    input.current?.focus({ preventScroll: true });
  }, []);

  // "Still looking…" after 6 s.
  useEffect(() => {
    if (!state.thinking) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), STILL_LOOKING_MS);
    return () => clearTimeout(t);
  }, [state.thinking]);

  // The 429 countdown.
  const blocked = state.blockedUntil > now;
  useEffect(() => {
    if (state.blockedUntil <= Date.now()) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= state.blockedUntil) clearInterval(t);
    }, 1000);
    setNow(Date.now());
    return () => clearInterval(t);
  }, [state.blockedUntil]);

  // Newest message in view.
  useEffect(() => {
    const el = log.current;
    if (el && (state.entries.length || state.thinking)) el.scrollTop = el.scrollHeight;
  }, [state.entries.length, state.thinking]);

  useEffect(() => {
    if (off && !askedOff.current) {
      askedOff.current = true;
      dispatch({ type: "notice", id: entryId(), tone: "off", text: OFF_TEXT });
    }
  }, [off, dispatch]);

  const fillLive = useCallback(async (id: number, answer: HelpAnswer, gen: number) => {
    if (!answer.live) return;
    const r = routeRef.current;
    try {
      const result = await readLive(answer.live, api(), { clipId: r.name === "clip" ? r.clipId : null });
      if (gen === generation.current) dispatch({ type: "live", entryId: id, live: { kind: "done", result } });
    } catch {
      if (gen !== generation.current) return;
      dispatch({ type: "live", entryId: id, live: { kind: "failed" } });
      sounds.play("deny");
    }
  }, [dispatch, generation]);

  const showAnswer = useCallback(
    (answer: HelpAnswer, requestId: string, trouble: boolean, gen: number) => {
      const id = entryId();
      const clean = { ...answer, actions: safeActions(answer.actions) };
      dispatch({ type: "answer", id, answer: clean, requestId, trouble });
      void fillLive(id, clean, gen);
    },
    [fillLive, dispatch],
  );

  const ask = useCallback(
    async (raw: string) => {
      const q = raw.trim().slice(0, QUESTION_MAX);
      const s = stateRef.current;
      if (!q || s.thinking || s.blockedUntil > Date.now() || helpSwitch() === "off") return;
      const gen = generation.current;
      const history = historyOf(s.entries);
      const context = helpContext(routeRef.current);
      dispatch({ type: "ask", id: entryId(), text: q });
      setText("");
      const result = await client.ask({ question: q, history, context });
      if (gen !== generation.current) return;
      switch (result.kind) {
        case "answer":
          return showAnswer(result.answer, result.requestId, false, gen);
        case "rate_limited": {
          sounds.play("deny");
          return dispatch({ type: "notice", id: entryId(), tone: "busy", text: AGAIN_TEXT, until: Date.now() + result.retryAfter * 1000 });
        }
        case "off":
          dispatch({ type: "notice", id: entryId(), tone: "off", text: OFF_TEXT });
          askedOff.current = true;
          void checkHelpStatus(client);
          return;
        case "bad_request":
          return dispatch({ type: "notice", id: entryId(), tone: "info", text: result.message });
        case "signed_out":
          return dispatch({ type: "notice", id: entryId(), tone: "info", text: "Sign in again, then ask me." });
        case "fallback": {
          if (result.reason === "server") sounds.play("deny");
          // The kill switch also stops the local answers.
          if (helpSwitch() === "off") return dispatch({ type: "notice", id: entryId(), tone: "off", text: OFF_TEXT });
          try {
            const local = await answerLocally(q, history, context);
            if (gen === generation.current) showAnswer(local, result.requestId, true, gen);
          } catch {
            if (gen === generation.current)
              dispatch({ type: "notice", id: entryId(), tone: "info", text: "Ask Clip Factory can't answer right now.", helpCode: result.requestId });
          }
        }
      }
    },
    [client, showAnswer, dispatch, generation],
  );

  // A question handed over by openHelp("…").
  useEffect(() => {
    if (!question) return;
    onQuestionTaken();
    void ask(question);
  }, [question, ask, onQuestionTaken]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    // The plane flies only when the question really goes; the bubble does not wait for it.
    if (!askOff && helpSwitch() !== "off") flight.launch();
    void ask(text);
  }

  function keys(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function startOver() {
    generation.current++;
    dispatch({ type: "reset" });
    setText("");
    input.current?.focus();
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(COPIED_TEXT);
    } catch {
      toast.info(`Your help code is ${code}. Send it to whoever helps you with Clip Factory.`);
    }
  }

  function go(action: HelpAction) {
    if (!routeOk(action.to)) return;
    dispatch({ type: "confirm", confirm: null });
    if (phone) onClose({ returnFocus: false });
    navigate(action.to);
    const reduced = prefersReducedMotion() || getPrefs().reduceMotion;
    void spotlight(action.highlight ?? [], { reduced }).then(async (el) => {
      // On wide screens the panel stays open, unless it covers the control that just lit up: then it steps away
      // (the chat is kept, so the launcher brings the steps back). Checked while the page scrolls the control in.
      if (phone || !el) return;
      for (let i = 0; i < TUCK_CHECKS; i++) {
        const box = self.current;
        if (!box?.isConnected || !el.isConnected) return;
        if (overlaps(el.getBoundingClientRect(), box.getBoundingClientRect())) return onClose({ returnFocus: false });
        await new Promise((r) => setTimeout(r, TUCK_EVERY_MS));
      }
    });
  }

  function choose(entry: number, action: HelpAction) {
    if (hasUnsaved()) dispatch({ type: "confirm", confirm: { actionId: action.id, entryId: entry } });
    else go(action);
  }

  const newest = newestAnswerId(state.entries);
  const newestEntry = state.entries.find((e) => e.id === newest);
  // "Go Home" while already on Home would be a dead tap: the suggestion chips are the next step there.
  const shown = (actions: readonly HelpAction[]) => (route.name === "home" ? actions.filter((x) => x.id !== GO_HOME.id) : actions);
  const tomatoTaken = !!newestEntry && newestEntry.role === "assistant" && shown(newestEntry.answer.actions).length > 0;
  const suggestions = suggestionsFor({ page: route.name });
  const left = Math.max(0, Math.ceil((state.blockedUntil - now) / 1000));
  const askOff = !text.trim() || state.thinking || blocked;

  const chips = (key: string) => (
    <ul className="help-chips" aria-label="Questions you can ask" key={key}>
      {suggestions.map((s) => (
        <li key={s}>
          <button type="button" className="help-chip" onClick={() => void ask(s)} disabled={state.thinking || blocked}>
            {s}
          </button>
        </li>
      ))}
    </ul>
  );

  function renderEntry(e: Entry): ReactNode {
    if (e.role === "user")
      return (
        <div key={e.id} className="help-msg help-msg--me">
          <p className="user-text">{e.text}</p>
        </div>
      );
    if (e.role === "notice") {
      const busy = e.tone === "busy";
      return (
        <div key={e.id} className={`help-msg help-msg--notice is-${e.tone}`} role={busy ? "status" : undefined}>
          <Icon name={busy ? "clock" : "info"} size={20} />
          <div>
            <p>{busy && e.until && e.until > now ? busyText(Math.max(1, Math.ceil((e.until - now) / 1000))) : e.text}</p>
            {e.helpCode ? <HelpCode code={e.helpCode} onCopy={copyCode} /> : null}
          </div>
        </div>
      );
    }
    const a = e.answer;
    const isNewest = e.id === newest;
    const pending = state.confirm?.entryId === e.id ? a.actions.find((x) => x.id === state.confirm?.actionId) : undefined;
    return (
      <div key={e.id} className="help-msg help-msg--bot">
        <p className="help-answer__text">
          <AnswerText text={a.text} live={e.live} />
        </p>
        {e.live?.kind === "failed" ? <p className="help-answer__note">{LIVE_FAILED_TEXT}</p> : null}
        {a.steps.length ? (
          <ol className="help-steps">
            {a.steps.map((s, i) => (
              <li key={i}>
                <Bold text={s} />
              </li>
            ))}
          </ol>
        ) : null}
        {pending ? (
          <div className="help-confirm" role="group" aria-label="Leave this page?">
            <p>{UNSAVED_TEXT}</p>
            <div className="help-confirm__row">
              <Button size="sm" className="help-sage" icon="x" onClick={() => dispatch({ type: "confirm", confirm: null })}>
                Stay
              </Button>
              <Button size="sm" className="help-sage" icon="chevronRight" onClick={() => go(pending)}>
                Leave
              </Button>
            </div>
          </div>
        ) : shown(a.actions).length ? (
          <div className="help-actions">
            {shown(a.actions).map((x, i) => (
              <Button
                key={x.id}
                size="sm"
                variant={isNewest && i === 0 ? "primary" : "glass"}
                className={isNewest && i === 0 ? "" : "help-sage"}
                icon={iconFor(x.to)}
                iconAfter="chevronRight"
                onClick={() => choose(e.id, x)}
              >
                {x.label}
              </Button>
            ))}
          </div>
        ) : null}
        {e.trouble || e.live?.kind === "failed" ? <HelpCode code={e.requestId} onCopy={copyCode} /> : null}
        {!a.known && isNewest ? chips(`chips-${e.id}`) : null}
      </div>
    );
  }

  return (
    <section
      ref={self}
      id="help-panel"
      className={`help-panel glass glass--strong${phone ? " is-sheet" : ""}`}
      role="dialog"
      aria-modal={phone ? "true" : "false"}
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          return;
        }
        // The phone sheet is modal: Tab goes round inside it.
        if (e.key === "Tab" && phone && self.current) {
          const all = Array.from(self.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
            const cs = getComputedStyle(el);
            return cs.display !== "none" && cs.visibility !== "hidden";
          });
          const first = all[0];
          const last = all[all.length - 1];
          if (!first || !last) return;
          if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        }
      }}
    >
      <header className="help-panel__head">
        <span className="help-panel__spark" aria-hidden="true">
          <Icon name="sparkle" size={20} />
        </span>
        <h2 className="help-panel__title" id={titleId}>
          Ask Clip Factory
        </h2>
        {narrow ? (
          <button type="button" className="icon-btn help-panel__restart" aria-label="Start over" onClick={startOver}>
            <Icon name="retry" size={20} />
          </button>
        ) : (
          <Button size="sm" variant="ghost" icon="retry" className="help-panel__restart" onClick={startOver}>
            Start over
          </Button>
        )}
        <button type="button" className="icon-btn help-panel__close" aria-label="Close" onClick={() => onClose()}>
          <Icon name="x" />
        </button>
      </header>

      <div className="help-panel__log" ref={log} aria-live="polite">
        {state.entries.length === 0 ? (
          <div className="help-empty">
            <p className="help-empty__hi">{GREETING}</p>
            {chips("chips-empty")}
          </div>
        ) : (
          state.entries.map(renderEntry)
        )}
        {state.thinking ? (
          <div className="help-msg help-msg--bot help-thinking" role="status">
            <span className="help-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className={slow ? "" : "sr-only"}>{slow ? "Still looking…" : "Looking…"}</span>
          </div>
        ) : null}
      </div>

      <form className="help-panel__form" onSubmit={submit}>
        <label className="sr-only" htmlFor={inputId}>
          Your question
        </label>
        <div className="help-panel__field">
          <textarea
            id={inputId}
            ref={input}
            className="input help-panel__input"
            rows={1}
            maxLength={QUESTION_MAX}
            placeholder="Ask me how to do something"
            enterKeyHint="send"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={keys}
            aria-describedby={text.length >= COUNTER_FROM ? `${inputId}-count` : undefined}
          />
          <PaperPlaneButton
            type="submit"
            flight={flight}
            tone={tomatoTaken ? "sage" : "primary"}
            className={`help-panel__ask${tomatoTaken ? " help-sage" : ""}`}
            disabled={askOff}
            aria-label={blocked ? `Send, available in ${left} seconds` : "Send"}
          />
        </div>
        {text.length >= COUNTER_FROM ? (
          <span className="help-panel__count" id={`${inputId}-count`}>
            {text.length}/{QUESTION_MAX}
          </span>
        ) : null}
      </form>
    </section>
  );
}

/** True when two boxes share any area. */
export function overlaps(a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function HelpCode({ code, onCopy }: { code: string; onCopy: (code: string) => void }) {
  return (
    <button type="button" className="help-code text-link" onClick={() => onCopy(code)}>
      Something went wrong? Copy the help code
    </button>
  );
}
