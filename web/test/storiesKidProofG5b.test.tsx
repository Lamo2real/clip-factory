// Kid-proof fixes in Clips Funded's Social accounts, Needs you bar and chat: picking "Share Clip Factory's app" is the
// choice (no second button of the same name); a connect result names the button the card shows and sends keys that
// live in Clip Factory there; a post stopped on an account that is connected again points at the post's own Try
// again; a half-typed chat message stays with its chat; an answer cut off mid-bold never shows "**".
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as chat from "../src/stories/api/mock/chat.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { createStore, setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import type { SocialAccount, StoriesApi, StoriesDashboard } from "../src/stories/api/types.ts";
import { keepDraft, readDraft } from "../src/stories/chat/ConversationView.tsx";
import { ChatText, inline } from "../src/stories/chat/text.tsx";
import { connectLabelOf, resultSentence } from "../src/stories/screens/Connections.tsx";
import { afterFix, forgetDashboards, forgetOnboarding } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { ConnectionsScreen } = await import("../src/stories/screens/Connections.tsx");
const { ConversationView } = await import("../src/stories/chat/ConversationView.tsx");

let host: HTMLElement;
let root: Root;

async function settle(times = 6) {
  for (let i = 0; i < times; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

beforeEach(async () => {
  await loadConfig(async () => new Response(JSON.stringify({ region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test/" })));
  localStorage.clear();
  sessionStorage.clear();
  resetWorkspaceMemory();
  forgetDashboards();
  forgetOnboarding();
  setMockLatency(0);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  setStoriesApi(null);
});

// ---------- Social accounts ----------

describe("Social accounts: picking Clip Factory's app is the choice", () => {
  it("is saved at once, with no second button of the same name, and Connect then works", async () => {
    (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { fresh: true } };
    const api = mockStoriesApi();
    const set = vi.spyOn(api, "setSocialApp");
    setStoriesApi(api);
    await act(async () =>
      root.render(
        <ToastProvider>
          <ConnectionsScreen ws="stories" page={{ name: "connections", platform: null, result: null, ws: null }} />
        </ToastProvider>,
      ),
    );
    await settle();
    const card = () => host.querySelector<HTMLElement>('.st-conn[data-platform="youtube"]')!;
    const share = Array.from(card().querySelectorAll<HTMLElement>("[role=radio]")).find((b) => /Share Clip Factory's app/.test(b.textContent ?? ""))!;
    await act(async () => share.click());
    await settle(10);
    expect(set).toHaveBeenCalledWith("stories", "youtube", { choice: "clips" });
    const same = Array.from(card().querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Share Clip Factory's app");
    expect(same).toHaveLength(0);
    expect(card().querySelector(".st-app__now")?.textContent).toContain("Shares Clip Factory's YouTube app");
    const connect = Array.from(card().querySelectorAll("button")).find((b) => b.textContent?.includes("Connect YouTube"))!;
    expect(connect.getAttribute("aria-disabled")).toBeNull();
  });

  it("a connect result names the button the card shows, and keys of Clip Factory's app are in Clip Factory", () => {
    const a = (platform: SocialAccount["platform"], connectionStatus: SocialAccount["connectionStatus"], choice: SocialAccount["app"]["choice"]) => ({ platform, connectionStatus, app: { choice, saved: true } });
    expect(resultSentence("denied", "tiktok", a("tiktok", "needs_reconnect", "clips")).text).toBe("You pressed cancel. Tap Reconnect to try again.");
    expect(resultSentence("denied", "youtube", a("youtube", "connected", "clips")).text).toBe("You pressed cancel. Tap Pick another channel to try again.");
    expect(resultSentence("denied", "x", a("x", "not_connected", "clips")).text).toBe("You pressed cancel. Tap Connect X to try again.");
    expect(resultSentence("expired", "tiktok", a("tiktok", "needs_reconnect", "clips")).text).toBe("That took too long. Tap Reconnect again.");
    const keys = resultSentence("keys_wrong", "tiktok", a("tiktok", "needs_reconnect", "clips")).text;
    expect(keys).toContain("Clip Factory");
    expect(keys).not.toContain("on this page");
    expect(resultSentence("keys_wrong", "tiktok", a("tiktok", "needs_reconnect", "own")).text).toContain("Check them on this page");
    // Without the card (it could not be read): the plain first-connect words.
    expect(resultSentence("denied", "tiktok").text).toBe("You pressed cancel. Tap Connect TikTok to try again.");
    expect(connectLabelOf({ platform: "facebook", connectionStatus: "choose_account" })).toBe("Pick another Page");
  });
});

// ---------- Needs you ----------

describe("Needs you after the account is fixed", () => {
  const stuck: StoriesDashboard["needsYou"][number] = {
    publishingJobId: "pj1",
    storyId: "01JSTST0000000000000000003",
    title: "Bolt ties his shoes",
    platform: "tiktok",
    sentence: "This TikTok account (Clips Funded) needs connecting again. Open Clips Funded › Social accounts, then tap Try again.",
    href: "/stories/connections",
  };
  const accounts = (status: string): StoriesDashboard["accounts"] => [{ platform: "tiktok", status, accountName: "Clips Funded" }] as StoriesDashboard["accounts"];

  it("points at the post's Try again once the account is connected; until then, at Social accounts", () => {
    expect(afterFix(stuck, accounts("needs_reconnect"))).toBe(stuck);
    expect(afterFix(stuck, accounts("connected"))).toEqual({ ...stuck, href: "/stories/review/01JSTST0000000000000000003", sentence: "TikTok is connected now. Tap Try again on “Bolt ties his shoes”." });
    // An account's own line (no post) stays as it is.
    const own = { ...stuck, publishingJobId: null, storyId: null };
    expect(afterFix(own, accounts("connected"))).toBe(own);
  });
});

// ---------- Chat ----------

describe("A half-typed chat message stays with its chat", () => {
  let store: MockStore;
  function chatApi(): StoriesApi {
    store = createStore();
    store.workspaces.push({ workspaceId: "stories", workspaceName: "Clips Funded", workspaceType: "stories", builtin: false, configuration: {} as never, version: 1 });
    chat.seed(store);
    const impl: Partial<StoriesApi> = { ...chat.api(store), getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: [], agents: [], tasks: [] }) };
    return new Proxy(impl, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.reject(new Error(`not used: ${k}`))) }) as StoriesApi;
  }

  it("comes back after another tab or another chat, and goes once it is sent", async () => {
    setStoriesApi(chatApi());
    const conv = chat.SEED_IDS.conversations.winter;
    const view = (convId: string) => (
      <ToastProvider>
        <ConversationView key={convId} ws="stories" convId={convId} onConversation={() => undefined} onMissing={() => undefined} />
      </ToastProvider>
    );
    await act(async () => root.render(view(conv)));
    await settle(10);
    const box = () => host.querySelector<HTMLTextAreaElement>("textarea.st-chat-box")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), "A long idea about a snowman who wants");
      box().dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Another chat, then back.
    await act(async () => root.render(view(chat.SEED_IDS.conversations.hooks)));
    await settle(10);
    expect(box().value).toBe("");
    await act(async () => root.render(view(conv)));
    await settle(10);
    expect(box().value).toBe("A long idea about a snowman who wants");
    // Another tab: the whole view goes and comes back.
    await act(async () => root.render(<div />));
    await act(async () => root.render(view(conv)));
    await settle(10);
    expect(box().value).toBe("A long idea about a snowman who wants");
    expect(readDraft("stories", conv)).toBe("A long idea about a snowman who wants");
    keepDraft("stories", conv, "");
    expect(readDraft("stories", conv)).toBe("");
  });
});

describe("An answer cut off mid-bold", () => {
  it("never shows the stars", () => {
    const html = renderToStaticMarkup(<ChatText text={"1. **The snowman who wanted"} />);
    expect(html).not.toContain("**");
    expect(html).toContain("<strong>The snowman who wanted</strong>");
    expect(renderToStaticMarkup(<ChatText text={"Here **you go** and **more"} />)).toBe('<p class="st-chat-text__p"><span>Here <strong>you go</strong> and <strong>more</strong></span></p>');
    expect(renderToStaticMarkup(<>{inline("Wait **")}</>)).toBe("Wait ");
    expect(renderToStaticMarkup(<>{inline("plain words")}</>)).toBe("plain words");
  });
});
