// Ask Clip Factory in mock mode (docs/CONTRACTS.md §19.8): GET /v1/help and POST /v1/help/answers in memory. Answers
// come from the browser's own retriever plus the fake model. Magic words, for tests only: `#429` (rate limited,
// Retry-After 5), `#503` (server trouble), `#off` (turned off), `#slow` (30 s, so the client times out), `#unread`
// (the pictures could not be read) and `#piclimit` (the daily picture limit). Pictures (§26) are checked like the API
// does, and a fake look says which page they show.
import { compose } from "../../features/help/compose.ts";
import type { AskBody, HelpTransport } from "../../features/help/helpApi.ts";
import { loadCorpus } from "../../features/help/kb.ts";
import { rank } from "../../features/help/retrieve.ts";
import { base64Bytes, jpegInfo, PICTURE_BYTES_MAX, PICTURE_TEXT } from "../../features/help/pictures.ts";
import { HELP_PAGES, PICTURES_MAX, type HelpContext, type HelpPictureResult, type HelpTurn } from "../../features/help/types.ts";
import { FAKE_MODEL_MS, fakeModel } from "./helpModel.ts";

export interface MockPictureSeen {
  bytes: number;
  width: number;
  height: number;
  hasExif: boolean;
}

export interface MockHelpState {
  enabled: boolean;
  /** Every answer request, for tests (never the question: only the outcome). */
  outcomes: string[];
  /** Pictures in Ask (§26); absent counts as on. */
  pictures?: boolean;
  /** For tests: what each request's pictures were (count and sizes, never the bytes). */
  seen?: { count: number; pictures: MockPictureSeen[] }[];
  /** For tests: each request's history. */
  history?: HelpTurn[][];
}

/** The page words the fake look "reads" from a screenshot of that page. */
const PAGE_WORDS: Record<string, string> = {
  home: "Home",
  jobs: "Jobs",
  job: "Job",
  review: "Review",
  library: "Library",
  clip: "Clip",
  settings: "Settings",
  skill: "Skills",
  get_app: "Get the app",
};

declare global {
  interface Window {
    __cfMockHelp?: MockHelpState;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

const frozen = () => typeof navigator !== "undefined" && navigator.webdriver === true;

export function mockHelpTransport(state: MockHelpState = { enabled: true, outcomes: [], pictures: true, seen: [], history: [] }): HelpTransport {
  if (typeof window !== "undefined") window.__cfMockHelp = state;
  let n = 0;
  const off = () => ({ status: 403, retryAfter: null, body: { error: { code: "help_off", message: "Ask Clip Factory is turned off right now." }, requestId: `m-${n}` } });

  return async (method, path, body, token, signal) => {
    n++;
    const requestId = `m-${n}`;
    await sleep(frozen() ? 20 : 60, signal);
    if (!token) return { status: 401, retryAfter: null, body: { error: { code: "unauthorized", message: "Sign in again." }, requestId } };
    if (method === "GET" && path === "/help") {
      const corpus = await loadCorpus();
      return {
        status: 200,
        retryAfter: null,
        body: { enabled: state.enabled, mode: state.enabled ? "model" : "off", corpusVersion: corpus.version, pictures: state.enabled && state.pictures !== false },
      };
    }
    if (!state.enabled) return off();
    const { question, history = [], context, pictures } = (body ?? {}) as AskBody;
    const q = typeof question === "string" ? question.trim() : "";
    const bad = (message: string) => {
      state.outcomes.push("bad_request");
      return { status: 400, retryAfter: null, body: { error: { code: "bad_request", message }, requestId } };
    };
    // Pictures: the same checks as the API (help/pictures.py).
    const seenPics: MockPictureSeen[] = [];
    if (pictures !== undefined) {
      if (!Array.isArray(pictures)) return bad(PICTURE_TEXT.cant_open);
      if (pictures.length > PICTURES_MAX) return bad("You can send 4 pictures at a time.");
      for (const p of pictures) {
        if (!p || p.type !== "image/jpeg" || typeof p.data !== "string" || Object.keys(p).length !== 2) return bad(PICTURE_TEXT.cant_open);
        const bytes = base64Bytes(p.data);
        if (!bytes) return bad(PICTURE_TEXT.cant_open);
        if (bytes.length > PICTURE_BYTES_MAX) return bad(PICTURE_TEXT.too_big);
        const info = jpegInfo(bytes);
        if (!info || bytes.length < 100) return bad(PICTURE_TEXT.cant_open);
        if (Math.max(info.width, info.height) > 1600) return bad(PICTURE_TEXT.too_big);
        seenPics.push({ bytes: bytes.length, ...info });
      }
    }
    if (seenPics.length) (state.seen ??= []).push({ count: seenPics.length, pictures: seenPics });
    (state.history ??= []).push(history);
    // Like the API's _parse: a page outside the enum is a bad request, so the mock cannot hide a client that sends one.
    const page = (context as { page?: unknown } | undefined)?.page;
    const badPage = page !== undefined && !(HELP_PAGES as readonly unknown[]).includes(page);
    if ((!q && !seenPics.length) || q.length > 300 || badPage) {
      state.outcomes.push("bad_request");
      return { status: 400, retryAfter: null, body: { error: { code: "bad_request", message: "Ask a question with up to 300 letters." }, requestId } };
    }
    if (q.includes("#429")) {
      state.outcomes.push("rate_limited");
      return {
        status: 429,
        retryAfter: 5,
        body: { error: { code: "rate_limited", message: "Let's take a short break. Ask again in a minute.", retryAfter: 5 }, requestId },
      };
    }
    if (q.includes("#503")) {
      state.outcomes.push("unavailable");
      return { status: 503, retryAfter: null, body: { error: { code: "unavailable", message: "Ask Clip Factory can't answer right now." }, requestId } };
    }
    if (q.includes("#off")) {
      state.enabled = false;
      state.outcomes.push("off");
      return off();
    }
    if (q.includes("#slow")) await sleep(30_000, signal);

    // The fake look: it "reads" the page the owner is on (the real one reads the pictures).
    let picture: HelpPictureResult | undefined;
    let words = "";
    if (seenPics.length) {
      if (state.pictures === false) picture = { read: false, why: "off" };
      else if (q.includes("#piclimit")) picture = { read: false, why: "limit" };
      else if (q.includes("#unread")) picture = { read: false, why: "trouble" };
      else {
        await sleep(frozen() ? 30 : FAKE_MODEL_MS, signal);
        const page = (context as HelpContext | undefined)?.page;
        const name = (page && PAGE_WORDS[page]) || "";
        picture = { read: true, seen: name ? `I can see the ${name} page.` : "I looked at your picture." };
        words = name;
      }
    }
    const asked = seenPics.length ? q.replace(/#\w+/g, " ").trim() : q;
    const corpus = await loadCorpus();
    const ranked = rank(corpus.docs, `${asked} ${words}`.trim(), history, context as HelpContext | undefined, corpus);
    let composed = compose(ranked);
    if (seenPics.length && !asked && !composed.known)
      composed = {
        ...composed,
        text: picture?.read
          ? "I looked at your picture, but I don't know that one yet. Tell me in words what you want to do."
          : picture?.why === "off"
            ? "Pictures are off right now. Tell me in words what you want to do."
            : picture?.why === "limit"
              ? "You sent lots of pictures today. Tell me in words what you want to do."
              : "I couldn't look at your picture this time. Tell me in words what you want to do.",
      };
    // A refused question never sends its pictures to the model, so it says nothing about them.
    const extra = picture && !composed.refused ? { picture } : {};
    if (!composed.known) {
      state.outcomes.push(composed.refused ? "refused" : "unknown");
      return { status: 200, retryAfter: null, body: { answer: composed, mode: "kb", requestId, ...extra } };
    }
    await sleep(frozen() ? 40 : FAKE_MODEL_MS, signal);
    state.outcomes.push("model");
    return { status: 200, retryAfter: null, body: { answer: fakeModel(composed, q), mode: "model", requestId, ...extra } };
  };
}
