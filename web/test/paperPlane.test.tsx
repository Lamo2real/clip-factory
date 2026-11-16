import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FADE_MS, FLIGHT_MS, PaperPlaneButton, RETURN_MS, useLaunch } from "../src/components/PaperPlane.tsx";
import { setPrefs } from "../src/lib/prefs.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let launchIt: () => void = () => undefined;
const clicked = vi.fn();

function Demo({ disabled = false }: { disabled?: boolean }) {
  const flight = useLaunch();
  launchIt = flight.launch;
  return <PaperPlaneButton flight={flight} disabled={disabled} onClick={clicked} />;
}

const btn = () => host.querySelector<HTMLButtonElement>("button")!;
const fly = () => host.querySelector<HTMLElement>(".fly")!;

beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  clicked.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setPrefs({ reduceMotion: false });
  vi.useRealTimers();
});

describe("PaperPlaneButton", () => {
  it("is only a plane: no words, named Send, and the plane is hidden from screen readers", () => {
    act(() => root.render(<Demo />));
    expect(btn().textContent?.trim()).toBe("");
    expect(btn().getAttribute("aria-label")).toBe("Send");
    expect(btn().querySelector("svg.paper-plane")).not.toBeNull();
    expect(fly().getAttribute("aria-hidden")).toBe("true");
    expect(btn().className).toContain("btn--primary");
  });

  it("stays focusable when off and does nothing on a tap", () => {
    act(() => root.render(<Demo disabled />));
    expect(btn().getAttribute("aria-disabled")).toBe("true");
    expect(btn().disabled).toBe(false);
    act(() => btn().click());
    expect(clicked).not.toHaveBeenCalled();
  });

  it("flies off with a trail, then comes back to rest; a second launch restarts it", () => {
    act(() => root.render(<Demo />));
    expect(fly().className).toBe("fly");
    act(() => launchIt());
    expect(fly().className).toContain("is-flying");
    expect(host.querySelector(".fly__trail")).not.toBeNull();
    const first = host.querySelector(".fly__item");
    act(() => vi.advanceTimersByTime(FLIGHT_MS));
    act(() => launchIt());
    // A fresh glyph (new key), so the CSS animation starts over.
    expect(host.querySelector(".fly__item")).not.toBe(first);
    act(() => vi.advanceTimersByTime(FLIGHT_MS + RETURN_MS));
    expect(fly().className).toBe("fly");
    expect(host.querySelector(".fly__trail")).toBeNull();
  });

  it("only fades with reduced motion", () => {
    setPrefs({ reduceMotion: true });
    act(() => root.render(<Demo />));
    act(() => launchIt());
    expect(fly().className).toContain("is-fading");
    expect(fly().className).not.toContain("is-flying");
    expect(host.querySelector(".fly__trail")).toBeNull();
    act(() => vi.advanceTimersByTime(FADE_MS));
    expect(fly().className).toBe("fly");
  });
});
