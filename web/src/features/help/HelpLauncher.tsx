// Ask Clip Factory's launcher (docs/CONTRACTS.md §19.8), mounted once in the signed-in shell: a glass "Ask" pill
// bottom right on wide screens (above the update bar), a 56 px icon-only circle on phones that never covers the
// tab bar or the update bar. It keeps that one spot and never moves; once the page is still, if it would make a
// control under it hard to tap, it fades out in place, and back in when the spot is clear (dodge.ts). Green glass,
// never vermilion.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AskMark } from "../../components/AskMark.tsx";
import { useMedia } from "../../lib/hooks.ts";
import { useRoute } from "../../lib/router.ts";
import { chatReducer, initialChat, useRevokeDropped } from "./chatState.ts";
import { HELP_EVENT } from "./context.ts";
import { useDodge } from "./dodge.ts";
import { defaultHelpClient, type HelpClient } from "./helpApi.ts";
import { HelpPanel } from "./HelpPanel.tsx";
import { dragHasFiles } from "./pictures.ts";
import { helpSwitch, useHelpSwitch, watchHelpStatus } from "./status.ts";

/** True when the element shows a keyboard focus ring (false where the browser cannot tell). */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/** How long the panel shows "turned off" before it closes. */
export const OFF_CLOSE_MS = 2500;

export function AskClipFactory({ client: given }: { client?: HelpClient } = {}) {
  const route = useRoute();
  const sw = useHelpSwitch();
  const phone = useMedia("(max-width: 767px)");
  const [client, setClient] = useState<HelpClient | null>(given ?? null);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const { hidden, reason } = useDodge(launcher, open || focused, open);
  // The conversation lives here, in memory only (§19.2, §19.8), so closing the panel (on phones, an answer button
  // closes it) and opening it again shows the last answer. Start over clears it; nothing is ever stored.
  const [chat, dispatch] = useReducer(chatReducer, initialChat);
  const generation = useRef(0);
  // Pictures are object URLs: each is let go when it leaves the chat, and all of them when Ask goes (sign-out).
  useRevokeDropped(chat);

  // A file dropped anywhere no drop zone took it must never replace the app (the Mac app hands drops to the page
  // since Ask takes pictures, §26): the drop is ignored.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.defaultPrevented || !dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.type === "dragover" && e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  // On phones the sheet covers everything, so it is modal: the page and the launcher behind it are inert.
  useEffect(() => {
    if (!open || !phone) return;
    const sheet = document.getElementById("help-panel");
    if (!sheet) return;
    // Everything beside the sheet and beside each of its ancestors (the shell, the tab bar, the launcher…).
    const behind: HTMLElement[] = [];
    for (let el: HTMLElement | null = sheet; el && el !== document.body; el = el.parentElement) {
      for (const sib of Array.from(el.parentElement?.children ?? [])) {
        if (sib !== el && sib instanceof HTMLElement && !sib.matches("script, style, .help-ring, #help-announce")) behind.push(sib);
      }
    }
    const changed = behind.filter((el) => !el.hasAttribute("inert"));
    for (const el of changed) el.setAttribute("inert", "");
    return () => {
      for (const el of changed) el.removeAttribute("inert");
    };
  }, [open, phone]);

  // The client, then the status checks (sign-in, every 5 minutes, back to the front).
  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    void (given ? Promise.resolve(given) : defaultHelpClient()).then((c) => {
      if (!alive) return;
      setClient(c);
      stop = watchHelpStatus(c);
    });
    return () => {
      alive = false;
      stop?.();
    };
  }, [given]);

  const close = useCallback((opts: { returnFocus?: boolean } = {}) => {
    setOpen(false);
    if (opts.returnFocus === false) return;
    const back = opener.current && opener.current.isConnected ? opener.current : launcher.current;
    requestAnimationFrame(() => (back ?? launcher.current)?.focus({ preventScroll: true }));
  }, []);

  // Open from anywhere: window.dispatchEvent(new CustomEvent("cf:help", { detail: { question } })).
  useEffect(() => {
    const onOpen = (e: Event) => {
      if (helpSwitch() !== "on") return;
      const q = (e as CustomEvent<{ question?: unknown }>).detail?.question;
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : launcher.current;
      setOpen(true);
      if (typeof q === "string" && q.trim()) setQuestion(q.trim());
    };
    window.addEventListener(HELP_EVENT, onOpen);
    return () => window.removeEventListener(HELP_EVENT, onOpen);
  }, []);

  // Turned off while open: the panel says so once, then closes.
  useEffect(() => {
    if (sw !== "off" || !open) return;
    const t = setTimeout(() => setOpen(false), OFF_CLOSE_MS);
    return () => clearTimeout(t);
  }, [sw, open]);

  const takeQuestion = useCallback(() => setQuestion(null), []);

  if (!client || sw === "unknown" || (sw === "off" && !open)) return null;
  return (
    <>
      {sw === "on" ? (
        <button
          ref={launcher}
          type="button"
          className={`help-launcher glass glass--green${hidden ? " is-hidden" : ""}${open ? " is-open" : ""}`}
          aria-label="Ask Clip Factory"
          aria-expanded={open}
          aria-controls={open ? "help-panel" : undefined}
          data-dodge={reason ?? undefined}
          // Only keyboard focus holds it shown: a tap, or focus handed back when the panel closes after a tap, does not.
          onFocus={(e) => setFocused(focusVisible(e.currentTarget))}
          onBlur={() => setFocused(false)}
          onClick={() => {
            if (open) return close();
            opener.current = launcher.current;
            setOpen(true);
          }}
        >
          <AskMark size={phone ? 24 : 22} />
          <span className="help-launcher__word">Ask</span>
        </button>
      ) : null}
      {open ? (
        <HelpPanel
          client={client}
          route={route}
          phone={phone}
          off={sw === "off"}
          question={question}
          onQuestionTaken={takeQuestion}
          onClose={close}
          chat={chat}
          dispatch={dispatch}
          generation={generation}
        />
      ) : null}
    </>
  );
}
