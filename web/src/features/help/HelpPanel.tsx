// The Ask Clip Factory panel (docs/CONTRACTS.md §19.8): a non-modal glass dialog above the launcher on wide
// screens, a full-screen sheet on phones. Short answers, numbered steps and up to two buttons that take you there.
// Pictures (§26): the picture button, paste and drop add up to 4 pictures to the tray above the field; they go with
// the next question and show in its bubble, where a tap opens them bigger.
// Ask as a full assistant (§27): when the API says the assistant is on, any question goes to Claude Opus 5.5 and the
// answer streams in; any file can be added (paperclip, drop, paste), pictures can be marked in red first, and a
// follow-up carries the last files along. Without the assistant everything works as §19 and §26 describe.
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
import { liveConnection } from "../../lib/live.ts";
import { defaultAskApi, type AskApi } from "./askApi.ts";
import { AnswerBody, CopyButton, FileTile, Sources, StatusLine, unreadNote, UploadRing } from "./AskBits.tsx";
import { runAsk, type AskConnection, type Running, type UploadFile } from "./askStream.ts";
import { addedText, carriedFiles, classify, COUNTER_FROM as ASK_COUNTER_FROM, FILE_TEXT, FILES_MAX, BYTES_PER_FILE, IMAGES_MAX, formatLabel, pastedTextFile, QUESTION_CHARS, type AskFile } from "./files.ts";
import { MarkupEditor, type MarkupResult } from "./MarkupEditor.tsx";
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
import { askHistory, entryId, historyOf, newestAnswerId, readyFiles, readyTray, type ChatEvent, type ChatState, type Entry, type LiveState, type SentPic } from "./chatState.ts";
import { boldParts, fill, GO_HOME, GREETING, hasPlaceholder, LIVE_FAILED_TEXT, OFF_TEXT, suggestionsFor, withoutLive } from "./compose.ts";
import { helpContext, helpPage } from "./context.ts";
import type { HelpClient } from "./helpApi.ts";
import { answerLocally, loadCorpus, routeOk, safeActions } from "./kb.ts";
import { readLive } from "./live.ts";
import { ADDED_TEXT, dragHasFiles, filesFrom, isPictureFile, NOTE_MS, PICTURE_TEXT, PICTURES_MAX, preparePicture, READYING_TEXT, toBase64, type PicError } from "./pictures.ts";
import { PictureViewer, type ViewerPicture } from "./PictureViewer.tsx";
import { spotlight } from "./spotlight.ts";
import { assistantStatus, checkHelpStatus, helpSwitch, picturesOn, useAssistant, usePicturesOn } from "./status.ts";
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
export const DROP_ANY_TEXT = "Drop it here";
export const ASK_PLACEHOLDER = "Ask me anything";
export const FILES_PLACEHOLDER = "Ask about your files";
export const SHORT_HELP_TEXT = "I couldn't think it through this time. Here is the short help.";
export const CUT_TEXT = "The answer was cut short. Ask me to go on.";
export const UPLOAD_FAILED_TEXT = "I couldn't send your files. Check your internet and try again.";
export const WEB_TIP_TEXT = "I can't search the web yet. Turn it on in Settings, and I can check today's steps for you.";
export const WEB_SETUP_ACTION: HelpAction = { id: "ask-web-setup:open", label: "Turn on web search", to: "/settings/app/ask#ask-web-setup", highlight: ["ask-web-setup"] };
const BIGGER_KEY = "cf-ask-bigger";
/** Send becomes Stop after this, so the paper plane's flight (or its 300 ms fade) is never cut off. */
export const STOP_AFTER_MS = 600;
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
  files: handed = null,
  onFilesTaken,
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
  /** Files dropped on the launcher (§27.7), added to the tray once the panel is open. */
  files?: File[] | null;
  onFilesTaken?: () => void;
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
  // §27: the assistant, the picture being marked, the answer streaming now, Bigger (desktop and tablet).
  const assistant = useAssistant();
  const smart = assistant.on;
  const filesOn = smart && assistant.files;
  const [marking, setMarking] = useState<{ id: number; opener: HTMLElement | null } | null>(null);
  const running = useRef<Running | null>(null);
  const askApiRef = useRef<Promise<AskApi> | null>(null);
  /** Server file ids → names, for "I couldn't read this one" notes (memory only). */
  const fileNames = useRef(new Map<string, string>());
  /** The one answer that shows the "turn on web search" tip (once per chat). */
  const webTipShown = useRef<number | null>(null);
  const [bigger, setBigger] = useState(() => {
    try {
      return localStorage.getItem(BIGGER_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleBigger = () =>
    setBigger((b) => {
      try {
        localStorage.setItem(BIGGER_KEY, b ? "0" : "1");
      } catch {
        /* a private window: it simply is not remembered */
      }
      return !b;
    });
  const getAskApi = () => (askApiRef.current ??= defaultAskApi());
  const [stopReady, setStopReady] = useState(false);
  useEffect(() => {
    if (state.streaming === null) {
      setStopReady(false);
      return;
    }
    const t = setTimeout(() => setStopReady(true), STOP_AFTER_MS);
    return () => clearTimeout(t);
  }, [state.streaming]);

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

  /** §27: the question goes to the assistant; the answer streams into an "ai" entry. Falls back to §19 when it can't. */
  const askSmart = useCallback(
    async (raw: string, fallback: (q: string, note: string | null) => Promise<void>) => {
      const q = raw.trim().slice(0, QUESTION_CHARS);
      const s = stateRef.current;
      const files = readyFiles(s);
      if ((!q && !files.length) || s.streaming !== null || s.thinking || s.blockedUntil > Date.now() || helpSwitch() === "off") return;
      const gen = generation.current;
      const sentTurns = s.entries.filter((e): e is Extract<Entry, { role: "user" }> => e.role === "user");
      const turns: { files: AskFile[] }[] = sentTurns.map((e) => ({
        files: (e.files ?? [])
          .filter((f): f is typeof f & { blob: Blob } => !!f.blob && !s.dropped.includes(f.id))
          .map((f) => ({ ...f, url: f.url ?? undefined })),
      }));
      const carried = carriedFiles(turns, files);
      const history = askHistory(s.entries);
      const context = helpContext(routeRef.current);
      const askId = entryId();
      const aiId = entryId();
      dispatch({ type: "ask", id: askId, text: q, files });
      setText("");
      const giveBack = () => {
        if (gen !== generation.current) return;
        if (files.length) dispatch({ type: "tray_restore", pics: files });
        if (q) setText((t) => t || q);
      };
      const api = await getAskApi();
      const conn = liveConnection();
      const adapter: AskConnection | null = conn ? { whoami: (ms) => conn.whoami(ms), onRaw: (fn) => conn.onRaw(fn) } : null;
      const uploads: UploadFile[] = [...files, ...carried].map((f, i) => ({
        id: f.id,
        name: f.name,
        type: f.kind === "image" ? "image/jpeg" : f.blob.type || "application/octet-stream",
        size: f.blob.size,
        blob: f.blob,
        format: f.format,
        kind: f.kind,
        carried: i >= files.length,
      }));
      let fileIds: Record<number, string> = {};
      dispatch({ type: "ai_start", id: aiId, askId: "pending" });
      const run = runAsk({ api, conn: adapter }, { question: q, history, context }, uploads, {
        onEvent: (ev) => gen === generation.current && dispatch({ type: "ai_event", entryId: aiId, event: ev }),
        onUpload: (id, fraction) => gen === generation.current && dispatch({ type: "upload", id, fraction }),
        onFileIds: (ids) => {
          fileIds = ids;
          for (const u of uploads) if (ids[u.id]) fileNames.current.set(ids[u.id]!, u.name);
        },
      });
      running.current = run;
      const end = await run.done;
      if (running.current === run) running.current = null;
      if (gen !== generation.current) return;
      switch (end.kind) {
        case "streamed": {
          const entry = stateRef.current.entries.find((e) => e.id === aiId);
          const stop = entry?.role === "ai" ? entry.answer.done?.stop : undefined;
          if (stop === "error") {
            sounds.play("deny");
            dispatch({ type: "ai_note", entryId: aiId, note: CUT_TEXT });
          }
          return dispatch({ type: "ai_end", entryId: aiId });
        }
        case "stopped":
          return dispatch({ type: "ai_end", entryId: aiId });
        case "refused":
          dispatch({ type: "ai_event", entryId: aiId, event: { type: "ask.delta", askId: "", seq: 1, text: end.text } });
          dispatch({ type: "ai_event", entryId: aiId, event: { type: "ask.done", askId: "", stop: "refused", links: [] } });
          return dispatch({ type: "ai_end", entryId: aiId });
        case "rate_limited":
          dispatch({ type: "ai_end", entryId: aiId });
          sounds.play("deny");
          dispatch({ type: "notice", id: entryId(), tone: "busy", text: AGAIN_TEXT, until: Date.now() + end.retryAfter * 1000 });
          return giveBack();
        case "bad_request":
          dispatch({ type: "ai_end", entryId: aiId });
          dispatch({ type: "notice", id: entryId(), tone: "info", text: end.message.replace(/\*\*/g, "") });
          return giveBack();
        case "upload_failed":
          dispatch({ type: "ai_end", entryId: aiId });
          sounds.play("deny");
          for (const id of Object.values(fileIds)) void api.deleteFile(id);
          dispatch({ type: "notice", id: entryId(), tone: "info", text: UPLOAD_FAILED_TEXT });
          return giveBack();
        case "fallback": {
          dispatch({ type: "ai_end", entryId: aiId });
          if (end.reason === "model" || end.reason === "timeout") sounds.play("deny");
          if (end.reason === "off") void checkHelpStatus(client);
          return fallback(q, end.reason === "model" || end.reason === "timeout" ? SHORT_HELP_TEXT : null);
        }
      }
    },
    [client, dispatch, generation],
  );

  const ask = useCallback(
    async (raw: string) => {
      if (assistantStatus().on) {
        return askSmart(raw, async (q, note) => {
          // The §19 path: the server's plain answer when the socket was not there, else the local one.
          const gen = generation.current;
          const history = historyOf(stateRef.current.entries);
          const context = helpContext(routeRef.current);
          const short = q.slice(0, QUESTION_MAX);
          if (note) dispatch({ type: "notice", id: entryId(), tone: "info", text: note });
          if (!short) return;
          if (!note) {
            const result = await client.ask({ question: short, history, context });
            if (gen !== generation.current) return;
            if (result.kind === "answer") return showAnswer(result.answer, result.requestId, false, gen);
          }
          try {
            const local = await answerLocally(short, history, context);
            if (gen === generation.current) showAnswer(local, `c-${Date.now()}`, true, gen);
          } catch {
            if (gen === generation.current) dispatch({ type: "notice", id: entryId(), tone: "info", text: "Ask Clip Factory can't answer right now." });
          }
        });
      }
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
    [client, showAnswer, beforePictureAnswer, dispatch, generation, askSmart],
  );

  // The waiting send goes once no picture is still being made ready.
  useEffect(() => {
    if (waiting.current === null || state.tray.some((p) => p.busy)) return;
    const raw = waiting.current;
    waiting.current = null;
    setNote((n) => (n === READYING_TEXT ? null : n));
    void ask(raw);
  }, [state.tray, ask]);

  /** §27: adds any files to the tray. Pictures become small clean JPEGs; other files go as they are; files Ask can't
   * read are refused here with a note that says what to do. */
  const addAny = useCallback(
    async (files: readonly File[]) => {
      const st = assistantStatus();
      if (!st.files) return setNote("Files are off right now. Ask me in words.");
      let error: string | null = null;
      const tray = stateRef.current.tray;
      let count = tray.length;
      let images = tray.filter((p) => p.busy || p.kind === "image").length;
      const pictures: { file: File; id: number }[] = [];
      let lastFormat = "";
      for (const file of files) {
        const c = classify(file);
        if ("refused" in c) {
          error ??= c.refused;
          continue;
        }
        if (file.size === 0) {
          error ??= FILE_TEXT.empty;
          continue;
        }
        if (count >= FILES_MAX) {
          error ??= FILE_TEXT.too_many;
          continue;
        }
        const format = formatLabel(file.name, file.type);
        if (c.kind === "image") {
          if (images >= IMAGES_MAX) {
            error ??= FILE_TEXT.too_many_pictures;
            continue;
          }
          const id = entryId();
          dispatch({ type: "tray_add", id });
          pictures.push({ file, id });
          images++;
        } else {
          if (file.size > BYTES_PER_FILE) {
            error ??= FILE_TEXT.too_big;
            continue;
          }
          dispatch({ type: "tray_file", file: { id: entryId(), kind: c.kind, name: file.name || `File.${format.toLowerCase()}`, format, size: file.size, blob: file } });
        }
        lastFormat = c.kind === "image" ? "IMAGE" : format;
        count++;
      }
      if (lastFormat) setTrayNews(addedText(lastFormat, Math.min(FILES_MAX, count)));
      if (error) {
        setNote(error.replace(/\*\*/g, ""));
        sounds.play("deny");
      }
      if (!pictures.length) return;
      const gen = generation.current;
      const results = await Promise.all(pictures.map((p) => preparePicture(p.file)));
      results.forEach((r, i) => {
        const { id, file } = pictures[i]!;
        if ("error" in r) {
          dispatch({ type: "tray_remove", id });
          setNote(PICTURE_TEXT[r.error === "not_picture" ? "cant_open" : r.error]);
          return;
        }
        if (gen !== generation.current || !stateRef.current.tray.some((p) => p.id === id)) {
          URL.revokeObjectURL(r.url);
          return;
        }
        const name = file.name || "Picture.jpg";
        dispatch({ type: "tray_ready", pic: { id, kind: "image", name, format: formatLabel(name, file.type), size: r.blob.size, blob: r.blob, url: r.url, width: r.width, height: r.height } });
      });
    },
    [dispatch, generation],
  );

  /** Adds picked, pasted or dropped files to the tray (pictures only, at most 4). */
  const addFiles = useCallback(
    async (files: readonly File[]) => {
      if (!files.length) return;
      if (assistantStatus().on) return addAny(files);
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
    [dispatch, generation, addAny],
  );

  function removePicture(id: number, index: number) {
    if (leaving.includes(id)) return;
    const reduced = prefersReducedMotion() || getPrefs().reduceMotion;
    setLeaving((l) => [...l, id]);
    const gone = stateRef.current.tray.find((p) => p.id === id);
    const max = assistantStatus().on ? FILES_MAX : PICTURES_MAX;
    setTrayNews(`${gone && !gone.busy && gone.kind !== "image" ? `${gone.name} taken away` : "Picture taken away"}. ${Math.max(0, stateRef.current.tray.length - 1)} of ${max}.`);
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
    if (assistantStatus().on) {
      const all = filesFrom(e.clipboardData);
      if (all.length) {
        e.preventDefault();
        e.stopPropagation();
        void addFiles(all);
        return;
      }
      // Long text becomes a file, so the question stays short (§27.7).
      const pasted = e.clipboardData?.getData("text/plain") ?? "";
      if (pasted.length > QUESTION_CHARS && assistantStatus().files) {
        e.preventDefault();
        void addAny([pastedTextFile(pasted)]).then(() => setNote(FILE_TEXT.long_paste));
      }
      return;
    }
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

  // Files handed over by the launcher.
  useEffect(() => {
    if (!handed?.length) return;
    onFilesTaken?.();
    void addFiles(handed);
  }, [handed, addFiles, onFilesTaken]);

  // A question handed over by openHelp("…").
  useEffect(() => {
    if (!question) return;
    onQuestionTaken();
    void ask(question);
  }, [question, ask, onQuestionTaken]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    // While an answer streams, Send is Stop.
    if (stateRef.current.streaming !== null) {
      running.current?.stop();
      return;
    }
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
    running.current?.stop();
    running.current = null;
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

  /** The editor's Save: the marked JPEG replaces the tray picture; the original stays in memory until it is sent. */
  function saveMarks(id: number, r: MarkupResult) {
    const item = stateRef.current.tray.find((p) => p.id === id);
    if (!item || item.busy) {
      URL.revokeObjectURL(r.url);
      return;
    }
    const original = item.original ?? { blob: item.blob, url: item.url!, width: item.width ?? r.width, height: item.height ?? r.height };
    dispatch({ type: "tray_marked", id, blob: r.blob, url: r.url, width: r.width, height: r.height, strokes: r.strokes, original });
    setTrayNews(r.strokes.length ? "Picture marked." : "Marks taken away.");
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
  const streaming = state.streaming !== null;
  // Send turns into Stop once the paper plane has flown (§20.6 keeps its fade even with less motion).
  const askOff = !streaming && ((!text.trim() && tray.length === 0) || processing || state.thinking || blocked);
  const maxChars = smart ? QUESTION_CHARS : QUESTION_MAX;
  const counterFrom = smart ? ASK_COUNTER_FROM : COUNTER_FROM;
  const lastUserFiles = (() => {
    for (let i = state.entries.length - 1; i >= 0; i--) {
      const e = state.entries[i]!;
      if (e.role === "user" && e.files?.length) return e.files.filter((f) => f.blob && !state.dropped.includes(f.id));
    }
    return [];
  })();
  const markItem = marking ? tray.find((p) => p.id === marking.id && !p.busy) : undefined;
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

  /** A streamed answer (§27.9): status line, text, sources, buttons, unread files, Copy answer. */
  function renderAi(e: Extract<Entry, { role: "ai" }>): ReactNode {
    const a = e.answer;
    const isNewest = e.id === newest;
    const prefix = `ask-${e.id}`;
    const unread = Object.values(a.files).filter((f) => !f.read);
    const pending = state.confirm?.entryId === e.id ? a.actions.find((x) => x.id === state.confirm?.actionId) : undefined;
    const actions = shown(a.actions.filter((x) => routeOk(x.to)));
    if (a.done?.webMissing && webTipShown.current === null) webTipShown.current = e.id;
    const showWebTip = webTipShown.current === e.id && !actions.some((x) => x.id === WEB_SETUP_ACTION.id);
    return (
      <div key={e.id} className="help-msg help-msg--bot ask-msg" aria-busy={!a.done || undefined}>
        {a.status && !a.done ? <StatusLine label={a.status.label} /> : null}
        {a.text ? <AnswerBody answer={a} idPrefix={prefix} /> : null}
        {e.note ? <p className="help-answer__note">{e.note}</p> : null}
        {unread.length ? (
          <ul className="ask-unread">
            {unread.map((u) => (
              <li key={u.fileId}>
                <Icon name="info" size={16} />
                <span>
                  <strong>{fileNames.current.get(u.fileId) ?? "A file"}</strong> {unreadNote(u.why)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {a.done ? <Sources sources={a.sources} done={a.done} idPrefix={prefix} /> : null}
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
        ) : actions.length ? (
          <div className="help-actions">
            {actions.map((x, i) => (
              <Button key={x.id} size="sm" variant={isNewest && i === 0 ? "primary" : "action"} icon={iconFor(x.to)} iconAfter="chevronRight" onClick={() => choose(e.id, x)}>
                {x.label}
              </Button>
            ))}
          </div>
        ) : null}
        {showWebTip ? (
          <div className="ask-tip">
            <p>{WEB_TIP_TEXT}</p>
            <Button size="sm" variant="glass" icon="globe" iconAfter="chevronRight" onClick={() => go(WEB_SETUP_ACTION)}>
              {WEB_SETUP_ACTION.label}
            </Button>
          </div>
        ) : null}
        {a.done && a.text ? <CopyButton text={a.text} label="Copy answer" className="ask-copy--answer" /> : null}
      </div>
    );
  }

  function renderEntry(e: Entry): ReactNode {
    if (e.role === "user") {
      const sent = e.pictures ?? [];
      const viewable = sent.filter((p): p is SentPic & { url: string } => !!p.url);
      return (
        <div key={e.id} className={`help-msg help-msg--me${sent.length || e.files?.length ? " has-pics" : ""}`}>
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
          {e.files?.length ? (
            <ul className="ask-sent" aria-label={e.files.length === 1 ? "Your file" : `Your ${e.files.length} files`}>
              {e.files.map((f, i) => {
                return (
                  <li key={f.id}>
                    {f.kind === "image" ? (
                      f.url ? (
                        <button
                          type="button"
                          className="help-sent__tile"
                          aria-label={`Open picture ${i + 1} bigger`}
                          onClick={(ev) =>
                            setViewer({
                              pictures: [{ url: f.url!, width: f.width ?? 0, height: f.height ?? 0 }],
                              start: 0,
                              opener: ev.currentTarget,
                            })
                          }
                        >
                          <img src={f.url} alt="" width={f.width} height={f.height} />
                          {f.marked ? <span className="ask-marked" aria-label="Marked"><Icon name="pen" size={12} /></span> : null}
                        </button>
                      ) : (
                        <span className="help-sent__tile is-gone" role="img" aria-label={`Picture ${i + 1}, no longer kept`}>
                          <Icon name="image" size={28} />
                        </span>
                      )
                    ) : (
                      <FileTile f={f} note={f.blob ? undefined : "No longer kept"} />
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {e.text ? <p className="user-text">{e.text}</p> : null}
        </div>
      );
    }
    if (e.role === "ai") return renderAi(e);
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
      className={`help-panel glass glass--strong${phone ? " is-sheet" : ""}${bigger && !phone ? " is-bigger" : ""}`}
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
        {!phone && smart ? (
          <button type="button" className="icon-btn help-panel__bigger" aria-pressed={bigger} aria-label={bigger ? "Smaller" : "Bigger"} onClick={toggleBigger}>
            <Icon name={bigger ? "shrink" : "expand"} size={20} />
          </button>
        ) : null}
        {narrow || (smart && !phone && !bigger) ? (
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
          <ul className={`help-pics${smart ? " ask-tray" : ""}`} ref={trayRef} aria-label={smart ? "Files to send" : "Pictures to send"}>
            {tray.map((p, i) => {
              const picNo = tray.slice(0, i + 1).filter((x) => x.busy || x.kind === "image").length;
              return (
                <li
                  key={p.id}
                  className={`help-pic${p.busy ? " is-busy" : ""}${!p.busy && p.kind !== "image" ? " is-file" : ""}${leaving.includes(p.id) ? " is-leaving" : ""}`}
                >
                  {p.busy ? (
                    <span className="help-pic__wait help-shimmer" aria-hidden="true" />
                  ) : p.kind === "image" ? (
                    <>
                      {smart ? (
                        <button
                          type="button"
                          className="help-pic__mark"
                          aria-label={`Mark picture ${picNo}${p.marked ? " (marked)" : ""}`}
                          onClick={(ev) => setMarking({ id: p.id, opener: ev.currentTarget })}
                        >
                          <img className="help-pic__img" src={p.url} alt="" width={p.width} height={p.height} />
                        </button>
                      ) : (
                        <img className="help-pic__img" src={p.url} alt={`Picture ${picNo}`} width={p.width} height={p.height} />
                      )}
                      {smart ? (
                        <span className={`ask-marked${p.marked ? "" : " is-hint"}`} aria-hidden="true">
                          <Icon name="pen" size={12} />
                        </span>
                      ) : null}
                      <UploadRing value={state.uploads[p.id]} name={`picture ${picNo}`} />
                      <button type="button" className="help-pic__remove" aria-label={`Take away picture ${picNo}`} onClick={() => removePicture(p.id, i)}>
                        <Icon name="x" size={16} />
                      </button>
                    </>
                  ) : (
                    <FileTile f={p}>
                      <UploadRing value={state.uploads[p.id]} name={p.name} />
                      <button type="button" className="help-pic__remove" aria-label={`Take away ${p.name}`} onClick={() => removePicture(p.id, i)}>
                        <Icon name="x" size={16} />
                      </button>
                    </FileTile>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        {smart && lastUserFiles.length && !tray.length && !streaming ? (
          <div className="ask-carry" role="group" aria-label="Files your next question still uses">
            <span className="ask-carry__label">Still using:</span>
            <ul className="ask-carry__list">
              {lastUserFiles.map((f, i) => (
                <li key={f.id} className="ask-carry__item">
                  <span className="ask-carry__name">{f.kind === "image" ? `picture ${i + 1}` : f.name}</span>
                  <button type="button" className="ask-carry__drop" aria-label={`Stop using ${f.kind === "image" ? `picture ${i + 1}` : f.name}`} onClick={() => dispatch({ type: "carry_drop", id: f.id })}>
                    <Icon name="x" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <span className="sr-only" role="status">
          {trayNews}
        </span>
        <label className="sr-only" htmlFor={inputId}>
          Your question
        </label>
        <div className={`help-panel__field${pics || filesOn ? " has-pic-btn" : ""}`}>
          {pics || filesOn ? (
            <>
              <button
                ref={picButton}
                type="button"
                className="icon-btn help-panel__pic"
                aria-label={filesOn ? "Add a file" : "Add a picture"}
                onClick={() => {
                  if (filesOn) {
                    if (stateRef.current.tray.length >= FILES_MAX) return setNote(FILE_TEXT.too_many);
                  } else if (stateRef.current.tray.length >= PICTURES_MAX) return setNote(PICTURE_TEXT.too_many);
                  fileInput.current?.click();
                }}
              >
                <Icon name={filesOn ? "paperclip" : "image"} size={phone ? 24 : 22} />
              </button>
              <input
                ref={fileInput}
                type="file"
                accept={filesOn ? undefined : "image/*"}
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
            maxLength={maxChars}
            placeholder={smart ? (tray.length ? FILES_PLACEHOLDER : ASK_PLACEHOLDER) : tray.length ? PICTURE_PLACEHOLDER : "Ask me how to do something"}
            enterKeyHint="send"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={keys}
            aria-describedby={text.length >= counterFrom ? `${inputId}-count` : undefined}
          />
          {streaming && stopReady ? (
            <button type="submit" className="btn btn--sm btn--glass ask-stop" aria-label="Stop answer">
              <Icon name="square" size={20} />
            </button>
          ) : (
            <PaperPlaneButton
              type="submit"
              flight={flight}
              tone={mainTaken ? "action" : "primary"}
              className="help-panel__ask"
              disabled={askOff}
              aria-label={blocked ? `Send, available in ${left} seconds` : "Send"}
            />
          )}
        </div>
        {text.length >= counterFrom ? (
          <span className="help-panel__count" id={`${inputId}-count`}>
            {text.length}/{maxChars}
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
          <Icon name={filesOn ? "paperclip" : "image"} size={56} />
          <p>{filesOn ? DROP_ANY_TEXT : DROP_TEXT}</p>
        </div>
      ) : null}
      {marking && markItem && !markItem.busy && markItem.url ? (
        <MarkupEditor
          source={{
            url: markItem.original?.url ?? markItem.url,
            blob: markItem.original?.blob ?? markItem.blob,
            width: markItem.original?.width ?? markItem.width ?? 1,
            height: markItem.original?.height ?? markItem.height ?? 1,
            strokes: markItem.strokes,
            label: `picture ${tray.filter((x) => x.busy || x.kind === "image").findIndex((x) => x.id === markItem.id) + 1}`,
          }}
          onSave={(r) => {
            const opener = marking.opener;
            saveMarks(markItem.id, r);
            setMarking(null);
            requestAnimationFrame(() => opener?.isConnected && opener.focus({ preventScroll: true }));
          }}
          onCancel={() => {
            const opener = marking.opener;
            setMarking(null);
            requestAnimationFrame(() => opener?.isConnected && opener.focus({ preventScroll: true }));
          }}
        />
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
