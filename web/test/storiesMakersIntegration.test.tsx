// Lamo Stories makers, the integration of the API, agent and web halves (docs/CONTRACTS.md §45.37), against the
// in-memory API with the API's own shapes and sentences:
// - your own video model has a Try it, like Luma AI Ray2 (POST …/providers/own-video/check), only once one is added;
// - the maker models the API refuses at save time are refused here too (Bedrock sound, Bedrock video other than Luma
//   AI's, Amazon's ended Nova ids, an ElevenLabs voice), and sound runs on ElevenLabs only;
// - an OpenAI-compatible key is for one address: one service per workspace, the key names its address;
// - the sound makers carry a price (ElevenLabs and your own by the second of sound, Amazon Polly by the character);
// - a maker Amazon ended is never a pick for Setup step 4;
// - Amazon Polly is a display host only, never one an added model may name.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { BAD_VIDEO_MODEL, ELEVENLABS_ONLY_SOUND, ENDED_MODEL, NEED_MODEL_FIRST, NO_BEDROCK_SOUND, ONE_SERVICE } from "../src/stories/api/mock/ai.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import { OWN_VIDEO_BUSY, OWN_VIDEO_FIRST } from "../src/stories/api/mock/workspace.ts";
import { HOST_LABEL, hostIdOf, KEYED_HOSTS, MAKER_HOSTS, MODEL_HOSTS, type MakerModelDef, type StoriesApi, type StoriesConfig } from "../src/stories/api/types.ts";
import { PRICED_MAKERS } from "../src/stories/settings/ProviderPrices.tsx";
import { TRY_WORDS } from "../src/stories/settings/ReelTry.tsx";
import { unitsText } from "../src/stories/settings/VideoUsage.tsx";
import { priceWords } from "../src/stories/settings/VideoSection.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { SettingsScreen } = await import("../src/stories/screens/Settings.tsx");

let host: HTMLElement;
let root: Root;
let api: StoriesApi;
let store: MockStore;
let calls: { name: string; args: unknown[] }[];

function start(knobs: Record<string, unknown> = {}) {
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { checkModelsMs: 20, tryMs: 0, ...knobs } };
  const real = mockStoriesApi();
  store = (window as unknown as { __cfStoriesMock: { store: MockStore } }).__cfStoriesMock.store;
  api = new Proxy(real as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>, {
    get(target, key: string) {
      const fn = target[key]!;
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        return fn(...args);
      };
    },
  }) as unknown as StoriesApi;
  setStoriesApi(api);
}
async function settle(times = 8) {
  for (let i = 0; i < times; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}
async function openVideo() {
  forgetLoaded();
  await act(async () =>
    root.render(
      <ToastProvider>
        <SettingsScreen key={`video${Math.random()}`} ws="stories" page={{ name: "settings", section: "video" }} />
      </ToastProvider>,
    ),
  );
  await settle();
}
async function refusal(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, message: e.message };
    throw e;
  }
  throw new Error("it was not refused");
}

const RAY: MakerModelDef = { label: "My Ray", provider: "Luma AI", kind: "video", host: "bedrock", modelId: "us.luma.ray-v2:0", region: "us-west-2", price: null, note: "" };

beforeEach(async () => {
  await loadConfig(async () => new Response(JSON.stringify({ region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test/" })));
  calls = [];
  localStorage.clear();
  resetWorkspaceMemory();
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

describe("your own video model's Try it (§45.37 G7: the API's providers.CHECKABLE)", () => {
  it("needs a video model first, then makes one test shot, one at a time, with the API's sentences", async () => {
    start({ tryMs: 60_000 });
    expect(await refusal(api.tryMaker("stories", "own-video"))).toEqual({ status: 409, message: OWN_VIDEO_FIRST });
    await api.putMakerModel("stories", "custom-ray", RAY);
    const job = await api.tryMaker("stories", "own-video");
    expect(job).toMatchObject({ jobType: "provider_check", contentId: "own-video", meta: { providers: { animation: "own-video" } } });
    expect(await refusal(api.tryMaker("stories", "own-video"))).toEqual({ status: 409, message: OWN_VIDEO_BUSY });
    expect(OWN_VIDEO_BUSY).toBe(TRY_WORDS["own-video"].busy);
    const row = (await api.providers("stories")).find((p) => p.id === "own-video");
    expect(row?.check?.jobId).toBe(job.jobId);
  });

  it("Settings › Video shows it only once a video model is added, and it tries own-video", async () => {
    start({ lumaBucket: true });
    await openVideo();
    expect(document.querySelector('[data-provider="own-video"]')).toBeNull();
    expect(document.querySelector('[data-provider="luma-ray"]')).not.toBeNull();
    await api.putMakerModel("stories", "custom-ray", RAY);
    await openVideo();
    const own = document.querySelector<HTMLElement>('[data-provider="own-video"]')!;
    expect(own).not.toBeNull();
    expect(own.textContent).toContain(TRY_WORDS["own-video"].line);
    const button = Array.from(own.querySelectorAll("button")).find((b) => /Try it/.test(b.textContent ?? ""))!;
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle(10);
    expect(calls.filter((c) => c.name === "tryMaker").map((c) => c.args)).toEqual([["stories", "own-video"]]);
  });
});

describe("the maker models the API refuses at save time (§45.37 G1, G2, G7: makers.clean)", () => {
  it("refuses Bedrock sound, Bedrock video other than Luma AI's, Amazon's ended ids and an ElevenLabs voice", async () => {
    start();
    const sound = { label: "Rain", provider: "Amazon", kind: "audio", host: "bedrock", modelId: "amazon.sound-v1:0", region: "us-east-1", price: null, note: "" } as unknown as MakerModelDef;
    expect(await refusal(api.putMakerModel("stories", "custom-rain", sound))).toMatchObject({ status: 400, message: NO_BEDROCK_SOUND });
    expect(await refusal(api.putMakerModel("stories", "custom-v", { ...RAY, modelId: "acme.video-v1:0" }))).toMatchObject({ status: 400, message: BAD_VIDEO_MODEL });
    expect(await refusal(api.putMakerModel("stories", "custom-v", { ...RAY, modelId: "us.amazon.nova-reel-v1:1", region: "us-east-1" }))).toMatchObject({ status: 400, message: ENDED_MODEL });
    const canvas = { ...RAY, kind: "image", modelId: "amazon.nova-canvas-v1:0", region: "us-east-1" } as MakerModelDef;
    expect(await refusal(api.putMakerModel("stories", "custom-c", canvas))).toMatchObject({ status: 400, message: ENDED_MODEL });
    const voice = { label: "Voice", provider: "ElevenLabs", kind: "audio", host: "elevenlabs", modelId: "eleven_multilingual_v2", price: null, note: "" } as MakerModelDef;
    expect(await refusal(api.putMakerModel("stories", "custom-voice", voice))).toMatchObject({ status: 400, message: ELEVENLABS_ONLY_SOUND });
    // a cross-Region profile id of Luma AI's model is kept as saved
    expect((await api.putMakerModel("stories", "custom-ray", RAY)).modelId).toBe("us.luma.ray-v2:0");
  });

  it("offers sound on ElevenLabs only, and Amazon Polly only as the bundled maker's display host", () => {
    expect(MAKER_HOSTS.audio).toEqual(["elevenlabs"]);
    expect(hostIdOf("Amazon Polly")).toBe("polly");
    expect(HOST_LABEL.polly).toBe("Amazon Polly");
    expect(KEYED_HOSTS).not.toContain("polly");
    expect(MODEL_HOSTS).not.toContain("polly");
    expect(Object.values(MAKER_HOSTS).flat()).not.toContain("polly");
  });
});

describe("one OpenAI-compatible service per workspace, its key for that one address (§45.37 G4)", () => {
  it("asks for the model (or its address) before the key, and names the address the key is for", async () => {
    start();
    expect(await refusal(api.setProviderKey("stories", "openai_compatible", "sk-proj-0123456789abcd9k2q"))).toEqual({ status: 409, message: NEED_MODEL_FIRST });
    const pic = { label: "GPT image", provider: "OpenAI", kind: "image", host: "openai_compatible", modelId: "gpt-image-1", baseUrl: "https://api.example-images.com/v1", price: null, note: "" } as MakerModelDef;
    await api.putMakerModel("stories", "custom-pic", pic);
    const row = await api.setProviderKey("stories", "openai_compatible", "sk-proj-0123456789abcd9k2q");
    expect(row.line).toContain("Key saved for api.example-images.com · ends 9k2q.");
    expect(JSON.stringify(row)).not.toContain("0123456789abcd");
    // a second service is refused while the first is in use
    const other = { ...pic, baseUrl: "https://api.other-images.com/v1" };
    expect(await refusal(api.putMakerModel("stories", "custom-pic-2", other))).toEqual({ status: 409, message: ONE_SERVICE("api.example-images.com") });
    // and the same address is fine
    expect((await api.putMakerModel("stories", "custom-pic-3", { ...pic, baseUrl: "https://api.example-images.com/v2" })).key).toBe("custom-pic-3");
  });
});

describe("the sound makers' prices and use (§45.37 G1, G3: the API's ai_config.PRICE_PROVIDERS)", () => {
  it("prices ElevenLabs and your own sound model by the second of sound, and Amazon Polly by the character spoken", async () => {
    const by = Object.fromEntries(PRICED_MAKERS.map((m) => [m.id, m.unit]));
    expect(by).toMatchObject({ elevenlabs: "second", "own-sound": "second", polly: "character", stability: "image", "luma-ray": "second" });
    expect(unitsText({ provider: "polly", units: 1234, unit: "character" })).toBe("1,234 characters spoken");
    expect(unitsText({ provider: "elevenlabs", units: 12, unit: "second" })).toBe("12 seconds of sound");
    expect(priceWords({ perUnit: 0.000016, unit: "character", currency: "USD" })).toContain("a character spoken");
    start();
    const ai = await api.getAi("stories");
    const { version, ...config } = ai.ai;
    const price = { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: null, cacheWritePer1M: null, longContext: null, currency: "USD", source: "owner" as const, note: "Mine.", perUnit: 0.000016, unit: "character" as const };
    const saved = await api.putAi("stories", { ...config, version, prices: { polly: price } });
    expect(saved.prices.polly).toMatchObject({ perUnit: 0.000016, unit: "character" });
    expect(await refusal(api.putAi("stories", { ...config, version: saved.version, prices: { polly: { ...price, unit: "second" } } }))).toMatchObject({ status: 400 });
  });
});

describe("Setup step 4 never counts a maker Amazon ended (§45.37 G7)", () => {
  it("is to do while Nova Reel or Nova Canvas is the stored pick, even after the makers were saved on purpose", async () => {
    start();
    const w = await api.getWorkspace("stories");
    const config = w.configuration as StoriesConfig;
    store.workspaces = store.workspaces.map((x) => (x.workspaceId === w.workspaceId ? { ...x, configuration: { ...config, providers: { ...config.providers, video: "nova-reel", videoModel: null } } } : x));
    store.onboarding.providersPickedAt = "2026-09-01T10:00:00.000Z";
    const steps = (await api.getOnboarding("stories")).steps;
    expect(steps.find((s) => s.step === "video")?.state).toBe("todo");
  });
});
