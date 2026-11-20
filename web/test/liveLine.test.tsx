import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumedJob } from "../src/api/mock/fixtures.ts";
import type { Job, JobLive } from "../src/api/types.ts";
import { clearJobLive, clockText, lineWords, STALE_MS, takeJobLive } from "../src/lib/jobLive.ts";
import { applyJobLiveEvent, pickJobLive } from "../src/lib/liveCache.ts";
import { LiveLine } from "../src/screens/jobs/LiveLine.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const BASE = resumedJob();

function running(over: Partial<Job> = {}): Job {
  return { ...BASE, status: "running", run: "r1", note: undefined, ...over };
}

function line(over: Partial<JobLive> = {}): JobLive {
  return {
    jobId: BASE.jobId,
    run: "r1",
    step: "render",
    text: "Cutting clip 3 of 10",
    detail: "0:41 of 0:58",
    tech: "ffmpeg · 1080×1920 · 30 fps",
    i: 3,
    n: 10,
    at: iso(1000),
    ...over,
  };
}

const push = (l: JobLive) => act(() => takeJobLive({ type: "jobLive", op: "upsert", id: l.jobId, item: l }));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  clearJobLive();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const text = (sel: string) => host.querySelector(sel)?.textContent ?? null;
const status = () => host.querySelector('[role="status"]');

describe("LiveLine", () => {
  it("shows the sentence, the small detail and the tiny what-is-running line", () => {
    act(() => root.render(<LiveLine job={running({ live: line() })} />));
    expect(text(".live-line__text")).toBe("Cutting clip 3 of 10");
    expect(text(".live-line__detail")).toBe("0:41 of 0:58");
    expect(text(".live-line__tech")).toBe("ffmpeg · 1080×1920 · 30 fps");
  });

  it("says how much of the chat it has read", () => {
    const chat = line({ step: "analyze", text: "Reading the chat", detail: "12,430 messages", tech: "Twitch chat replay" });
    act(() => root.render(<LiveLine job={running({ live: chat })} />));
    expect(text(".live-line__text")).toBe("Reading the chat");
    expect(text(".live-line__detail")).toBe("12,430 messages");
    expect(text(".live-line__tech")).toBe("Twitch chat replay");
    act(() => root.render(<LiveLine job={running({ live: chat })} compact className="job-row__step" />));
    expect(host.textContent).toBe("Reading the chat · 12,430 messages");
  });

  it("updates when a new line arrives over the live connection", () => {
    const job = running({ live: line() });
    act(() => root.render(<LiveLine job={job} />));
    push(line({ text: "Cutting clip 4 of 10", detail: "0:03 of 0:47", i: 4, at: iso(0) }));
    expect(text(".live-line__text")).toBe("Cutting clip 4 of 10");
    expect(text(".live-line__detail")).toBe("0:03 of 0:47");
  });

  it("ignores a line written by an older run of the job", () => {
    const job = running({ live: line() });
    act(() => root.render(<LiveLine job={job} />));
    push(line({ run: "old", text: "Saving clip 9 of 10", at: iso(0) }));
    expect(text(".live-line__text")).toBe("Cutting clip 3 of 10");
  });

  it("falls back to the job's note before the first line, and shows nothing once the job ended", () => {
    const job = running({ note: "Picking up where it stopped…" });
    act(() => root.render(<LiveLine job={job} />));
    expect(host.textContent).toBe("Picking up where it stopped…");
    act(() => root.render(<LiveLine job={{ ...job, live: line() }} />));
    expect(text(".live-line__text")).toBe("Cutting clip 3 of 10"); // the first live line replaces the note
    act(() => root.render(<LiveLine job={{ ...job, live: line(), status: "ready" }} />));
    expect(host.textContent).toBe("");
  });

  it("counts the seconds of a model call itself, without new writes", () => {
    const l = line({ step: "checklist", text: "Checking clip 4 of 10 with Claude", detail: undefined, since: iso(72_000), at: iso(0), tech: "Claude Opus 5.5 · thinking" });
    act(() => root.render(<LiveLine job={running({ live: l })} />));
    expect(text(".live-line__detail")).toBe("1:12");
    act(() => vi.advanceTimersByTime(3000));
    expect(text(".live-line__detail")).toBe("1:15");
  });

  it("says it is still working, with the step's name, after a minute without a new line", () => {
    act(() => root.render(<LiveLine job={running({ live: line({ at: iso(0) }) })} />));
    expect(text(".live-line__text")).toBe("Cutting clip 3 of 10");
    act(() => vi.advanceTimersByTime(STALE_MS + 70_000));
    expect(text(".live-line__text")).toBe("Still working: Cut the clips");
    expect(text(".live-line__detail")).toBe("last update 2 min ago");
    expect(host.querySelector(".live-line.is-stale")).not.toBeNull();
    expect(host.querySelector(".live-line__tech")).toBeNull();
  });

  it("says it too when lines keep coming but the words have not changed for five minutes", () => {
    const stuck = line({ at: iso(0), lastChange: iso(6 * 60_000) });
    act(() => root.render(<LiveLine job={running({ live: stuck })} />));
    expect(text(".live-line__text")).toBe("Still working: Cut the clips");
    expect(text(".live-line__detail")).toBe("last update 6 min ago");
    push(line({ at: iso(0), lastChange: iso(0), text: "Cutting clip 4 of 10" })); // news: alive again
    expect(text(".live-line__text")).toBe("Cutting clip 4 of 10");
  });

  it("does not depend on the phone's clock: the ages come from the agent's own times", () => {
    // The agent's clock is 10 minutes ahead of this phone's: a line "from the future" is not stale, and a call
    // that began 20 s before the line shows 20 s, never a negative or a huge number.
    const ahead = new Date(NOW + 600_000).toISOString();
    const l = line({ at: ahead, lastChange: ahead, since: new Date(NOW + 580_000).toISOString(), detail: undefined });
    act(() => root.render(<LiveLine job={running({ live: l })} />));
    expect(text(".live-line__text")).toBe("Cutting clip 3 of 10");
    expect(text(".live-line__detail")).toBe("0:20");
    expect(lineWords(line({ at: iso(0), since: new Date(NOW + 5000).toISOString(), detail: undefined }), NOW, "x").detail).toBe("0:00");
  });

  it("the visible words are no live region; the hidden status speaks only when the step or clip changes", () => {
    const job = running({ live: line() });
    act(() => root.render(<LiveLine job={job} />));
    expect(host.querySelector(".live-line__body [aria-live]")).toBeNull();
    expect(status()?.getAttribute("aria-live")).toBe("polite");
    expect(status()?.textContent).toBe("Cutting clip 3 of 10.");
    // The seconds move: nothing new to hear.
    push(line({ detail: "0:52 of 0:58", at: iso(0) }));
    expect(text(".live-line__detail")).toBe("0:52 of 0:58");
    expect(status()?.textContent).toBe("Cutting clip 3 of 10.");
    // The next clip: heard once.
    push(line({ text: "Cutting clip 4 of 10", i: 4, at: iso(0) }));
    expect(status()?.textContent).toBe("Cutting clip 4 of 10.");
  });

  it("compact: one line for the lists, the detail hidden from screen readers, the fallback before a line", () => {
    const job = running();
    act(() => root.render(<LiveLine job={job} compact className="job-row__step" fallback={<span>Cut the clips · 70%</span>} after=" · 70%" />));
    expect(host.textContent).toBe("Cut the clips · 70%");
    act(() =>
      root.render(<LiveLine job={{ ...job, live: line() }} compact className="job-row__step" fallback={<span>x</span>} after=" · 70%" />),
    );
    const el = host.querySelector(".job-row__step.live-line--compact.clamp-1");
    expect(el?.textContent).toBe("Cutting clip 3 of 10 · 0:41 of 0:58 · 70%");
    expect(el?.querySelector(".live-line__more")?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector(".live-line__tech")).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(el?.getAttribute("aria-live")).toBe("off"); // quiet inside Home's live list
  });
});

describe("live line helpers", () => {
  it("clock text", () => {
    expect(clockText(41)).toBe("0:41");
    expect(clockText(72)).toBe("1:12");
    expect(clockText(3723)).toBe("1:02:03");
    expect(clockText(-5)).toBe("0:00");
  });

  it("lineWords never shows the seconds to a screen reader", () => {
    const w = lineWords(line({ since: iso(21_000), at: iso(0), detail: undefined }), NOW, "Cut the clips");
    expect(w.detail).toBe("0:21");
    expect(w.say).toBe("Cutting clip 3 of 10.");
  });

  it("the newest line of a run wins; a new run replaces an older one; delete forgets it", () => {
    const ev = (l: JobLive) => ({ type: "jobLive" as const, op: "upsert" as const, id: l.jobId, item: l });
    let m = applyJobLiveEvent(new Map(), ev(line({ at: iso(0) })));
    m = applyJobLiveEvent(m, ev(line({ text: "late", at: iso(5000) })));
    expect(m.get(line().jobId)?.text).toBe("Cutting clip 3 of 10");
    m = applyJobLiveEvent(m, ev(line({ run: "r2", text: "new run", at: iso(9000) })));
    expect(m.get(line().jobId)?.text).toBe("new run");
    m = applyJobLiveEvent(m, { type: "jobLive", op: "delete", id: line().jobId });
    expect(m.size).toBe(0);
  });

  it("pickJobLive: only while queued or running, only the job's run, the newer of pushed and fetched", () => {
    const fetched = line({ text: "fetched", at: iso(5000) });
    const pushed = line({ text: "pushed", at: iso(0) });
    expect(pickJobLive(running({ live: fetched }), pushed)?.text).toBe("pushed");
    expect(pickJobLive(running({ live: pushed }), fetched)?.text).toBe("pushed");
    expect(pickJobLive(running({ live: fetched, status: "ready" }), pushed)).toBeNull();
    expect(pickJobLive(running({ run: "r9" }), pushed)).toBeNull();
    expect(pickJobLive(running({ run: undefined }), pushed)?.text).toBe("pushed");
  });
});
