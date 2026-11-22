// Ask's memory above the Clip Factory / Lamo Stories branch (docs/CONTRACTS.md §45.16.1, §45.17): the conversation
// and whether the panel is open outlive Ask itself (switching to Lamo Stories unmounts Clip Factory's shell, Ask
// with it), an answer that is still streaming keeps writing into it, and sign-out (the provider going) still lets go
// of every picture's object URL. With no provider above, Ask keeps its own memory, exactly as before.
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskMemoryProvider, useAskMemory, type AskMemory } from "../src/features/help/askMemory.tsx";
import type { TrayFile } from "../src/features/help/chatState.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let seen: AskMemory | null = null;

/** Stands in for Ask's launcher: reads the memory and hands it to the test. */
function Ask() {
  const memory = useAskMemory();
  useEffect(() => {
    seen = memory;
  });
  return <p data-open={String(memory.open)}>{memory.chat.entries.length} entries</p>;
}

const picture = (url: string): TrayFile => ({ id: 7, kind: "image", name: "a.jpg", format: "JPG", size: 3, blob: new Blob(["abc"]), url, width: 1, height: 1 });

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  seen = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("with the provider above the branch", () => {
  it("keeps the conversation and the open panel while Ask is off screen, and takes what streams in meanwhile", () => {
    act(() =>
      root.render(
        <AskMemoryProvider>
          <Ask />
        </AskMemoryProvider>,
      ),
    );
    act(() => {
      seen!.setOpen(true);
      seen!.dispatch({ type: "ask", id: 1, text: "How do I change my click sound?" });
      seen!.dispatch({ type: "ai_start", id: 2, askId: "pending" });
    });
    const dispatch = seen!.dispatch;
    const generation = seen!.generation;
    // Lamo Stories: Clip Factory's shell, Ask with it, leaves the page.
    act(() => root.render(<AskMemoryProvider>{null}</AskMemoryProvider>));
    expect(host.textContent).toBe("");
    // The answer keeps streaming into the memory with the same dispatch the panel was given.
    act(() => {
      dispatch({ type: "ai_event", entryId: 2, event: { type: "ask.delta", askId: "a1", seq: 1, text: "Open Settings" } });
      dispatch({ type: "ai_event", entryId: 2, event: { type: "ask.done", askId: "a1", stop: "end", links: [] } });
      dispatch({ type: "ai_end", entryId: 2 });
    });
    // Back to Clip Factory: the same conversation, the panel open as it was.
    act(() =>
      root.render(
        <AskMemoryProvider>
          <Ask />
        </AskMemoryProvider>,
      ),
    );
    expect(seen!.open).toBe(true);
    expect(seen!.generation).toBe(generation);
    expect(seen!.chat.entries.map((e) => e.role)).toEqual(["user", "ai"]);
    expect(seen!.chat.streaming).toBeNull();
    expect(JSON.stringify(seen!.chat.entries[1])).toContain("Open Settings");
  });

  it("lets go of the pictures' object URLs only when the provider goes (sign-out), not when Ask does", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    act(() =>
      root.render(
        <AskMemoryProvider>
          <Ask />
        </AskMemoryProvider>,
      ),
    );
    act(() => seen!.dispatch({ type: "tray_file", file: picture("blob:mock/1") }));
    act(() => root.render(<AskMemoryProvider>{null}</AskMemoryProvider>));
    expect(revoke).not.toHaveBeenCalled();
    act(() => root.render(<div />));
    expect(revoke).toHaveBeenCalledWith("blob:mock/1");
  });
});

describe("with no provider (Ask on its own, as in its own tests)", () => {
  it("keeps its own memory for as long as it lives, as before", () => {
    act(() => root.render(<Ask />));
    act(() => {
      seen!.setOpen(true);
      seen!.dispatch({ type: "ask", id: 1, text: "Hi" });
    });
    expect(host.querySelector("p")?.getAttribute("data-open")).toBe("true");
    expect(host.textContent).toBe("1 entries");
    act(() => root.render(<div />));
    act(() => root.render(<Ask />));
    expect(seen!.open).toBe(false);
    expect(seen!.chat.entries).toEqual([]);
  });
});
