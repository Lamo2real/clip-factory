/**
 * `data-scrolled` on <html> once the page has scrolled at all, gone again back at its top (a bounce above it counts as
 * the top). An installed phone app runs edge to edge under its status bar: at the top of a page the backdrop shows
 * under the clock as it is, and once something can slide up under the clock a strip of the app's own glass lies there
 * (layout.css .app::before, Clips Funded's .st-frame::before), so the white clock keeps AA over any card. Both apps
 * scroll the window, so one flag serves them both.
 */
export function installPageScrolled(root: HTMLElement = document.documentElement, win: Window = window): () => void {
  const check = () => root.toggleAttribute("data-scrolled", win.scrollY > 0);
  check();
  win.addEventListener("scroll", check, { passive: true });
  return () => win.removeEventListener("scroll", check);
}
