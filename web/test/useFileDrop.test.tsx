// The shared drop zone hook and its overlay (docs/CONTRACTS.md §45.40.1): a counted highlight that never flickers
// over children, files checked and refused with their line (the shake restarts on each refusal), a dropped link, text
// dragged into a text box let through, and page zones that leave alone what another zone, Ask or a dialog has, and
// are off while their app is hidden.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneContext } from "../src/app/shell.ts";
import { DropOverlay, REFUSED_SHOW_MS } from "../src/components/DropOverlay.tsx";
import { REFUSED_MS, useFileDrop, WRONG_THING, type FileDropOptions } from "../src/lib/useFileDrop.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Payload = { files?: File[]; uri?: string; text?: string };
type Fired = Event & { dataTransfer: { dropEffect: string } };

/** A drag event as the browser sends it: the types, the files and the data of the drag. */
function drag(type: string, p: Payload, extra: { relatedTarget?: EventTarget | null; clientX?: number; clientY?: number } = {}): Fired {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Fired;
  const data: Record<string, string> = {};
  if (p.uri) data["text/uri-list"] = p.uri;
  if (p.text) data["text/plain"] = p.text;
  const types = [...(p.files?.length ? ["Files"] : []), ...Object.keys(data)];
  Object.assign(e, {
    dataTransfer: { types, files: p.files ?? [], items: [], getData: (t: string) => data[t] ?? "", dropEffect: "none" },
    relatedTarget: null,
    clientX: 300,
    clientY: 300,
    ...extra,
  });
  return e;
}

const VIDEO = new File(["v"], "trick.mp4", { type: "video/mp4" });
const PNG = new File(["p"], "shot.png", { type: "image/png" });
const videoOnly = (f: File) => (f.type.startsWith("video/") ? null : "Pick an MP4 or MOV video.");

let host: HTMLElement;
let root: Root;
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function Zone(props: Omit<FileDropOptions, "scope"> & { children?: ReactNode }) {
  const { children, ...opts } = props;
  const drop = useFileDrop({ scope: "element", ...opts });
  return (
    <div className="zone drop-host" data-refusals={drop.refusals} {...drop.bind}>
      <input className="box" type="text" />
      <span className="child">
        <b className="grandchild">x</b>
      </span>
      {children}
      <DropOverlay drop={drop} scope="element" words={{ file: "Drop your video here", link: "Drop the link here", either: "Drop it here", busy: "Wait for it." }} />
    </div>
  );
}

function Page(props: Omit<FileDropOptions, "scope">) {
  const drop = useFileDrop({ scope: "page", ...props });
  return (
    <>
      <main className="page" data-refusals={drop.refusals}>
        <p className="words">hello</p>
        <input className="box" type="url" />
        <button className="help-launcher" type="button">
          <span className="ask">Ask</span>
        </button>
        <div id="help-panel">
          <textarea />
        </div>
      </main>
      <DropOverlay drop={drop} scope="page" words={{ file: "Drop your video here", link: "Drop the link here", either: "Drop it here" }} look="stories" />
    </>
  );
}

const render = (ui: ReactNode) => act(() => root.render(ui));
const fire = <E extends Event>(sel: string, e: E): E => {
  act(() => {
    $(sel)!.dispatchEvent(e);
  });
  return e;
};
const layer = () => $(".drop-layer");
const status = (scope: string) => $(`${scope} [role=status], body > [role=status]`)?.textContent;

describe("an element zone", () => {
  it("shows one highlight that never flickers while the pointer moves over its children", () => {
    render(<Zone checkFile={videoOnly} />);
    fire(".zone", drag("dragenter", { files: [VIDEO] }));
    expect(layer()?.textContent).toBe("Drop your video here");
    expect(layer()?.getAttribute("aria-hidden")).toBe("true");
    expect(layer()?.className).toContain("drop-layer--element");
    expect(layer()?.className).toContain("drop-layer--clips");
    // Into a child: its dragenter comes first, then the zone's dragleave. Still one highlight.
    fire(".child", drag("dragenter", { files: [VIDEO] }));
    fire(".zone", drag("dragleave", { files: [VIDEO] }));
    expect(layer()).not.toBeNull();
    fire(".grandchild", drag("dragenter", { files: [VIDEO] }));
    fire(".child", drag("dragleave", { files: [VIDEO] }));
    expect(layer()).not.toBeNull();
    const over = fire(".grandchild", drag("dragover", { files: [VIDEO] }));
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("copy");
    // Out of the last one: it goes.
    fire(".grandchild", drag("dragleave", { files: [VIDEO] }));
    expect(layer()).toBeNull();
  });

  it("clears on a drop anywhere, the drag ending and the pointer leaving the window", () => {
    render(<Zone checkFile={videoOnly} />);
    fire(".zone", drag("dragenter", { files: [VIDEO] }));
    act(() => {
      window.dispatchEvent(drag("dragend", { files: [VIDEO] }));
    });
    expect(layer()).toBeNull();
    fire(".zone", drag("dragenter", { files: [VIDEO] }));
    act(() => {
      document.body.dispatchEvent(drag("dragleave", { files: [VIDEO] }, { clientX: 0, clientY: 0 }));
    });
    expect(layer()).toBeNull();
  });

  it("takes a video and refuses a picture with its line; each refusal counts up and shakes again", () => {
    const onFiles = vi.fn();
    render(<Zone checkFile={videoOnly} onFiles={onFiles} />);
    fire(".zone", drag("dragenter", { files: [VIDEO] }));
    const taken = fire(".zone", drag("drop", { files: [VIDEO] }));
    expect(taken.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledWith([VIDEO]);
    expect(layer()).toBeNull();

    fire(".zone", drag("dragenter", { files: [PNG] }));
    fire(".child", drag("drop", { files: [PNG] }));
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect($(".zone")!.dataset.refusals).toBe("1");
    expect(layer()?.className).toContain("is-refused");
    expect(layer()?.textContent).toBe("Pick an MP4 or MOV video.");
    expect($(".zone [role=status]")?.textContent).toBe("Pick an MP4 or MOV video.");
    const first = layer();
    fire(".zone", drag("drop", { files: [PNG] }));
    expect($(".zone")!.dataset.refusals).toBe("2");
    // A new layer: its shake starts again.
    expect(layer()).not.toBe(first);
    expect(layer()?.className).toContain("is-refused");
  });

  it("keeps the refused pill 1.6 s and the line 4 s, and a new drag clears the line", () => {
    vi.useFakeTimers();
    render(<Zone checkFile={videoOnly} />);
    fire(".zone", drag("drop", { files: [PNG] }));
    expect(layer()?.className).toContain("is-refused");
    act(() => vi.advanceTimersByTime(REFUSED_SHOW_MS));
    expect(layer()).toBeNull();
    expect(status(".zone")).toBe("Pick an MP4 or MOV video.");
    act(() => vi.advanceTimersByTime(REFUSED_MS - REFUSED_SHOW_MS));
    expect(status(".zone")).toBe("");
    fire(".zone", drag("drop", { files: [PNG] }));
    expect(status(".zone")).toBe("Pick an MP4 or MOV video.");
    fire(".zone", drag("dragenter", { files: [VIDEO] }));
    expect(status(".zone")).toBe("");
    expect(layer()?.className).toContain("is-file");
  });

  it("takes the files that pass, up to the most it takes, and says when there were too many", () => {
    const onFiles = vi.fn();
    const pics = [1, 2, 3].map((i) => new File(["p"], `p${i}.png`, { type: "image/png" }));
    const check = (f: File) => (f.type.startsWith("image/") ? null : "Pick a picture.");
    render(<Zone checkFile={check} maxFiles={2} tooMany="Two at a time." onFiles={onFiles} />);
    fire(".zone", drag("drop", { files: [new File(["d"], "a.pdf", { type: "application/pdf" }), ...pics] }));
    expect(onFiles).toHaveBeenCalledWith(pics.slice(0, 2));
    expect(status(".zone")).toBe("Two at a time.");
  });

  it("takes a dropped link, from a uri-list or plain text that is one link", () => {
    const onLink = vi.fn();
    render(<Zone checkFile={videoOnly} links onLink={onLink} />);
    fire(".zone", drag("dragenter", { uri: "https://www.tiktok.com/@a/video/1" }));
    expect(layer()?.textContent).toBe("Drop the link here");
    fire(".zone", drag("drop", { uri: "https://www.tiktok.com/@a/video/1" }));
    expect(onLink).toHaveBeenLastCalledWith("https://www.tiktok.com/@a/video/1");
    fire(".zone", drag("drop", { text: "https://youtu.be/dQw4w9WgXcQ" }));
    expect(onLink).toHaveBeenLastCalledWith("https://youtu.be/dQw4w9WgXcQ");
    // A thumbnail off a video page: its picture and the page's link. The link is what was meant.
    fire(".zone", drag("dragenter", { files: [PNG], uri: "https://www.youtube.com/shorts/dQw4w9WgXcQ" }));
    expect(layer()?.textContent).toBe("Drop it here");
    fire(".zone", drag("drop", { files: [PNG], uri: "https://www.youtube.com/shorts/dQw4w9WgXcQ" }));
    expect(onLink).toHaveBeenLastCalledWith("https://www.youtube.com/shorts/dQw4w9WgXcQ");
    // Words that are no link.
    fire(".zone", drag("drop", { text: "hello there" }));
    expect(status(".zone")).toBe(WRONG_THING);
  });

  it("lets text dragged into a text box land there, and still takes a file dropped on it", () => {
    const onLink = vi.fn();
    const onFiles = vi.fn();
    render(<Zone checkFile={videoOnly} links onLink={onLink} onFiles={onFiles} />);
    fire(".zone", drag("dragenter", { text: "some words" }));
    fire(".box", drag("dragenter", { text: "some words" }));
    expect(layer()).toBeNull();
    const over = fire(".box", drag("dragover", { text: "some words" }));
    expect(over.defaultPrevented).toBe(false);
    const dropped = fire(".box", drag("drop", { uri: "https://www.tiktok.com/@a/video/1", text: "https://www.tiktok.com/@a/video/1" }));
    expect(dropped.defaultPrevented).toBe(false);
    expect(onLink).not.toHaveBeenCalled();
    const file = fire(".box", drag("drop", { files: [VIDEO] }));
    expect(file.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledWith([VIDEO]);
  });

  it("is quiet for a drag it does not take: files on a links-only zone, links on a files-only zone", () => {
    render(<Zone checkFile={videoOnly} />);
    const e = fire(".zone", drag("dragover", { uri: "https://x.com/a/status/1" }));
    expect(e.defaultPrevented).toBe(false);
    expect(layer()).toBeNull();
    render(<Zone links />);
    const f = fire(".zone", drag("dragover", { files: [VIDEO] }));
    expect(f.defaultPrevented).toBe(false);
  });

  it("while busy shows the busy line, takes no drop and refuses it with that line", () => {
    const onFiles = vi.fn();
    render(<Zone checkFile={videoOnly} onFiles={onFiles} busy="Wait for it." />);
    fire(".zone", drag("dragenter", { files: [VIDEO] }));
    expect(layer()?.className).toContain("is-busy");
    expect(layer()?.textContent).toBe("Wait for it.");
    const over = fire(".zone", drag("dragover", { files: [VIDEO] }));
    expect(over.dataTransfer.dropEffect).toBe("none");
    fire(".zone", drag("drop", { files: [VIDEO] }));
    expect(onFiles).not.toHaveBeenCalled();
    expect(status(".zone")).toBe("Wait for it.");
  });

  it("is off when not enabled: no highlight, nothing taken, nothing prevented", () => {
    const onFiles = vi.fn();
    render(<Zone checkFile={videoOnly} onFiles={onFiles} enabled={false} />);
    expect(fire(".zone", drag("dragenter", { files: [VIDEO] })).defaultPrevented).toBe(false);
    expect(layer()).toBeNull();
    expect(fire(".zone", drag("drop", { files: [VIDEO] })).defaultPrevented).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe("a page zone", () => {
  it("takes a video dropped anywhere on the page, and shows the layer on the window", () => {
    const onFiles = vi.fn();
    render(<Page checkFile={videoOnly} links onFiles={onFiles} />);
    fire(".words", drag("dragenter", { files: [VIDEO] }));
    expect(layer()?.className).toContain("drop-layer--page");
    expect(layer()?.className).toContain("st-drop");
    expect(layer()?.parentElement).toBe(document.body);
    expect(layer()?.textContent).toBe("Drop your video here");
    const e = fire(".words", drag("drop", { files: [VIDEO] }));
    expect(e.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledWith([VIDEO]);
    expect(layer()).toBeNull();
  });

  it("never takes what an element zone took first, and its count stays in step around it", () => {
    const onFiles = vi.fn();
    const inner = vi.fn();
    function Both() {
      return (
        <>
          <Page checkFile={videoOnly} onFiles={onFiles} />
          <Zone checkFile={videoOnly} onFiles={inner} />
        </>
      );
    }
    render(<Both />);
    fire(".words", drag("dragenter", { files: [VIDEO] }));
    expect($(".drop-layer--page")).not.toBeNull();
    // Into the element zone: it takes the drag, the page's layer goes.
    fire(".child", drag("dragenter", { files: [VIDEO] }));
    fire(".words", drag("dragleave", { files: [VIDEO] }));
    fire(".child", drag("dragover", { files: [VIDEO] }));
    expect($(".drop-layer--page")).toBeNull();
    expect($(".drop-layer--element")).not.toBeNull();
    // Back out onto the page: the page's layer again, and it stays after the zone's leave.
    fire(".words", drag("dragenter", { files: [VIDEO] }));
    fire(".child", drag("dragleave", { files: [VIDEO] }));
    expect($(".drop-layer--page")).not.toBeNull();
    expect($(".drop-layer--element")).toBeNull();
    // A drop on the element zone is the zone's only.
    fire(".child", drag("drop", { files: [VIDEO] }));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("leaves a prevented event alone", () => {
    const onFiles = vi.fn();
    render(<Page checkFile={videoOnly} onFiles={onFiles} />);
    const words = $(".words")!;
    const taker = (e: Event) => e.preventDefault();
    words.addEventListener("drop", taker);
    fire(".words", drag("drop", { files: [VIDEO] }));
    words.removeEventListener("drop", taker);
    expect(onFiles).not.toHaveBeenCalled();
    expect(status("body")).toBe("");
  });

  it("leaves Ask's launcher and panel to Ask", () => {
    const onFiles = vi.fn();
    render(<Page checkFile={videoOnly} onFiles={onFiles} />);
    for (const sel of [".help-launcher .ask", "#help-panel textarea"]) {
      expect(fire(sel, drag("dragenter", { files: [VIDEO] })).defaultPrevented, sel).toBe(false);
      expect(layer(), sel).toBeNull();
      expect(fire(sel, drag("drop", { files: [VIDEO] })).defaultPrevented, sel).toBe(false);
    }
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("is off while its app is hidden behind the other one", () => {
    const onFiles = vi.fn();
    render(
      <PaneContext.Provider value={{ active: false, clipsMounted: true, hosted: true }}>
        <Page checkFile={videoOnly} onFiles={onFiles} />
      </PaneContext.Provider>,
    );
    expect(fire(".words", drag("dragenter", { files: [VIDEO] })).defaultPrevented).toBe(false);
    expect(layer()).toBeNull();
    expect(fire(".words", drag("drop", { files: [VIDEO] })).defaultPrevented).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
    // On screen again: it takes drops.
    render(
      <PaneContext.Provider value={{ active: true, clipsMounted: true, hosted: true }}>
        <Page checkFile={videoOnly} onFiles={onFiles} />
      </PaneContext.Provider>,
    );
    fire(".words", drag("drop", { files: [VIDEO] }));
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("is off while a dialog is open", () => {
    const onFiles = vi.fn();
    render(<Page checkFile={videoOnly} onFiles={onFiles} />);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    expect(fire(".words", drag("dragenter", { files: [VIDEO] })).defaultPrevented).toBe(false);
    expect(layer()).toBeNull();
    expect(fire(".words", drag("drop", { files: [VIDEO] })).defaultPrevented).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
    dialog.remove();
    fire(".words", drag("drop", { files: [VIDEO] }));
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("portals into the host it is given, with its status line", () => {
    const stage = document.createElement("div");
    stage.className = "stories-app";
    document.body.append(stage);
    function Hosted() {
      const drop = useFileDrop({ scope: "page", checkFile: videoOnly });
      return <DropOverlay drop={drop} scope="page" words={{ file: "Drop your video here" }} look="stories" host={stage} />;
    }
    render(<Hosted />);
    expect(stage.querySelector("[role=status]")).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(drag("dragenter", { files: [VIDEO] }));
    });
    expect(stage.querySelector(".drop-layer.st-drop")).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(drag("drop", { files: [PNG] }));
    });
    expect(stage.querySelector("[role=status]")?.textContent).toBe("Pick an MP4 or MOV video.");
  });
});
