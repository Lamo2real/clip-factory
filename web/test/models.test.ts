// The AI model picker's list (docs/DECISIONS.md ADR-42): it comes from config/models.json, and the mock API checks a
// pick the way the real API does.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { mockApi, type MockFaults } from "../src/api/mock/index.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import { CLIP_MODELS, DEFAULT_CLIP_MODEL, clipModelLabel, currentClipModel, isClipModel } from "../src/lib/models.ts";
import { findApple } from "../src/lib/settingsTree.ts";

const config = JSON.parse(readFileSync(join(import.meta.dirname, "../../config/models.json"), "utf8"));

beforeAll(() => {
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
});

describe("clip models", () => {
  it("lists the owner's five choices from config/models.json, in its order", () => {
    expect(CLIP_MODELS.map((m) => m.key)).toEqual(config.clipModels);
    expect(CLIP_MODELS.map((m) => m.label)).toEqual([
      "Claude Fable 5.2",
      "Claude Fable 5.1",
      "Claude Opus 5.5",
      "Claude Sonnet 5.5",
      "Claude Haiku 5.5",
    ]);
    for (const m of CLIP_MODELS) {
      expect(m.line.length).toBeGreaterThan(0);
      expect(m.line.length).toBeLessThanOrEqual(60);
    }
  });

  it("defaults to agentModel and reads an unknown pick as the default", () => {
    expect(DEFAULT_CLIP_MODEL).toBe("fable-5-1");
    expect(currentClipModel(undefined)).toBe("fable-5-1");
    expect(currentClipModel("gpt-9")).toBe("fable-5-1");
    expect(currentClipModel("nova-2-lite")).toBe("fable-5-1"); // in models.json, but not a clip model
    expect(currentClipModel("opus-5-5")).toBe("opus-5-5");
    expect(isClipModel(5)).toBe(false);
    expect(clipModelLabel("haiku-5-5")).toBe("Claude Haiku 5.5");
    expect(clipModelLabel("gone-1")).toBe("gone-1");
  });

  it("has an apple in Settings › Clip making › Clips", () => {
    const found = findApple("ai-model");
    expect(found?.branch.slug).toBe("clips");
    expect(found?.apple.name).toBe("AI model");
  });
});

describe("mock API clipModel", () => {
  function setup() {
    const store = seed();
    const faults: MockFaults = { keepStopsAfterSave: 0, resumeAfterMs: 60_000 };
    return { store, api: mockApi(store, faults) };
  }

  it("saves a model from the list and starts new jobs with it", async () => {
    const { api } = setup();
    expect((await api.getSettings()).clipModel).toBe("fable-5-1");
    expect((await api.putSettings({ clipModel: "sonnet-5-5" })).clipModel).toBe("sonnet-5-5");
    const job = await api.createJob({ source: { type: "link", url: "https://www.youtube.com/watch?v=x" }, clipTarget: { min: 1, max: 3 } });
    expect(job.model).toBe("sonnet-5-5");
  });

  it("refuses a model that is not in the list", async () => {
    const { api } = setup();
    await expect(api.putSettings({ clipModel: "gpt-9" })).rejects.toBeInstanceOf(ApiError);
    expect((await api.getSettings()).clipModel).toBe("fable-5-1");
  });
});
