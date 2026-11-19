// The Ask Clip Factory panel (docs/CONTRACTS.md §19.8): a non-modal glass dialog above the launcher on wide
// screens, a full-screen sheet on phones. Short answers, numbered steps and up to two buttons that take you there.
// Pictures (§26): the picture button, paste and drop add up to 4 pictures to the tray above the field; they go with
// the next question and show in its bubble, where a tap opens them bigger.
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { AskMark } from "../../components/AskMark.tsx";
import { api } from "../../api/index.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { PaperPlaneButton, useLaunch } from "../../components/PaperPlane.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { ActGlyph, Button } from "../../components/ui.tsx";
import { useMedia } from "../../lib/hooks.ts";
import { useAction, watchResult } from "../../lib/motion.ts";
import { getPrefs, prefersReducedMotion } from "../../lib/prefs.ts";
import { navigate, type Route } from "../../lib/router.ts";
import { sounds } from "../../lib/sounds.ts";
import { entryId, historyOf, newestAnswerId, readyTray, type ChatEvent, type ChatState, type Entry, type LiveState, type SentPic } from "./chatState.ts";
import { boldParts, fill, GO_HOME, GREETING, hasPlaceholder, LIVE_FAILED_TEXT, OFF_TEXT, suggestionsFor, withoutLive } from "./compose.ts";
import { helpContext, helpPage } from "./context.ts";
import type { HelpClient } from "./helpApi.ts";
import { answerLocally, loadCorpus, routeOk, safeActions } from "./kb.ts";
import { readLive } from "./live.ts";
import { ADDED_TEXT, dragHasFiles, filesFrom, isPictureFile, NOTE_MS, PICTURE_TEXT, PICTURES_MAX, preparePicture, READYING_TEXT, toBase64, type PicError } from "./pictures.ts";
import { PictureViewer, type ViewerPicture } from "./PictureViewer.tsx";
import { spotlight } from "./spotlight.ts";
import { checkHelpStatus, helpSwitch, picturesOn, usePicturesOn } from "./status.ts";
import { QUESTION_MAX, type HelpAction, type HelpAnswer, type HelpPictureResult } from "./types.ts";
import { hasUnsaved } from "./unsaved.ts";

export const COUNTER_FROM = 250;
export const STILL_LOOKING_MS = 6000;
export const COPIED_TEXT = "Copied. Send this code to whoever helps you with Clip Factory.";
export const UNSAVED_TEXT = "You have a change that isn't saved yet. Leave anyway?";
export const AGAIN_TEXT = "You can ask again now.";
export const PICTURE_PLACEHOLDER = "Ask about your picture";
export const LOOKING_AT_PICTURE = "Looking at your picture…";
export const DROP_TEXT = "Drop your picture here";
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
  const pics = usePicturesOn();
  /** A short glass note floating above the tray and field (a picture that could not be added), gone after 5 s. */
  const [note, setNote] = useState<string | null>(null);
  /** What a screen reader hears about the tray ("Picture added. 2 of 4."). */
  const [trayNews, setTrayNews] = useState("");
  const [viewer, setViewer] = useState<{ pictures: ViewerPicture[]; start: number; opener: HTMLElement } | null>(null);
  const [dropping, setDropping] = useState(false);
  /** Tiles shrinking out (160 ms) before they leave the tray. */
  const [leaving, setLeaving] = useState<readonly number[]>([]);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const picButton = useRef<HTMLButtonElement>(null);
  const trayRef = useRef<HTMLUListElement>(null);
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
  // §20: Start over turns once (one handle: only one of its two looks is on screen at a time).
  const restart = useAction("refresh");

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

  // A picture note goes away by itself.
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

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

  /** Before the answer to a question with pictures: keep what they showed, or say why they were not read. With no
   * words the answer itself already says why (the server picks it), so no second note. */
  const beforePictureAnswer = useCallback(
    (askId: number, picture: HelpPictureResult | undefined, worded: boolean) => {
      if (!picture) return;
      if (picture.read) return dispatch({ type: "seen", entryId: askId, seen: picture.seen });
      // Only trouble is an error (deny); off and the daily limit are just how things are.
      if (picture.why === "trouble") sounds.play("deny");
      if (!worded) return;
      const text = picture.why === "off" ? PICTURE_TEXT.off : picture.why === "limit" ? PICTURE_TEXT.limit : PICTURE_TEXT.unread;
      dispatch({ type: "notice", id: entryId(), tone: "info", text });
    },
    [dispatch],
  );

  /** A send that started while a picture was still being made ready: it goes as soon as the tray is ready. */
  const waiting = useRef<string | null>(null);

  const ask = useCallback(
    async (raw: string) => {
      const q = raw.trim().slice(0, QUESTION_MAX);
      const s = stateRef.current;
      const tray = readyTray(s);
      if (s.tray.some((p) => p.busy)) {
        waiting.current = raw;
        setNote(READYING_TEXT);
        return;
      }
      if ((!q && !tray.length) || s.thinking || s.blockedUntil > Date.now() || helpSwitch() === "off") return;
      const gen = generation.current;
      const history = historyOf(s.entries);
      const context = helpContext(routeRef.current);
      const askId = entryId();
      dispatch({ type: "ask", id: askId, text: q, pictures: tray.length ? tray : undefined });
      setText("");
      // When the question could not go, its pictures (and words) come back, so trying again is one tap.
      const giveBack = () => {
        if (!tray.length || gen !== generation.current) return;
        dispatch({ type: "tray_restore", pics: tray });
        if (q) setText((t) => t || q);
      };
      let pictures;
      try {
        pictures = tray.length ? await Promise.all(tray.map(async (p) => ({ type: "image/jpeg" as const, data: await toBase64(p.blob) }))) : undefined;
      } catch {
        pictures = undefined;
      }
      if (gen !== generation.current) return;
      if (tray.length && !pictures) {
        sounds.play("deny");
        dispatch({ type: "notice", id: entryId(), tone: "info", text: PICTURE_TEXT.unread });
        return giveBack();
      }
      const result = await client.ask(pictures ? { question: q, history, context, pictures } : { question: q, history, context });
      if (gen !== generation.current) return;
      switch (result.kind) {
        case "answer":
          beforePictureAnswer(askId, result.picture, !!q);
          return showAnswer(result.answer, result.requestId, false, gen);
        case "rate_limited": {
          sounds.play("deny");
          dispatch({ type: "notice", id: entryId(), tone: "busy", text: AGAIN_TEXT, until: Date.now() + result.retryAfter * 1000 });
          return giveBack();
        }
        case "off":
          dispatch({ type: "notice", id: entryId(), tone: "off", text: OFF_TEXT });
          askedOff.current = true;
          void checkHelpStatus(client);
          return;
        case "bad_request":
          dispatch({ type: "notice", id: entryId(), tone: "info", text: result.message });
          return giveBack();
        case "signed_out":
          return dispatch({ type: "notice", id: entryId(), tone: "info", text: "Sign in again, then ask me." });
        case "fallback": {
          if (result.reason === "server") sounds.play("deny");
          // The kill switch also stops the local answers.
          if (helpSwitch() === "off") return dispatch({ type: "notice", id: entryId(), tone: "off", text: OFF_TEXT });
          // The local answers cannot look at pictures: say so, and answer the words if there are any.
          if (tray.length) {
            dispatch({ type: "notice", id: entryId(), tone: "info", text: PICTURE_TEXT.unread });
            giveBack();
            if (!q) return;
          }
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
    [client, showAnswer, beforePictureAnswer, dispatch, generation],
  );

  // The waiting send goes once no picture is still being made ready.
  useEffect(() => {
    if (waiting.current === null || state.tray.some((p) => p.busy)) return;
    const raw = waiting.current;
    waiting.current = null;
    setNote((n) => (n === READYING_TEXT ? null : n));
    void ask(raw);
  }, [state.tray, ask]);

  /** Adds picked, pasted or dropped files to the tray (pictures only, at most 4). */
  const addFiles = useCallback(
    async (files: readonly File[]) => {
      if (!files.length) return;
      if (!picturesOn()) return setNote(PICTURE_TEXT.off);
      const pictures = files.filter(isPictureFile);
      let error: PicError | null = pictures.length < files.length ? "not_picture" : null;
      const room = PICTURES_MAX - stateRef.current.tray.length;
      if (pictures.length > room) error = "too_many";
      const taking = pictures.slice(0, Math.max(0, room));
      const ids = taking.map(() => entryId());
      ids.forEach((id) => dispatch({ type: "tray_add", id }));
      if (ids.length) setTrayNews(READYING_TEXT);
      const gen = generation.current;
      const results = await Promise.all(taking.map((f) => preparePicture(f)));
      let added = 0;
      results.forEach((r, i) => {
        const id = ids[i]!;
        if ("error" in r) {
          error ??= r.error;
          dispatch({ type: "tray_remove", id });
          return;
        }
        // Start over or a take-away while it was being made ready: let it go.
        if (gen !== generation.current || !stateRef.current.tray.some((p) => p.id === id)) {
          URL.revokeObjectURL(r.url);
          return;
        }
        dispatch({ type: "tray_ready", pic: { ...r, id } });
        added++;
      });
      if (added) setTrayNews(ADDED_TEXT(Math.min(PICTURES_MAX, stateRef.current.tray.length)));
      else setTrayNews("");
      if (error) setNote(PICTURE_TEXT[error]);
    },
    [dispatch, generation],
  );

  function removePicture(id: number, index: number) {
    if (leaving.includes(id)) return;
    const reduced = prefersReducedMotion() || getPrefs().reduceMotion;
    setLeaving((l) => [...l, id]);
    setTrayNews(`Picture taken away. ${Math.max(0, stateRef.current.tray.length - 1)} of ${PICTURES_MAX}.`);
    setTimeout(
      () => {
        dispatch({ type: "tray_remove", id });
        setLeaving((l) => l.filter((x) => x !== id));
        // Focus moves to the next take-away button, or to the picture button when the tray is empty.
        requestAnimationFrame(() => {
          const left = Array.from(trayRef.current?.querySelectorAll<HTMLButtonElement>(".help-pic:not(.is-leaving) .help-pic__remove") ?? []);
          (left[Math.min(index, left.length - 1)] ?? picButton.current ?? input.current)?.focus({ preventScroll: true });
        });
      },
      reduced ? 120 : 160,
    );
  }

  function paste(e: ClipboardEvent<HTMLElement>) {
    const files = filesFrom(e.clipboardData).filter(isPictureFile);
    // Text pastes as text; only a picture is taken over.
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    void addFiles(files);
  }

  function dragEnter(e: DragEvent<HTMLElement>) {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current++;
    setDropping(true);
  }

  function dragOver(e: DragEvent<HTMLElement>) {
    if (!dragHasFiles(e.dataTransfer)) return;
    // Without this the webview would open the file instead of handing it to Ask.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function dragLeave(e: DragEvent<HTMLElement>) {
    if (!dragHasFiles(e.dataTransfer)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropping(false);
  }

  function drop(e: DragEvent<HTMLElement>) {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    void addFiles(filesFrom(e.dataTransfer));
  }

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
    waiting.current = null;
    // The reset lets go of every picture (useRevokeDropped in the launcher).
    dispatch({ type: "reset" });
    setText("");
    setNote(null);
    setTrayNews("");
    input.current?.focus();
  }

  /** Copies the help code; false when the clipboard said no (the toast then shows the code instead). */
  async function copyCode(code: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(COPIED_TEXT);
      return true;
    } catch {
      toast.info(`Your help code is ${code}. Send it to whoever helps you with Clip Factory.`);
      return false;
    }
  }

  function go(action: HelpAction) {
    if (!routeOk(action.to)) return;
    dispatch({ type: "confirm", confirm: null });
    if (phone) onClose({ returnFocus: false });
    navigate(action.to);
    const reduced = prefersReducedMotion() || getPrefs().reduceMotion;
    // On wide screens the panel stays open, unless it covers the control that just lit up: then it steps away
    // (the chat is kept, so the launcher brings the steps back). Checked while the page scrolls the control in, and
    // once more where it comes to rest (on a slow machine the scroll can outlast the checks).
    const covers = (el: HTMLElement) => {
      const box = self.current;
      if (!box?.isConnected || !el.isConnected) return false;
      return overlaps(el.getBoundingClientRect(), box.getBoundingClientRect());
    };
    const onArrive = (el: HTMLElement) => {
      if (!phone && covers(el)) onClose({ returnFocus: false });
    };
    void spotlight(action.highlight ?? [], { reduced, onArrive }).then(async (el) => {
      if (phone || !el) return;
      for (let i = 0; i < TUCK_CHECKS; i++) {
        if (!self.current?.isConnected || !el.isConnected) return;
        if (covers(el)) return onClose({ returnFocus: false });
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
  const mainTaken = !!newestEntry && newestEntry.role === "assistant" && shown(newestEntry.answer.actions).length > 0;
  const suggestions = suggestionsFor({ page: helpPage(route.name) });
  const left = Math.max(0, Math.ceil((state.blockedUntil - now) / 1000));
  const tray = state.tray;
  const processing = tray.some((p) => p.busy);
  const askOff = (!text.trim() && tray.length === 0) || processing || state.thinking || blocked;
  const lastUser = [...state.entries].reverse().find((x) => x.role === "user");
  const lookingAtPicture = state.thinking && lastUser?.role === "user" && !!lastUser.pictures?.length;

  const chips = (key: string) => (
    <ul className="help-chips" aria-label="Questions you can ask" key={key}>
      {suggestions.map((s) => (
        <li key={s}>
          <button
            type="button"
            className="help-chip"
            onClick={() => {
              void ask(s);
              // The chip asks at once and launches the panel's Send plane, as Send does (§20.11).
              if (helpSwitch() !== "off") flight.launch();
            }}
            disabled={state.thinking || blocked}
          >
            {s}
          </button>
        </li>
      ))}
    </ul>
  );

  function renderEntry(e: Entry): ReactNode {
    if (e.role === "user") {
      const sent = e.pictures ?? [];
      const viewable = sent.filter((p): p is SentPic & { url: string } => !!p.url);
      return (
        <div key={e.id} className={`help-msg help-msg--me${sent.length ? " has-pics" : ""}`}>
          {sent.length ? (
            <ul className={`help-sent${sent.length === 1 ? " is-one" : ""}`} aria-label={sent.length === 1 ? "Your picture" : `Your ${sent.length} pictures`}>
              {sent.map((p, i) => (
                <li key={p.id}>
                  {p.url ? (
                    <button
                      type="button"
                      className="help-sent__tile"
                      aria-label={`Open picture ${i + 1} bigger`}
                      onClick={(ev) => setViewer({ pictures: viewable, start: Math.max(0, viewable.findIndex((v) => v.id === p.id)), opener: ev.currentTarget })}
                    >
                      <img src={p.url} alt="" width={p.width} height={p.height} />
                    </button>
                  ) : (
                    <span className="help-sent__tile is-gone" role="img" aria-label={`Picture ${i + 1}, no longer kept`}>
                      <Icon name="image" size={28} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {e.text ? <p className="user-text">{e.text}</p> : null}
        </div>
      );
    }
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
              <Button size="sm" icon="x" onClick={() => dispatch({ type: "confirm", confirm: null })}>
                Stay
              </Button>
              <Button size="sm" variant="action" icon="chevronRight" onClick={() => go(pending)}>
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
                variant={isNewest && i === 0 ? "primary" : "action"}
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
      onPaste={paste}
      onDragEnter={dragEnter}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
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
          <AskMark size={22} />
        </span>
        <h2 className="help-panel__title" id={titleId}>
          Ask Clip Factory
        </h2>
        {narrow ? (
          <button
            type="button"
            className="icon-btn help-panel__restart"
            aria-label="Start over"
            data-act="refresh"
            onClick={() => {
              startOver();
              restart.play();
            }}
          >
            <ActGlyph act={restart}>
              <Icon name="retry" size={20} />
            </ActGlyph>
          </button>
        ) : (
          <Button size="sm" variant="ghost" icon="retry" act={restart} className="help-panel__restart" onClick={startOver}>
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
            <span className={slow || lookingAtPicture ? "" : "sr-only"}>{lookingAtPicture ? LOOKING_AT_PICTURE : slow ? "Still looking…" : "Looking…"}</span>
          </div>
        ) : null}
      </div>

      <form className="help-panel__form" onSubmit={submit}>
        {tray.length ? (
          <ul className="help-pics" ref={trayRef} aria-label="Pictures to send">
            {tray.map((p, i) => (
              <li key={p.id} className={`help-pic${p.busy ? " is-busy" : ""}${leaving.includes(p.id) ? " is-leaving" : ""}`}>
                {p.busy ? (
                  <span className="help-pic__wait help-shimmer" aria-hidden="true" />
                ) : (
                  <>
                    <img className="help-pic__img" src={p.url} alt={`Picture ${i + 1}`} width={p.width} height={p.height} />
                    <button type="button" className="help-pic__remove" aria-label={`Take away picture ${i + 1}`} onClick={() => removePicture(p.id, i)}>
                      <Icon name="x" size={16} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        <span className="sr-only" role="status">
          {trayNews}
        </span>
        <label className="sr-only" htmlFor={inputId}>
          Your question
        </label>
        <div className={`help-panel__field${pics ? " has-pic-btn" : ""}`}>
          {pics ? (
            <>
              <button
                ref={picButton}
                type="button"
                className="icon-btn help-panel__pic"
                aria-label="Add a picture"
                onClick={() => {
                  if (stateRef.current.tray.length >= PICTURES_MAX) return setNote(PICTURE_TEXT.too_many);
                  fileInput.current?.click();
                }}
              >
                <Icon name="image" size={phone ? 24 : 22} />
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const files = Array.from(e.currentTarget.files ?? []);
                  // The same picture can be picked again next time.
                  e.currentTarget.value = "";
                  void addFiles(files);
                }}
              />
            </>
          ) : null}
          <textarea
            id={inputId}
            ref={input}
            className="input help-panel__input"
            rows={1}
            maxLength={QUESTION_MAX}
            placeholder={tray.length ? PICTURE_PLACEHOLDER : "Ask me how to do something"}
            enterKeyHint="send"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={keys}
            aria-describedby={text.length >= COUNTER_FROM ? `${inputId}-count` : undefined}
          />
          <PaperPlaneButton
            type="submit"
            flight={flight}
            tone={mainTaken ? "action" : "primary"}
            className="help-panel__ask"
            disabled={askOff}
            aria-label={blocked ? `Send, available in ${left} seconds` : "Send"}
          />
        </div>
        {text.length >= COUNTER_FROM ? (
          <span className="help-panel__count" id={`${inputId}-count`}>
            {text.length}/{QUESTION_MAX}
          </span>
        ) : null}
        <div className="help-note-slot" role="status">
          {note ? (
            <p className="help-note">
              <Icon name="info" size={18} />
              <span>{note}</span>
            </p>
          ) : null}
        </div>
      </form>
      {dropping ? (
        <div className="help-drop" aria-hidden="true">
          <Icon name="image" size={56} />
          <p>{DROP_TEXT}</p>
        </div>
      ) : null}
      {viewer ? <PictureViewer pictures={viewer.pictures} start={viewer.start} opener={viewer.opener} onClose={() => setViewer(null)} /> : null}
    </section>
  );
}

/** True when two boxes share any area. */
export function overlaps(a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function HelpCode({ code, onCopy }: { code: string; onCopy: (code: string) => Promise<boolean> }) {
  const copy = useAction("copy");
  return (
    <button
      type="button"
      className="help-code text-link"
      data-act="copy"
      onClick={() => {
        const done = onCopy(code);
        copy.play();
        // The clipboard said no: no "copied" look; the toast shows the code instead (no deny: nothing went wrong).
        watchResult(done, () => copy.fail({ sound: false }));
      }}
    >
      <ActGlyph act={copy}>
        <Icon name="copy" size={16} />
      </ActGlyph>
      Something went wrong? Copy the help code
    </button>
  );
}
