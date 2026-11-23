// A sheet closed by a tap is gone at once: the second click of that double-click must not land on what was under it
// (another job's row, the next page). Any other click goes through as usual.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "../src/components/Sheet.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let behind: HTMLButtonElement;
let pressed: ReturnType<typeof vi.fn<() => void>>;

function Asks() {
  const [open, setOpen] = useState(true);
  return open ? (
    <Sheet
      title="Delete this job?"
      onClose={() => setOpen(false)}
      actions={
        <>
          <button type="button" className="keep" onClick={() => setOpen(false)}>
            Keep it
          </button>
          <button type="button" className="go" onClick={() => setOpen(false)}>
            Delete job
          </button>
        </>
      }
    />
  ) : null;
}

const click = (el: Element, x: number, y: number, detail = 1) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, detail }));
  });

beforeEach(() => {
  pressed = vi.fn<() => void>();
  behind = document.createElement("button");
  behind.addEventListener("click", pressed);
  document.body.appendChild(behind);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Asks />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  behind.remove();
  vi.useRealTimers();
});

describe("Sheet and a double-click", () => {
  it("swallows the second click of a double-click on Delete job", () => {
    click(document.querySelector(".go")!, 200, 300);
    expect(document.querySelector(".sheet")).toBeNull();
    click(behind, 202, 301);
    expect(pressed).not.toHaveBeenCalled();
    // Only that one click: the next one goes through.
    click(behind, 202, 301);
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  it("swallows the second click after Keep it, or after a tap outside", () => {
    click(document.querySelector(".keep")!, 120, 400);
    click(behind, 120, 400);
    expect(pressed).not.toHaveBeenCalled();

    act(() => root.render(<></>));
    act(() => root.render(<Asks key="again" />));
    click(document.querySelector(".sheet-scrim")!, 10, 10);
    expect(document.querySelector(".sheet")).toBeNull();
    click(behind, 12, 12);
    expect(pressed).not.toHaveBeenCalled();
  });

  it("lets a click somewhere else, a later click, or a keyboard close through", () => {
    click(document.querySelector(".go")!, 200, 300);
    click(behind, 600, 300);
    expect(pressed).toHaveBeenCalledTimes(1);

    act(() => root.render(<></>));
    act(() => root.render(<Asks key="later" />));
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    click(document.querySelector(".go")!, 200, 300);
    vi.advanceTimersByTime(600);
    click(behind, 200, 300);
    expect(pressed).toHaveBeenCalledTimes(2);
    vi.useRealTimers();

    act(() => root.render(<></>));
    act(() => root.render(<Asks key="keys" />));
    click(document.querySelector(".go")!, 0, 0, 0);
    click(behind, 0, 0);
    expect(pressed).toHaveBeenCalledTimes(3);
  });
});
