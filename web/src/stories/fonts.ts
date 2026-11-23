// Clips Funded' own fonts (styles/fonts.css: Fugaz One and Fraunces, self-hosted from /fonts/stories/, OFL), put on
// the page by the first Clips Funded screen, never by its code arriving. The shell prefetches the Stories chunk
// at idle while Clip Factory is on screen (stories/pane.tsx), and a @font-face that arrives then, even one no word
// uses, makes Chromium paint Clip Factory's words again a pixel off (web/scripts/clips-unchanged.sh with Stories on:
// Settings' cards). So the faces are not in the chunk's style sheet (styles/stories.css does not import fonts.css):
// StoriesApp adds them once, before its first paint. Clip Factory keeps Inter and Times; these names are only ever
// used under .stories-app.
import FACES from "./styles/fonts.css?inline";

/** The <style> that carries the faces (one per document). */
export const FONTS_ATTR = "data-st-fonts";

/** Adds Stories' @font-face rules to the page once (StoriesApp, before its first paint). */
export function addStoriesFonts(doc: Document = document): void {
  if (doc.head.querySelector(`style[${FONTS_ATTR}]`)) return;
  const style = doc.createElement("style");
  style.setAttribute(FONTS_ATTR, "");
  style.textContent = FACES;
  doc.head.append(style);
}
