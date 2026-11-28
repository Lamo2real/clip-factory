// Reference videos, "Edit like these" (docs/CONTRACTS.md §57), in memory with the API's rules and sentences. Two ready
// examples to start with. A completed upload is "analyzing" for about 4 s, then "ready" with a made-up summary. Test
// knobs: window.__cfMock.refVideos.
import { ApiError } from "../errors.ts";
import type { Api, RefVideo } from "../types.ts";
import {
  REF_MAX_BYTES,
  REF_MAX_COUNT,
  REF_TYPES,
} from "../../lib/refVideos.ts";
import { coverArt } from "./art.ts";
import { ulid } from "./fixtures.ts";

export type RefVideosApi = Pick<
  Api,
  "listRefVideos" | "createRefVideo" | "completeRefVideo" | "deleteRefVideo"
>;

/** How long a pretend check takes. */
export const MOCK_CHECK_MS = 4000;

export interface RefVideosControls {
  /** The next check fails (the Try again path). */
  failNext(): void;
  /** Starts again with the two examples. */
  reset(): void;
}

const KIND =
  "That file is not a video we can use. Use MP4, MOV or WebM up to 500 MB.";
const FULL = "You have 10 reference videos. Delete one first.";
const GONE = "We could not find that video.";
const READ_FAIL = "We could not read this video. Try again.";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const seeded = (): RefVideo[] => [
  {
    refId: ulid(),
    name: "Ranked clutch edit",
    status: "ready",
    createdAt: ago(3_600_000),
    thumbUrl: coverArt(0, "No way he hit that", "facecam_top"),
    summary: [
      "Facecam on top, game below",
      "Big yellow captions, 2 words a line",
      "Hook text in the first second",
      "Quick cuts every 2 seconds",
    ],
    unsupported: ["Added music"],
    duration: 28,
  },
  {
    refId: ulid(),
    name: "Funny fails",
    status: "ready",
    createdAt: ago(2 * 86_400_000),
    thumbUrl: coverArt(1, "Wait for it", "blur_fill"),
    summary: [
      "Whole game picture, blurred behind",
      "White captions, 3 words a line",
      "Starts on the funniest part",
      "Ends on the punchline",
    ],
    unsupported: ["Sound effects"],
    duration: 41,
  },
];

const ready = (
  name: string,
  seed: number,
): Pick<RefVideo, "thumbUrl" | "summary" | "unsupported" | "duration"> => ({
  thumbUrl: coverArt(seed, name, "facecam_top"),
  summary: [
    "Facecam on top, game below",
    "Big white captions, 2 words a line",
    "Hook text in the first second",
  ],
  unsupported: [],
  duration: 32,
});

export function refVideosApi({
  delay,
}: {
  delay: (min?: number, max?: number) => Promise<void>;
}): { api: RefVideosApi; controls: RefVideosControls } {
  let videos: RefVideo[] = seeded();
  const pending = new Map<string, { name: string; createdAt: string }>();
  /** When each video being checked is done, and whether it fails. */
  const checks = new Map<string, { at: number; fail: boolean }>();
  let failNext = false;
  let seed = 2;

  /** Moves each video whose pretend check is over to ready (or failed). */
  const settle = () => {
    const now = Date.now();
    videos = videos.map((v) => {
      const c = checks.get(v.refId);
      if (v.status !== "analyzing" || !c || c.at > now) return v;
      checks.delete(v.refId);
      if (c.fail) return { ...v, status: "failed", error: READ_FAIL };
      const { error: _e, ...rest } = v;
      return { ...rest, status: "ready", ...ready(v.name, seed++) };
    });
  };
  const startCheck = (refId: string) => {
    checks.set(refId, { at: Date.now() + MOCK_CHECK_MS, fail: failNext });
    failNext = false;
  };
  const newestFirst = () =>
    [...videos].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const api: RefVideosApi = {
    async listRefVideos() {
      await delay();
      settle();
      return structuredClone(newestFirst());
    },
    async createRefVideo({ filename, contentType, size }) {
      await delay();
      if (
        !(REF_TYPES as readonly string[]).includes(contentType) ||
        !(size > 0) ||
        size > REF_MAX_BYTES
      )
        throw new ApiError(400, "bad_request", KIND);
      if (videos.length + pending.size >= REF_MAX_COUNT)
        throw new ApiError(409, "conflict", FULL);
      const refId = ulid();
      const name = Array.from(
        String(filename)
          .replace(/\.[a-z0-9]{1,5}$/i, "")
          .trim() || "Video",
      )
        .slice(0, 60)
        .join("");
      pending.set(refId, { name, createdAt: new Date().toISOString() });
      return {
        refId,
        uploadUrl: "mock://upload",
        headers: { "Content-Type": contentType },
      };
    },
    async completeRefVideo(refId) {
      await delay();
      const p = pending.get(refId);
      if (p) {
        pending.delete(refId);
        videos = [
          ...videos,
          { refId, name: p.name, status: "analyzing", createdAt: p.createdAt },
        ];
        startCheck(refId);
      } else {
        const v = videos.find((x) => x.refId === refId);
        if (!v) throw new ApiError(404, "not_found", GONE);
        const { error: _e, ...rest } = v;
        videos = videos.map((x) =>
          x.refId === refId ? { ...rest, status: "analyzing" } : x,
        );
        startCheck(refId);
      }
      return structuredClone(videos.find((x) => x.refId === refId)!);
    },
    async deleteRefVideo(refId) {
      await delay();
      if (!videos.some((v) => v.refId === refId))
        throw new ApiError(404, "not_found", GONE);
      videos = videos.filter((v) => v.refId !== refId);
      checks.delete(refId);
    },
  };

  const controls: RefVideosControls = {
    failNext: () => {
      failNext = true;
    },
    reset: () => {
      videos = seeded();
      pending.clear();
      checks.clear();
      failNext = false;
    },
  };
  return { api, controls };
}
