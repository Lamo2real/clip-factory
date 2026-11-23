// The window's drop guard (docs/CONTRACTS.md §12.5, §45.40): installed once in main.tsx, for the whole app from the
// start, so it is there too when the app opens straight into Clips Funded (Ask's own guard lives in Clip Factory's
// shell, HelpLauncher.tsx, and is not mounted then). A file or a link dropped where no zone took it is refused: a
// stray file never replaces the app, and a stray link never navigates the page (or, in the Mac app, opens the system
// browser). Zones (lib/useFileDrop.ts, NewJobForm, Ask) run before it and prevent the default themselves, so they
// always get their drops; text dragged into a text box still lands there.

const NOT_TEXT = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** True when the event's target is a place that types text: a text input, a textarea or a contenteditable. */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return false;
  if (el.closest('textarea, [contenteditable]:not([contenteditable="false"])')) return true;
  const input = el.closest("input");
  return !!input && !NOT_TEXT.has(input.type);
}

/** The drag carries files, and whether it carries a link (a uri-list). */
function carries(data: Pick<DataTransfer, "types"> | null | undefined): { files: boolean; link: boolean } {
  const types = Array.from(data?.types ?? []);
  return { files: types.includes("Files"), link: types.includes("text/uri-list") };
}

/** The guard for one dragover or drop that reached the window. */
export function guardDrop(e: DragEvent): void {
  // A zone took it.
  if (e.defaultPrevented) return;
  const { files, link } = carries(e.dataTransfer);
  // Text (or a link) into a box: the box takes it.
  if (!files && isEditableTarget(e.target)) return;
  if (!files && !link) return;
  e.preventDefault();
  if (e.type === "dragover" && e.dataTransfer) e.dataTransfer.dropEffect = "none";
}

let installed: (() => void) | null = null;

/** Adds the guard to the window (once; a second call does nothing). Returns the way to take it off again (tests). */
export function installDropGuard(target: Window = window): () => void {
  if (installed) return installed;
  target.addEventListener("dragover", guardDrop);
  target.addEventListener("drop", guardDrop);
  const off = () => {
    target.removeEventListener("dragover", guardDrop);
    target.removeEventListener("drop", guardDrop);
    if (installed === off) installed = null;
  };
  installed = off;
  return off;
}
