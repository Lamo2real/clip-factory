// Ask Clip Factory in mock mode (docs/CONTRACTS.md §19.8): GET /v1/help and POST /v1/help/answers in memory. Answers
// come from the browser's own retriever plus the fake model. Magic words, for tests only: `#429` (rate limited,
// Retry-After 5), `#503` (server trouble), `#off` (turned off), `#slow` (30 s, so the client times out).
import { compose } from "../../features/help/compose.ts";
import type { AskBody, HelpTransport } from "../../features/help/helpApi.ts";
import { loadCorpus } from "../../features/help/kb.ts";
import { rank } from "../../features/help/retrieve.ts";
import { HELP_PAGES, type HelpContext } from "../../features/help/types.ts";
import { FAKE_MODEL_MS, fakeModel } from "./helpModel.ts";

export interface MockHelpState {
  enabled: boolean;
  /** Every answer request, for tests (never the question: only the outcome). */
  outcomes: string[];
}

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

export function mockHelpTransport(state: MockHelpState = { enabled: true, outcomes: [] }): HelpTransport {
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
      return { status: 200, retryAfter: null, body: { enabled: state.enabled, mode: state.enabled ? "model" : "off", corpusVersion: corpus.version } };
    }
    if (!state.enabled) return off();
    const { question, history = [], context } = (body ?? {}) as AskBody;
    const q = typeof question === "string" ? question.trim() : "";
    // Like the API's _parse: a page outside the enum is a bad request, so the mock cannot hide a client that sends one.
    const page = (context as { page?: unknown } | undefined)?.page;
    const badPage = page !== undefined && !(HELP_PAGES as readonly unknown[]).includes(page);
    if (!q || q.length > 300 || badPage) {
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

    const corpus = await loadCorpus();
    const ranked = rank(corpus.docs, q, history, context as HelpContext | undefined, corpus);
    const composed = compose(ranked);
    if (!composed.known) {
      state.outcomes.push(composed.refused ? "refused" : "unknown");
      return { status: 200, retryAfter: null, body: { answer: composed, mode: "kb", requestId } };
    }
    await sleep(frozen() ? 40 : FAKE_MODEL_MS, signal);
    state.outcomes.push("model");
    return { status: 200, retryAfter: null, body: { answer: fakeModel(composed, q), mode: "model", requestId } };
  };
}
