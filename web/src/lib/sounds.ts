import { clipsHidden } from "../app/shell.ts";
import { getPrefs } from "./prefs.ts";
import { SoundEngine } from "./sound.ts";

/**
 * The app's one sound engine, following the Sound setting and the chosen click and error sounds. Quiet while a Lamo
 * Stories page is on screen (a Clip Factory page kept behind it never plays over it, §45.38; Lamo Stories plays its
 * own sounds then); never quiet while Lamo Stories is switched off.
 */
export const sounds = new SoundEngine(
  () => getPrefs().soundEnabled && !clipsHidden(),
  () => ({ tap: getPrefs().clickSound, deny: getPrefs().errorSound }),
);
