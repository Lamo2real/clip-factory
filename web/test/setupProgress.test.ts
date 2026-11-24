import { describe, expect, it } from "vitest";
import type { PlatformSetup } from "../src/api/types.ts";
import { computeReady, doneLine, notStarted, progressOf, stateLine, stepDone, stillConnectedLine } from "../src/lib/setupProgress.ts";
import { allSteps, GUIDES } from "../src/setup/index.ts";

const blank = (patch: Partial<PlatformSetup> = {}): PlatformSetup => ({
  platform: "youtube",
  stepsDone: [],
  ready: false,
  keys: { saved: false },
  account: { platform: "youtube", status: "not_connected" },
  gates: [{ key: "published_app", state: "action" }],
  ...patch,
});

describe("setup progress (§17.1)", () => {
  const yt = GUIDES.youtube;

  it("starts at step 1 with nothing done", () => {
    const p = progressOf(yt, blank());
    expect(p.current?.id).toBe("ready-channel");
    expect(p.currentNumber).toBe(1);
    expect(p.done).toBe(0);
    expect(p.fraction).toBe(0);
    expect(stateLine(yt, blank())).toBe("Not started");
  });

  it("leaves optional steps out of the ring", () => {
    const counted = allSteps(yt).filter((s) => !s.optional).length;
    expect(progressOf(yt, blank()).total).toBe(counted);
    expect(counted).toBe(allSteps(yt).length - 2);
  });

  it("the current step is the first one that counts and is not done", () => {
    const s = blank({ stepsDone: ["ready-channel", "ready-computer", "key-project"] });
    const p = progressOf(yt, s);
    expect(p.current?.id).toBe("key-console");
    expect(p.done).toBe(3);
    expect(stateLine(yt, s)).toBe(`Step 3 of ${allSteps(yt).length}`);
  });

  it("auto steps tick themselves from what the server knows", () => {
    const paste = allSteps(yt).find((s) => s.id === "key-paste")!;
    const connect = allSteps(yt).find((s) => s.id === "connect")!;
    const verify = allSteps(GUIDES.tiktok).find((s) => s.id === "key-verify")!;
    expect(stepDone(paste, blank({ stepsDone: ["key-paste"] }))).toBe(false);
    expect(stepDone(paste, blank({ keys: { saved: true } }))).toBe(true);
    expect(stepDone(connect, blank({ account: { platform: "youtube", status: "needs_reconnect" } }))).toBe(false);
    expect(stepDone(connect, blank({ account: { platform: "youtube", status: "connected" } }))).toBe(true);
    expect(stepDone(verify, blank({ platform: "tiktok", files: [] }))).toBe(false);
    expect(stepDone(verify, blank({ platform: "tiktok", files: ["tiktokAbc123.txt"] }))).toBe(true);
    expect(stepDone(paste, null)).toBe(false);
  });

  it("is ready when connected and no gate needs the owner", () => {
    const connected = { platform: "youtube" as const, status: "connected" as const };
    expect(computeReady({ account: connected, gates: [{ key: "published_app", state: "action" }] })).toBe(false);
    expect(computeReady({ account: connected, gates: [{ key: "published_app", state: "ok" }] })).toBe(true);
    expect(computeReady({ account: connected, gates: [{ key: "posting_audit", state: "limited" }] })).toBe(true);
    expect(computeReady({ account: { platform: "x", status: "needs_reconnect" }, gates: [] })).toBe(false);
  });

  it("a ready platform fills its ring and says so", () => {
    const s = blank({ ready: true, account: { platform: "youtube", status: "connected" }, gates: [{ key: "published_app", state: "ok" }] });
    expect(progressOf(yt, s).fraction).toBe(1);
    expect(stateLine(yt, s)).toBe("Ready");
    const tiktok = blank({
      platform: "tiktok",
      ready: true,
      account: { platform: "tiktok", status: "connected" },
      gates: [
        { key: "app_review", state: "limited" },
        { key: "posting_audit", state: "limited" },
      ],
    });
    expect(stateLine(GUIDES.tiktok, tiktok)).toBe("Works now, posts stay private");
  });

  it("says when the owner must connect again", () => {
    const s = blank({ stepsDone: ["ready-channel"], account: { platform: "youtube", status: "needs_reconnect", reason: "token_dead" } });
    expect(stateLine(yt, s)).toBe("Needs you: connect again");
    expect(notStarted(s)).toBe(false);
    expect(notStarted(blank())).toBe(true);
  });

  it("When it's done says what the platform card says: private posts, and TikTok's Mac", () => {
    const connected = { status: "connected" as const };
    const tiktok = blank({ platform: "tiktok", ready: true, account: { platform: "tiktok", ...connected }, gates: [{ key: "posting_audit", state: "limited" }] });
    expect(stateLine(GUIDES.tiktok, tiktok)).toBe("Works now, posts stay private");
    expect(doneLine("TikTok", tiktok)).toBe("Works now, posts stay private. To post for everyone, turn on Your Mac posts TikTok.");
    expect(doneLine("TikTok", tiktok, { macOn: true })).toBe("Works now, posts stay private. Your Mac posts TikTok for everyone.");
    const facebook = blank({ platform: "facebook", ready: true, account: { platform: "facebook", ...connected }, gates: [{ key: "app_live", state: "limited" }] });
    expect(doneLine("Facebook", facebook)).toBe("Works now, posts stay private.");
    const x = blank({ platform: "x", ready: true, account: { platform: "x", ...connected }, gates: [] });
    expect(doneLine("X", x)).toBe("Ready. Clip Factory posts here by itself.");
    expect(doneLine("X", x, { leaving: true })).toBe("Disconnecting…");
    expect(doneLine("X", { ...x, ready: false })).toBe("Connected.");
    expect(doneLine("X", { ...x, ready: false, account: { platform: "x", status: "needs_reconnect" } })).toBe("X logged Clip Factory out. Press Connect again.");
    expect(stillConnectedLine("@lamo")).toBe("Still connected as @lamo. Nothing changed.");
  });
});
