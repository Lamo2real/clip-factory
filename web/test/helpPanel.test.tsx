import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeApi = {
  me: vi.fn(async () => ({ counts: { review: 5, running: 1, posted: 9 } })),
};
vi.mock("../src/api/index.ts", () => ({ api: () => fakeApi }));
// No socket in these tests (liveConnection() is null), so the assistant path ends before it calls the Ask API.
vi.mock("../src/features/help/askApi.ts", async (orig) => ({ ...(await orig<object>()), defaultAskApi: async () => ({}) }));

import { ToastProvider } from "../src/components/Toasts.tsx";
import { openHelp } from "../src/features/help/context.ts";
import type { AskBody, AskResult, HelpClient, StatusResult } from "../src/features/help/helpApi.ts";
import { AskClipFactory } from "../src/features/help/HelpLauncher.tsx";
import { setAssistantStatus, setHelpSwitch } from "../src/features/help/status.ts";
import { CANT_REACH_TEXT, cantAnswerText, PICTURE_KEPT_TEXT, TOO_LONG_TEXT } from "../src/features/help/HelpPanel.tsx";
import type { HelpAnswer } from "../src/features/help/types.ts";
import { registerUnsaved } from "../src/features/help/unsaved.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const keepAnswer: HelpAnswer = {
  known: true,
  text: "**Keep** says yes to a clip.",
  steps: ["Tap **Review**.", "Tap **Keep**."],
  actions: [
    { id: "review-keep:review", label: "Open Review", to: "/review", highlight: ["keep"] },
    { id: "x:bad", label: "Nowhere", to: "/nope" },
  ],
  sources: ["review-keep"],
};
const liveAnswer: HelpAnswer = {
  known: true,
  text: "Clips waiting in Review: {value}. New clips wait in **Review**.",
  steps: [],
  actions: [{ id: "review-waiting:review", label: "Open Review", to: "/review" }],
  sources: ["review-waiting"],
  live: { metric: "review_waiting", text: "Clips waiting in Review: {value}." },
};

function fakeClient(answers: AskResult[], status: StatusResult = { kind: "ok", status: { enabled: true, mode: "model", corpusVersion: "v" } }) {
  const queue = [...answers];
  return {
    status: vi.fn(async () => status),
    ask: vi.fn(async (_body: AskBody): Promise<AskResult> => queue.shift() ?? { kind: "answer", answer: keepAnswer, mode: "model", requestId: "r" }),
  } satisfies HelpClient;
}

let host: HTMLDivElement;
let root: Root;

async function mount(client: HelpClient) {
  await act(async () => {
    root.render(
      <ToastProvider>
        <AskClipFactory client={client} />
      </ToastProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const launcher = () => $<HTMLButtonElement>('button[aria-label="Ask Clip Factory"]');
const button = (name: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === name);

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function ask(text: string) {
  const ta = $<HTMLTextAreaElement>(".help-panel__input")!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await until(() => !$(".help-thinking"));
}

/** Waits (with real timers, under act) until `ok` holds; slow machines get up to 3 s. */
async function until(ok: () => boolean) {
  await act(async () => {
    await vi.waitFor(
      () => {
        if (!ok()) throw new Error("not yet");
      },
      { timeout: 3000, interval: 10 },
    );
  });
}

beforeEach(() => {
  setHelpSwitch("unknown");
  history.replaceState(null, "", "/");
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  fakeApi.me.mockClear();
});

afterEach(async () => {
  setAssistantStatus({ on: false, web: "off", files: false });
  await act(async () => root.unmount());
  host.remove();
});

describe("Ask Clip Factory panel", () => {
  it("hides the launcher while the switch is off", async () => {
    await mount(fakeClient([], { kind: "ok", status: { enabled: false, mode: "off", corpusVersion: "" } }));
    expect(launcher()).toBeNull();
    await act(async () => openHelp("What does Keep do?"));
    expect($(".help-panel")).toBeNull();
  });

  it("opens with a greeting and three suggestions, answers, and drops a button that leads nowhere", async () => {
    const client = fakeClient([]);
    await mount(client);
    expect(launcher()).not.toBeNull();
    await act(async () => launcher()!.click());
    expect(host.textContent).toContain("Hi! What do you want to do?");
    expect(host.querySelectorAll(".help-chip")).toHaveLength(3);
    expect(document.activeElement).toBe($(".help-panel__input"));

    await act(async () => host.querySelector<HTMLButtonElement>(".help-chip")!.click());
    await until(() => !!host.querySelector(".help-steps"));
    expect(client.ask).toHaveBeenCalledTimes(1);
    const body = client.ask.mock.calls[0]![0];
    expect(body.question).toBe("How do I make clips from a Twitch link?");
    expect(body.context?.page).toBe("home");
    expect(host.querySelector(".help-steps")!.children).toHaveLength(2);
    const actions = host.querySelectorAll(".help-actions .btn");
    expect(actions).toHaveLength(1);
    expect(actions[0]!.className).toContain("btn--primary");
    // The main action moved to the answer: Ask becomes an ordinary action (still the vermilion CTA look).
    expect($(".help-panel__ask")!.className).toContain("btn--action");
    expect($(".help-panel__ask")!.className).not.toContain("btn--primary");
  });

  it("shows a calm countdown on 429, keeps Ask off, and never retries by itself", async () => {
    const client = fakeClient([{ kind: "rate_limited", retryAfter: 5, requestId: "r" }]);
    await mount(client);
    await act(async () => launcher()!.click());
    await ask("What does Keep do?");
    expect(host.textContent).toMatch(/Let's take a short break\. You can ask again in [45] seconds\./);
    await ask("Again?");
    expect($(".help-panel__ask")!.getAttribute("aria-disabled")).toBe("true");
    await settle(50);
    expect(client.ask).toHaveBeenCalledTimes(1);
  });

  it("answers locally on a 5xx and offers the help code", async () => {
    const client = fakeClient([{ kind: "fallback", reason: "server", status: 503, requestId: "req-42" }]);
    await mount(client);
    await act(async () => launcher()!.click());
    await ask("What does Keep do?");
    await until(() => !!host.querySelector(".help-code"));
    expect(host.textContent).toContain("Keep");
    expect(host.textContent).toContain("Something went wrong? Copy the help code");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await act(async () => button("Something went wrong? Copy the help code")!.click());
    expect(writeText).toHaveBeenCalledWith("req-42");
    expect(document.body.textContent).toContain("Copied. Send this code to whoever helps you with Clip Factory.");
  });

  it("does not answer locally once the switch is off", async () => {
    const client = fakeClient([{ kind: "fallback", reason: "network", status: 0, requestId: "c-1" }]);
    await mount(client);
    await act(async () => launcher()!.click());
    setHelpSwitch("off");
    await settle();
    await ask("What does Keep do?");
    expect(client.ask).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Ask Clip Factory is turned off right now.");
  });

  it("fills a live number, and says so when it can't", async () => {
    const client = fakeClient([
      { kind: "answer", answer: liveAnswer, mode: "kb", requestId: "r1" },
      { kind: "answer", answer: liveAnswer, mode: "kb", requestId: "r2" },
    ]);
    await mount(client);
    await act(async () => launcher()!.click());
    await ask("how many clips are waiting?");
    await until(() => !!host.textContent?.includes("Clips waiting in Review: 5."));
    fakeApi.me.mockRejectedValueOnce(new Error("offline"));
    await ask("how many clips are waiting now?");
    await until(() => !!host.textContent?.includes("I couldn't get that number right now."));
    expect(host.querySelectorAll(".help-code").length).toBeGreaterThan(0);
  });

  it("asks before leaving an unsaved change, and Escape returns focus to the launcher", async () => {
    const off = registerUnsaved(() => true);
    await mount(fakeClient([]));
    await act(async () => launcher()!.click());
    await ask("What does Keep do?");
    await act(async () => button("Open Review")!.click());
    expect(host.textContent).toContain("You have a change that isn't saved yet. Leave anyway?");
    expect(location.pathname).toBe("/");
    await act(async () => button("Stay")!.click());
    expect(location.pathname).toBe("/");
    await act(async () => button("Open Review")!.click());
    await act(async () => button("Leave")!.click());
    expect(location.pathname).toBe("/review");
    off();

    await act(async () => {
      $(".help-panel__input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await until(() => !$(".help-panel") && document.activeElement === launcher());
  });

  it("keeps the conversation when the panel closes and opens again, until Start over", async () => {
    await mount(fakeClient([]));
    await act(async () => launcher()!.click());
    await ask("What does Keep do?");
    expect(host.querySelector(".help-steps")).not.toBeNull();
    await act(async () => $<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    await until(() => !$(".help-panel"));
    await act(async () => launcher()!.click());
    expect(host.querySelector(".help-msg--me")!.textContent).toBe("What does Keep do?");
    expect(host.querySelector(".help-steps")!.children).toHaveLength(2);
    await act(async () => button("Start over")!.click());
    expect(host.querySelector(".help-steps")).toBeNull();
    expect(host.textContent).toContain("Hi! What do you want to do?");
  });

  it("leaves out Go Home on Home, where it would do nothing", async () => {
    const unknown: HelpAnswer = { known: false, text: "I don't know that one yet.", steps: [], actions: [{ id: "go-home", label: "Go Home", to: "/" }], sources: [] };
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await mount(fakeClient([{ kind: "answer", answer: unknown, mode: "kb", requestId: "r" }, { kind: "answer", answer: unknown, mode: "kb", requestId: "r2" }]));
    await act(async () => launcher()!.click());
    await ask("i want a dinosaur");
    expect(button("Go Home")).toBeUndefined();
    expect(host.querySelectorAll(".help-msg--bot .help-chip")).toHaveLength(3);
    // The main action stays on Ask.
    expect($(".help-panel__ask")!.className).toContain("btn--primary");
    history.replaceState(null, "", "/jobs");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await ask("i want a dinosaur");
    expect(button("Go Home")).toBeDefined();
  });

  it("is modal on phones: the page behind is inert and Tab goes round inside the sheet", async () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
    await mount(fakeClient([]));
    const page = document.createElement("div");
    page.className = "shell";
    host.prepend(page);
    await act(async () => launcher()!.click());
    const sheet = $(".help-panel")!;
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(sheet.className).toContain("is-sheet");
    expect(page.hasAttribute("inert")).toBe(true);
    expect(launcher()!.hasAttribute("inert")).toBe(true);
    const ask = $<HTMLButtonElement>(".help-panel__ask")!;
    ask.focus();
    await act(async () => {
      ask.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(ask);
    await act(async () => $<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    await until(() => !$(".help-panel"));
    expect(page.hasAttribute("inert")).toBe(false);
    expect(launcher()!.hasAttribute("inert")).toBe(false);
  });

  it("sends with the paper plane: Enter sends, Shift+Enter is a new line, the question shows at once", async () => {
    let release: (r: AskResult) => void = () => undefined;
    const client = {
      status: vi.fn(async (): Promise<StatusResult> => ({ kind: "ok", status: { enabled: true, mode: "model", corpusVersion: "v" } })),
      ask: vi.fn((_body: AskBody) => new Promise<AskResult>((r) => (release = r))),
    } satisfies HelpClient;
    await mount(client);
    await act(async () => launcher()!.click());
    const ta = $<HTMLTextAreaElement>(".help-panel__input")!;
    const send = $<HTMLButtonElement>(".help-panel__ask")!;
    expect(ta.getAttribute("enterkeyhint")).toBe("send");
    expect(send.getAttribute("aria-label")).toBe("Send");
    expect(send.textContent?.trim()).toBe("");
    expect(send.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "What does Keep do?");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(send.getAttribute("aria-disabled")).toBeNull();
    // Shift+Enter is left to the browser (a new line): nothing is sent.
    const shift = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => ta.dispatchEvent(shift));
    expect(shift.defaultPrevented).toBe(false);
    expect(client.ask).not.toHaveBeenCalled();
    await act(async () => send.click());
    // The question bubble and the plane's flight start together; the answer is still on its way.
    expect($(".help-msg--me")?.textContent).toBe("What does Keep do?");
    expect($(".help-panel__ask .fly")!.className).toContain("is-flying");
    expect(client.ask).toHaveBeenCalledTimes(1);
    await act(async () => release({ kind: "answer", answer: keepAnswer, mode: "model", requestId: "r" }));
    await until(() => !!$(".help-steps"));
  });

  it("opens from anywhere with a question", async () => {
    const client = fakeClient([]);
    await mount(client);
    await act(async () => openHelp("What does Keep do?"));
    await until(() => client.ask.mock.calls.length > 0);
    expect($(".help-panel")).not.toBeNull();
    expect(client.ask).toHaveBeenCalledWith(expect.objectContaining({ question: "What does Keep do?" }));
  });

  describe("when the assistant can't answer (owner report 2026-11-19)", () => {
    const unknownAnswer: HelpAnswer = { known: false, text: "I don't know that one yet.", steps: [], actions: [], sources: [] };
    const on = { kind: "ok" as const, status: { enabled: true, mode: "model" as const, corpusVersion: "v", assistant: { on: true, web: "no_key" as const, files: true } } };

    it("never answers an open question with a random topic: says it can't reach Ask, keeps the words, Try again resends", async () => {
      const unknown = { kind: "answer" as const, answer: unknownAnswer, mode: "kb" as const, requestId: "r1" };
      const client = fakeClient([unknown, unknown], on);
      await mount(client);
      await act(async () => launcher()!.click());
      await settle();
      await ask("What do I do now?");
      await until(() => !!host.querySelector(".help-msg--notice"));
      expect(host.querySelector(".help-msg--notice")!.textContent).toContain(CANT_REACH_TEXT);
      expect(host.querySelector(".help-msg--bot")).toBeNull();
      expect(host.textContent).not.toContain("Jobs working right now");
      expect($<HTMLTextAreaElement>(".help-panel__input")!.value).toBe("What do I do now?");
      const again = button("Try again")!;
      expect(again).toBeTruthy();
      await act(async () => again.click());
      await until(() => host.querySelectorAll(".help-msg--notice").length === 2);
      expect(client.ask).toHaveBeenCalledTimes(2);
    });

    it("still gives the short help when the question truly matches one", async () => {
      const client = fakeClient([{ kind: "answer", answer: keepAnswer, mode: "kb", requestId: "r2" }], on);
      await mount(client);
      await act(async () => launcher()!.click());
      await settle();
      await ask("What does Keep do?");
      await until(() => !!host.querySelector(".help-msg--bot"));
      expect(host.querySelector(".help-msg--bot")!.textContent).toContain("Keep says yes to a clip.");
      expect(button("Try again")).toBeUndefined();
    });
  });

  it("words why Ask could not answer, never a guess", () => {
    expect(cantAnswerText({ reason: "no_socket" }, null)).toBe(CANT_REACH_TEXT);
    expect(cantAnswerText({ reason: "no_socket" }, "picture")).toBe(PICTURE_KEPT_TEXT);
    expect(cantAnswerText({ reason: "timeout" }, null)).toBe(TOO_LONG_TEXT);
    expect(cantAnswerText({ reason: "model", why: "access", message: "Ask's AI model is not turned on yet." }, "picture")).toBe(
      "Ask's AI model is not turned on yet. Your question is still here.",
    );
    expect(cantAnswerText({ reason: "model", why: "other", message: "x" }, null)).toBe(CANT_REACH_TEXT);
  });
});
