// The Lamo Stories mock's workspace settings, round 3 (docs/CONTRACTS.md §45.34): the default shape and its size (the
// resolution must be one of that shape's; 30 fps only), the keep choices for reference videos and chat pictures, the
// files made besides the MP4, and Nova Reel's line in the API's own words (nothing switches to the built-in animation
// by itself), as the real API answers them.
import { beforeEach, describe, expect, it } from "vitest";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency } from "../src/stories/api/mock/store.ts";
import type { StoriesApi, StoriesConfig } from "../src/stories/api/types.ts";
import { notReadyLine } from "../src/stories/settings/VideoSection.tsx";

let api: StoriesApi;

beforeEach(() => {
  setMockLatency(0);
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = undefined;
  api = mockStoriesApi();
});

async function patch(configuration: Partial<StoriesConfig>) {
  const w = await api.getWorkspace("stories");
  return api.patchWorkspace("stories", { configuration, version: w.version });
}

describe("the shape and its size", () => {
  it("saves 9:16, 1:1 and 16:9 each with one of its own sizes, and refuses a size of another shape", async () => {
    for (const [aspect, resolution] of [
      ["1:1", "1080x1080"],
      ["1:1", "720x720"],
      ["16:9", "1920x1080"],
      ["16:9", "1280x720"],
      ["9:16", "720x1280"],
      ["9:16", "1080x1920"],
    ] as const) {
      const w = await patch({ video: { aspect, resolution, quality: "high", fps: 30 } });
      expect((w.configuration as StoriesConfig).video).toEqual({ aspect, resolution, quality: "high", fps: 30 });
    }
    await expect(patch({ video: { aspect: "1:1", resolution: "1080x1920", quality: "high", fps: 30 } })).rejects.toMatchObject({ status: 400, field: "video", message: "That size does not fit that shape. Pick one of its sizes." });
    await expect(patch({ video: { aspect: "4:3" as never, resolution: "1080x1920", quality: "high", fps: 30 } })).rejects.toMatchObject({ status: 400, field: "video" });
    await expect(patch({ video: { aspect: "9:16", resolution: "1080x1920", quality: "high", fps: 60 as never } })).rejects.toMatchObject({ status: 400, field: "video" });
    // A size alone is checked against the shape already saved.
    await patch({ video: { aspect: "16:9", resolution: "1920x1080", quality: "high", fps: 30 } });
    await expect(patch({ video: { resolution: "1080x1080" } as never })).rejects.toMatchObject({ status: 400, field: "video" });
  });
});

describe("storage and production", () => {
  it("keeps reference videos, chat pictures and the extra files as picked, and refuses anything else", async () => {
    const w = await patch({ production: { burnCaptions: false, scenesAtOnce: 2, keepVersions: 3, keepReferences: "study_only", keepChatPictures: "days_90", extraFormats: ["webm", "mov"] } });
    expect((w.configuration as StoriesConfig).production).toEqual({ burnCaptions: false, scenesAtOnce: 2, keepVersions: 3, keepReferences: "study_only", keepChatPictures: "days_90", extraFormats: ["webm", "mov"] });
    await expect(patch({ production: { burnCaptions: true, scenesAtOnce: 2, keepVersions: "all", keepReferences: "forever" as never } })).rejects.toMatchObject({ status: 400, field: "production" });
    await expect(patch({ production: { burnCaptions: true, scenesAtOnce: 2, keepVersions: "all", keepChatPictures: "days_7" as never } })).rejects.toMatchObject({ status: 400, field: "production" });
    await expect(patch({ production: { burnCaptions: true, scenesAtOnce: 2, keepVersions: "all", extraFormats: ["mp4" as never] } })).rejects.toMatchObject({ status: 400, field: "production" });
    await expect(patch({ production: { burnCaptions: true, scenesAtOnce: 2, keepVersions: "all", extraFormats: ["webm", "webm"] } })).rejects.toMatchObject({ status: 400, field: "production" });
  });
});

describe("Nova Reel's line", () => {
  it("says it is not ready and what to do, never that the built-in animation makes the videos", async () => {
    await patch({ providers: { images: "builtin-rig", video: "nova-reel", audio: "builtin-synth" } });
    const reel = (await api.providers("stories")).find((p) => p.id === "nova-reel")!;
    expect(reel.state).toBe("needs_setup");
    expect(reel.line).toMatch(/^Amazon Nova Reel is not ready yet: .+\. Pick Built-in animation in Settings › Video, or finish its setup\.$/);
    expect(reel.line).not.toMatch(/built-in animation makes|videos use the built-in animation/i);
  });

  it("is said once on the Video page with the API's label (Amazon Nova Reel 1.1 (AI video)), which differs from the name in its line", async () => {
    await patch({ providers: { images: "builtin-rig", video: "nova-reel", audio: "builtin-synth" } });
    const reel = (await api.providers("stories")).find((p) => p.id === "nova-reel")!;
    expect(reel.label).toBe("Amazon Nova Reel 1.1 (AI video)");
    expect(notReadyLine(reel)).toBe(reel.line);
    expect(notReadyLine(reel).match(/is not ready yet/g)).toHaveLength(1);
    // A line that does not say it yet gets the sentence once, in front.
    expect(notReadyLine({ label: "Amazon Nova Canvas (AI pictures)", line: "Make one portrait to check it." })).toBe("Amazon Nova Canvas (AI pictures) is not ready yet. Make one portrait to check it.");
  });
});
