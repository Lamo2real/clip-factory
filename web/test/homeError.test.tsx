// Home draws its error state (F010): a failed load shows Try again instead of skeletons forever, and a failed numbers
// call blanks only the views stat. The parts of Home that need the session or the toasts are stubbed out.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import type { Api } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fake: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => fake as Api }));
vi.mock("../src/screens/home/NewJobForm.tsx", () => ({ NewJobForm: () => null }));
vi.mock("../src/components/GetApp.tsx", () => ({ GetAppBanner: () => null }));
vi.mock("../src/screens/home/MoneyTile.tsx", () => ({ MoneyTile: () => null }));
vi.mock("../src/lib/live.ts", () => ({ useLiveEvents: () => undefined, useLivePoll: () => undefined }));

const { Home } = await import("../src/screens/home/Home.tsx");
const { seed } = await import("../src/api/mock/fixtures.ts");

const down = () => new ApiError(503, "internal", "Something went wrong on our side. Try again in a moment.");
const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  for (const k of Object.keys(fake)) delete (fake as Record<string, unknown>)[k];
  const s = seed();
  fake.listJobs = vi.fn(async () => ({ jobs: s.jobs.slice(0, 6), nextCursor: null }));
  fake.listClips = vi.fn(async () => s.clips.filter((c) => c.status === "review"));
  fake.insights = vi.fn(async () => ({ posts: [] }) as unknown as Awaited<ReturnType<Api["insights"]>>);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Home error state (F010)", () => {
  it("a failed jobs load shows Try again in the Working now card and the review row, not skeletons", async () => {
    fake.listJobs = vi.fn(async () => {
      throw down();
    });
    act(() => root.render(<Home />));
    await flush();
    expect(host.querySelector(".skeleton")).toBeNull();
    expect(host.querySelector(".home-row__cards [role=alert]")?.textContent).toContain("Try again in a moment.");
    expect(host.querySelector(".working__failed")?.textContent).toContain("Try again");
    expect(host.textContent).not.toContain("Checking for new clips");

    // Try again loads Home once the server answers.
    const s = seed();
    fake.listJobs = vi.fn(async () => ({ jobs: s.jobs.slice(0, 6), nextCursor: null }));
    const retry = host.querySelector<HTMLButtonElement>(".working__failed button")!;
    act(() => retry.click());
    await flush();
    expect(host.querySelector("[role=alert]")).toBeNull();
    expect(host.querySelector(".working__failed")).toBeNull();
    expect(host.querySelectorAll(".home-row__cards .teaser").length).toBeGreaterThan(0);
  });

  it("a failed numbers call still shows the jobs and clips; only the views stat says it could not load", async () => {
    fake.insights = vi.fn(async () => {
      throw down();
    });
    act(() => root.render(<Home />));
    await flush();
    expect(host.querySelector(".skeleton")).toBeNull();
    expect(host.querySelector("[role=alert]")).toBeNull();
    expect(host.querySelectorAll(".home-row__cards .teaser").length).toBeGreaterThan(0);
    expect(host.querySelector(".stat__value")?.textContent).toBe("–");
    expect(host.querySelector(".stat__sub")?.textContent).toContain("Could not get the numbers right now");
  });
});
