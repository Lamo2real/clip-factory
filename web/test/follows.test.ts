// Follow creators (docs/CONTRACTS.md §24.5): the words, the order, the live events, and the mock API's rules.
import { describe, expect, it } from "vitest";
import { followsApi, parseFollow } from "../src/api/mock/follows.ts";
import type { Follow, LiveEvent } from "../src/api/types.ts";
import { searchSettings } from "../src/lib/settingsTree.ts";
import { applyFollowEvent, askMessage, initials, lastLine, liveBadge, sortFollows, watchingLine } from "../src/screens/settings/FollowBranch.tsx";
import { liveSummary } from "../src/screens/home/StreamersRow.tsx";

const follow = (over: Partial<Follow> = {}): Follow => ({
  followId: "twitch:someone",
  platform: "twitch",
  platformId: "someone",
  handle: "someone",
  name: "Someone",
  avatarUrl: "",
  url: "https://www.twitch.tv/someone",
  autoClips: true,
  permissionAt: "2026-11-18T10:00:00.000Z",
  followedAt: "2026-11-18T10:00:00.000Z",
  resolved: true,
  ...over,
});

const fresh = () => {
  const events: LiveEvent[] = [];
  const made = followsApi((e) => events.push(e), async () => undefined);
  return { ...made, events };
};

describe("Streamers I follow: the words", () => {
  it("shows LIVE with viewers, Offline, Needs a grown-up, or nothing yet", () => {
    expect(liveBadge(follow({ live: { isLive: true, viewers: 1200 } }))).toMatchObject({ text: "LIVE · 1.2K watching", tone: "vermilion" });
    expect(liveBadge(follow({ live: { isLive: true } }))?.text).toBe("LIVE");
    expect(liveBadge(follow({ live: { isLive: false } }))?.text).toBe("Offline");
    expect(liveBadge(follow({ resolved: false }))?.text).toBe("Needs a grown-up");
    expect(liveBadge(follow({ platform: "youtube", resolved: true }))).toBeNull();
    expect(watchingLine(42)).toBe("42 watching");
    expect(watchingLine(undefined)).toBeNull();
  });

  it("says what was noticed, in plain words", () => {
    const at = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(lastLine(follow({ last: { state: "noticed", text: "Stream ended", at } }))).toMatch(/^Stream ended .+\.$/);
    expect(lastLine(follow())).toBeNull();
  });

  it("puts live streamers first, then by name", () => {
    const list = sortFollows([follow({ followId: "a", name: "Zed" }), follow({ followId: "b", name: "Amy" }), follow({ followId: "c", name: "Max", live: { isLive: true } })]);
    expect(list.map((f) => f.name)).toEqual(["Max", "Amy", "Zed"]);
  });

  it("makes initials for streamers without a picture", () => {
    expect(initials("SpeedySpeedruns")).toBe("SS");
    expect(initials("Clip City Games")).toBe("CC");
    expect(initials("nightowlplays")).toBe("NI");
    expect(initials("!!!")).toBe("?");
  });

  it("gives a friendly message to ask for permission", () => {
    expect(askMessage("Amy")).toContain("Hi Amy!");
    expect(askMessage("Amy")).toContain("say they are from you");
  });

  it("counts who is live for Home", () => {
    expect(liveSummary([follow({ live: { isLive: true } }), follow()])).toBe("1 live now.");
    expect(liveSummary([follow()])).toBe("Nobody is live right now.");
  });

  it("applies live events: upsert in place, add, delete", () => {
    const list = [follow()];
    const up = applyFollowEvent(list, { type: "follow", op: "upsert", id: "twitch:someone", item: follow({ live: { isLive: true } }) });
    expect(up[0]!.live?.isLive).toBe(true);
    expect(applyFollowEvent(list, { type: "follow", op: "upsert", id: "kick:x", item: follow({ followId: "kick:x" }) })).toHaveLength(2);
    expect(applyFollowEvent(list, { type: "follow", op: "delete", id: "twitch:someone" })).toEqual([]);
    expect(applyFollowEvent(list, { type: "job", op: "delete", id: "j" })).toBe(list);
  });

  it("is found by Find a setting", () => {
    for (const word of ["follow", "twitch", "kick", "live", "limit"]) {
      expect(searchSettings(word, false).some((h) => h.branch.slug === "streamers")).toBe(true);
    }
  });
});

describe("the mock follows API (same rules as §24.1)", () => {
  it("reads links and names, and never accepts other sites", () => {
    expect(parseFollow("https://www.twitch.tv/SpeedySpeedruns")).toEqual({ platform: "twitch", value: "speedyspeedruns" });
    expect(parseFollow("kick.com/NightOwlPlays")).toEqual({ platform: "kick", value: "nightowlplays" });
    expect(parseFollow("SpeedySpeedruns")).toEqual({ platform: "", value: "SpeedySpeedruns" });
    for (const bad of ["https://evil.example/x", "https://user:pw@twitch.tv/x", "https://twitch.tv:8080/name", "https://twitch.tv/videos/1", ""]) {
      expect(() => parseFollow(bad)).toThrow();
    }
  });

  it("asks which site for a name alone, then finds the streamer", async () => {
    const { api } = fresh();
    expect(await api.lookupFollow("SpeedySpeedruns")).toEqual({ needsPlatform: true, name: "SpeedySpeedruns" });
    const found = await api.lookupFollow("SpeedySpeedruns", "twitch");
    expect(found.needsPlatform).toBe(false);
    if (!found.needsPlatform) expect(found.creator).toMatchObject({ name: "SpeedySpeedruns", resolved: true, live: { isLive: true } });
  });

  it("finds Kick streamers by name before the keys, and fills them in once the keys are saved", async () => {
    const { api, events } = fresh();
    const found = await api.lookupFollow("nightowlplays", "kick");
    if (!found.needsPlatform) expect(found.creator).toMatchObject({ resolved: false, needsKeys: true });
    await api.follow("kick", "nightowlplays");
    let view = await api.listFollows();
    expect(view.keys.find((k) => k.platform === "kick")).toMatchObject({ saved: false, needed: true });
    await expect(api.saveFollowKeys("kick", { clientId: "x", clientSecret: "y" })).rejects.toThrow();
    view = await api.saveFollowKeys("kick", { clientId: "01KICKCLIENT0001", clientSecret: "kicksecret-abcdefghijkl" });
    expect(view.follows[0]).toMatchObject({ name: "NightOwlPlays", resolved: true });
    expect(view.keys.find((k) => k.platform === "kick")?.hints?.clientSecret).toBe("••••ijkl");
    expect(JSON.stringify(view)).not.toContain("kicksecret-abcdefghijkl");
    expect(events.some((e) => e.type === "follow")).toBe(true);
  });

  it("switches, removes and knows nobody after Remove", async () => {
    const { api } = fresh();
    await api.follow("twitch", "speedyspeedruns");
    expect((await api.setFollowAuto("twitch", "speedyspeedruns", false)).autoClips).toBe(false);
    await api.unfollow("twitch", "speedyspeedruns");
    expect((await api.listFollows()).follows).toEqual([]);
    await expect(api.unfollow("twitch", "speedyspeedruns")).rejects.toThrow();
  });

  it("the knobs flip live, end a stream and notice a new video", async () => {
    const { api, controls, events } = fresh();
    controls.seed();
    const before = events.length;
    controls.setLive("twitch:cozycrafts", true, 77);
    controls.endStream("twitch:speedyspeedruns");
    controls.newVideo("youtube:UCclipcitygames000000000");
    const view = await api.listFollows();
    expect(view.follows.find((f) => f.followId === "twitch:cozycrafts")?.live).toMatchObject({ isLive: true, viewers: 77 });
    expect(view.follows.find((f) => f.followId === "twitch:speedyspeedruns")?.last?.text).toBe("Stream ended");
    expect(events.length - before).toBe(3);
  });
});
