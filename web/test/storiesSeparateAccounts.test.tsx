// Clips Funded posts only to accounts of its own (docs/CONTRACTS.md §45.37 G8, the owner's hard rule of
// 22 Nov: "I do not want videos generated in lamo stories … uploaded to the same accounts as clip factory thats a hard
// no"), and Clip Factory's shared developer app is protected (§45.37 G6: "Keep it, protect CF"), against the
// in-memory API and the Social accounts page:
// - every card says up front to use a new account made for Clips Funded; there is no "Use it for both" on
//   any screen and no route for it;
// - per platform, the same account by each stable identity (YouTube the channel id, Facebook the Page id, Instagram
//   the user id and the username, TikTok the union id and the handle, X the user id and the handle) is refused at
//   connect and before every post, also when Clip Factory connects it later (then the card says why);
// - the shared app's choice reads "Share Clip Factory's app" with "Clip Factory's posts always go first. Clips Funded
//   uses what's left." (never "quicker"), and a post with no room left waits with its time and goes out after the reset.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { nextReset } from "../src/stories/api/mock/publishing.ts";
import { matchesClips } from "../src/stories/api/mock/social.ts";
import { setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import type { Platform, PublishingJob, StoriesApi } from "../src/stories/api/types.ts";
import { CLIPS_LATER_LINE, NEW_ACCOUNT_LINE, SAME_AS_CLIPS_LINE, SHARED_APP_ACCOUNT_LINE, SHARED_APP_LINE } from "../src/stories/screens/Connections.tsx";
import { PostRow, waitingLine, waitTime } from "../src/stories/studio/PostsPanel.tsx";
import { forgetDashboards, forgetOnboarding } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { ConnectionsScreen } = await import("../src/stories/screens/Connections.tsx");

let host: HTMLElement;
let root: Root;
let store: MockStore;
let api: StoriesApi;

/** The Clips Funded accounts the pretend platforms sign in with (mock/social.ts STORIES_IDENTITY). */
const STORIES: Record<Platform, { id: string; handle: string; name: string }> = {
  youtube: { id: "UC7stories0lamo00000000a", handle: "@fundedclips", name: "Clips Funded" },
  tiktok: { id: "-000lamostories-open-id", handle: "@funded.clips", name: "Clips Funded" },
  instagram: { id: "17841400000000001", handle: "@funded.clips", name: "funded.clips" },
  facebook: { id: "109876543210987", handle: "Clips Funded", name: "Clips Funded" },
  x: { id: "1600000000000000002", handle: "@fundedclips", name: "Clips Funded" },
};

function start(knobs: Record<string, unknown> = {}) {
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs };
  api = mockStoriesApi();
  store = (window as unknown as { __cfStoriesMock: { store: MockStore } }).__cfStoriesMock.store;
  setStoriesApi(api);
}
/** Clip Factory's own account on a platform now has these identities (it connected it, or always had it). */
function clipsHas(platform: Platform, who: { id?: string; handle?: string }) {
  store.knobs.clipsIdentity = { ...((store.knobs.clipsIdentity as object | undefined) ?? {}), [platform]: who };
}
async function render(knobs: Record<string, unknown> = {}) {
  start(knobs);
  await act(async () =>
    root.render(
      <ToastProvider>
        <ConnectionsScreen ws="stories" page={{ name: "connections", platform: null, result: null, ws: null }} />
      </ToastProvider>,
    ),
  );
  await settle();
}
async function settle(times = 5) {
  for (let i = 0; i < times; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}
const card = (platform: string) => host.querySelector<HTMLElement>(`.st-conn[data-platform="${platform}"]`)!;
const buttons = (el: ParentNode = host) => Array.from(el.querySelectorAll<HTMLButtonElement>("button, [role=radio]"));
const status = async (p: Platform) => (await api.social("stories")).accounts.find((a) => a.platform === p)!;

/** Connect a platform the way its pretend sign-in goes: straight in, or through its list of Pages and accounts. */
async function connect(p: Platform): Promise<string> {
  const { authorizeUrl } = await api.connectSocial("stories", p);
  const result = new URL(authorizeUrl, "https://x.test").searchParams.get("result")!;
  if (result !== "choose") return result;
  const chosen = await api.chooseSocial("stories", p, STORIES[p].id);
  return chosen.connectionStatus === "same_as_clips" ? "same_as_clips" : "connected";
}
/** Ready to connect: Meta's own app (the seed's) or Clip Factory's shared app for the others. */
async function appReady(p: Platform) {
  const a = await status(p);
  if (a.app.choice === null && (p === "youtube" || p === "tiktok" || p === "x")) await api.setSocialApp("stories", p, { choice: "clips" });
}
/** An approved story to post. */
const approved = () => store.stories.find((s) => s.status === "approved" || s.status === "published")!;
async function postTo(p: Platform): Promise<PublishingJob> {
  const s = approved();
  return (await api.publish("stories", s.storyId, [{ platform: p, socialAccountId: `stories.${p}` }]))[0]!;
}
const jobOf = (id: string) => store.publishing.find((j) => j.publishingJobId === id)!;
const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await act(async () => await new Promise((r) => setTimeout(r, 10)));
  expect(ok()).toBe(true);
};

beforeEach(async () => {
  await loadConfig(async () => new Response(JSON.stringify({ region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test/" })));
  localStorage.clear();
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
  localStorage.clear();
});

describe("no route or screen offers sharing an account (§45.37 G8 (d))", () => {
  it("the API has no share call, and no card has Use it for both, not even Clip Factory's own account", async () => {
    await render();
    expect(Object.keys(api)).not.toContain("shareWithClips");
    expect(Object.keys(api).filter((k) => /share/i.test(k))).toEqual([]);
    // The seed's X is Clip Factory's own: it says why, offers a different account, and nothing to share it.
    expect(store.social.find((a) => a.platform === "x")?.connectionStatus).toBe("same_as_clips");
    expect(card("x").textContent).toContain(SAME_AS_CLIPS_LINE);
    // The API sends that sentence as the account's warning too (public_of): the card says it once.
    expect((await api.social("stories")).accounts.find((a) => a.platform === "x")?.warning).toBe(SAME_AS_CLIPS_LINE);
    expect(card("x").textContent!.split(SAME_AS_CLIPS_LINE)).toHaveLength(2);
    expect(buttons(card("x")).map((b) => b.textContent?.trim())).toContain("Pick another account");
    for (const b of buttons()) expect(b.textContent ?? "").not.toMatch(/for both/i);
    expect(host.textContent).not.toMatch(/use it for both|Are you sure\?.*both post/i);
  });

  it("every card says up front to use a new account made for Clips Funded", async () => {
    await render();
    for (const p of ["youtube", "tiktok", "instagram", "facebook", "x"]) {
      const first = card(p).querySelector(".st-conn__new");
      expect(first?.textContent, p).toBe(NEW_ACCOUNT_LINE);
      // Before the developer app and before any Connect button.
      expect(first!.compareDocumentPosition(card(p).querySelector(".st-app")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(NEW_ACCOUNT_LINE).toBe("Use a new account made for Clips Funded, not Clip Factory's.");
  });

  it("the shared developer app reads Share Clip Factory's app, Clip Factory first, still a different account; never quicker", async () => {
    await render({ fresh: true });
    for (const p of ["youtube", "tiktok", "x"]) {
      const share = buttons(card(p)).find((b) => b.getAttribute("role") === "radio" && /Share Clip Factory's app/.test(b.textContent ?? ""));
      expect(share, p).toBeTruthy();
      expect(share!.textContent).toContain(SHARED_APP_LINE);
      expect(share!.textContent).toContain(SHARED_APP_ACCOUNT_LINE);
    }
    expect(SHARED_APP_LINE).toBe("Clip Factory's posts always go first. Clips Funded uses what's left.");
    expect(SHARED_APP_ACCOUNT_LINE).toBe("Even with Clip Factory's app, sign in with a different account made for Clips Funded.");
    // Meta never shares Clip Factory's app.
    for (const p of ["instagram", "facebook"]) expect(card(p).textContent).not.toContain("Share Clip Factory's app");
    expect(host.textContent).not.toMatch(/quicker/i);
  });

  it("with Clip Factory's app picked, the card still says Clip Factory goes first and to sign in with a different account", async () => {
    await render();
    const yt = card("youtube");
    expect(yt.querySelector(".st-app__now")?.textContent).toContain(SHARED_APP_LINE);
    expect(yt.querySelector(".st-app__now")?.textContent).toContain(SHARED_APP_ACCOUNT_LINE);
    expect(host.textContent).not.toMatch(/quicker/i);
  });
});

// Each platform and each identity the platform gives that Clip Factory's ACCOUNT# also has (§45.37 G8 (b)).
const SAME: [Platform, string, { id?: string; handle?: string }][] = [
  ["youtube", "the channel id", { id: STORIES.youtube.id }],
  ["facebook", "the Page id", { id: STORIES.facebook.id }],
  ["instagram", "the user id", { id: STORIES.instagram.id }],
  ["instagram", "the username", { handle: "funded.clips" }],
  ["tiktok", "the union id", { id: STORIES.tiktok.id }],
  ["tiktok", "the handle", { handle: "@funded.clips" }],
  ["x", "the user id", { id: STORIES.x.id }],
  ["x", "the handle", { handle: "FundedClips" }],
];

describe("the same account as Clip Factory's, by any identity, is refused (§45.37 G8 (b), (d))", () => {
  for (const [p, what, who] of SAME) {
    it(`${p} by ${what}: refused at connect`, async () => {
      start();
      await appReady(p);
      clipsHas(p, who);
      expect(await connect(p)).toBe("same_as_clips");
      expect((await status(p)).connectionStatus).toBe("same_as_clips");
      // And so before the post: it never goes out there.
      const job = await postTo(p);
      expect(job.publishingStatus).toBe("needs_attention");
      expect(job.error).toMatch(/is the one Clip Factory posts to/);
    });

    it(`${p} by ${what}: blocked before the upload once Clip Factory connects it later, and the card says why`, async () => {
      await render({ publishMs: 20 });
      await appReady(p);
      expect(await connect(p)).toBe("connected");
      // A post asked for while it was still Clips Funded's own...
      const job = await postTo(p);
      expect(job.publishingStatus).toBe("queued");
      // ...and Clip Factory connects the very same account before the upload starts.
      clipsHas(p, who);
      await until(() => jobOf(job.publishingJobId).publishingStatus !== "queued");
      expect(jobOf(job.publishingJobId)).toMatchObject({ publishingStatus: "needs_attention" });
      expect(jobOf(job.publishingJobId).url).toBeUndefined();
      // The API's code and warning (public_of): Clip Factory has it now.
      expect(await status(p)).toMatchObject({ connectionStatus: "same_as_clips", reason: "clips_now", warning: CLIPS_LATER_LINE });
      // A new post is stopped at the tap too.
      expect((await postTo(p)).publishingStatus).toBe("needs_attention");
      // The page says it is Clip Factory's account now, with a way to a different one.
      await act(async () => root.render(<ToastProvider>{null}</ToastProvider>));
      await act(async () =>
        root.render(
          <ToastProvider>
            <ConnectionsScreen ws="stories" page={{ name: "connections", platform: null, result: null, ws: null }} />
          </ToastProvider>,
        ),
      );
      await settle(6);
      expect(card(p).textContent).toContain(CLIPS_LATER_LINE);
      expect(card(p).textContent).toContain("Clip Factory's own");
      // Said once: the server's warning is the card's line, never a second, different explanation.
      expect(card(p).textContent!.split(CLIPS_LATER_LINE)).toHaveLength(2);
      expect(card(p).textContent).not.toContain(SAME_AS_CLIPS_LINE);
      for (const b of buttons(card(p))) expect(b.textContent ?? "").not.toMatch(/for both/i);
    });
  }

  it("YouTube and Facebook compare their ids only, the others also the handle; a different account is fine", async () => {
    start();
    expect(matchesClips("youtube", { externalAccountId: "UCother", handle: "@clipfactory" }, store)).toBe(false);
    expect(matchesClips("facebook", { externalAccountId: "1", handle: "Clip Factory Clips" }, store)).toBe(false);
    expect(matchesClips("x", { externalAccountId: "1", handle: "@ClipFactoryGG" }, store)).toBe(true);
    expect(matchesClips("tiktok", { externalAccountId: "other-open-id", handle: "clipfactory" }, store)).toBe(true);
    expect(matchesClips("instagram", { externalAccountId: "1", handle: null, accountName: "clipfactory.gg" }, store)).toBe(true);
    for (const p of ["youtube", "tiktok", "x"] as Platform[]) {
      await appReady(p);
      expect(await connect(p), p).toBe("connected");
      expect((await postTo(p)).publishingStatus, p).toBe("queued");
    }
  });

  it("the callback's same_as_clips result says Clips Funded needs its own separate account", async () => {
    start({ connectResult: "same_as_clips" });
    await act(async () =>
      root.render(
        <ToastProvider>
          <ConnectionsScreen ws="stories" page={{ name: "connections", platform: "tiktok", result: "same_as_clips", ws: null }} />
        </ToastProvider>,
      ),
    );
    await settle(6);
    expect(document.body.textContent).toContain("This is Clip Factory's own account. Clips Funded needs its own separate account: sign in with a different one.");
    expect(document.body.textContent).not.toMatch(/use it for both/i);
  });
});

describe("Clip Factory's shared app: its posts always go first (§45.37 G6 (c))", () => {
  it("a post with no room left waits with its time, never fails, and goes out by itself after the reset", async () => {
    start({ publishMs: 15, clipsFirst: ["youtube"], clipsFirstUntil: new Date(Date.now() + 250).toISOString() });
    const job = await postTo("youtube");
    await until(() => !!jobOf(job.publishingJobId).waitingUntil);
    // The API's public job shape (publish.public_job): waitingUntil and its own line, waiting.
    expect(jobOf(job.publishingJobId)).toMatchObject({ publishingStatus: "queued", waiting: expect.stringMatching(/^Waiting: Clip Factory's posts go first\. Posts at \d{1,2} [A-Z][a-z]{2} \d\d:\d\d UTC\.$/) });
    expect(waitingLine(jobOf(job.publishingJobId))).toMatch(/^Waiting: Clip Factory's posts go first\. Posts at (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d\.$/);
    expect((await api.listPublishing("stories", approved().storyId)).find((j) => j.publishingJobId === job.publishingJobId)?.waitingUntil).toBeTruthy();
    // After the reset it goes out with no tap.
    await until(() => jobOf(job.publishingJobId).publishingStatus === "posted", 3000);
    expect(jobOf(job.publishingJobId).waitingUntil ?? null).toBeNull();
    expect(jobOf(job.publishingJobId).waiting ?? null).toBeNull();
    expect(jobOf(job.publishingJobId).url).toBeTruthy();
  });

  it("only on Clip Factory's app: with Clips Funded's own app nothing waits", async () => {
    start({ publishMs: 15, clipsFirst: true });
    await api.setSocialApp("stories", "youtube", { choice: "own", clientId: "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps." + "googleusercontent.com", clientSecret: "GOCSPX-" + "abcdefghijklmnopqrstuvwxyz12" });
    store.social = store.social.map((a) => (a.platform === "youtube" ? { ...a, connectionStatus: "connected", externalAccountId: STORIES.youtube.id, accountName: "Clips Funded", handle: "@fundedclips" } : a));
    const job = await postTo("youtube");
    await until(() => jobOf(job.publishingJobId).publishingStatus === "posted", 3000);
    expect(jobOf(job.publishingJobId).waitingUntil ?? null).toBeNull();
  });

  it("each window resets when Clip Factory's share comes back: YouTube's day, TikTok's day, X's month", () => {
    const now = new Date("2026-11-22T19:30:00Z");
    expect(nextReset("youtube", now)).toBe("2026-11-23T08:00:00.000Z");
    expect(nextReset("tiktok", now)).toBe("2026-11-23T00:00:00.000Z");
    expect(nextReset("x", now)).toBe("2026-12-01T00:00:00.000Z");
    expect(nextReset("youtube", new Date("2026-11-22T07:00:00Z"))).toBe("2026-11-22T08:00:00.000Z");
  });

  it("the post row and the time words: the weekday and time within the week, else the day and month", () => {
    const now = new Date(2026, 10, 22, 19, 30);
    expect(waitTime(new Date(2026, 10, 23, 8, 0).toISOString(), now)).toBe("Mon 08:00");
    expect(waitTime(new Date(2026, 11, 1, 0, 0).toISOString(), now)).toBe("1 Dec 00:00");
    const job: PublishingJob = {
      publishingJobId: "p1",
      workspaceId: "stories",
      contentId: "s1",
      socialAccountId: "stories.youtube",
      platform: "youtube",
      publishingStatus: "queued",
      accountName: "Clips Funded",
      handle: "@fundedclips",
      waitingUntil: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      waiting: "Waiting: Clip Factory's posts go first. Posts at 23 Nov 08:00 UTC.",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    act(() => root.render(<ul>{<PostRow job={job} onRetry={() => undefined} />}</ul>));
    const line = host.querySelector(".st-s-post__wait");
    expect(line?.getAttribute("role")).toBe("status");
    expect(line?.textContent).toBe(waitingLine(job));
    expect(line?.textContent).toMatch(/^Waiting: Clip Factory's posts go first\. Posts at /);
    // Not waiting: no line; a stopped post never says it waits.
    expect(waitingLine({ ...job, waitingUntil: null, waiting: null })).toBeNull();
    expect(waitingLine({ ...job, publishingStatus: "failed" })).toBeNull();
  });

  it("reads the API's own shape: a waiting post is queued or publishing, its time in the owner's time, else the API's line", () => {
    const now = new Date(2026, 10, 22, 19, 30);
    const until = new Date(2026, 10, 23, 8, 0).toISOString();
    // As publish.public_job sends it: waitingUntil and waiting, never waitUntil.
    const api = { publishingStatus: "publishing" as const, waitingUntil: until, waiting: "Waiting: Clip Factory's posts go first. Posts at 23 Nov 07:00 UTC." };
    expect(waitingLine(api, now)).toBe("Waiting: Clip Factory's posts go first. Posts at Mon 08:00.");
    expect(waitingLine({ ...api, publishingStatus: "queued" }, now)).toBe("Waiting: Clip Factory's posts go first. Posts at Mon 08:00.");
    // No time: the API's line as it is.
    expect(waitingLine({ ...api, waitingUntil: null }, now)).toBe(api.waiting);
    expect(waitingLine({ publishingStatus: "posted", waitingUntil: until, waiting: api.waiting }, now)).toBeNull();
    expect(waitingLine({ publishingStatus: "publishing", waitingUntil: null, waiting: null }, now)).toBeNull();
  });
});
