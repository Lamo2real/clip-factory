/**
 * Which way the owner last moved around: `data-input="keyboard"` on <html> after Tab, `"pointer"` after a tap or a
 * click. Chromium counts every focus in a text field as :focus-visible, so a field opened by a tap (the Ask box)
 * would wear the keyboard ring each time; the CSS shows that ring only when the keyboard got there.
 */
export function installInputModality(root: HTMLElement = document.documentElement, target: EventTarget = window): void {
  target.addEventListener(
    "keydown",
    (e) => {
      if ((e as KeyboardEvent).key === "Tab") root.dataset.input = "keyboard";
    },
    true,
  );
  target.addEventListener(
    "pointerdown",
    () => {
      root.dataset.input = "pointer";
    },
    true,
  );
}
